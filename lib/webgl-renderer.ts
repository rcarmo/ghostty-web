import type { ITerminalDecoration, ITheme } from './interfaces';
import {
  DEFAULT_THEME,
  type FontMetrics,
  type IRenderable,
  type IScrollbackProvider,
  type RendererOptions,
} from './renderer';
import type { ITerminalRenderer } from './renderer-contract';
import type { SelectionManager } from './selection-manager';
import type { GhosttyCell } from './types';
import { WebGLRenderer as VendoredWebGLRenderer } from './vendor/libghostty-webgl/src/WebGLRenderer';
import {
  DirtyState,
  ROW_DIRTY,
  ROW_HAS_HYPERLINK,
  ROW_HAS_SELECTION,
} from './vendor/libghostty-webgl/src/types';
import type {
  DecorationRange,
  RenderInput,
  SelectionRange,
  TerminalTheme,
  GhosttyCell as WebGLGhosttyCell,
} from './vendor/libghostty-webgl/src/types';

/**
 * Terminal-facing WebGL renderer adapter.
 *
 * This class intentionally does not extend CanvasRenderer: a canvas can only
 * own one rendering context, so grabbing a 2D context first would make WebGL2
 * initialization impossible. It implements the same Terminal-facing contract
 * and translates the current pull-model terminal state into libghostty-webgl's
 * push-model RenderInput.
 */
export class WebGLRenderer implements ITerminalRenderer {
  private canvas: HTMLCanvasElement;
  private options: RendererOptions;
  private vendored: VendoredWebGLRenderer;
  private theme: Required<ITheme>;
  private allowTransparency: boolean;
  private cols = 0;
  private rows = 0;
  private selectionManager?: SelectionManager;
  private onRequestRender?: () => void;
  private hoveredHyperlinkId: number | null = null;
  private hoveredLinkRange: { startX: number; startY: number; endX: number; endY: number } | null =
    null;
  private decorations: ITerminalDecoration[] = [];
  private preeditOverlay?: HTMLDivElement;
  private cursorVisible = true;
  private cursorBlinkInterval?: number;
  private scrollbarWidth: number;

