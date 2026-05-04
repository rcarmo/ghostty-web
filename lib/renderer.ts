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

import type { ITheme } from './interfaces';
import type { SelectionManager } from './selection-manager';
import type { GhosttyCell, ILink } from './types';
import { CellFlags } from './types';

// Interface for objects that can be rendered
export interface IRenderable {
  getLine(y: number): GhosttyCell[] | null;
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
  devicePixelRatio?: number; // Default: window.devicePixelRatio
  scrollbarWidth?: number; // 0 = hidden
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

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private fontSize: number;
  private fontFamily: string;
  private cursorStyle: 'block' | 'underline' | 'bar';
  private cursorBlink: boolean;
  private theme: Required<ITheme>;
  private devicePixelRatio: number;
  private scrollbarWidth: number;
  private metrics: FontMetrics;
  private fontStrings: { plain: string; bold: string; italic: string; boldItalic: string };

  // Cursor blinking state
  private cursorVisible: boolean = true;
  private cursorBlinkInterval?: number;
  private lastCursorPosition: { x: number; y: number } = { x: 0, y: 0 };

  // Viewport tracking (for scrolling)
  private lastViewportY: number = 0;

  // Current buffer being rendered (for grapheme lookups)
  private currentBuffer: IRenderable | null = null;

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

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
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
    this.devicePixelRatio = options.devicePixelRatio ?? window.devicePixelRatio ?? 1;
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

  private measureFont(): FontMetrics {
    // Use an offscreen canvas for measurement
    const canvas = document.createElement('canvas');
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

    // Fill background after resize
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, cssWidth, cssHeight);
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

    // getCursor() calls update() internally to ensure fresh state.
    // Multiple update() calls are safe - dirty state persists until clearDirty().
    const cursor = buffer.getCursor();
    const dims = buffer.getDimensions();
    const scrollbackLength = scrollbackProvider ? scrollbackProvider.getScrollbackLength() : 0;

    // Check if buffer needs full redraw (e.g., screen change between normal/alternate)
    if (buffer.needsFullRedraw?.()) {
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
          : forceAll || buffer.isRowDirty(y) || selectionRows.has(y) || hyperlinkRows.has(y);

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
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, lineY, lineWidth, this.metrics.height);

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

    // Only draw cell background if it's different from the default (black)
    // This lets the theme background (drawn earlier) show through for default cells
    const isDefaultBg = bg_r === 0 && bg_g === 0 && bg_b === 0;
    if (!isDefaultBg) {
      this.ctx.fillStyle = this.rgbToCSS(bg_r, bg_g, bg_b);
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
    }
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
      let fg_r = cell.fg_r,
        fg_g = cell.fg_g,
        fg_b = cell.fg_b;
      if (cell.flags & CellFlags.INVERSE) {
        fg_r = cell.bg_r;
        fg_g = cell.bg_g;
        fg_b = cell.bg_b;
      }
      fillColor = this.rgbToCSS(fg_r, fg_g, fg_b);
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
    // - Block drawing characters (U+2580-U+259F): rectangles for gap-free ASCII art
    // - Powerline glyphs (U+E0B0-U+E0BF): vector shapes to match exact cell height
    if (
      codepoint >= 0x2580 &&
      codepoint <= 0x259f &&
      this.renderBlockChar(codepoint, cellX, cellY, cellWidth)
    ) {
      // rendered as rectangle
    } else if (
      codepoint >= 0xe0b0 &&
      codepoint <= 0xe0b7 &&
      this.renderPowerlineGlyph(codepoint, cellX, cellY, cellWidth)
    ) {
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
      case 0x2594: // ▔ UPPER ONE EIGHTH BLOCK
        this.ctx.fillRect(cellX, cellY, cellWidth, height / 8);
        return true;
      case 0x2595: // ▕ RIGHT ONE EIGHTH BLOCK
        this.ctx.fillRect(cellX + (cellWidth * 7) / 8, cellY, cellWidth / 8, height);
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

  private startCursorBlink(): void {
    // xterm.js uses ~530ms blink interval
    this.cursorBlinkInterval = window.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      // Note: Render loop should redraw cursor line automatically
    }, 530);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) {
      clearInterval(this.cursorBlinkInterval);
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

  /**
   * Update font size
   */
  public setFontSize(size: number): void {
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
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);

    // Don't draw scrollbar if fully transparent or no scrollback
    if (opacity <= 0 || scrollbackLength === 0) return;

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
    this.hoveredHyperlinkId = hyperlinkId;
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
    this.hoveredLinkRange = range;
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
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Cleanup resources
   */
  public dispose(): void {
    this.stopCursorBlink();
  }
}
