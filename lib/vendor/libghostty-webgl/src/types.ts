// Keep renderer contract local to avoid runtime coupling to ghostty-web entrypoint
// exports that may not exist in older compatible peer versions.

export interface CellMetrics {
  width: number;
  height: number;
  baseline: number;
}

export type CursorStyle = "block" | "underline" | "bar";

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface TerminalTheme {
  foreground: RGBA;
  background: RGBA;
  cursor: RGBA;
  cursorAccent: RGBA;
  selectionBackground: RGBA;
  selectionForeground: RGBA | null;
  selectionOpacity: number;
}

export interface SelectionRange {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

export interface LinkRange {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface HyperlinkRange {
  hyperlinkId: number;
  range: LinkRange | null;
}

export const ROW_DIRTY = 0x01;
export const ROW_HAS_SELECTION = 0x02;
export const ROW_HAS_HYPERLINK = 0x04;

export const DirtyState = {
  NONE: 0,
  PARTIAL: 1,
  FULL: 2,
} as const;

export type DirtyState = (typeof DirtyState)[keyof typeof DirtyState];

export const CellFlags = {
  BOLD: 1 << 0,
  ITALIC: 1 << 1,
  UNDERLINE: 1 << 2,
  STRIKETHROUGH: 1 << 3,
  INVERSE: 1 << 4,
  INVISIBLE: 1 << 5,
  BLINK: 1 << 6,
  FAINT: 1 << 7,
} as const;

export interface GhosttyCell {
  codepoint: number;
  fg_r: number;
  fg_g: number;
  fg_b: number;
  bg_r: number;
  bg_g: number;
  bg_b: number;
  flags: number;
  width: number;
  hyperlink_id: number;
  grapheme_len: number;
}

export type GraphemeRow = ReadonlyArray<string | undefined>;
export type GraphemeRows = ReadonlyArray<GraphemeRow | undefined>;

export interface RenderInput {
  cols: number;
  rows: number;
  viewportCells: GhosttyCell[];
  graphemeRows: GraphemeRows;
  rowFlags: Uint8Array;
  dirtyState: DirtyState;
  selectionRange: SelectionRange | null;
  hoveredLink: HyperlinkRange | null;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  cursorStyle: CursorStyle;
  getGraphemeString?: (viewportRow: number, col: number) => string;
  theme: TerminalTheme;
  viewportY: number;
  scrollbackLength: number;
  scrollbarOpacity: number;
}

export interface Renderer {
  attach(canvas: HTMLCanvasElement): void;
  resize(cols: number, rows: number): void;
  render(input: RenderInput): void;
  updateTheme(theme: TerminalTheme): void;
  setFontSize(size: number): void;
  setFontFamily(family: string): void;
  getMetrics(): CellMetrics;
  getCanvas(): HTMLCanvasElement;
  readonly charWidth: number;
  readonly charHeight: number;
  clear(): void;
  dispose(): void;
}