  static canUse(canvas: HTMLCanvasElement): boolean {
    // Probe on a throwaway canvas. Calling getContext('webgl2') on the real
    // terminal canvas would permanently bind it to WebGL; if construction later
    // fails, CanvasRenderer fallback could no longer obtain a 2D context.
    const doc = canvas.ownerDocument ?? (typeof document !== 'undefined' ? document : undefined);
    if (!doc) return false;
    const probe = doc.createElement('canvas');
    try {
      const gl = probe.getContext('webgl2');
      if (!gl) return false;
      // Release the probe context immediately where supported. This avoids
      // burning scarce WebGL contexts on iOS/WebKit before the real renderer is
      // constructed.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return true;
    } catch {
      return false;
    }
  }

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    this.options = options;
    this.theme = { ...DEFAULT_THEME, ...(options.theme ?? {}) };
    this.allowTransparency = options.allowTransparency ?? false;
    this.scrollbarWidth = Math.max(0, options.scrollbarWidth ?? 8);
    this.vendored = new VendoredWebGLRenderer({
      fontSize: options.fontSize,
      fontFamily: options.fontFamily,
      devicePixelRatio: options.devicePixelRatio,
      ownerDocument: canvas.ownerDocument,
      alpha: this.allowTransparency,
    });
    this.vendored.attach(canvas);
    this.vendored.updateTheme(this.toWebGLTheme(this.theme));
    this.setCursorBlink(options.cursorBlink ?? false);
  }

  get charWidth(): number {
    return this.vendored.charWidth;
  }

  get charHeight(): number {
    return this.vendored.charHeight;
  }

  resize(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
    this.cols = Math.floor(cols);
    this.rows = Math.floor(rows);
    this.vendored.resize(this.cols, this.rows);
  }

  render(
    buffer: IRenderable,
    forceAll = false,
    viewportY = 0,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity = 1
  ): void {
    const dims = buffer.getDimensions();
    if (dims.cols !== this.cols || dims.rows !== this.rows) {
      this.resize(dims.cols, dims.rows);
    }

    const input = this.buildRenderInput(
      buffer,
      forceAll,
      viewportY,
      scrollbackProvider,
      scrollbarOpacity
    );
    this.vendored.render(input);
  }

  clear(): void {
    this.vendored.clear();
  }

  dispose(): void {
    this.stopCursorBlink();
    this.preeditOverlay?.remove();
    this.preeditOverlay = undefined;
    this.vendored.dispose();
  }

  getMetrics(): FontMetrics {
    return this.vendored.getMetrics();
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  setTheme(theme: ITheme): void {
    this.theme = { ...this.theme, ...theme };
    this.vendored.updateTheme(this.toWebGLTheme(this.theme));
  }

  setAllowTransparency(allowTransparency: boolean): void {
    this.allowTransparency = allowTransparency;
  }

  setFontSize(fontSize: number): void {
    if (!Number.isFinite(fontSize) || fontSize <= 0) return;
    this.options.fontSize = fontSize;
    this.vendored.setFontSize(fontSize);
  }

  setFontFamily(fontFamily: string): void {
    this.options.fontFamily = fontFamily;
    this.vendored.setFontFamily(fontFamily);
  }

  setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    this.options.cursorStyle = style;
  }

  setCursorBlink(blink: boolean): void {
    this.options.cursorBlink = blink;
    if (blink) {
      this.startCursorBlink();
    } else {
      this.stopCursorBlink();
    }
  }

  setScrollbarWidth(width: number): void {
    this.scrollbarWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  }

  setSelectionManager(selectionManager: SelectionManager): void {
    this.selectionManager = selectionManager;
  }

  setHoveredHyperlinkId(id: number | null): void {
    this.hoveredHyperlinkId =
      id !== null && Number.isFinite(id) ? Math.max(0, Math.floor(id)) : null;
  }

  setHoveredLinkRange(
    range: { startX: number; startY: number; endX: number; endY: number } | null
  ): void {
    this.hoveredLinkRange = sanitizeLinkRange(range);
  }

  setDecorations(decorations: ITerminalDecoration[]): void {
    this.decorations = decorations.slice();
  }

  clearDecorations(): void {
    this.decorations = [];
  }

  attachOverlayTo(parent: HTMLElement): void {
    if (this.preeditOverlay) return;
    const overlay = parent.ownerDocument.createElement('div');
    overlay.style.position = 'absolute';
    overlay.style.pointerEvents = 'none';
    overlay.style.whiteSpace = 'pre';
    overlay.style.display = 'none';
    overlay.style.textDecoration = 'underline';
    overlay.style.zIndex = '1';
    parent.appendChild(overlay);
    this.preeditOverlay = overlay;
  }

  drawPreedit(text: string, cellX = 0, cellY = 0): void {
    if (!this.preeditOverlay) return;
    if (!text) {
      this.clearPreedit();
      return;
    }
    const metrics = this.getMetrics();
    const safeCellX = Number.isFinite(cellX) ? Math.max(0, Math.floor(cellX)) : 0;
    const safeCellY = Number.isFinite(cellY) ? Math.max(0, Math.floor(cellY)) : 0;
    this.preeditOverlay.textContent = text;
    this.preeditOverlay.style.left = `${safeCellX * metrics.width}px`;
    this.preeditOverlay.style.top = `${safeCellY * metrics.height}px`;
    this.preeditOverlay.style.font = `${this.options.fontSize ?? 15}px ${this.options.fontFamily ?? 'monospace'}`;
    this.preeditOverlay.style.color = this.theme.foreground;
    this.preeditOverlay.style.display = 'block';
  }

  clearPreedit(): void {
    if (!this.preeditOverlay) return;
    this.preeditOverlay.textContent = '';
    this.preeditOverlay.style.display = 'none';
  }

  setOnRequestRender(onRequestRender: () => void): void {
    this.onRequestRender = onRequestRender;
  }

  private startCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) return;
    const view = this.canvas.ownerDocument.defaultView;
    if (!view) return;
    this.cursorBlinkInterval = view.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      this.onRequestRender?.();
    }, 530);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) {
      const view = this.canvas.ownerDocument.defaultView;
      if (view) {
        view.clearInterval(this.cursorBlinkInterval);
      } else {
        clearInterval(this.cursorBlinkInterval);
      }
      this.cursorBlinkInterval = undefined;
    }
    this.cursorVisible = true;
  }

  private buildRenderInput(
    buffer: IRenderable,
    forceAll: boolean,
    viewportY: number,
    scrollbackProvider: IScrollbackProvider | undefined,
    scrollbarOpacity: number
  ): RenderInput {
    const dims = buffer.getDimensions();
    const viewportCells: WebGLGhosttyCell[] = [];
    const graphemeRows: (Array<string | undefined> | undefined)[] = [];
    const rowFlags = new Uint8Array(dims.rows);
    const selectionRange = this.selectionManager?.getSelectionCoords() ?? null;
    const cursor = buffer.getCursor();

    const viewport = buffer.getViewport?.();
    const scrollbackLength = scrollbackProvider?.getScrollbackLength() ?? 0;
    const clampedViewportY = clamp(viewportY, 0, scrollbackLength);
    const integerViewportY = Math.floor(clampedViewportY);

    for (let row = 0; row < dims.rows; row++) {
      const source = this.getRenderLineSource(
        buffer,
        row,
        dims.cols,
        integerViewportY,
        scrollbackLength,
        scrollbackProvider,
        viewport
      );
      const graphemes: Array<string | undefined> = [];
      let hasGrapheme = false;
      let flags = forceAll || source.isDirty ? ROW_DIRTY : 0;
      if (this.rowIntersectsSelection(row, selectionRange)) flags |= ROW_HAS_SELECTION;
      if (this.rowIntersectsHoveredLink(row)) flags |= ROW_HAS_HYPERLINK;

      for (let col = 0; col < dims.cols; col++) {
        const cell = source.cellAt(col) ?? this.emptyCell();
        viewportCells.push(cell as WebGLGhosttyCell);
        if (cell.grapheme_len > 0 && source.graphemeRow !== null && buffer.getGraphemeString) {
          graphemes[col] = buffer.getGraphemeString(source.graphemeRow, col);
          hasGrapheme = true;
        }
      }
      graphemeRows[row] = hasGrapheme ? graphemes : undefined;
      rowFlags[row] = flags;
    }

    return {
      cols: dims.cols,
      rows: dims.rows,
      viewportCells,
      graphemeRows,
      rowFlags,
      // Force a full instance upload for now. WKWebView/iOS in particular has
      // shown blank/stale rows when dirty-row metadata and viewport snapshots
      // disagree. This is conservative but correct; rowFlags still carry dirty
      // information for future optimization.
      dirtyState: DirtyState.FULL,
      selectionRange: selectionRange
        ? {
            startCol: selectionRange.startCol,
            startRow: selectionRange.startRow,
            endCol: selectionRange.endCol,
            endRow: selectionRange.endRow,
          }
        : null,
      hoveredLink:
        this.hoveredHyperlinkId !== null || this.hoveredLinkRange
          ? { hyperlinkId: this.hoveredHyperlinkId ?? 0, range: this.hoveredLinkRange }
          : null,
      decorations: this.toWebGLDecorations(),
      cursorX: cursor.x,
      cursorY: cursor.y,
      cursorVisible: cursor.visible && this.cursorVisible,
      cursorStyle: cursor.style ?? this.options.cursorStyle ?? 'block',
      getGraphemeString: buffer.getGraphemeString?.bind(buffer),
      theme: this.toWebGLTheme(this.theme),
      viewportY: clampedViewportY,
      scrollbackLength,
      scrollbarOpacity,
      scrollbarWidth: this.scrollbarWidth,
      allowTransparency: this.allowTransparency,
    };
  }

  private getRenderLineSource(
    buffer: IRenderable,
    viewportRow: number,
    cols: number,
    viewportY: number,
    scrollbackLength: number,
    scrollbackProvider: IScrollbackProvider | undefined,
    viewport: GhosttyCell[] | undefined
  ): {
    cellAt: (col: number) => GhosttyCell | undefined;
    graphemeRow: number | null;
    isDirty: boolean;
  } {
    if (viewportY > 0) {
      if (viewportRow < viewportY && scrollbackProvider) {
        const scrollbackOffset = scrollbackLength - viewportY + viewportRow;
        const line = scrollbackProvider.getScrollbackLine(scrollbackOffset) ?? [];
        return {
          cellAt: (col) => line[col],
          graphemeRow: null,
          isDirty: true,
        };
      }

      const screenRow = viewportRow - viewportY;
      return {
        cellAt: this.getViewportLineCellReader(buffer, viewport, screenRow, cols),
        graphemeRow: screenRow >= 0 ? screenRow : null,
        isDirty: screenRow >= 0 ? buffer.isRowDirty(screenRow) : true,
      };
    }

    return {
      cellAt: this.getViewportLineCellReader(buffer, viewport, viewportRow, cols),
      graphemeRow: viewportRow,
      isDirty: buffer.isRowDirty(viewportRow),
    };
  }

  private getViewportLineCellReader(
    buffer: IRenderable,
    viewport: GhosttyCell[] | undefined,
    row: number,
    cols: number
  ): (col: number) => GhosttyCell | undefined {
    if (row < 0) return () => undefined;
    if (!viewport) {
      const line = buffer.getLine(row) ?? [];
      return (col) => line[col];
    }
    const offset = row * cols;
    return (col) => viewport[offset + col];
  }

  private rowIntersectsSelection(row: number, selection: SelectionRange | null): boolean {
    if (!selection) return false;
    return row >= selection.startRow && row <= selection.endRow;
  }

  private rowIntersectsHoveredLink(row: number): boolean {
    const range = this.hoveredLinkRange;
    if (!range) return false;
    return row >= range.startY && row <= range.endY;
  }

  private emptyCell(): WebGLGhosttyCell {
    return {
      codepoint: 32,
      fg_r: 0,
      fg_g: 0,
      fg_b: 0,
      bg_r: 0,
      bg_g: 0,
      bg_b: 0,
      fgIsDefault: true,
      bgIsDefault: true,
      flags: 0,
      width: 1,
      hyperlink_id: 0,
      grapheme_len: 0,
    };
  }

  private toWebGLDecorations(): DecorationRange[] {
    return this.decorations.map((decoration) => ({
      line: decoration.line,
      column: decoration.column,
      length: decoration.length,
      background: decoration.background ? this.cssToRgba(decoration.background) : undefined,
      foreground: decoration.foreground ? this.cssToRgba(decoration.foreground) : undefined,
    }));
  }

  private toWebGLTheme(theme: Required<ITheme>): TerminalTheme {
    return {
      foreground: this.cssToRgba(theme.foreground),
      background: this.cssToRgba(theme.background),
      cursor: this.cssToRgba(theme.cursor),
      cursorAccent: this.cssToRgba(theme.cursorAccent),
      selectionBackground: this.cssToRgba(theme.selectionBackground),
      selectionForeground: this.cssToRgba(theme.selectionForeground),
      selectionOpacity: 1,
    };
  }

  private cssToRgba(value: string): { r: number; g: number; b: number; a: number } {
    const direct = parseCssColor(value);
    if (direct) return direct;

    // CanvasRenderer accepts any browser CSS color. Use the browser parser too
    // so WebGL themes don't regress for names, rgb(), hsl(), etc.
    const normalized = normalizeCssColor(value, this.canvas.ownerDocument);
    if (normalized && normalized !== value) {
      const parsed = parseCssColor(normalized);
      if (parsed) return parsed;
    }

    return { r: 0, g: 0, b: 0, a: 1 };
  }
}

