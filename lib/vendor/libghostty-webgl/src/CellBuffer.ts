import {
  CellFlags,
  DirtyState,
  type GraphemeRows,
  ROW_DIRTY,
  ROW_HAS_HYPERLINK,
  ROW_HAS_SELECTION,
  type GhosttyCell,
  type RenderInput,
  type TerminalTheme,
} from "./types";
import type { GlyphAtlas, GlyphMetrics } from "./GlyphAtlas";
import { profileDuration, profileStart } from "./profile";

const CELL_STRIDE = 32;
const GLYPH_COLOR_ATLAS = 0x01;

const DECO_UNDERLINE = 0x01;
const DECO_STRIKETHROUGH = 0x02;
const DECO_HYPERLINK = 0x04;
const _DECO_CURLY = 0x08;

const LINK_COLOR = { r: 74, g: 144, b: 226, a: 255 };
const ASCII_CACHE: string[] = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i));
const SPACE_CODEPOINT = 32;
const EMPTY_GRAPHEME_ROWS: GraphemeRows = [];

interface ResolvedCellColors {
  fgR: number;
  fgG: number;
  fgB: number;
  fgA: number;
  bgR: number;
  bgG: number;
  bgB: number;
  bgA: number;
  decoR: number;
  decoG: number;
  decoB: number;
  decoA: number;
  decoFlags: number;
}

