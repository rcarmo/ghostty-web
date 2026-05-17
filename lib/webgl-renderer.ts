import type { ITerminalDecoration, ITheme } from './interfaces';
import type { ITerminalRenderer } from './renderer-contract';
import {
  DEFAULT_THEME,
  type FontMetrics,
  type IRenderable,
  type IScrollbackProvider,
  type RendererOptions,
} from './renderer';
import type { SelectionManager } from './selection-manager';
import { WebGLRenderer as VendoredWebGLRenderer } from './vendor/libghostty-webgl/src/WebGLRenderer';
import { DirtyState, ROW_DIRTY, ROW_HAS_HYPERLINK, ROW_HAS_SELECTION } from './vendor/libghostty-webgl/src/types';
import type {
  GhosttyCell as WebGLGhosttyCell,
  RenderInput,
  SelectionRange,
  TerminalTheme,
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
  private cols = 0;
  private rows = 0;
  private selectionManager?: SelectionManager;
  private onRequestRender?: () => void;
  private hoveredHyperlinkId: number | null = null;
  private hoveredLinkRange: { startX: number; startY: number; endX: number; endY: number } | null = null;
  private decorations: ITerminalDecoration[] = [];
  private preeditOverlay?: HTMLDivElement;

  static canUse(canvas: HTMLCanvasElement): boolean {
    try {
      return Boolean(canvas.getContext('webgl2'));
    } catch {
      return false;
    }
  }

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    this.options = options;
    this.theme = { ...DEFAULT_THEME, ...(options.theme ?? {}) };
    this.vendored = new VendoredWebGLRenderer({
      fontSize: options.fontSize,
      fontFamily: options.fontFamily,
      devicePixelRatio: options.devicePixelRatio,
      alpha: true,
    });
    this.vendored.attach(canvas);
    this.vendored.updateTheme(this.toWebGLTheme(this.theme));
  }

  get charWidth(): number {
    return this.vendored.charWidth;
  }

  get charHeight(): number {
    return this.vendored.charHeight;
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.vendored.resize(cols, rows);
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

    const input = this.buildRenderInput(buffer, forceAll, viewportY, scrollbackProvider, scrollbarOpacity);
    this.vendored.render(input);
  }

  clear(): void {
    this.vendored.clear();
  }

  dispose(): void {
    this.clearPreedit();
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

  setFontSize(fontSize: number): void {
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
  }

  setSelectionManager(selectionManager: SelectionManager): void {
    this.selectionManager = selectionManager;
  }

  setHoveredHyperlinkId(id: number | null): void {
    this.hoveredHyperlinkId = id;
  }

  setHoveredLinkRange(range: { startX: number; startY: number; endX: number; endY: number } | null): void {
    this.hoveredLinkRange = range;
  }

  setDecorations(decorations: ITerminalDecoration[]): void {
    this.decorations = decorations.slice();
  }

  clearDecorations(): void {
    this.decorations = [];
  }

  attachOverlayTo(parent: HTMLElement): void {
    if (this.preeditOverlay) return;
    const overlay = document.createElement('div');
    overlay.style.position = 'absolute';
    overlay.style.pointerEvents = 'none';
    overlay.style.whiteSpace = 'pre';
    overlay.style.display = 'none';
    parent.appendChild(overlay);
    this.preeditOverlay = overlay;
  }

  drawPreedit(text: string): void {
    if (!this.preeditOverlay) return;
    this.preeditOverlay.textContent = text;
    this.preeditOverlay.style.display = text ? 'block' : 'none';
  }

  clearPreedit(): void {
    if (!this.preeditOverlay) return;
    this.preeditOverlay.remove();
    this.preeditOverlay = undefined;
  }

  setOnRequestRender(onRequestRender: () => void): void {
    this.onRequestRender = onRequestRender;
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

    for (let row = 0; row < dims.rows; row++) {
      const line = buffer.getLine(row) ?? [];
      const graphemes: Array<string | undefined> = [];
      let hasGrapheme = false;
      let flags = forceAll || buffer.isRowDirty(row) ? ROW_DIRTY : 0;
      if (this.rowIntersectsSelection(row, selectionRange)) flags |= ROW_HAS_SELECTION;
      if (this.rowIntersectsHoveredLink(row)) flags |= ROW_HAS_HYPERLINK;

      for (let col = 0; col < dims.cols; col++) {
        const cell = line[col] ?? this.emptyCell();
        viewportCells.push(cell as WebGLGhosttyCell);
        if (cell.grapheme_len > 0 && buffer.getGraphemeString) {
          graphemes[col] = buffer.getGraphemeString(row, col);
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
      dirtyState: forceAll ? DirtyState.FULL : DirtyState.PARTIAL,
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
      cursorX: cursor.x,
      cursorY: cursor.y,
      cursorVisible: cursor.visible,
      cursorStyle: cursor.style ?? this.options.cursorStyle ?? 'block',
      getGraphemeString: buffer.getGraphemeString?.bind(buffer),
      theme: this.toWebGLTheme(this.theme),
      viewportY,
      scrollbackLength: scrollbackProvider?.getScrollbackLength() ?? 0,
      scrollbarOpacity,
    };
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
      flags: 0,
      width: 1,
      hyperlink_id: 0,
      grapheme_len: 0,
    };
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
    if (value.startsWith('#')) {
      const hex = value.slice(1);
      if (hex.length === 3) {
        return {
          r: Number.parseInt(hex[0]! + hex[0]!, 16),
          g: Number.parseInt(hex[1]! + hex[1]!, 16),
          b: Number.parseInt(hex[2]! + hex[2]!, 16),
          a: 1,
        };
      }
      if (hex.length >= 6) {
        return {
          r: Number.parseInt(hex.slice(0, 2), 16),
          g: Number.parseInt(hex.slice(2, 4), 16),
          b: Number.parseInt(hex.slice(4, 6), 16),
          a: 1,
        };
      }
    }
    return { r: 0, g: 0, b: 0, a: 1 };
  }
}
