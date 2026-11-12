import type { AbiLayout } from './abi';
import type { GhosttyWasmExports } from './types';

export interface CoreSelectionRange {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
  rectangle: boolean;
}

/** The terminal core owns selected pins; JS owns only gesture policy. */
export class CoreSelection {
  constructor(
    private ex: GhosttyWasmExports,
    private abi: AbiLayout,
    private terminal: number
  ) {}
  private buffers<T>(types: string[], action: (pointers: number[]) => T): T {
    const pointers: number[] = [];
    try {
      for (const type of types) {
        const ptr = this.ex.ghostty_wasm_alloc(this.abi.size(type));
        if (!ptr) throw new Error('Failed to allocate selection buffer');
        pointers.push(ptr);
      }
      return action(pointers);
    } finally {
      for (let i = 0; i < pointers.length; i++)
        this.ex.ghostty_wasm_free(pointers[i], this.abi.size(types[i]));
    }
  }
  clear(): void {
    this.ex.ghostty_terminal_set(
      this.terminal,
      this.abi.enumValue('GhosttyTerminalOption', 'SELECTION'),
      0
    );
  }
  set(range: CoreSelectionRange): boolean {
    if (
      Object.entries(range).some(
        ([key, value]) => key !== 'rectangle' && (!Number.isSafeInteger(value) || Number(value) < 0)
      )
    )
      return false;
    return this.buffers(['GhosttySelection', 'GhosttyPoint'], ([selection, point]) => {
      this.ex.memory &&
        new Uint8Array(this.ex.memory.buffer, selection, this.abi.size('GhosttySelection')).fill(0);
      const ref = (field: string, col: number, row: number) => {
        const view = new DataView(this.ex.memory.buffer);
        new Uint8Array(this.ex.memory.buffer, point, this.abi.size('GhosttyPoint')).fill(0);
        view.setUint32(
          point + this.abi.offset('GhosttyPoint', 'tag'),
          this.abi.enumValue('GhosttyPointTag', 'SCREEN'),
          true
        );
        const coordinate = point + this.abi.offset('GhosttyPoint', 'value');
        view.setUint16(coordinate + this.abi.offset('GhosttyPointCoordinate', 'x'), col, true);
        view.setUint32(coordinate + this.abi.offset('GhosttyPointCoordinate', 'y'), row, true);
        return (
          this.ex.ghostty_terminal_grid_ref(
            this.terminal,
            point,
            selection + this.abi.offset('GhosttySelection', field)
          ) === 0
        );
      };
      if (!ref('start', range.startCol, range.startRow) || !ref('end', range.endCol, range.endRow))
        return false;
      new DataView(this.ex.memory.buffer).setUint8(
        selection + this.abi.offset('GhosttySelection', 'rectangle'),
        range.rectangle ? 1 : 0
      );
      return (
        this.ex.ghostty_terminal_set(
          this.terminal,
          this.abi.enumValue('GhosttyTerminalOption', 'SELECTION'),
          selection
        ) === 0
      );
    });
  }
  range(): CoreSelectionRange | null {
    return this.buffers(
      ['GhosttySelection', 'GhosttySelection', 'GhosttyPointCoordinate'],
      ([selection, ordered, point]) => {
        if (
          this.ex.ghostty_terminal_get(
            this.terminal,
            this.abi.enumValue('GhosttyTerminalData', 'SELECTION'),
            selection
          ) !== 0
        )
          return null;
        if (
          this.ex.ghostty_terminal_selection_ordered(
            this.terminal,
            selection,
            this.abi.enumValue('GhosttySelectionOrder', 'FORWARD'),
            ordered
          ) !== 0
        )
          return null;
        const coordinate = (field: string) => {
          if (
            this.ex.ghostty_terminal_point_from_grid_ref(
              this.terminal,
              ordered + this.abi.offset('GhosttySelection', field),
              this.abi.enumValue('GhosttyPointTag', 'SCREEN'),
              point
            ) !== 0
          )
            return null;
          const view = new DataView(this.ex.memory.buffer);
          return {
            x: view.getUint16(point + this.abi.offset('GhosttyPointCoordinate', 'x'), true),
            y: view.getUint32(point + this.abi.offset('GhosttyPointCoordinate', 'y'), true),
          };
        };
        const start = coordinate('start'),
          end = coordinate('end');
        if (!start || !end) return null;
        const rectangular =
          new DataView(this.ex.memory.buffer).getUint8(
            ordered + this.abi.offset('GhosttySelection', 'rectangle')
          ) !== 0;
        if (rectangular) {
          const left = Math.min(start.x, end.x),
            right = Math.max(start.x, end.x),
            top = Math.min(start.y, end.y),
            bottom = Math.max(start.y, end.y);
          start.x = left;
          end.x = right;
          start.y = top;
          end.y = bottom;
        }
        return {
          startCol: start.x,
          startRow: start.y,
          endCol: end.x,
          endRow: end.y,
          rectangle:
            new DataView(this.ex.memory.buffer).getUint8(
              ordered + this.abi.offset('GhosttySelection', 'rectangle')
            ) !== 0,
        };
      }
    );
  }
  text(): string {
    return this.buffers(['GhosttySelection', 'GhosttyString'], ([selection, slot]) => {
      if (
        this.ex.ghostty_terminal_get(
          this.terminal,
          this.abi.enumValue('GhosttyTerminalData', 'SELECTION'),
          selection
        ) !== 0
      )
        return '';
      if (this.ex.ghostty_formatter_terminal_new(0, slot, this.terminal) !== 0)
        throw new Error('Failed to create selection formatter');
      const formatter = new DataView(this.ex.memory.buffer).getUint32(slot, true);
      try {
        for (const [key, value] of [
          ['EMIT', this.abi.enumValue('GhosttyFormatterFormat', 'PLAIN')],
          ['TRIM', 1],
          ['UNWRAP', 1],
        ] as const) {
          new DataView(this.ex.memory.buffer).setUint32(slot, value, true);
          if (
            this.ex.ghostty_formatter_set(
              formatter,
              this.abi.enumValue('GhosttyFormatterOption', key),
              slot
            ) !== 0
          )
            throw new Error('Selection formatting failed');
        }
        if (
          this.ex.ghostty_formatter_set(
            formatter,
            this.abi.enumValue('GhosttyFormatterOption', 'SELECTION'),
            selection
          ) !== 0
        )
          return '';
        const code = this.ex.ghostty_formatter_format_buf(formatter, 0, 0, slot);
        if (code !== 0 && code !== -3) throw new Error('Selection measurement failed');
        const length = new DataView(this.ex.memory.buffer).getUint32(slot, true);
        if (length > 1024 * 1024) throw new Error('Selection exceeds 1 MiB');
        if (!length) return '';
        const output = this.ex.ghostty_wasm_alloc(length);
        if (!output) throw new Error('Failed to allocate selection text');
        try {
          if (this.ex.ghostty_formatter_format_buf(formatter, output, length, slot) !== 0)
            throw new Error('Selection formatting failed');
          return new TextDecoder().decode(new Uint8Array(this.ex.memory.buffer, output, length));
        } finally {
          this.ex.ghostty_wasm_free(output, length);
        }
      } finally {
        this.ex.ghostty_formatter_free(formatter);
      }
    });
  }
}