export class CellBuffer {
  private gl: WebGL2RenderingContext;
  private buffer: WebGLBuffer;
  private cols: number = 0;
  private rows: number = 0;
  private data: ArrayBuffer = new ArrayBuffer(0);
  private u8: Uint8Array = new Uint8Array(0);
  private view: DataView = new DataView(new ArrayBuffer(0));
  private resolved: ResolvedCellColors = createResolvedColors();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const buffer = gl.createBuffer();
    if (!buffer) {
      throw new Error("Failed to create WebGL buffer");
    }
    this.buffer = buffer;
  }

  get handle(): WebGLBuffer {
    return this.buffer;
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;

    const totalBytes = cols * rows * CELL_STRIDE;
    this.data = new ArrayBuffer(totalBytes);
    this.u8 = new Uint8Array(this.data);
    this.view = new DataView(this.data);

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, totalBytes, this.gl.DYNAMIC_DRAW);
  }

  // Debug: enable verbose cell logging via window flag
  private static shouldDebugCells(): boolean {
    return typeof window !== "undefined" && (window as any).BOOTTY_DEBUG_CELLS === true;
  }

  update(input: RenderInput, atlas: GlyphAtlas, forceFullUpload: boolean): void {
    if (input.cols !== this.cols || input.rows !== this.rows) {
      this.resize(input.cols, input.rows);
    }

    const rows = input.rows;
    const cols = input.cols;
    const rowFlags = input.rowFlags;
    const dirtyRows: number[] = [];
    const dirtyMask = ROW_DIRTY | ROW_HAS_SELECTION | ROW_HAS_HYPERLINK;

    if (forceFullUpload || input.dirtyState === DirtyState.FULL) {
      for (let y = 0; y < rows; y++) dirtyRows.push(y);
    } else {
      for (let y = 0; y < rows; y++) {
        if ((rowFlags[y] & dirtyMask) !== 0) {
          dirtyRows.push(y);
        }
      }
    }

    if (dirtyRows.length === 0) return;

    // Diagnostic: dump first 3 rows of cells received by WebGL renderer
    if (CellBuffer.shouldDebugCells() && input.dirtyState === DirtyState.FULL) {
      for (let row = 0; row < Math.min(3, rows); row++) {
        const rowBase = row * cols;
        let text = "";
        for (let col = 0; col < cols; col++) {
          const cell = input.viewportCells[rowBase + col];
          if (cell && cell.codepoint > SPACE_CODEPOINT) {
            text += String.fromCodePoint(cell.codepoint);
          } else {
            text += " ";
          }
        }
        console.log(`[webgl-cellbuffer] row ${row}: "${text.trimEnd()}"`);
      }
    }

    const writeStart = profileStart();
    const hasPreResolvedRows = input.graphemeRows && input.graphemeRows.length > 0;
    const graphemeRows = hasPreResolvedRows
      ? input.graphemeRows
      : this.resolveLegacyGraphemeRows(input, dirtyRows);
    const sparseLegacyFallback = hasPreResolvedRows ? input.getGraphemeString : undefined;
    for (const row of dirtyRows) {
      this.writeRow(row, input, atlas, graphemeRows[row], sparseLegacyFallback);
    }

    profileDuration("bootty:webgl:cellbuffer-write", writeStart, {
      cols,
      rows,
      dirtyRows: dirtyRows.length,
      dirtyState: input.dirtyState,
      forceFullUpload,
    });

    const uploadStart = profileStart();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    const rowSize = cols * CELL_STRIDE;
    let dirtyRanges = 0;
    let uploadedBytes = 0;
    const fullUpload = dirtyRows.length > rows * 0.5 || forceFullUpload;
    if (fullUpload) {
      this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, this.u8);
      dirtyRanges = 1;
      uploadedBytes = this.u8.byteLength;
    } else {
      let rangeStart = dirtyRows[0];
      let rangeEnd = dirtyRows[0];
      const flushRange = (start: number, end: number) => {
        const offset = start * rowSize;
        const byteLength = (end - start + 1) * rowSize;
        this.gl.bufferSubData(
          this.gl.ARRAY_BUFFER,
          offset,
          this.u8.subarray(offset, offset + byteLength),
        );
        dirtyRanges += 1;
        uploadedBytes += byteLength;
      };
      for (let i = 1; i < dirtyRows.length; i++) {
        const row = dirtyRows[i];
        if (row === rangeEnd + 1) {
          rangeEnd = row;
          continue;
        }
        flushRange(rangeStart, rangeEnd);
        rangeStart = row;
        rangeEnd = row;
      }
      flushRange(rangeStart, rangeEnd);
    }
    profileDuration("bootty:webgl:cellbuffer-upload", uploadStart, {
      cols,
      rows,
      dirtyRows: dirtyRows.length,
      dirtyRanges,
      dirtyState: input.dirtyState,
      forceFullUpload,
      fullUpload,
      uploadedBytes,
    });
  }

  private writeRow(
    row: number,
    input: RenderInput,
    atlas: GlyphAtlas,
    graphemeRow: ReadonlyArray<string | undefined> | undefined,
    sparseLegacyFallback: ((viewportRow: number, col: number) => string) | undefined,
  ): void {
    const cols = input.cols;
    const rowOffset = row * cols * CELL_STRIDE;
    const rowBase = row * cols;
    const selectionRange = input.selectionRange;
    const hovered = input.hoveredLink;
    const theme = input.theme;
    const resolved = this.resolved;
    const hoveredId = hovered?.hyperlinkId ?? 0;

    let selStart = -1;
    let selEnd = -1;
    if (selectionRange && row >= selectionRange.startRow && row <= selectionRange.endRow) {
      if (selectionRange.startRow === selectionRange.endRow) {
        selStart = selectionRange.startCol;
        selEnd = selectionRange.endCol;
      } else if (row === selectionRange.startRow) {
        selStart = selectionRange.startCol;
        selEnd = cols - 1;
      } else if (row === selectionRange.endRow) {
        selStart = 0;
        selEnd = selectionRange.endCol;
      } else {
        selStart = 0;
        selEnd = cols - 1;
      }
    }
    const hasSelection = selStart >= 0;

    let hoverStart = -1;
    let hoverEnd = -1;
    if (hoveredId === 0 && hovered?.range) {
      const range = hovered.range;
      if (row >= range.startY && row <= range.endY) {
        if (range.startY === range.endY) {
          hoverStart = range.startX;
          hoverEnd = range.endX;
        } else if (row === range.startY) {
          hoverStart = range.startX;
          hoverEnd = cols - 1;
        } else if (row === range.endY) {
          hoverStart = 0;
          hoverEnd = range.endX;
        } else {
          hoverStart = 0;
          hoverEnd = cols - 1;
        }
      }
    }
    const hasHoverRange = hoverStart >= 0;

    for (let col = 0; col < cols; col++) {
      const cell = input.viewportCells[rowBase + col];
      const offset = rowOffset + col * CELL_STRIDE;
      if (!cell) {
        this.writeEmptyCell(offset);
        continue;
      }

      const cellSpan = cell.width === 0 ? 0 : cell.width;
      const isSelected = hasSelection && col >= selStart && col <= selEnd;
      const isHovered =
        hoveredId > 0
          ? cell.hyperlink_id === hoveredId
          : hasHoverRange && col >= hoverStart && col <= hoverEnd;

      resolveCellColors(cell, theme, isSelected, isHovered, resolved);

      let glyphFlags = 0;
      let atlasMetrics: GlyphMetrics | null = null;
      if (cellSpan > 0 && resolved.fgA > 0 && !(cell.flags & CellFlags.INVISIBLE)) {
        let grapheme = "";
        let hasGlyph = false;
        if (cell.grapheme_len > 0) {
          const preResolved = graphemeRow?.[col];
          grapheme =
            preResolved !== undefined
              ? preResolved
              : sparseLegacyFallback
                ? sparseLegacyFallback(row, col)
                : "";
          if (grapheme.length === 1) {
            hasGlyph = grapheme.charCodeAt(0) > SPACE_CODEPOINT;
          } else {
            hasGlyph = grapheme.trim().length > 0;
          }
        } else {
          const codepoint = cell.codepoint || SPACE_CODEPOINT;
          if (codepoint > SPACE_CODEPOINT) {
            grapheme =
              codepoint < ASCII_CACHE.length
                ? ASCII_CACHE[codepoint]
                : String.fromCodePoint(codepoint);
            hasGlyph = true;
          }
        }

        if (hasGlyph) {
          const bold = (cell.flags & CellFlags.BOLD) !== 0;
          const italic = (cell.flags & CellFlags.ITALIC) !== 0;
          atlasMetrics = atlas.getGlyph(grapheme, bold, italic);
          if (atlasMetrics.isColor) {
            glyphFlags |= GLYPH_COLOR_ATLAS;
          }
        }
      }

      const atlasX = atlasMetrics?.atlasX ?? 0;
      const atlasY = atlasMetrics?.atlasY ?? 0;
      const atlasW = atlasMetrics?.atlasW ?? 0;
      const atlasH = atlasMetrics?.atlasH ?? 0;
      const bearingX = atlasMetrics?.bearingX ?? 0;
      const bearingY = atlasMetrics?.bearingY ?? 0;

      this.view.setUint16(offset + 0, atlasX, true);
      this.view.setUint16(offset + 2, atlasY, true);
      this.view.setUint16(offset + 4, atlasW, true);
      this.view.setUint16(offset + 6, atlasH, true);
      this.view.setInt16(offset + 8, clampI16(bearingX), true);
      this.view.setInt16(offset + 10, clampI16(bearingY), true);

      this.view.setUint32(offset + 12, packU8x4(cellSpan, resolved.decoFlags, glyphFlags, 0), true);
      this.view.setUint32(
        offset + 16,
        packU8x4(resolved.fgR, resolved.fgG, resolved.fgB, resolved.fgA),
        true,
      );
      this.view.setUint32(
        offset + 20,
        packU8x4(resolved.bgR, resolved.bgG, resolved.bgB, resolved.bgA),
        true,
      );
      this.view.setUint32(
        offset + 24,
        packU8x4(resolved.decoR, resolved.decoG, resolved.decoB, resolved.decoA),
        true,
      );

      this.view.setUint32(offset + 28, 0, true);
    }
  }

  private resolveLegacyGraphemeRows(input: RenderInput, dirtyRows: number[]): GraphemeRows {
    if (!input.getGraphemeString) {
      return EMPTY_GRAPHEME_ROWS;
    }
    const rows = input.rows;
    const legacyRows: Array<Array<string | undefined> | undefined> = Array.from(
      { length: rows },
      () => undefined,
    );
    for (const row of dirtyRows) {
      const rowData = this.resolveLegacyGraphemeRow(input, row);
      if (rowData) {
        legacyRows[row] = rowData;
      }
    }
    return legacyRows;
  }

  private resolveLegacyGraphemeRow(
    input: RenderInput,
    row: number,
  ): Array<string | undefined> | undefined {
    if (!input.getGraphemeString) {
      return undefined;
    }
    const cols = input.cols;
    const rowOffset = row * cols;
    let rowData: Array<string | undefined> | undefined;
    for (let col = 0; col < cols; col++) {
      const cell = input.viewportCells[rowOffset + col];
      if (!cell || cell.width === 0 || cell.grapheme_len <= 0) continue;
      rowData ??= Array.from({ length: cols }, () => undefined);
      rowData[col] = input.getGraphemeString(row, col);
    }
    return rowData;
  }

  private writeEmptyCell(offset: number): void {
    this.view.setUint16(offset + 0, 0, true);
    this.view.setUint16(offset + 2, 0, true);
    this.view.setUint16(offset + 4, 0, true);
    this.view.setUint16(offset + 6, 0, true);
    this.view.setInt16(offset + 8, 0, true);
    this.view.setInt16(offset + 10, 0, true);
    this.view.setUint32(offset + 12, packU8x4(1, 0, 0, 0), true);
    this.view.setUint32(offset + 16, 0, true);
    this.view.setUint32(offset + 20, 0, true);
    this.view.setUint32(offset + 24, 0, true);
    this.view.setUint32(offset + 28, 0, true);
  }
}