function sanitizeLinkRange(
  range: { startX: number; startY: number; endX: number; endY: number } | null
): { startX: number; startY: number; endX: number; endY: number } | null {
  if (!range) return null;
  if (![range.startX, range.startY, range.endX, range.endY].every(Number.isFinite)) return null;
  return {
    startX: Math.max(0, Math.floor(range.startX)),
    startY: Math.max(0, Math.floor(range.startY)),
    endX: Math.max(0, Math.floor(range.endX)),
    endY: Math.max(0, Math.floor(range.endY)),
  };
}

function parseCssColor(value: string): { r: number; g: number; b: number; a: number } | null {
  const color = value.trim();
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      return validRgba({
        r: Number.parseInt(hex[0]! + hex[0]!, 16),
        g: Number.parseInt(hex[1]! + hex[1]!, 16),
        b: Number.parseInt(hex[2]! + hex[2]!, 16),
        a: hex.length === 4 ? Number.parseInt(hex[3]! + hex[3]!, 16) / 255 : 1,
      });
    }
    if (hex.length === 6 || hex.length === 8) {
      return validRgba({
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
      });
    }
  }

  const rgba = color.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1]!
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= 3) {
      return validRgba({
        r: parseColorChannel(parts[0]!),
        g: parseColorChannel(parts[1]!),
        b: parseColorChannel(parts[2]!),
        a: parts[3] !== undefined ? clamp01(Number.parseFloat(parts[3]!)) : 1,
      });
    }
  }

  return null;
}

function validRgba(color: { r: number; g: number; b: number; a: number }): {
  r: number;
  g: number;
  b: number;
  a: number;
} | null {
  if (![color.r, color.g, color.b, color.a].every(Number.isFinite)) return null;
  return color;
}

function normalizeCssColor(value: string, document: Document | undefined): string | null {
  if (!document) return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#000000';
  ctx.fillStyle = value;
  return typeof ctx.fillStyle === 'string' ? ctx.fillStyle : null;
}

function parseColorChannel(value: string): number {
  if (value.endsWith('%')) return clampU8((Number.parseFloat(value) / 100) * 255);
  return clampU8(Number.parseFloat(value));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function clampU8(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}
