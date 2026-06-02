/**
 * Canvas Renderer for Terminal Display
 *
 * High-performance canvas-based renderer that draws the terminal using
 * Ghostty's WASM terminal emulator. Features:
 * - Font metrics measurement with DPI scaling
 * - Full color support (256-color palette + RGB)
 * - All text styles (bold, italic, underline, strikethrough, etc.)
 * - Multiple cursor styles (block, underline, bar)
 * - Dirty line optimization for 60 FPS
 */

import type { ITerminalDecoration, ITheme } from './interfaces';
import { KITTY_PLACEHOLDER, diacriticToInt } from './kitty_diacritics';
import type { SelectionManager } from './selection-manager';
import type { GhosttyCell, ILink, KittyImagePixels, KittyPlacementInfo } from './types';
import { CellFlags, KittyImageFormat } from './types';

// Interface for objects that can be rendered
export interface IRenderable {
  getLine(y: number): GhosttyCell[] | null;
  getViewport?(): GhosttyCell[];
  getCursor(): { x: number; y: number; visible: boolean; style?: 'block' | 'underline' | 'bar' };
  getDimensions(): { cols: number; rows: number };
  isRowDirty(y: number): boolean;
  /** Returns true if a full redraw is needed (e.g., screen change) */
  needsFullRedraw?(): boolean;
  clearDirty(): void;
  /**
   * Get the full grapheme string for a cell at (row, col).
   * For cells with grapheme_len > 0, this returns all codepoints combined.
   * For simple cells, returns the single character.
   */
  getGraphemeString?(row: number, col: number): string;

  // Kitty graphics — optional. When implemented, the renderer composites
  // images onto the canvas after text rendering. GhosttyTerminal provides
  // these; other IRenderable implementations (e.g. test fakes) can omit.
  getKittyGraphics?(): number | null;
  iterPlacements?(graphics: number, onlyVisible?: boolean): Iterable<KittyPlacementInfo>;
  getKittyImagePixels?(graphics: number, imageId: number): KittyImagePixels | null;
  /**
   * Returns the full codepoint sequence for the cell at (row, col) in
   * the active screen — the base codepoint followed by any combining
   * marks. Used to decode unicode-placeholder cells (U+10EEEE plus
   * combining diacritics that encode row/column slice positions).
   */
  getGrapheme?(row: number, col: number): number[] | null;
}

export interface IScrollbackProvider {
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  getScrollbackLength(): number;
}

// ============================================================================
// Type Definitions
// ============================================================================

export const DEFAULT_SCROLLBAR_WIDTH = 8;

export interface RendererOptions {
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  cursorStyle?: 'block' | 'underline' | 'bar'; // Default: 'block'
  cursorBlink?: boolean; // Default: false
  theme?: ITheme;
  devicePixelRatio?: number; // Default: canvas owner window devicePixelRatio
  scrollbarWidth?: number; // 0 = hidden
  allowTransparency?: boolean;
}

export interface FontMetrics {
  width: number; // Character cell width in CSS pixels
  height: number; // Character cell height in CSS pixels
  baseline: number; // Distance from top to text baseline
}

const LINK_HOVER_COLOR = '#4A90E2';

// ============================================================================
// Default Theme
// ============================================================================

