// Core search integration adapted from rundel/ghostterm (MIT), 0708fc36.
import type { AbiLayout } from './abi';
import type { GhosttyWasmExports } from './types';

export interface SearchMatch {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

/** Literal, ASCII-case-insensitive search over the active screen and retained history. */
export class TerminalSearch {
  private handle = 0;
  private needle = '';
  constructor(
    private ex: GhosttyWasmExports,
    private abi: AbiLayout,
    private terminal: number,
    private released: () => void
  ) {
    const slot = ex.ghostty_wasm_alloc_opaque();
    if (!slot) throw new Error('Failed to allocate search handle');
    try {
      const result = ex.ghostty_search_new(0, slot, terminal);
      if (result !== 0) throw new Error(`Ghostty search unavailable: ${result}`);
      this.handle = new DataView(ex.memory.buffer).getUint32(slot, true);
    } finally {
      ex.ghostty_wasm_free_opaque(slot);
    }
    // The existing renderer owns scrolling; do not move the core viewport.
    try {
      this.withBuffer(4, (ptr) => {
        new DataView(ex.memory.buffer).setUint32(
          ptr,
          abi.enumValue('GhosttySearchScroll', 'NONE'),
          true
        );
        this.check(
          ex.ghostty_search_set(
            this.handle,
            abi.enumValue('GhosttySearchOption', 'SELECT_SCROLL'),
            ptr
          )
        );
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  get disposed(): boolean {
    return !this.handle;
  }
  private check(result: number): void {
    if (result !== 0) throw new Error(`Ghostty search failed: ${result}`);
  }
  private withBuffer<T>(size: number, action: (ptr: number) => T): T {
    const ptr = this.ex.ghostty_wasm_alloc(size);
    if (!ptr) throw new Error('Failed to allocate search buffer');
    try {
      return action(ptr);
    } finally {
      this.ex.ghostty_wasm_free(ptr, size);
    }
  }
  setNeedle(text: string): void {
    if (!this.handle) throw new Error('Search has been disposed');
    if (text.length > 1024) throw new RangeError('Search is limited to 1024 characters');
    if (text === this.needle) return;
    const key = this.abi.enumValue('GhosttySearchOption', 'NEEDLE');
    if (!text) this.check(this.ex.ghostty_search_set(this.handle, key, 0));
    else {
      const bytes = new TextEncoder().encode(text);
      this.withBuffer(bytes.length, (data) =>
        this.withBuffer(this.abi.size('GhosttyString'), (str) => {
          new Uint8Array(this.ex.memory.buffer, data, bytes.length).set(bytes);
          const view = new DataView(this.ex.memory.buffer);
          view.setUint32(str + this.abi.offset('GhosttyString', 'ptr'), data, true);
          view.setUint32(str + this.abi.offset('GhosttyString', 'len'), bytes.length, true);
          this.check(this.ex.ghostty_search_set(this.handle, key, str));
        })
      );
    }
    this.needle = text;
  }
  run(): void {
    if (this.handle && this.needle) this.check(this.ex.ghostty_search_run(this.handle));
  }
  private read(key: string): number {
    if (!this.handle) return -1;
    return this.withBuffer(4, (ptr) =>
      this.ex.ghostty_search_get(this.handle, this.abi.enumValue('GhosttySearchData', key), ptr) ===
      0
        ? new DataView(this.ex.memory.buffer).getUint32(ptr, true)
        : -1
    );
  }
  get count(): number {
    return Math.max(0, this.read('TOTAL_MATCHES'));
  }
  get index(): number {
    return this.read('SELECTED_INDEX');
  }
  select(older = true): boolean {
    if (!this.handle || !this.needle) return false;
    return (
      (older
        ? this.ex.ghostty_search_select_next(this.handle)
        : this.ex.ghostty_search_select_prev(this.handle)) === 0
    );
  }
  selectedMatch(): SearchMatch | null {
    if (!this.handle) return null;
    return this.withBuffer(this.abi.size('GhosttySelection'), (selection) => {
      if (
        this.ex.ghostty_search_get(
          this.handle,
          this.abi.enumValue('GhosttySearchData', 'SELECTED_MATCH'),
          selection
        ) !== 0
      )
        return null;
      return this.withBuffer(this.abi.size('GhosttyPointCoordinate'), (coord) => {
        const point = (field: string) => {
          const ref = selection + this.abi.offset('GhosttySelection', field);
          if (
            this.ex.ghostty_terminal_point_from_grid_ref(
              this.terminal,
              ref,
              this.abi.enumValue('GhosttyPointTag', 'SCREEN'),
              coord
            ) !== 0
          )
            return null;
          const view = new DataView(this.ex.memory.buffer);
          return {
            x: view.getUint16(coord + this.abi.offset('GhosttyPointCoordinate', 'x'), true),
            y: view.getUint32(coord + this.abi.offset('GhosttyPointCoordinate', 'y'), true),
          };
        };
        const start = point('start'),
          end = point('end');
        if (!start || !end) return null;
        return { startCol: start.x, startRow: start.y, endCol: end.x, endRow: end.y };
      });
    });
  }
  dispose(): void {
    if (this.handle) {
      this.ex.ghostty_search_free(this.handle);
      this.handle = 0;
      this.released();
    }
  }
}
