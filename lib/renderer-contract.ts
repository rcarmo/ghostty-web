import type { ITerminalDecoration, ITheme } from './interfaces';
import type { IRenderable, IScrollbackProvider } from './renderer';
import type { SelectionManager } from './selection-manager';

export interface ITerminalRenderer {
  readonly charWidth: number;
  readonly charHeight: number;

  resize(cols: number, rows: number): void;
  render(
    buffer: IRenderable,
    forceAll?: boolean,
    viewportY?: number,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity?: number
  ): void;
  clear(): void;
  dispose(): void;

  getMetrics(): { width: number; height: number; baseline: number };
  getCanvas(): HTMLCanvasElement;
  setTheme(theme: ITheme): void;
  setAllowTransparency(allowTransparency: boolean): void;
  setFontSize(fontSize: number): void;
  setFontFamily(fontFamily: string): void;
  setFontWeight(weight: number): void;
  remeasureFont(): void;
  setCursorStyle(style: 'block' | 'underline' | 'bar'): void;
  setCursorBlink(blink: boolean): void;
  setScrollbarWidth(width: number): void;

  setSelectionManager(selectionManager: SelectionManager): void;
  setHoveredHyperlinkId(id: number | null): void;
  setHoveredLinkRange(
    range: { startX: number; startY: number; endX: number; endY: number } | null
  ): void;
  setDecorations(decorations: ITerminalDecoration[]): void;
  clearDecorations(): void;

  drawPreedit(text: string, cursorStart?: number, cursorEnd?: number): void;
  clearPreedit(): void;
  attachOverlayTo(parent: HTMLElement): void;
  setOnRequestRender(onRequestRender: () => void): void;

  /**
   * WebGL-only: install a custom post-process fragment shader as a final
   * composite pass, or null to render directly again. Undefined on
   * CanvasRenderer — check for presence before calling. See
   * WebGLRenderer.setPostProcessShader (lib/webgl-renderer.ts) for the
   * shader contract.
   */
  setPostProcessShader?(fragmentSource: string | null): void;

  /**
   * WebGL-only: force a render on the next frame. Undefined on
   * CanvasRenderer. Needed to pump continuous frames for a u_time-driven
   * post-process animation (e.g. a ramp) while the terminal is otherwise
   * idle and wouldn't repaint on its own — see
   * WebGLRenderer.requestRender (lib/webgl-renderer.ts).
   */
  requestRender?(): void;
}