export const DEFAULT_THEME: Required<ITheme> = {
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  // Selection colors: solid colors that replace cell bg/fg when selected
  // Using Ghostty's approach: selection bg = default fg, selection fg = default bg
  selectionBackground: '#d4d4d4',
  selectionForeground: '#1e1e1e',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

// ============================================================================
// CanvasRenderer Class
// ============================================================================

/**
 * Staleness check for kittyImageCache: an entry is reusable iff every
 * identity field matches the just-fetched KittyImagePixels. Width/height/
 * format catch geometry/format changes (which can keep dataLen identical —
 * e.g., 100×50 RGBA and 50×100 RGBA both serialize to 20000 bytes), and
 * dataPtr (the WASM byteOffset) catches re-allocations from retransmits.
 */
function cachedMatchesPixels(
  cached: {
    width: number;
    height: number;
    format: KittyImageFormat;
    dataPtr: number;
    dataLen: number;
  },
  pixels: KittyImagePixels
): boolean {
  return (
    cached.width === pixels.width &&
    cached.height === pixels.height &&
    cached.format === pixels.format &&
    cached.dataPtr === pixels.data.byteOffset &&
    cached.dataLen === pixels.data.length
  );
}

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private fontSize: number;
  private fontFamily: string;
  private cursorStyle: 'block' | 'underline' | 'bar';
  private cursorBlink: boolean;
  private theme: Required<ITheme>;
  private allowTransparency: boolean;
  private devicePixelRatio: number;
  private readonly fixedDevicePixelRatio?: number;
  private scrollbarWidth: number;
  private metrics: FontMetrics;
  private fontStrings: { plain: string; bold: string; italic: string; boldItalic: string };

  // Cursor blinking state
  private cursorVisible: boolean = true;
  private cursorBlinkInterval?: number;
  private lastCursorPosition: { x: number; y: number } = { x: 0, y: 0 };

  // Hook called whenever the renderer's own internal state (today: cursor
  // blink toggle) changes such that the next frame would look different.
  // Set by Terminal so it can wake its render scheduler. Without this, an
  // event-driven Terminal that has gone idle would never repaint the
  // blinking cursor.
  private onRequestRender: (() => void) | null = null;

  // Viewport tracking (for scrolling)
  private lastViewportY: number = 0;

  // Current buffer being rendered (for grapheme lookups)
  private currentBuffer: IRenderable | null = null;

  /**
   * Decoded kitty graphics images, keyed by image id. Each entry caches
   * a canvas painted from the WASM-side RGBA bytes so per-frame compositing
   * is just a drawImage call.
   *
   * Staleness key combines width/height/format/dataPtr/dataLen — the
   * kitty protocol allows reusing an id with new bytes, and dataLen alone
   * is too weak (transposed dims or format change can keep byte count
   * identical). dataPtr is the WASM byteOffset, which changes whenever
   * ghostty frees + re-allocates the image bytes (i.e., on retransmit).
   */
  private kittyImageCache = new Map<
    number,
    {
      canvas: HTMLCanvasElement;
      width: number;
      height: number;
      format: KittyImageFormat;
      dataPtr: number;
      dataLen: number;
    }
  >();

  /**
   * Per-frame index of virtual placements keyed by image id. Populated
   * once at the start of each render() pass (cheap — typically zero or
   * a handful of entries). Looked up by U+10EEEE placeholder cells in
   * renderPlaceholderCell to find the placement's grid dimensions.
   */
  private kittyVirtualPlacements = new Map<number, KittyPlacementInfo>();

  /**
   * Direct (non-virtual) placements that need compositing this frame.
   * Built once per render() in precomputeKittyState so renderKittyImages
   * doesn't re-walk the iterator. Empty when no kitty graphics are active.
   */
  private currentDirectPlacements: KittyPlacementInfo[] = [];

  /**
   * Last frame's direct-placement signatures, keyed by image id. Used to
   * detect placement add/remove/move/redecode so we can mark the affected
   * rows for repaint (clearing stale image pixels) and skip the composite
   * pass entirely when nothing has changed. dataLen is the same staleness
   * discriminator used by kittyImageCache.
   */
  private lastKittyDirectSigs = new Map<
    number,
    {
      viewportCol: number;
      viewportRow: number;
      pixelWidth: number;
      pixelHeight: number;
      sourceX: number;
      sourceY: number;
      sourceWidth: number;
      sourceHeight: number;
      imgWidth: number;
      imgHeight: number;
      imgFormat: KittyImageFormat;
      dataPtr: number;
      dataLen: number;
    }
  >();

  /**
   * Rows whose image footprint changed since last frame (placement added,
   * removed, moved, resized, or re-decoded under the same id). Added to
   * rowsToRender so the underlying text repaints — which clears stale
   * image pixels — before we composite the current placements on top.
   */
  private kittyDamagedRows = new Set<number>();

  /**
   * Cached IRenderable on the current render() call so renderCellText
   * can call into it (e.g. getGrapheme) without us threading the buffer
   * through every helper. Set at the top of render(), cleared at the end.
   */
  private currentRenderBuffer: IRenderable | null = null;
  private currentKittyGraphics: number | null = null;

  // Selection manager (for rendering selection)
  private selectionManager?: SelectionManager;
  // Cached selection coordinates for current render pass (viewport-relative)
  private currentSelectionCoords: {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null = null;

  // Link rendering state
  private hoveredHyperlinkId: number = 0;
  private previousHoveredHyperlinkId: number = 0;

  // Regex link hover tracking (for links without hyperlink_id)
  private hoveredLinkRange: { startX: number; startY: number; endX: number; endY: number } | null =
    null;
  private previousHoveredLinkRange: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null = null;

  // General-purpose decorations (absolute buffer coordinates) used by search
  // and other consumers that need xterm-style highlight ranges.
  private decorations: ITerminalDecoration[] = [];
  private previousDecorationRows: Set<number> = new Set();
  private currentDecorationRows: Set<number> = new Set();
  private currentScrollbackLength: number = 0;
  private currentViewportY: number = 0;

  // Preedit overlay canvas (separate layer above main canvas for IME composition)
  private overlayCanvas: HTMLCanvasElement | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: options.allowTransparency ?? false });
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    this.ctx = ctx;

    // Apply options
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.cursorStyle = options.cursorStyle ?? 'block';
    this.cursorBlink = options.cursorBlink ?? false;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.allowTransparency = options.allowTransparency ?? false;
    this.fixedDevicePixelRatio = options.devicePixelRatio;
    this.devicePixelRatio = this.getDevicePixelRatio();
    this.scrollbarWidth = options.scrollbarWidth ?? DEFAULT_SCROLLBAR_WIDTH;

    // Measure font metrics (also builds cached font strings)
    this.fontStrings = this.buildFontStrings();
    this.metrics = this.measureFont();

    // Setup cursor blinking if enabled
    if (this.cursorBlink) {
      this.startCursorBlink();
    }
  }

  // ==========================================================================
  // Font Metrics Measurement
  // ==========================================================================

  private buildFontStrings(): { plain: string; bold: string; italic: string; boldItalic: string } {
    // Quote font family names that contain spaces but aren't already quoted
    const quotedFamily = this.fontFamily
      .split(',')
      .map((f) => {
        const trimmed = f.trim();
        if (trimmed.startsWith('"') || trimmed.startsWith("'") || !trimmed.includes(' ')) {
          return trimmed;
        }
        return `"${trimmed}"`;
      })
      .join(', ');
    const base = `${this.fontSize}px ${quotedFamily}`;
    return {
      plain: base,
      bold: `bold ${base}`,
      italic: `italic ${base}`,
      boldItalic: `bold italic ${base}`,
    };
  }

  private getFontString(bold: boolean, italic: boolean): string {
    if (bold && italic) return this.fontStrings.boldItalic;
    if (bold) return this.fontStrings.bold;
    if (italic) return this.fontStrings.italic;
    return this.fontStrings.plain;
  }

  private getDevicePixelRatio(): number {
    return (
      this.fixedDevicePixelRatio ?? this.canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1
    );
  }

  private measureFont(): FontMetrics {
    // Use an offscreen canvas for measurement
    const canvas = this.canvas.ownerDocument.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    // Set font (use actual pixel size for accurate measurement)
    ctx.font = this.fontStrings.plain;

    // Measure width using 'M' (typically widest character)
    const widthMetrics = ctx.measureText('M');
    const width = Math.ceil(widthMetrics.width);

    // Use font-level metrics (fontBoundingBox) rather than glyph-specific metrics (actualBoundingBox).
    // This ensures the cell height accommodates ALL glyphs in the font, including powerline
    // characters (U+E0B0, U+E0B6, etc.) which are designed to fill the full cell height.
    // Fall back to actual metrics if font metrics aren't available.
    const ascent =
      widthMetrics.fontBoundingBoxAscent ??
      widthMetrics.actualBoundingBoxAscent ??
      this.fontSize * 0.8;
    const descent =
      widthMetrics.fontBoundingBoxDescent ??
      widthMetrics.actualBoundingBoxDescent ??
      this.fontSize * 0.2;

    const height = Math.ceil(ascent + descent);
    const baseline = Math.ceil(ascent);

    return { width, height, baseline };
  }

  /**
   * Remeasure font metrics (call after font loads or changes)
   */
  public remeasureFont(): void {
    this.metrics = this.measureFont();
  }

  // ==========================================================================
  // Color Conversion
  // ==========================================================================

  private rgbToCSS(r: number, g: number, b: number): string {
    return `rgb(${r}, ${g}, ${b})`;
  }

  // ==========================================================================
  // Canvas Sizing
  // ==========================================================================

  /**
   * Resize canvas to fit terminal dimensions
   */
  public resize(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
    cols = Math.floor(cols);
    rows = Math.floor(rows);

    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;

    // Set CSS size (what user sees)
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    // Set actual canvas size (scaled for DPI)
    this.canvas.width = cssWidth * this.devicePixelRatio;
    this.canvas.height = cssHeight * this.devicePixelRatio;

    // Scale context to match DPI (setting canvas.width/height resets the context)
    this.ctx.scale(this.devicePixelRatio, this.devicePixelRatio);

    // Set text rendering properties for crisp text
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';

    // Fill background after resize unless the host wants the terminal to stay transparent.
    if (!this.allowTransparency) {
      this.ctx.fillStyle = this.theme.background;
      this.ctx.fillRect(0, 0, cssWidth, cssHeight);
    }

    // Keep overlay canvas in sync with main canvas dimensions
    this.resizeOverlay();
  }

  // ==========================================================================
  // Main Rendering
  // ==========================================================================

  /**
   * Render the terminal buffer to canvas
   */
  public render(
    buffer: IRenderable,
    forceAll: boolean = false,
    viewportY: number = 0,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity: number = 1
  ): void {
    // Store buffer reference for grapheme lookups in renderCell
    this.currentBuffer = buffer;
    this.currentRenderBuffer = buffer;

    // getCursor() calls update() internally to ensure fresh state.
    // Multiple update() calls are safe - dirty state persists until clearDirty().
    const cursor = buffer.getCursor();
    const dims = buffer.getDimensions();

    // Pre-frame: build the virtual-placement index so unicode-placeholder
    // cells can look up their target image's grid layout in O(1) during
    // the per-cell text pass. Also collects direct placements + computes
    // kittyDamagedRows (rows where a placement was added/removed/moved/
    // re-decoded, so the text underneath needs repainting to clear stale
    // image pixels).
    this.precomputeKittyState(buffer, dims.rows, Math.floor(viewportY));
    const scrollbackLength = scrollbackProvider ? scrollbackProvider.getScrollbackLength() : 0;

    // Check if buffer needs full redraw (e.g., screen change between normal/alternate)
    if (buffer.needsFullRedraw?.()) {
      forceAll = true;
    }

    const currentDevicePixelRatio = this.getDevicePixelRatio();
    if (currentDevicePixelRatio !== this.devicePixelRatio) {
      this.devicePixelRatio = currentDevicePixelRatio;
      forceAll = true;
    }

    // Resize canvas if dimensions changed
    const needsResize =
      this.canvas.width !== dims.cols * this.metrics.width * this.devicePixelRatio ||
      this.canvas.height !== dims.rows * this.metrics.height * this.devicePixelRatio;

    if (needsResize) {
      this.resize(dims.cols, dims.rows);
      forceAll = true; // Force full render after resize
    }

    // Force re-render when viewport changes (scrolling)
    if (viewportY !== this.lastViewportY) {
      forceAll = true;
      this.lastViewportY = viewportY;
    }

    // Check if cursor position changed or if blinking (need to redraw cursor line)
    const cursorMoved =
      cursor.x !== this.lastCursorPosition.x || cursor.y !== this.lastCursorPosition.y;
    if (cursorMoved || this.cursorBlink) {
      // Mark cursor lines as needing redraw
      if (!forceAll && !buffer.isRowDirty(cursor.y)) {
        // Need to redraw cursor line
        const line = buffer.getLine(cursor.y);
        if (line) {
          this.renderLine(line, cursor.y, dims.cols);
        }
      }
      if (cursorMoved && this.lastCursorPosition.y !== cursor.y) {
        // Also redraw old cursor line if cursor moved to different line
        if (!forceAll && !buffer.isRowDirty(this.lastCursorPosition.y)) {
          const line = buffer.getLine(this.lastCursorPosition.y);
          if (line) {
            this.renderLine(line, this.lastCursorPosition.y, dims.cols);
          }
        }
      }
    }

    // Check if we need to redraw selection-related lines
    const hasSelection = this.selectionManager && this.selectionManager.hasSelection();
    const selectionRows = new Set<number>();

    // Cache selection coordinates for use during cell rendering
    // This is used by isInSelection() to determine if a cell needs selection colors
    this.currentSelectionCoords = hasSelection ? this.selectionManager!.getSelectionCoords() : null;

    // Mark current selection rows for redraw (includes programmatic selections)
    if (this.currentSelectionCoords) {
      const coords = this.currentSelectionCoords;
      for (let row = coords.startRow; row <= coords.endRow; row++) {
        selectionRows.add(row);
      }
    }

    // Always mark dirty selection rows for redraw (to clear old overlay)
    if (this.selectionManager) {
      const dirtyRows = this.selectionManager.getDirtySelectionRows();
      if (dirtyRows.size > 0) {
        for (const row of dirtyRows) {
          selectionRows.add(row);
        }
        // Clear the dirty rows tracking after marking for redraw
        this.selectionManager.clearDirtySelectionRows();
      }
    }

    // Track rows with hyperlinks that need redraw when hover changes
    const hyperlinkRows = new Set<number>();
    const hyperlinkChanged = this.hoveredHyperlinkId !== this.previousHoveredHyperlinkId;
    const a = this.hoveredLinkRange,
      b = this.previousHoveredLinkRange;
    const linkRangeChanged =
      a !== b &&
      (!a ||
        !b ||
        a.startX !== b.startX ||
        a.startY !== b.startY ||
        a.endX !== b.endX ||
        a.endY !== b.endY);

    if (hyperlinkChanged) {
      // Find rows containing the old or new hovered hyperlink
      // Must check the correct buffer based on viewportY (scrollback vs screen)
      for (let y = 0; y < dims.rows; y++) {
        let line: GhosttyCell[] | null = null;

        // Same logic as rendering: fetch from scrollback or screen
        if (viewportY > 0) {
          if (y < viewportY && scrollbackProvider) {
            // This row is from scrollback
            // Floor viewportY for array access (handles fractional values during smooth scroll)
            const scrollbackOffset = scrollbackLength - Math.floor(viewportY) + y;
            line = scrollbackProvider.getScrollbackLine(scrollbackOffset);
          } else {
            // This row is from visible screen
            const screenRow = y - Math.floor(viewportY);
            line = buffer.getLine(screenRow);
          }
        } else {
          // At bottom - fetch from visible screen
          line = buffer.getLine(y);
        }

        if (line) {
          for (const cell of line) {
            if (
              cell.hyperlink_id === this.hoveredHyperlinkId ||
              cell.hyperlink_id === this.previousHoveredHyperlinkId
            ) {
              hyperlinkRows.add(y);
              break; // Found hyperlink in this row
            }
          }
        }
      }
      // Update previous state
      this.previousHoveredHyperlinkId = this.hoveredHyperlinkId;
    }

    // Track rows affected by link range changes (for regex URLs)
    if (linkRangeChanged) {
      // Add rows from old range
      if (this.previousHoveredLinkRange) {
        for (
          let y = this.previousHoveredLinkRange.startY;
          y <= this.previousHoveredLinkRange.endY;
          y++
        ) {
          hyperlinkRows.add(y);
        }
      }
      // Add rows from new range
      if (this.hoveredLinkRange) {
        for (let y = this.hoveredLinkRange.startY; y <= this.hoveredLinkRange.endY; y++) {
          hyperlinkRows.add(y);
        }
      }
      this.previousHoveredLinkRange = this.hoveredLinkRange;
    }

    // Track decoration rows. Decorations are stored in absolute buffer
    // coordinates (0 = oldest scrollback line); convert them to viewport rows
    // for the current scroll position, and also repaint previous decoration
    // rows so clearing/changing decorations removes stale highlights.
    this.currentScrollbackLength = scrollbackLength;
    this.currentViewportY = Math.floor(viewportY);
    const decorationRows = new Set<number>(this.previousDecorationRows);
    this.currentDecorationRows = new Set();
    for (const d of this.decorations) {
      if (d.length <= 0) continue;
      const row = d.line - scrollbackLength + this.currentViewportY;
      if (row < 0 || row >= dims.rows) continue;
      decorationRows.add(row);
      this.currentDecorationRows.add(row);
    }
    this.previousDecorationRows = new Set(this.currentDecorationRows);

    // Track if anything was actually rendered
    let anyLinesRendered = false;

    // Determine which rows need rendering.
    // We also include adjacent rows (above and below) for each dirty row to handle
    // glyph overflow - tall glyphs like Devanagari vowel signs can extend into
    // adjacent rows' visual space.
    const rowsToRender = new Set<number>();
    for (let y = 0; y < dims.rows; y++) {
      // When scrolled, always force render all lines since we're showing scrollback
      const needsRender =
        viewportY > 0
          ? true
          : forceAll ||
            buffer.isRowDirty(y) ||
            selectionRows.has(y) ||
            hyperlinkRows.has(y) ||
            decorationRows.has(y) ||
            this.kittyDamagedRows.has(y);

      if (needsRender) {
        rowsToRender.add(y);
        // Include adjacent rows to handle glyph overflow
        if (y > 0) rowsToRender.add(y - 1);
        if (y < dims.rows - 1) rowsToRender.add(y + 1);
      }
    }

    // Render each line
    for (let y = 0; y < dims.rows; y++) {
      if (!rowsToRender.has(y)) {
        continue;
      }

      anyLinesRendered = true;

      // Fetch line from scrollback or visible screen
      let line: GhosttyCell[] | null = null;
      if (viewportY > 0) {
        // Scrolled up - need to fetch from scrollback + visible screen
        // When scrolled up N lines, we want to show:
        // - Scrollback lines (from the end) + visible screen lines

        // Check if this row should come from scrollback or visible screen
        if (y < viewportY && scrollbackProvider) {
          // This row is from scrollback (upper part of viewport)
          // Get from end of scrollback buffer
          // Floor viewportY for array access (handles fractional values during smooth scroll)
          const scrollbackOffset = scrollbackLength - Math.floor(viewportY) + y;
          line = scrollbackProvider.getScrollbackLine(scrollbackOffset);
        } else {
          // This row is from visible screen (lower part of viewport)
          const screenRow = viewportY > 0 ? y - Math.floor(viewportY) : y;
          line = buffer.getLine(screenRow);
        }
      } else {
        // At bottom - fetch from visible screen
        line = buffer.getLine(y);
      }

      if (line) {
        this.renderLine(line, y, dims.cols);
      }
    }

    // Selection highlighting is now integrated into renderCellBackground/renderCellText
    // No separate overlay pass needed - this fixes z-order issues with complex glyphs

    // Link underlines are drawn during cell rendering (see renderCell)

    // Composite kitty graphics images on top of the text. MVP z-order is
    // "above text" — programs sending images typically clear the cell area
    // first, so there's nothing meaningful underneath. A future commit can
    // split into below/above-text passes via PlacementLayer if real apps
    // need it.
    //
    // Skip when no rows were repainted: the previous frame's image pixels
    // are still on the canvas and unchanged, and re-issuing drawImage with
    // source-over compositing onto translucent images would accumulate
    // alpha. Placement adds/removes/moves seed kittyDamagedRows in
    // precomputeKittyState, which forces those rows into rowsToRender and
    // flips anyLinesRendered to true.
    if (this.currentDirectPlacements.length > 0 && anyLinesRendered) {
      this.renderKittyImages();
    }

    // Render cursor (only if we're at the bottom, not scrolled)
    if (viewportY === 0 && cursor.visible && this.cursorVisible) {
      // Use cursor style from buffer if provided, otherwise use renderer default
      const cursorStyle = cursor.style ?? this.cursorStyle;
      this.renderCursor(cursor.x, cursor.y, cursorStyle);
    }

    // Render scrollbar if scrolled or scrollback exists (with opacity for fade effect)
    if (scrollbackProvider && scrollbarOpacity > 0 && this.scrollbarWidth > 0) {
      this.renderScrollbar(viewportY, scrollbackLength, dims.rows, scrollbarOpacity);
    }

    // Update last cursor position
    this.lastCursorPosition = { x: cursor.x, y: cursor.y };

    // ALWAYS clear dirty flags after rendering, regardless of forceAll.
    // This is critical - if we don't clear after a full redraw, the dirty
    // state persists and the next frame might not detect new changes properly.
    buffer.clearDirty();
  }

  /**
   * Render a single line using two-pass approach:
   * 1. First pass: Draw all cell backgrounds
   * 2. Second pass: Draw all cell text and decorations
   *
   * This two-pass approach is necessary for proper rendering of complex scripts
   * like Devanagari where diacritics (like vowel sign ि) can extend LEFT of the
   * base character into the previous cell's visual area. If we draw backgrounds
   * and text in a single pass (cell by cell), the background of cell N would
   * cover any left-extending portions of graphemes from cell N-1.
   */
  private renderLine(line: GhosttyCell[], y: number, cols: number): void {
    const lineY = y * this.metrics.height;
    const lineWidth = cols * this.metrics.width;

    // Clear line background then fill with theme color.
    // We clear just the cell area - glyph overflow is handled by also
    // redrawing adjacent rows (see render() method).
    // clearRect is needed because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, lineY, lineWidth, this.metrics.height);
    if (!this.allowTransparency) {
      this.ctx.fillStyle = this.theme.background;
      this.ctx.fillRect(0, lineY, lineWidth, this.metrics.height);
    }

    // PASS 1: Draw all cell backgrounds first
    // This ensures all backgrounds are painted before any text, allowing text
    // to "bleed" across cell boundaries without being covered by adjacent backgrounds
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellBackground(cell, x, y);
    }

    // PASS 2: Draw all cell text and decorations
    // Now text can safely extend beyond cell boundaries (for complex scripts)
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellText(cell, x, y);
    }
  }

  /**
   * Render a cell's background only (Pass 1 of two-pass rendering)
   * Selection highlighting is integrated here to avoid z-order issues with
   * complex glyphs (like Devanagari) that extend outside their cell bounds.
   */
  private renderCellBackground(cell: GhosttyCell, x: number, y: number): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    if (isSelected) {
      // Draw selection background (solid color, not overlay)
      this.ctx.fillStyle = this.theme.selectionBackground;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
      return; // Selection background replaces cell background
    }

    const decoration = this.getDecorationAt(x, y);

    // Extract background color and handle inverse
    let bg_r = cell.bg_r,
      bg_g = cell.bg_g,
      bg_b = cell.bg_b;

    if (cell.flags & CellFlags.INVERSE) {
      // When inverted, background becomes foreground
      bg_r = cell.fg_r;
      bg_g = cell.fg_g;
      bg_b = cell.fg_b;
    }

    // Cells with the default bg let the line-level theme.background fill
    // (drawn earlier in renderLine) show through. Cells with an explicit
    // bg — including literal RGB(0,0,0) — get painted here. The cell's
    // bgIsDefault flag carries the GhosttyStyleColor tag from upstream;
    // we cannot infer it from the RGB triple because (0,0,0) is a valid
    // explicit color (programs emit it for "true black" backgrounds, e.g.
    // letterboxed image renderings).
    const useThemeBg = cell.flags & CellFlags.INVERSE ? cell.fgIsDefault : cell.bgIsDefault;
    if (!useThemeBg) {
      this.ctx.fillStyle = this.rgbToCSS(bg_r, bg_g, bg_b);
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
    }

    if (decoration?.background) {
      this.ctx.fillStyle = decoration.background;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
    }
  }

  private getDecorationAt(x: number, viewportRow: number): ITerminalDecoration | null {
    if (this.decorations.length === 0) return null;
    const absoluteLine =
      viewportRow + this.currentScrollbackLength - Math.floor(this.currentViewportY);
    for (let i = this.decorations.length - 1; i >= 0; i--) {
      const d = this.decorations[i];
      if (d.line !== absoluteLine) continue;
      if (x >= d.column && x < d.column + d.length) return d;
    }
    return null;
  }

  private drawHorizontalLine(x: number, y: number, width: number, color: string): void {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(x, y);
    this.ctx.lineTo(x + width, y);
    this.ctx.stroke();
  }

  /**
   * Render a cell's text and decorations (Pass 2 of two-pass rendering)
   * Selection foreground color is applied here to match the selection background.
   */
  private renderCellText(cell: GhosttyCell, x: number, y: number, colorOverride?: string): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Kitty unicode placeholder: cells with codepoint U+10EEEE represent
    // a slice of a virtually-placed image. Substitute the slice draw for
    // text rendering. If it's not a valid placeholder (e.g., the image
    // hasn't been transmitted yet), fall through and render as text —
    // typically the system "missing glyph" box, which is the expected
    // behavior for a stray U+10EEEE.
    if (cell.codepoint === KITTY_PLACEHOLDER) {
      if (this.renderPlaceholderCell(cell, x, y)) return;
    }

    // Skip rendering if invisible
    if (cell.flags & CellFlags.INVISIBLE) {
      return;
    }

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    this.ctx.font = this.getFontString(
      !!(cell.flags & CellFlags.BOLD),
      !!(cell.flags & CellFlags.ITALIC)
    );

    // Set text color - use override if provided, otherwise selection or cell color
    let fillColor: string;
    if (colorOverride) {
      fillColor = colorOverride;
    } else if (isSelected) {
      fillColor = this.theme.selectionForeground;
    } else {
      const decoration = this.getDecorationAt(x, y);
      if (decoration?.foreground) {
        fillColor = decoration.foreground;
      } else {
        // Extract colors and handle inverse. Mirrors the background path
        // above: cells with no explicit color come back as (0,0,0) — treat
        // that as a sentinel for "use theme default" rather than rendering
        // literal black. Without this, default-fg text on a dark theme is
        // invisible.
        let fg_r = cell.fg_r,
          fg_g = cell.fg_g,
          fg_b = cell.fg_b;
        if (cell.flags & CellFlags.INVERSE) {
          // When inverted, foreground becomes background.
          fg_r = cell.bg_r;
          fg_g = cell.bg_g;
          fg_b = cell.bg_b;
        }

        // Same reasoning as the bg path: only fall back to theme.foreground
        // when the cell has the default fg (tag NONE), not when its explicit
        // RGB happens to be (0,0,0).
        const useThemeFg = cell.flags & CellFlags.INVERSE ? cell.bgIsDefault : cell.fgIsDefault;
        fillColor = useThemeFg ? this.theme.foreground : this.rgbToCSS(fg_r, fg_g, fg_b);
      }
    }
    this.ctx.fillStyle = fillColor;

    // Apply faint effect
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 0.5;
    }

    // Draw text
    const textX = cellX;
    const textY = cellY + this.metrics.baseline;

    const codepoint = cell.codepoint || 32;

    // Handle special characters that need pixel-perfect rendering:
    // - Box drawing characters (U+2500-U+257F): geometric lines for connected TUI borders
    // - Block drawing characters (U+2580-U+259F): rectangles for gap-free ASCII art
    // - Powerline glyphs (U+E0B0-U+E0BF): vector shapes to match exact cell height
    if (this.renderBlockChar(codepoint, cellX, cellY, cellWidth)) {
      // rendered as rectangle
    } else if (codepoint >= 0x2500 && codepoint <= 0x257f) {
      this.renderBoxDrawing(codepoint, cellX, cellY, cellWidth, this.metrics.height);
    } else if (this.renderPowerlineGlyph(codepoint, cellX, cellY, cellWidth)) {
      // rendered as vector path
    } else {
      // Use grapheme lookup for complex scripts, single codepoint otherwise
      const char =
        cell.grapheme_len > 0 && this.currentBuffer?.getGraphemeString
          ? this.currentBuffer.getGraphemeString(y, x)
          : String.fromCodePoint(codepoint);
      this.ctx.fillText(char, textX, textY);
    }

    // Reset alpha
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 1.0;
    }

    const underlineY = cellY + this.metrics.baseline + 2;

    if (cell.flags & CellFlags.UNDERLINE) {
      this.drawHorizontalLine(cellX, underlineY, cellWidth, fillColor);
    }
    if (cell.flags & CellFlags.STRIKETHROUGH) {
      this.drawHorizontalLine(cellX, cellY + this.metrics.height / 2, cellWidth, fillColor);
    }
    if (cell.hyperlink_id > 0 && cell.hyperlink_id === this.hoveredHyperlinkId) {
      this.drawHorizontalLine(cellX, underlineY, cellWidth, LINK_HOVER_COLOR);
    }
    if (this.hoveredLinkRange) {
      const range = this.hoveredLinkRange;
      const isInRange =
        (y === range.startY && x >= range.startX && (y < range.endY || x <= range.endX)) ||
        (y > range.startY && y < range.endY) ||
        (y === range.endY && x <= range.endX && (y > range.startY || x >= range.startX));
      if (isInRange) {
        this.drawHorizontalLine(cellX, underlineY, cellWidth, LINK_HOVER_COLOR);
      }
    }
  }

  /**
   * Render block drawing characters as filled rectangles for pixel-perfect rendering.
   * Returns true if the character was handled, false if it should be rendered as text.
   */
  private renderBlockChar(
    codepoint: number,
    cellX: number,
    cellY: number,
    cellWidth: number
  ): boolean {
    const height = this.metrics.height;

    // Block Elements (U+2580-U+259F)
    switch (codepoint) {
      case 0x2580: // ▀ UPPER HALF BLOCK
        this.ctx.fillRect(cellX, cellY, cellWidth, height / 2);
        return true;
      case 0x2581: // ▁ LOWER ONE EIGHTH BLOCK
        this.ctx.fillRect(cellX, cellY + (height * 7) / 8, cellWidth, height / 8);
        return true;
      case 0x2582: // ▂ LOWER ONE QUARTER BLOCK
        this.ctx.fillRect(cellX, cellY + (height * 3) / 4, cellWidth, height / 4);
        return true;
      case 0x2583: // ▃ LOWER THREE EIGHTHS BLOCK
        this.ctx.fillRect(cellX, cellY + (height * 5) / 8, cellWidth, (height * 3) / 8);
        return true;
      case 0x2584: // ▄ LOWER HALF BLOCK
        this.ctx.fillRect(cellX, cellY + height / 2, cellWidth, height / 2);
        return true;
      case 0x2585: // ▅ LOWER FIVE EIGHTHS BLOCK
        this.ctx.fillRect(cellX, cellY + (height * 3) / 8, cellWidth, (height * 5) / 8);
        return true;
      case 0x2586: // ▆ LOWER THREE QUARTERS BLOCK
        this.ctx.fillRect(cellX, cellY + height / 4, cellWidth, (height * 3) / 4);
        return true;
      case 0x2587: // ▇ LOWER SEVEN EIGHTHS BLOCK
        this.ctx.fillRect(cellX, cellY + height / 8, cellWidth, (height * 7) / 8);
        return true;
      case 0x2588: // █ FULL BLOCK
        this.ctx.fillRect(cellX, cellY, cellWidth, height);
        return true;
      case 0x2589: // ▉ LEFT SEVEN EIGHTHS BLOCK
        this.ctx.fillRect(cellX, cellY, (cellWidth * 7) / 8, height);
        return true;
      case 0x258a: // ▊ LEFT THREE QUARTERS BLOCK
        this.ctx.fillRect(cellX, cellY, (cellWidth * 3) / 4, height);
        return true;
      case 0x258b: // ▋ LEFT FIVE EIGHTHS BLOCK
        this.ctx.fillRect(cellX, cellY, (cellWidth * 5) / 8, height);
        return true;
      case 0x258c: // ▌ LEFT HALF BLOCK
        this.ctx.fillRect(cellX, cellY, cellWidth / 2, height);
        return true;
      case 0x258d: // ▍ LEFT THREE EIGHTHS BLOCK
        this.ctx.fillRect(cellX, cellY, (cellWidth * 3) / 8, height);
        return true;
      case 0x258e: // ▎ LEFT ONE QUARTER BLOCK
        this.ctx.fillRect(cellX, cellY, cellWidth / 4, height);
        return true;
      case 0x258f: // ▏ LEFT ONE EIGHTH BLOCK
        this.ctx.fillRect(cellX, cellY, cellWidth / 8, height);
        return true;
      case 0x2590: // ▐ RIGHT HALF BLOCK
        this.ctx.fillRect(cellX + cellWidth / 2, cellY, cellWidth / 2, height);
        return true;
      case 0x2591: {
        // ░ LIGHT SHADE
        const prev = this.ctx.globalAlpha;
        this.ctx.globalAlpha = prev * 0.25;
        this.ctx.fillRect(cellX, cellY, cellWidth, height);
        this.ctx.globalAlpha = prev;
        return true;
      }
      case 0x2592: {
        // ▒ MEDIUM SHADE
        const prev = this.ctx.globalAlpha;
        this.ctx.globalAlpha = prev * 0.5;
        this.ctx.fillRect(cellX, cellY, cellWidth, height);
        this.ctx.globalAlpha = prev;
        return true;
      }
      case 0x2593: {
        // ▓ DARK SHADE
        const prev = this.ctx.globalAlpha;
        this.ctx.globalAlpha = prev * 0.75;
        this.ctx.fillRect(cellX, cellY, cellWidth, height);
        this.ctx.globalAlpha = prev;
        return true;
      }
      case 0x2594: // ▔ UPPER ONE EIGHTH BLOCK
        this.ctx.fillRect(cellX, cellY, cellWidth, height / 8);
        return true;
      case 0x2595: // ▕ RIGHT ONE EIGHTH BLOCK
        this.ctx.fillRect(cellX + (cellWidth * 7) / 8, cellY, cellWidth / 8, height);
        return true;
      case 0x2596: // ▖ QUADRANT LOWER LEFT
        this.ctx.fillRect(cellX, cellY + height / 2, cellWidth / 2, height / 2);
        return true;
      case 0x2597: // ▗ QUADRANT LOWER RIGHT
        this.ctx.fillRect(cellX + cellWidth / 2, cellY + height / 2, cellWidth / 2, height / 2);
        return true;
      case 0x2598: // ▘ QUADRANT UPPER LEFT
        this.ctx.fillRect(cellX, cellY, cellWidth / 2, height / 2);
        return true;
      case 0x2599: // ▙ QUADRANT UPPER LEFT AND LOWER LEFT AND LOWER RIGHT
        this.ctx.fillRect(cellX, cellY, cellWidth / 2, height);
        this.ctx.fillRect(cellX + cellWidth / 2, cellY + height / 2, cellWidth / 2, height / 2);
        return true;
      case 0x259a: // ▚ QUADRANT UPPER LEFT AND LOWER RIGHT
        this.ctx.fillRect(cellX, cellY, cellWidth / 2, height / 2);
        this.ctx.fillRect(cellX + cellWidth / 2, cellY + height / 2, cellWidth / 2, height / 2);
        return true;
      case 0x259b: // ▛ QUADRANT UPPER LEFT AND UPPER RIGHT AND LOWER LEFT
        this.ctx.fillRect(cellX, cellY, cellWidth, height / 2);
        this.ctx.fillRect(cellX, cellY + height / 2, cellWidth / 2, height / 2);
        return true;
      case 0x259c: // ▜ QUADRANT UPPER LEFT AND UPPER RIGHT AND LOWER RIGHT
        this.ctx.fillRect(cellX, cellY, cellWidth, height / 2);
        this.ctx.fillRect(cellX + cellWidth / 2, cellY + height / 2, cellWidth / 2, height / 2);
        return true;
      case 0x259d: // ▝ QUADRANT UPPER RIGHT
        this.ctx.fillRect(cellX + cellWidth / 2, cellY, cellWidth / 2, height / 2);
        return true;
      case 0x259e: // ▞ QUADRANT UPPER RIGHT AND LOWER LEFT
        this.ctx.fillRect(cellX + cellWidth / 2, cellY, cellWidth / 2, height / 2);
        this.ctx.fillRect(cellX, cellY + height / 2, cellWidth / 2, height / 2);
        return true;
      case 0x259f: // ▟ QUADRANT UPPER RIGHT AND LOWER LEFT AND LOWER RIGHT
        this.ctx.fillRect(cellX + cellWidth / 2, cellY, cellWidth / 2, height / 2);
        this.ctx.fillRect(cellX, cellY + height / 2, cellWidth, height / 2);
        return true;
      default:
        return false;
    }
  }

  // Stroke the current path using the current fillStyle (for soft/outline powerline dividers)
  private strokeWithFillColor(): void {
    this.ctx.strokeStyle = this.ctx.fillStyle;
    this.ctx.lineWidth = 1;
    this.ctx.stroke();
  }

  /**
   * Render Unicode box-drawing character (U+2500-U+257F) as geometric lines.
   * Font glyphs for these often don't connect between adjacent cells.
   */
  private renderBoxDrawing(cp: number, x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    const mx = Math.round(x + w / 2);
    const my = Math.round(y + h / 2);
    const thin = 1;
    const thick = 3;

    // Try double-line rendering first (U+2550-U+256C)
    if (cp >= 0x2550 && cp <= 0x256c) {
      if (this.renderDoubleBoxDrawing(cp, x, y, w, h)) return;
    }

    // Single-line segments
    const segments = this.getBoxDrawingSegments(cp);
    if (!segments) {
      ctx.fillText(String.fromCodePoint(cp), x, y + this.metrics.baseline);
      return;
    }

    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const x1 = Math.round(x + w);
    const y1 = Math.round(y + h);

    // Check for straight-through lines to avoid center overlap dots
    const dirs = new Set(segments.map((s) => s.dir));
    const hasLeft = dirs.has('left'),
      hasRight = dirs.has('right');
    const hasUp = dirs.has('up'),
      hasDown = dirs.has('down');
    const maxWeight = segments.some((s) => s.weight === 'heavy') ? thick : thin;

    // Draw horizontal span as single rect if both left+right present
    if (hasLeft && hasRight) {
      const lw = maxWeight;
      const half = Math.floor(lw / 2);
      ctx.fillRect(x0, my - half, x1 - x0, lw);
    } else {
      for (const seg of segments) {
        if (seg.dir !== 'left' && seg.dir !== 'right') continue;
        const lw = seg.weight === 'heavy' ? thick : thin;
        const half = Math.floor(lw / 2);
        if (seg.dir === 'right') ctx.fillRect(mx, my - half, x1 - mx, lw);
        else ctx.fillRect(x0, my - half, mx - x0, lw);
      }
    }

    // Draw vertical span as single rect if both up+down present
    if (hasUp && hasDown) {
      const lw = maxWeight;
      const half = Math.floor(lw / 2);
      ctx.fillRect(mx - half, y0, lw, y1 - y0);
    } else {
      for (const seg of segments) {
        if (seg.dir !== 'up' && seg.dir !== 'down') continue;
        const lw = seg.weight === 'heavy' ? thick : thin;
        const half = Math.floor(lw / 2);
        if (seg.dir === 'down') ctx.fillRect(mx - half, my, lw, y1 - my);
        else ctx.fillRect(mx - half, y0, lw, my - y0);
      }
    }
  }

  private getBoxDrawingSegments(
    cp: number
  ): { dir: 'up' | 'down' | 'left' | 'right'; weight: 'light' | 'heavy' }[] | null {
    switch (cp) {
      case 0x2500:
        return [
          { dir: 'left', weight: 'light' },
          { dir: 'right', weight: 'light' },
        ]; // ─
      case 0x2501:
        return [
          { dir: 'left', weight: 'heavy' },
          { dir: 'right', weight: 'heavy' },
        ]; // ━
      case 0x2502:
        return [
          { dir: 'up', weight: 'light' },
          { dir: 'down', weight: 'light' },
        ]; // │
      case 0x2503:
        return [
          { dir: 'up', weight: 'heavy' },
          { dir: 'down', weight: 'heavy' },
        ]; // ┃
      case 0x250c:
        return [
          { dir: 'right', weight: 'light' },
          { dir: 'down', weight: 'light' },
        ]; // ┌
      case 0x250d:
        return [
          { dir: 'right', weight: 'heavy' },
          { dir: 'down', weight: 'light' },
        ]; // ┍
      case 0x250e:
        return [
          { dir: 'right', weight: 'light' },
          { dir: 'down', weight: 'heavy' },
        ]; // ┎
      case 0x250f:
        return [
          { dir: 'right', weight: 'heavy' },
          { dir: 'down', weight: 'heavy' },
        ]; // ┏
      case 0x2510:
        return [
          { dir: 'left', weight: 'light' },
          { dir: 'down', weight: 'light' },
        ]; // ┐
      case 0x2511:
        return [
          { dir: 'left', weight: 'heavy' },
          { dir: 'down', weight: 'light' },
        ]; // ┑
      case 0x2512:
        return [
          { dir: 'left', weight: 'light' },
          { dir: 'down', weight: 'heavy' },
        ]; // ┒
      case 0x2513:
        return [
          { dir: 'left', weight: 'heavy' },
          { dir: 'down', weight: 'heavy' },
        ]; // ┓
      case 0x2514:
        return [
          { dir: 'right', weight: 'light' },
          { dir: 'up', weight: 'light' },
        ]; // └
      case 0x2515:
        return [
          { dir: 'right', weight: 'heavy' },
          { dir: 'up', weight: 'light' },
        ]; // ┕
      case 0x2516:
        return [
          { dir: 'right', weight: 'light' },
          { dir: 'up', weight: 'heavy' },
        ]; // ┖
      case 0x2517:
        return [
          { dir: 'right', weight: 'heavy' },
          { dir: 'up', weight: 'heavy' },
        ]; // ┗
      case 0x2518:
        return [
          { dir: 'left', weight: 'light' },
          { dir: 'up', weight: 'light' },
        ]; // ┘
      case 0x2519:
        return [
          { dir: 'left', weight: 'heavy' },
          { dir: 'up', weight: 'light' },
        ]; // ┙
      case 0x251a:
        return [
          { dir: 'left', weight: 'light' },
          { dir: 'up', weight: 'heavy' },
        ]; // ┚
      case 0x251b:
        return [
          { dir: 'left', weight: 'heavy' },
          { dir: 'up', weight: 'heavy' },
        ]; // ┛
      case 0x251c:
        return [
          { dir: 'up', weight: 'light' },
          { dir: 'down', weight: 'light' },
          { dir: 'right', weight: 'light' },
        ]; // ├
      case 0x2524:
        return [
          { dir: 'up', weight: 'light' },
          { dir: 'down', weight: 'light' },
          { dir: 'left', weight: 'light' },
        ]; // ┤
      case 0x252c:
        return [
          { dir: 'left', weight: 'light' },
          { dir: 'right', weight: 'light' },
          { dir: 'down', weight: 'light' },
        ]; // ┬
      case 0x2534:
        return [
          { dir: 'left', weight: 'light' },
          { dir: 'right', weight: 'light' },
          { dir: 'up', weight: 'light' },
        ]; // ┴
      case 0x253c:
        return [
          { dir: 'up', weight: 'light' },
          { dir: 'down', weight: 'light' },
          { dir: 'left', weight: 'light' },
          { dir: 'right', weight: 'light' },
        ]; // ┼
      case 0x2504:
        return [
          { dir: 'left', weight: 'light' },
          { dir: 'right', weight: 'light' },
        ]; // ┄ (dashed, render as solid)
      case 0x2505:
        return [
          { dir: 'left', weight: 'heavy' },
          { dir: 'right', weight: 'heavy' },
        ]; // ┅
      case 0x2506:
        return [
          { dir: 'up', weight: 'light' },
          { dir: 'down', weight: 'light' },
        ]; // ┆
      case 0x2507:
        return [
          { dir: 'up', weight: 'heavy' },
          { dir: 'down', weight: 'heavy' },
        ]; // ┇
      case 0x2508:
        return [
          { dir: 'left', weight: 'light' },
          { dir: 'right', weight: 'light' },
        ]; // ┈
      case 0x2509:
        return [
          { dir: 'left', weight: 'heavy' },
          { dir: 'right', weight: 'heavy' },
        ]; // ┉
      case 0x250a:
        return [
          { dir: 'up', weight: 'light' },
          { dir: 'down', weight: 'light' },
        ]; // ┊
      case 0x250b:
        return [
          { dir: 'up', weight: 'heavy' },
          { dir: 'down', weight: 'heavy' },
        ]; // ┋
      // Rounded corners (╭╮╯╰)
      case 0x256d:
        return [
          { dir: 'right', weight: 'light' },
          { dir: 'down', weight: 'light' },
        ]; // ╭
      case 0x256e:
        return [
          { dir: 'left', weight: 'light' },
          { dir: 'down', weight: 'light' },
        ]; // ╮
      case 0x256f:
        return [
          { dir: 'left', weight: 'light' },
          { dir: 'up', weight: 'light' },
        ]; // ╯
      case 0x2570:
        return [
          { dir: 'right', weight: 'light' },
          { dir: 'up', weight: 'light' },
        ]; // ╰
      default:
        return null;
    }
  }

  /**
   * Render double-line box drawing (U+2550-U+256C) as two parallel lines.
   * Returns true if rendered, false to fall back to font.
   */
  private renderDoubleBoxDrawing(cp: number, x: number, y: number, w: number, h: number): boolean {
    const ctx = this.ctx;
    const mx = x + w / 2;
    const my = y + h / 2;
    const gap = 2; // gap between double lines
    const lw = 1;

    // Helper to draw segments
    const horiz = (x0: number, x1: number, cy: number) =>
      ctx.fillRect(x0, cy - lw / 2, x1 - x0, lw);
    const vert = (y0: number, y1: number, cx: number) => ctx.fillRect(cx - lw / 2, y0, lw, y1 - y0);

    switch (cp) {
      case 0x2550: // ═
        horiz(x, x + w, my - gap);
        horiz(x, x + w, my + gap);
        break;
      case 0x2551: // ║
        vert(y, y + h, mx - gap);
        vert(y, y + h, mx + gap);
        break;
      case 0x2552: // ╒
        horiz(mx, x + w, my - gap);
        horiz(mx, x + w, my + gap);
        vert(my - gap, y + h, mx);
        break;
      case 0x2553: // ╓
        horiz(mx - gap, x + w, my);
        vert(my, y + h, mx - gap);
        vert(my, y + h, mx + gap);
        break;
      case 0x2554: // ╔
        horiz(mx + gap, x + w, my - gap);
        horiz(mx - gap, x + w, my + gap);
        vert(my - gap, y + h, mx - gap);
        vert(my + gap, y + h, mx + gap);
        break;
      case 0x2555: // ╕
        horiz(x, mx, my - gap);
        horiz(x, mx, my + gap);
        vert(my - gap, y + h, mx);
        break;
      case 0x2556: // ╖
        horiz(x, mx + gap, my);
        vert(my, y + h, mx - gap);
        vert(my, y + h, mx + gap);
        break;
      case 0x2557: // ╗
        horiz(x, mx - gap, my - gap);
        horiz(x, mx + gap, my + gap);
        vert(my - gap, y + h, mx + gap);
        vert(my + gap, y + h, mx - gap);
        break;
      case 0x2558: // ╘
        horiz(mx, x + w, my - gap);
        horiz(mx, x + w, my + gap);
        vert(y, my + gap, mx);
        break;
      case 0x2559: // ╙
        horiz(mx - gap, x + w, my);
        vert(y, my, mx - gap);
        vert(y, my, mx + gap);
        break;
      case 0x255a: // ╚
        horiz(mx + gap, x + w, my - gap);
        horiz(mx - gap, x + w, my + gap);
        vert(y, my - gap, mx - gap);
        vert(y, my + gap, mx + gap);
        break;
      case 0x255b: // ╛
        horiz(x, mx, my - gap);
        horiz(x, mx, my + gap);
        vert(y, my + gap, mx);
        break;
      case 0x255c: // ╜
        horiz(x, mx + gap, my);
        vert(y, my, mx - gap);
        vert(y, my, mx + gap);
        break;
      case 0x255d: // ╝
        horiz(x, mx - gap, my - gap);
        horiz(x, mx + gap, my + gap);
        vert(y, my - gap, mx + gap);
        vert(y, my + gap, mx - gap);
        break;
      case 0x255e: // ╞
        horiz(mx, x + w, my - gap);
        horiz(mx, x + w, my + gap);
        vert(y, y + h, mx);
        break;
      case 0x255f: // ╟
        horiz(mx - gap, x + w, my);
        vert(y, y + h, mx - gap);
        vert(y, y + h, mx + gap);
        break;
      case 0x2560: // ╠
        horiz(mx + gap, x + w, my - gap);
        horiz(mx + gap, x + w, my + gap);
        vert(y, y + h, mx - gap);
        vert(y, y + h, mx + gap);
        break;
      case 0x2561: // ╡
        horiz(x, mx, my - gap);
        horiz(x, mx, my + gap);
        vert(y, y + h, mx);
        break;
      case 0x2562: // ╢
        horiz(x, mx + gap, my);
        vert(y, y + h, mx - gap);
        vert(y, y + h, mx + gap);
        break;
      case 0x2563: // ╣
        horiz(x, mx - gap, my - gap);
        horiz(x, mx - gap, my + gap);
        vert(y, y + h, mx - gap);
        vert(y, y + h, mx + gap);
        break;
      case 0x2564: // ╤
        horiz(x, x + w, my - gap);
        horiz(x, x + w, my + gap);
        vert(my + gap, y + h, mx);
        break;
      case 0x2565: // ╥
        horiz(x, x + w, my);
        vert(my, y + h, mx - gap);
        vert(my, y + h, mx + gap);
        break;
      case 0x2566: // ╦
        horiz(x, x + w, my - gap);
        horiz(x, mx - gap, my + gap);
        horiz(mx + gap, x + w, my + gap);
        vert(my + gap, y + h, mx - gap);
        vert(my + gap, y + h, mx + gap);
        break;
      case 0x2567: // ╧
        horiz(x, x + w, my - gap);
        horiz(x, x + w, my + gap);
        vert(y, my - gap, mx);
        break;
      case 0x2568: // ╨
        horiz(x, x + w, my);
        vert(y, my, mx - gap);
        vert(y, my, mx + gap);
        break;
      case 0x2569: // ╩
        horiz(x, mx - gap, my - gap);
        horiz(mx + gap, x + w, my - gap);
        horiz(x, x + w, my + gap);
        vert(y, my - gap, mx - gap);
        vert(y, my - gap, mx + gap);
        break;
      case 0x256a: // ╪
        horiz(x, x + w, my - gap);
        horiz(x, x + w, my + gap);
        vert(y, y + h, mx);
        break;
      case 0x256b: // ╫
        horiz(x, x + w, my);
        vert(y, y + h, mx - gap);
        vert(y, y + h, mx + gap);
        break;
      case 0x256c: // ╬
        horiz(x, mx - gap, my - gap);
        horiz(mx + gap, x + w, my - gap);
        horiz(x, mx - gap, my + gap);
        horiz(mx + gap, x + w, my + gap);
        vert(y, my - gap, mx - gap);
        vert(y, my - gap, mx + gap);
        vert(my + gap, y + h, mx - gap);
        vert(my + gap, y + h, mx + gap);
        break;
      default:
        return false;
    }
    return true;
  }

  /**
   * Render Powerline glyphs as vector shapes for pixel-perfect cell height.
   * Powerline glyphs (U+E0B0-U+E0BF) are designed to span the full cell height,
   * but font rendering often makes them slightly taller/shorter than the cell.
   * Drawing them as paths ensures they exactly fill the cell bounds.
   * Returns true if the character was handled, false if it should be rendered as text.
   */
  private renderPowerlineGlyph(
    codepoint: number,
    cellX: number,
    cellY: number,
    cellWidth: number
  ): boolean {
    const height = this.metrics.height;
    const ctx = this.ctx;

    switch (codepoint) {
      case 0xe0b0: // Right-pointing triangle (hard divider)
      case 0xe0b1: // Right-pointing angle (soft divider)
        ctx.beginPath();
        ctx.moveTo(cellX, cellY);
        ctx.lineTo(cellX + cellWidth, cellY + height / 2);
        ctx.lineTo(cellX, cellY + height);
        if (codepoint === 0xe0b0) {
          ctx.closePath();
          ctx.fill();
        } else this.strokeWithFillColor();
        return true;

      case 0xe0b2: // Left-pointing triangle (hard divider)
      case 0xe0b3: // Left-pointing angle (soft divider)
        ctx.beginPath();
        ctx.moveTo(cellX + cellWidth, cellY);
        ctx.lineTo(cellX, cellY + height / 2);
        ctx.lineTo(cellX + cellWidth, cellY + height);
        if (codepoint === 0xe0b2) {
          ctx.closePath();
          ctx.fill();
        } else this.strokeWithFillColor();
        return true;

      case 0xe0b4: // Right semicircle (filled)
      case 0xe0b5: // Right semicircle (outline)
        ctx.beginPath();
        ctx.moveTo(cellX, cellY);
        // Ellipse curving right: center at left edge, radii = cellWidth (x) and height/2 (y)
        ctx.ellipse(
          cellX,
          cellY + height / 2,
          cellWidth,
          height / 2,
          0,
          -Math.PI / 2,
          Math.PI / 2,
          false
        );
        if (codepoint === 0xe0b4) {
          ctx.closePath();
          ctx.fill();
        } else this.strokeWithFillColor();
        return true;

      case 0xe0b6: // Left semicircle (filled)
      case 0xe0b7: // Left semicircle (outline)
        ctx.beginPath();
        ctx.moveTo(cellX + cellWidth, cellY);
        // Ellipse curving left: center at right edge, radii = cellWidth (x) and height/2 (y)
        ctx.ellipse(
          cellX + cellWidth,
          cellY + height / 2,
          cellWidth,
          height / 2,
          0,
          -Math.PI / 2,
          Math.PI / 2,
          true
        );
        if (codepoint === 0xe0b6) {
          ctx.closePath();
          ctx.fill();
        } else this.strokeWithFillColor();
        return true;

      default:
        return false;
    }
  }

  /**
   * Walk the placement iterator once at frame start, partitioning the
   * results: virtual placements go into kittyVirtualPlacements (keyed
   * by image id) for placeholder-cell lookup; direct visible placements
   * stay implicit and get re-iterated by renderKittyImages later.
   *
   * Also caches the storage handle for renderPlaceholderCell so the
   * per-cell hot path doesn't have to re-resolve it.
   */
  private precomputeKittyState(
    buffer: IRenderable,
    dimsRows: number,
    viewportYOffset: number
  ): void {
    this.kittyVirtualPlacements.clear();
    this.currentDirectPlacements = [];
    this.kittyDamagedRows.clear();
    this.currentKittyGraphics = null;

    const newSigs: typeof this.lastKittyDirectSigs = new Map();
    const cellH = this.metrics.height;
    const markRows = (viewportRow: number, pixelHeight: number): void => {
      const rowStart = Math.max(0, Math.floor(viewportRow));
      const rowEnd = Math.min(dimsRows, Math.ceil(viewportRow + pixelHeight / cellH));
      for (let r = rowStart; r < rowEnd; r++) this.kittyDamagedRows.add(r);
    };

    if (buffer.getKittyGraphics && buffer.iterPlacements) {
      const graphics = buffer.getKittyGraphics();
      if (graphics !== null) {
        this.currentKittyGraphics = graphics;
        // onlyVisible=false so virtual placements come through too. We
        // partition: virtuals into kittyVirtualPlacements (placeholder-cell
        // lookup), directs into currentDirectPlacements (composite pass).
        for (const p of buffer.iterPlacements(graphics, false)) {
          if (p.isVirtual) {
            this.kittyVirtualPlacements.set(p.imageId, p);
            continue;
          }
          const visiblePlacement =
            viewportYOffset === 0 ? p : { ...p, viewportRow: p.viewportRow - viewportYOffset };
          this.currentDirectPlacements.push(visiblePlacement);
          const pixels = buffer.getKittyImagePixels?.(graphics, p.imageId);
          const sig = {
            viewportCol: visiblePlacement.viewportCol,
            viewportRow: visiblePlacement.viewportRow,
            pixelWidth: visiblePlacement.pixelWidth,
            pixelHeight: visiblePlacement.pixelHeight,
            sourceX: visiblePlacement.sourceX,
            sourceY: visiblePlacement.sourceY,
            sourceWidth: visiblePlacement.sourceWidth,
            sourceHeight: visiblePlacement.sourceHeight,
            imgWidth: pixels?.width ?? 0,
            imgHeight: pixels?.height ?? 0,
            imgFormat: pixels?.format ?? (0 as KittyImageFormat),
            dataPtr: pixels?.data.byteOffset ?? 0,
            dataLen: pixels?.data.length ?? 0,
          };
          newSigs.set(p.imageId, sig);
          const prev = this.lastKittyDirectSigs.get(p.imageId);
          const changed =
            !prev ||
            prev.viewportCol !== sig.viewportCol ||
            prev.viewportRow !== sig.viewportRow ||
            prev.pixelWidth !== sig.pixelWidth ||
            prev.pixelHeight !== sig.pixelHeight ||
            prev.sourceX !== sig.sourceX ||
            prev.sourceY !== sig.sourceY ||
            prev.sourceWidth !== sig.sourceWidth ||
            prev.sourceHeight !== sig.sourceHeight ||
            prev.imgWidth !== sig.imgWidth ||
            prev.imgHeight !== sig.imgHeight ||
            prev.imgFormat !== sig.imgFormat ||
            prev.dataPtr !== sig.dataPtr ||
            prev.dataLen !== sig.dataLen;
          if (changed) {
            markRows(sig.viewportRow, sig.pixelHeight);
            if (prev) markRows(prev.viewportRow, prev.pixelHeight);
          }
        }
      }
    }

    // Removed placements (were drawn last frame, gone now): mark their
    // rows so text repaint clears stale image pixels.
    for (const [id, prev] of this.lastKittyDirectSigs) {
      if (!newSigs.has(id)) markRows(prev.viewportRow, prev.pixelHeight);
    }
    this.lastKittyDirectSigs = newSigs;
  }

  /**
   * Get (or decode + cache) the canvas-ready bitmap for a kitty image.
   * Returns null if the image isn't stored or decode fails. Shared by
   * renderKittyImages (direct placements) and renderPlaceholderCell
   * (unicode-placeholder cells).
   */
  private getOrDecodeKittyImage(
    buffer: IRenderable,
    graphics: number,
    imageId: number
  ): HTMLCanvasElement | null {
    const cached = this.kittyImageCache.get(imageId);
    const pixels = buffer.getKittyImagePixels?.(graphics, imageId);
    if (!pixels) return cached?.canvas ?? null;
    if (cached && cachedMatchesPixels(cached, pixels)) return cached.canvas;
    const canvas = this.decodeKittyImageToCanvas(pixels);
    if (!canvas) return null;
    this.kittyImageCache.set(imageId, {
      canvas,
      width: pixels.width,
      height: pixels.height,
      format: pixels.format,
      dataPtr: pixels.data.byteOffset,
      dataLen: pixels.data.length,
    });
    return canvas;
  }

  /**
   * Substitute a cell's text rendering with a slice of a kitty graphics
   * image. Called from renderCellText when the cell's codepoint is
   * U+10EEEE.
   *
   * Decodes the image_id from cell.fg_*  (low 24 bits; high byte from
   * an optional third combining diacritic) and the row/col-of-image
   * from the first two combining diacritics on the cell. Looks up the
   * virtual placement (from precomputeKittyState) for grid dims, then
   * draws the matching slice scaled to one terminal cell.
   *
   * Returns true if the cell was handled as a placeholder; false to
   * fall through to normal text rendering (e.g., unknown image, no
   * matching virtual placement, or malformed diacritics).
   */
  private renderPlaceholderCell(cell: GhosttyCell, x: number, y: number): boolean {
    const buffer = this.currentRenderBuffer;
    const graphics = this.currentKittyGraphics;
    if (!buffer || graphics === null || !buffer.getGrapheme) return false;

    // Image id from fg color (low 24 bits) + optional 3rd diacritic
    // (high byte). The base codepoint at index 0 is U+10EEEE itself;
    // [1]=row, [2]=col, [3]=image_id_msb (optional).
    const codepoints = buffer.getGrapheme(y, x);
    if (!codepoints || codepoints.length < 3) return false;
    const rowD = diacriticToInt(codepoints[1]!);
    const colD = diacriticToInt(codepoints[2]!);
    if (rowD < 0 || colD < 0) return false;
    const fgRgb = (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b;
    let imageId = fgRgb;
    if (codepoints.length >= 4) {
      const msb = diacriticToInt(codepoints[3]!);
      if (msb >= 0) imageId = (msb << 24) | fgRgb;
    }

    const placement = this.kittyVirtualPlacements.get(imageId);
    if (!placement) return false;

    const pixels = buffer.getKittyImagePixels?.(graphics, imageId);
    if (!pixels) return false;
    const canvas = this.getOrDecodeKittyImage(buffer, graphics, imageId);
    if (!canvas) return false;

    // Slice geometry: image is conceptually scaled to fit
    // gridCols × gridRows cells; this cell shows one of those cells.
    const srcW = pixels.width / placement.gridCols;
    const srcH = pixels.height / placement.gridRows;
    const srcX = colD * srcW;
    const srcY = rowD * srcH;
    const destX = x * this.metrics.width;
    const destY = y * this.metrics.height;

    // Source-rect coords are fractional whenever pixels.{width,height} doesn't
    // divide evenly by placement.{gridCols,gridRows}. With smoothing on, each
    // slice is sampled with bilinear interpolation clamped to its own source
    // rect, producing visible seams between adjacent cells (the classic
    // tile-edge artifact). Disable smoothing for the slice draw.
    const prevSmoothing = this.ctx.imageSmoothingEnabled;
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(
      canvas,
      srcX,
      srcY,
      srcW,
      srcH,
      destX,
      destY,
      this.metrics.width,
      this.metrics.height
    );
    this.ctx.imageSmoothingEnabled = prevSmoothing;
    return true;
  }

  private renderKittyImages(): void {
    const buffer = this.currentRenderBuffer;
    const graphics = this.currentKittyGraphics;
    if (!buffer || graphics === null || !buffer.getKittyImagePixels) return;

    for (const p of this.currentDirectPlacements) {
      let cached = this.kittyImageCache.get(p.imageId);
      const pixels = buffer.getKittyImagePixels(graphics, p.imageId);
      if (!pixels) continue;

      // Cache miss or stale (image was re-transmitted under the same id).
      // See kittyImageCache docstring for staleness-key rationale.
      if (!cached || !cachedMatchesPixels(cached, pixels)) {
        const canvas = this.decodeKittyImageToCanvas(pixels);
        if (!canvas) continue;
        cached = {
          canvas,
          width: pixels.width,
          height: pixels.height,
          format: pixels.format,
          dataPtr: pixels.data.byteOffset,
          dataLen: pixels.data.length,
        };
        this.kittyImageCache.set(p.imageId, cached);
      }

      // Composite. Source/dest rects come straight from the C ABI's
      // PlacementRenderInfo; viewport_col/row may be negative when a
      // placement has scrolled partway off the top — drawImage handles
      // that correctly (clips to the canvas).
      this.ctx.drawImage(
        cached.canvas,
        p.sourceX,
        p.sourceY,
        p.sourceWidth,
        p.sourceHeight,
        p.viewportCol * this.metrics.width,
        p.viewportRow * this.metrics.height,
        p.pixelWidth,
        p.pixelHeight
      );
    }
  }

  /**
   * Decode a kitty graphics image into a canvas suitable for drawImage.
   * Expands non-RGBA formats into RGBA via putImageData; PNG payloads
   * (which require a JS-side decoder set up via ghostty_sys_set) are
   * not supported in this MVP and return null.
   */
  private decodeKittyImageToCanvas(pixels: KittyImagePixels): HTMLCanvasElement | null {
    const { width, height, format, data } = pixels;
    if (width === 0 || height === 0) return null;

    // Allocate a fresh ArrayBuffer (not a WASM-memory view) so that
    //   (a) the bytes survive the next vt_write that might detach the
    //       WASM memory buffer, and
    //   (b) ImageData accepts the buffer (it rejects ArrayBufferLike
    //       which would include SharedArrayBuffer).
    const rgba = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
    switch (format) {
      case KittyImageFormat.RGBA:
        rgba.set(data);
        break;
      case KittyImageFormat.RGB:
        for (let i = 0, o = 0; i < data.length; i += 3, o += 4) {
          rgba[o] = data[i]!;
          rgba[o + 1] = data[i + 1]!;
          rgba[o + 2] = data[i + 2]!;
          rgba[o + 3] = 255;
        }
        break;
      case KittyImageFormat.GRAY:
        for (let i = 0, o = 0; i < data.length; i++, o += 4) {
          const v = data[i]!;
          rgba[o] = v;
          rgba[o + 1] = v;
          rgba[o + 2] = v;
          rgba[o + 3] = 255;
        }
        break;
      case KittyImageFormat.GRAY_ALPHA:
        for (let i = 0, o = 0; i < data.length; i += 2, o += 4) {
          const v = data[i]!;
          rgba[o] = v;
          rgba[o + 1] = v;
          rgba[o + 2] = v;
          rgba[o + 3] = data[i + 1]!;
        }
        break;
      default:
        // PNG and unknown formats — skip silently. The terminal would have
        // dropped a PNG payload at parse time anyway unless a decoder was
        // installed via ghostty_sys_set(DECODE_PNG, fn).
        return null;
    }

    const canvas = this.canvas.ownerDocument.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    return canvas;
  }

  /**
   * Render cursor
   */
  private renderCursor(x: number, y: number, style?: 'block' | 'underline' | 'bar'): void {
    const cursorX = x * this.metrics.width;
    const cursorY = y * this.metrics.height;
    const cursorStyle = style ?? this.cursorStyle;

    this.ctx.fillStyle = this.theme.cursor;

    switch (cursorStyle) {
      case 'block':
        // Full cell block
        this.ctx.fillRect(cursorX, cursorY, this.metrics.width, this.metrics.height);
        // Re-draw character under cursor with cursorAccent color
        {
          const line = this.currentBuffer?.getLine(y);
          if (line?.[x]) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(cursorX, cursorY, this.metrics.width, this.metrics.height);
            this.ctx.clip();
            this.renderCellText(line[x], x, y, this.theme.cursorAccent);
            this.ctx.restore();
          }
        }
        break;

      case 'underline':
        // Underline at bottom of cell
        const underlineHeight = Math.max(2, Math.floor(this.metrics.height * 0.15));
        this.ctx.fillRect(
          cursorX,
          cursorY + this.metrics.height - underlineHeight,
          this.metrics.width,
          underlineHeight
        );
        break;

      case 'bar':
        // Vertical bar at left of cell
        const barWidth = Math.max(2, Math.floor(this.metrics.width * 0.15));
        this.ctx.fillRect(cursorX, cursorY, barWidth, this.metrics.height);
        break;
    }
  }

  // ==========================================================================
  // Cursor Blinking
  // ==========================================================================

  /**
   * Set a callback the renderer invokes when its internal state changes
   * outside the normal render-driven path (today: cursor-blink toggles).
   * Lets an event-driven Terminal wake its render scheduler instead of
   * polling every frame to catch the blink flip.
   */
  public setOnRequestRender(fn: (() => void) | null): void {
    this.onRequestRender = fn;
  }

  private startCursorBlink(): void {
    // xterm.js uses ~530ms blink interval
    const view = this.canvas.ownerDocument.defaultView;
    if (!view) return;
    this.cursorBlinkInterval = view.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      // Wake the render scheduler so the cursor cell is actually
      // repainted with the new visibility state.
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

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Update theme colors
   */
  public setTheme(theme: ITheme): void {
    this.theme = { ...DEFAULT_THEME, ...theme };
  }

  public setAllowTransparency(allowTransparency: boolean): void {
    this.allowTransparency = allowTransparency;
  }

  /**
   * Set general-purpose decorations in absolute buffer coordinates.
   * Decorations are painted as cell backgrounds before text rendering.
   */
  public setDecorations(decorations: ITerminalDecoration[]): void {
    this.decorations = decorations.slice();
  }

  public clearDecorations(): void {
    this.decorations = [];
  }

  /**
   * Update font size
   */
  public setFontSize(size: number): void {
    if (!Number.isFinite(size) || size <= 0) return;
    this.fontSize = size;
    this.fontStrings = this.buildFontStrings();
    this.metrics = this.measureFont();
  }

  /**
   * Update font family
   */
  public setFontFamily(family: string): void {
    this.fontFamily = family;
    this.fontStrings = this.buildFontStrings();
    this.metrics = this.measureFont();
  }

  /**
   * Update cursor style
   */
  public setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    this.cursorStyle = style;
  }

  /**
   * Enable/disable cursor blinking
   */
  public setCursorBlink(enabled: boolean): void {
    if (enabled && !this.cursorBlink) {
      this.cursorBlink = true;
      this.startCursorBlink();
    } else if (!enabled && this.cursorBlink) {
      this.cursorBlink = false;
      this.stopCursorBlink();
    }
  }

  public setScrollbarWidth(width: number): void {
    this.scrollbarWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  }

  /**
   * Render scrollbar (Phase 2)
   * Shows scroll position and allows click/drag interaction
   * @param opacity Opacity level (0-1) for fade in/out effect
   */
  private renderScrollbar(
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number,
    opacity: number = 1
  ): void {
    const ctx = this.ctx;
    const canvasHeight = this.canvas.height / this.devicePixelRatio;
    const canvasWidth = this.canvas.width / this.devicePixelRatio;

    // Scrollbar dimensions
    const scrollbarWidth = this.scrollbarWidth;
    const scrollbarX = canvasWidth - scrollbarWidth - 4;
    const scrollbarPadding = 4;
    const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;

    // Always clear the scrollbar area first (fixes ghosting when fading out)
    ctx.clearRect(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);
    if (!this.allowTransparency) {
      ctx.fillStyle = this.theme.background;
      ctx.fillRect(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);
    }

    // Don't draw scrollbar if disabled, fully transparent, or no scrollback
    if (scrollbarWidth <= 0 || opacity <= 0 || scrollbackLength === 0) return;

    // Calculate scrollbar thumb size and position
    const totalLines = scrollbackLength + visibleRows;
    const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);

    // Position: 0 = at bottom, scrollbackLength = at top
    const scrollPosition = viewportY / scrollbackLength; // 0 to 1
    const thumbY = scrollbarPadding + (scrollbarTrackHeight - thumbHeight) * (1 - scrollPosition);

    // Draw scrollbar track (subtle background) with opacity
    ctx.fillStyle = `rgba(128, 128, 128, ${0.1 * opacity})`;
    ctx.fillRect(scrollbarX, scrollbarPadding, scrollbarWidth, scrollbarTrackHeight);

    // Draw scrollbar thumb with opacity
    const isScrolled = viewportY > 0;
    const baseOpacity = isScrolled ? 0.5 : 0.3;
    ctx.fillStyle = `rgba(128, 128, 128, ${baseOpacity * opacity})`;
    ctx.fillRect(scrollbarX, thumbY, scrollbarWidth, thumbHeight);
  }
  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  /**
   * Get canvas element (needed by SelectionManager)
   */
  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Set selection manager (for rendering selection)
   */
  public setSelectionManager(manager: SelectionManager): void {
    this.selectionManager = manager;
  }

  /**
   * Check if a cell at (x, y) is within the current selection.
   * Uses cached selection coordinates for performance.
   */
  private isInSelection(x: number, y: number): boolean {
    const sel = this.currentSelectionCoords;
    if (!sel) return false;

    const { startCol, startRow, endCol, endRow } = sel;

    // Single line selection
    if (startRow === endRow) {
      return y === startRow && x >= startCol && x <= endCol;
    }

    // Multi-line selection
    if (y === startRow) {
      // First line: from startCol to end of line
      return x >= startCol;
    } else if (y === endRow) {
      // Last line: from start of line to endCol
      return x <= endCol;
    } else if (y > startRow && y < endRow) {
      // Middle lines: entire line is selected
      return true;
    }

    return false;
  }

  /**
   * Set the currently hovered hyperlink ID for rendering underlines
   */
  public setHoveredHyperlinkId(hyperlinkId: number): void {
    hyperlinkId = Number.isFinite(hyperlinkId) ? Math.max(0, Math.floor(hyperlinkId)) : 0;
    if (this.hoveredHyperlinkId === hyperlinkId) return;
    this.hoveredHyperlinkId = hyperlinkId;
    this.onRequestRender?.();
  }

  /**
   * Set the currently hovered link range for rendering underlines (for regex-detected URLs)
   * Pass null to clear the hover state
   */
  public setHoveredLinkRange(
    range: {
      startX: number;
      startY: number;
      endX: number;
      endY: number;
    } | null
  ): void {
    const sanitized = sanitizeLinkRange(range);
    // Coarse change check — link-detection is rate-limited upstream and
    // these setters are only called on hover transitions, so identity
    // comparison is enough to dedupe back-to-back clears.
    if (this.hoveredLinkRange === sanitized) return;
    this.hoveredLinkRange = sanitized;
    this.onRequestRender?.();
  }

  /**
   * Get character cell width (for coordinate conversion)
   */
  public get charWidth(): number {
    return this.metrics.width;
  }

  /**
   * Get character cell height (for coordinate conversion)
   */
  public get charHeight(): number {
    return this.metrics.height;
  }

  /**
   * Clear entire canvas
   */
  public clear(): void {
    // clearRect first because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.allowTransparency) {
      this.ctx.fillStyle = this.theme.background;
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  // ==========================================================================
  // Preedit Overlay Canvas (IME composition rendering)
  // ==========================================================================

  /**
   * Attach (or re-attach) the overlay canvas to a parent element.
   * Idempotent: if already attached to the same parent, does nothing.
   * Call this from Terminal.open() after the main canvas is added.
   */
  public attachOverlayTo(parent: HTMLElement): void {
    // Idempotent: skip if already attached to this parent
    if (this.overlayCanvas && this.overlayCanvas.parentElement === parent) return;

    // Create canvas if not yet created
    if (!this.overlayCanvas) {
      this.overlayCanvas = parent.ownerDocument.createElement('canvas');
      this.overlayCanvas.setAttribute('aria-hidden', 'true');
    }

    this.overlayCanvas.style.position = 'absolute';
    this.overlayCanvas.style.left = '0';
    this.overlayCanvas.style.top = '0';
    this.overlayCanvas.style.pointerEvents = 'none';
    this.overlayCanvas.style.zIndex = '1';

    // Ensure parent has a positioning context so absolute child lands correctly.
    // getComputedStyle returns 'static' in real browsers and '' in some test
    // environments when no explicit position is set — treat both as needing a fix.
    const cs = parent.ownerDocument.defaultView?.getComputedStyle(parent);
    if (!cs || cs.position === 'static' || cs.position === '') {
      parent.style.position = 'relative';
    }

    parent.appendChild(this.overlayCanvas);

    const ctx = this.overlayCanvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Failed to get overlay 2D context');
    this.overlayCtx = ctx;

    this.resizeOverlay();
  }

  /**
   * Resize the overlay canvas to match the main canvas dimensions (CSS + physical pixels).
   * Call whenever the main canvas is resized.
   */
  public resizeOverlay(): void {
    if (!this.overlayCanvas) return;
    this.overlayCanvas.width = this.canvas.width;
    this.overlayCanvas.height = this.canvas.height;
    this.overlayCanvas.style.width = this.canvas.style.width;
    this.overlayCanvas.style.height = this.canvas.style.height;
  }

  /**
   * Draw preedit (IME active composition) text at the given cell coordinates.
   * Clears any previous preedit drawing first.
   * @param text  Active composition string (empty string = clear only)
   * @param cellX Column index (0-based)
   * @param cellY Row index (0-based)
   */
  public drawPreedit(text: string, cellX: number, cellY: number): void {
    if (!this.overlayCtx || !this.overlayCanvas) return;
    const dpr = this.devicePixelRatio;
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    if (!text) return;

    const m = this.metrics;
    const px = cellX * m.width * dpr;
    const py = cellY * m.height * dpr;

    this.overlayCtx.save();
    // Mirror the font string from the main context
    this.overlayCtx.font = `${this.fontSize}px ${this.fontFamily}`;
    this.overlayCtx.textBaseline = 'top';
    this.overlayCtx.fillStyle = this.theme.foreground;
    this.overlayCtx.scale(dpr, dpr);
    const scaledPx = cellX * m.width;
    const scaledPy = cellY * m.height;
    this.overlayCtx.fillText(text, scaledPx, scaledPy);

    // Underline for preedit visibility
    const underlineY = scaledPy + m.height - 2;
    const textWidth = this.overlayCtx.measureText(text).width;
    this.overlayCtx.fillRect(scaledPx, underlineY, textWidth, 1);
    this.overlayCtx.restore();
  }

  /**
   * Clear the preedit overlay without drawing new text.
   */
  public clearPreedit(): void {
    if (!this.overlayCtx || !this.overlayCanvas) return;
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
  }

  /**
   * Cleanup resources
   */
  public dispose(): void {
    this.stopCursorBlink();

    // Remove overlay canvas from DOM
    if (this.overlayCanvas && this.overlayCanvas.parentElement) {
      this.overlayCanvas.parentElement.removeChild(this.overlayCanvas);
    }
    this.overlayCanvas = null;
    this.overlayCtx = null;
  }
}

function sanitizeLinkRange(
  range: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null
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