function resolveCellColors(
  cell: GhosttyCell,
  theme: TerminalTheme,
  isSelected: boolean,
  isHovered: boolean,
  out: ResolvedCellColors,
): void {
  let fgR = cell.fg_r;
  let fgG = cell.fg_g;
  let fgB = cell.fg_b;
  let bgR = cell.bg_r;
  let bgG = cell.bg_g;
  let bgB = cell.bg_b;

  if (cell.flags & CellFlags.INVERSE) {
    const tmpR = fgR;
    const tmpG = fgG;
    const tmpB = fgB;
    fgR = bgR;
    fgG = bgG;
    fgB = bgB;
    bgR = tmpR;
    bgG = tmpG;
    bgB = tmpB;
  }

  let fgA = 255;
  if (cell.flags & CellFlags.INVISIBLE) {
    fgA = 0;
  } else if (cell.flags & CellFlags.FAINT) {
    fgA = 128;
  }

  const isDefaultBg = bgR === 0 && bgG === 0 && bgB === 0;
  let bgA = isDefaultBg ? 0 : 255;

  if (isSelected) {
    const selectionOpacity = clampAlpha(theme.selectionOpacity * theme.selectionBackground.a);
    const baseR = isDefaultBg ? theme.background.r : bgR;
    const baseG = isDefaultBg ? theme.background.g : bgG;
    const baseB = isDefaultBg ? theme.background.b : bgB;
    const inv = 1 - selectionOpacity;
    bgR = clampU8(Math.round(baseR * inv + theme.selectionBackground.r * selectionOpacity));
    bgG = clampU8(Math.round(baseG * inv + theme.selectionBackground.g * selectionOpacity));
    bgB = clampU8(Math.round(baseB * inv + theme.selectionBackground.b * selectionOpacity));
    bgA = 255;
    if (theme.selectionForeground) {
      fgR = theme.selectionForeground.r;
      fgG = theme.selectionForeground.g;
      fgB = theme.selectionForeground.b;
    }
  }

  let decoFlags = 0;
  if (cell.flags & CellFlags.UNDERLINE) decoFlags |= DECO_UNDERLINE;
  if (cell.flags & CellFlags.STRIKETHROUGH) decoFlags |= DECO_STRIKETHROUGH;
  if (isHovered) decoFlags |= DECO_HYPERLINK;

  let decoR = fgR;
  let decoG = fgG;
  let decoB = fgB;
  let decoA = 255;
  if (decoFlags & DECO_HYPERLINK) {
    decoR = LINK_COLOR.r;
    decoG = LINK_COLOR.g;
    decoB = LINK_COLOR.b;
    decoA = LINK_COLOR.a;
  }

  out.fgR = fgR;
  out.fgG = fgG;
  out.fgB = fgB;
  out.fgA = fgA;
  out.bgR = bgR;
  out.bgG = bgG;
  out.bgB = bgB;
  out.bgA = bgA;
  out.decoR = decoR;
  out.decoG = decoG;
  out.decoB = decoB;
  out.decoA = decoA;
  out.decoFlags = decoFlags;
}

function clampU8(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

function clampI16(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < -32768) return -32768;
  if (value > 32767) return 32767;
  return Math.trunc(value);
}

function clampAlpha(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function createResolvedColors(): ResolvedCellColors {
  return {
    fgR: 0,
    fgG: 0,
    fgB: 0,
    fgA: 0,
    bgR: 0,
    bgG: 0,
    bgB: 0,
    bgA: 0,
    decoR: 0,
    decoG: 0,
    decoB: 0,
    decoA: 0,
    decoFlags: 0,
  };
}

function packU8x4(a: number, b: number, c: number, d: number): number {
  return ((a & 0xff) | ((b & 0xff) << 8) | ((c & 0xff) << 16) | ((d & 0xff) << 24)) >>> 0;
}
