import { Ghostty } from './ghostty';
/**
 * Initialize the ghostty-web library by loading the WASM module.
 * Must be called before creating any Terminal instances.
 *
 * This creates a shared WASM instance that all Terminal instances will use.
 * For test isolation, pass a Ghostty instance directly to Terminal constructor.
 *
 * @example
 * ```typescript
 * import { init, Terminal } from 'ghostty-web';
 *
 * await init();
 * const term = new Terminal();
 * term.open(document.getElementById('terminal'));
 * ```
 */
export declare function init(wasmPath?: string): Promise<void>;
/**
 * Initialize ghostty-web from a pre-fetched `ArrayBuffer` (e.g. from an
 * IndexedDB cache). Skips the fetch but still compiles the module.
 *
 * No-op if the singleton is already set, but **deduplication of concurrent
 * calls is the caller's responsibility** — two overlapping awaits will both
 * proceed past the guard and the second will overwrite the first. Wrap this
 * in a shared promise (e.g. `if (!ready) ready = initFromBytes(...)`) to
 * guarantee at-most-once execution.
 */
export declare function initFromBytes(bytes: ArrayBuffer): Promise<void>;
/**
 * Initialize ghostty-web from a fetch `Response`, using
 * `WebAssembly.instantiateStreaming` when `Content-Type: application/wasm`
 * is set so compilation overlaps with the download. Falls back to
 * `arrayBuffer()` + `compile` if the header is missing.
 *
 * Same deduplication contract as `initFromBytes`: concurrent callers must
 * coordinate externally (e.g. via a shared promise).
 */
export declare function initFromResponse(response: Response): Promise<void>;
/**
 * Get the initialized Ghostty instance.
 * Throws if init() hasn't been called.
 * @internal
 */
export declare function getGhostty(): Ghostty;
export { Terminal } from './terminal';
export type { ITerminalOptions, ITerminalDecoration, ITheme, ITerminalAddon, ITerminalCore, IDisposable, IEvent, IBufferRange, IKeyEvent, IUnicodeVersionProvider, } from './interfaces';
export { Ghostty, GhosttyTerminal, KeyEncoder, CellFlags, DirtyState, KeyEncoderOption, } from './ghostty';
export { Key, KeyAction, Mods } from './types';
export type { KeyEvent, GhosttyCell, RGB, Cursor, TerminalHandle } from './types';
export { CanvasRenderer, DEFAULT_THEME } from './renderer';
export type { RendererOptions, FontMetrics, IRenderable } from './renderer';
export { InputHandler } from './input-handler';
export { EventEmitter } from './event-emitter';
export { SelectionManager } from './selection-manager';
export type { SelectionCoordinates } from './selection-manager';
export { FitAddon } from './addons/fit';
export type { ITerminalDimensions } from './addons/fit';
export { OSC8LinkProvider } from './providers/osc8-link-provider';
export { UrlRegexProvider } from './providers/url-regex-provider';
export { LinkDetector } from './link-detector';
export type { ILink, ILinkProvider, IBufferCellPosition } from './types';
//# sourceMappingURL=index.d.ts.map