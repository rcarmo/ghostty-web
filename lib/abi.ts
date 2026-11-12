// Layout reader adapted from rundel/ghostterm (MIT), 0708fc36.
import * as C from './types';
import type { GhosttyWasmExports } from './types';
/**
 * Layout information for the libghostty-vt WebAssembly module.
 *
 * libghostty-vt publishes a machine-readable description of its C ABI through
 * `ghostty_type_json()`: struct sizes and field offsets, and the bit positions
 * inside packed values such as `GhosttyCell`. Bit positions of packed values are
 * explicitly not covered by the ABI promise, so they are read from the manifest
 * of the loaded module instead of being hard-coded here.
 */

interface ManifestField {
  offset: number;
  size: number;
  type: string;
}

interface ManifestBits {
  lsb: number;
  width: number;
}

interface ManifestType {
  kind: string;
  size?: number;
  align?: number;
  fields?: Record<string, ManifestField>;
  bits?: Record<string, ManifestBits & Record<string, unknown>>;
  values?: Record<string, number>;
}

interface Manifest {
  abi: { pointer_size: number; usize_size: number; endian: string };
  library_version?: string;
  types: Record<string, ManifestType>;
}

/** A bit field inside a packed value of up to 64 bits. */
export interface BitField {
  lsb: number;
  width: number;
}

/**
 * Read `width` bits starting at `lsb` from a 64-bit value given as its low and
 * high 32-bit halves. Fields wider than 32 bits are not supported.
 */
export function readBits(lo: number, hi: number, field: BitField): number {
  const { lsb, width } = field;
  const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
  if (lsb >= 32) return (hi >>> (lsb - 32)) & mask;
  if (lsb + width <= 32) return (lo >>> lsb) & mask;
  const loBits = 32 - lsb;
  return ((lo >>> lsb) | (hi << loBits)) & mask;
}

export class AbiLayout {
  readonly version: string | undefined;
  private types: Record<string, ManifestType>;

  constructor(json: string) {
    const manifest = JSON.parse(json) as Manifest;
    if (
      !manifest.abi ||
      manifest.abi.pointer_size !== 4 ||
      manifest.abi.usize_size !== 4 ||
      manifest.abi.endian !== 'little' ||
      !manifest.types
    ) {
      throw new Error(
        `Unsupported libghostty-vt ABI: pointer size ${manifest.abi?.pointer_size}, ${manifest.abi?.endian} endian`
      );
    }
    this.version = manifest.library_version;
    this.types = manifest.types;
  }

  private type(name: string): ManifestType {
    const t = this.types[name];
    if (!t) throw new Error(`libghostty-vt manifest has no type ${name}`);
    return t;
  }

  /** Size in bytes of a type. */
  size(name: string): number {
    const size = this.type(name).size;
    if (!Number.isSafeInteger(size) || size! <= 0 || size! > 1024 * 1024)
      throw new Error(`Invalid libghostty-vt size for ${name}`);
    return size!;
  }

  /** Byte offset of a struct field. */
  offset(struct: string, field: string): number {
    const f = this.type(struct).fields?.[field];
    if (!f) throw new Error(`libghostty-vt struct ${struct} has no field ${field}`);
    if (
      !Number.isSafeInteger(f.offset) ||
      !Number.isSafeInteger(f.size) ||
      f.offset < 0 ||
      f.size <= 0 ||
      f.offset + f.size > this.size(struct)
    )
      throw new Error(`Invalid libghostty-vt field ${struct}.${field}`);
    return f.offset;
  }

  expectFieldSize(struct: string, field: string, size: number): void {
    this.offset(struct, field);
    if (this.type(struct).fields![field].size !== size)
      throw new Error(`Unsupported libghostty-vt field representation ${struct}.${field}`);
  }

  /** Bit position of a field in a packed type. */
  bits(packed: string, field: string): BitField {
    const b = this.type(packed).bits?.[field];
    if (!b) throw new Error(`libghostty-vt packed type ${packed} has no field ${field}`);
    if (
      !Number.isSafeInteger(b.lsb) ||
      !Number.isSafeInteger(b.width) ||
      b.lsb < 0 ||
      b.width <= 0 ||
      b.width > 32 ||
      b.lsb + b.width > this.size(packed) * 8
    )
      throw new Error(`Invalid libghostty-vt bits ${packed}.${field}`);
    return { lsb: b.lsb, width: b.width };
  }

  enumValue(name: string, value: string): number {
    const result = this.type(name).values?.[value];
    if (!Number.isSafeInteger(result))
      throw new Error(`Missing libghostty-vt enum ${name}.${value}`);
    return result!;
  }

  validateEnum(name: string, values: object, aliases: Record<string, string> = {}): void {
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'number') continue;
      if (this.enumValue(name, aliases[key] ?? key) !== value)
        throw new Error(`Incompatible libghostty-vt selector ${name}.${key}`);
    }
  }

  /** Bit position of a field nested inside a union arm of a packed type. */
  unionBits(packed: string, field: string, arm: string, inner: string): BitField {
    const outer = this.type(packed).bits?.[field] as
      | (ManifestBits & { arms?: Record<string, { bits: Record<string, ManifestBits> }> })
      | undefined;
    const b = outer?.arms?.[arm]?.bits?.[inner];
    if (!outer || !b) {
      throw new Error(`libghostty-vt packed type ${packed} has no ${field}.${arm}.${inner}`);
    }
    return { lsb: outer.lsb + b.lsb, width: b.width };
  }
}

const layouts = new WeakMap<object, AbiLayout>();

/** Read and cache the actual loaded module's manifest before allocating handles. */
export function moduleAbi(exports: GhosttyWasmExports): AbiLayout {
  const cached = layouts.get(exports);
  if (cached) return cached;
  if (typeof exports.ghostty_type_json !== 'function')
    throw new Error('libghostty-vt has no ABI manifest');
  const start = exports.ghostty_type_json();
  const bytes = new Uint8Array(exports.memory.buffer);
  if (!Number.isSafeInteger(start) || start <= 0 || start >= bytes.length)
    throw new Error('Invalid libghostty-vt manifest pointer');
  const limit = Math.min(bytes.length, start + 4 * 1024 * 1024);
  let end = start;
  while (end < limit && bytes[end] !== 0) end++;
  if (end === limit) throw new Error('Unterminated or oversized libghostty-vt manifest');
  const abi = new AbiLayout(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end))
  );
  const tables: [string, object, Record<string, string>?][] = [
    ['GhosttyTerminalOption', C.TerminalOption],
    ['GhosttyCursorStyle', C.CursorVisualStyle],
    ['GhosttyRenderStateDirty', C.DirtyState, { NONE: 'FALSE' }],
    ['GhosttyTerminalScreen', C.TerminalScreen],
    ['GhosttyKittyImageFormat', C.KittyImageFormat],
    ['GhosttyTerminalData', C.TerminalData, { CURSOR_STYLE: 'CURSOR_SGR_STYLE' }],
    ['GhosttySysOption', C.SysOption],
    ['GhosttyRenderStateData', C.RenderStateData],
    ['GhosttyRenderStateOption', C.RenderStateOption],
    ['GhosttyRenderStateRowData', C.RenderStateRowData],
    ['GhosttyRenderStateRowOption', C.RenderStateRowOption],
    ['GhosttyRenderStateRowCellsData', C.RowCellsData],
    ['GhosttyRowData', C.RowData],
    ['GhosttyCellData', C.CellData],
    ['GhosttyCellWide', C.CellWide],
    ['GhosttyPointTag', C.PointTag],
    ['GhosttyKeyEncoderOption', C.KeyEncoderOption, { KITTY_KEYBOARD_FLAGS: 'KITTY_FLAGS' }],
    ['GhosttyKittyGraphicsData', C.KittyGraphicsData],
    ['GhosttyKittyGraphicsPlacementData', C.KittyGraphicsPlacementData],
    ['GhosttyKittyGraphicsImageData', C.KittyGraphicsImageData],
  ];
  for (const [name, values, aliases] of tables) abi.validateEnum(name, values, aliases);
  if (abi.size('GhosttyCell') !== 8 || ![1, 2, 4].includes(abi.size('GhosttyStyleFlags')))
    throw new Error('Unsupported libghostty-vt cell/flags representation');
  // Layout offsets may move; scalar representations used by DataView must not.
  const fields: Record<string, Record<string, number>> = {
    GhosttyString: { ptr: 4, len: 4 },
    GhosttyTerminalScrollbar: { total: 8, offset: 8, len: 8 },
    GhosttyTerminalScrollViewport: { tag: 4, value: 16 },
    GhosttyColorRgb: { r: 1, g: 1, b: 1 },
    GhosttyPointCoordinate: { x: 2, y: 4 },
    GhosttyGridRef: { node: 4, x: 2, y: 2 },
    GhosttyTerminalModeConfig: { mode: 2, value: 1 },
    GhosttyStyleColor: { tag: 1 },
    GhosttyCodepointBuffer: { ptr: 4, cap: 4, len: 4 },
    GhosttySysImage: { width: 4, height: 4, data: 4, data_len: 4 },
    GhosttySizeReportSize: { rows: 2, columns: 2, cell_width: 4, cell_height: 4 },
    GhosttyKittyGraphicsPlacementRenderInfo: {
      size: 4,
      pixel_width: 4,
      pixel_height: 4,
      grid_cols: 4,
      grid_rows: 4,
      viewport_col: 4,
      viewport_row: 4,
      viewport_visible: 1,
      source_x: 4,
      source_y: 4,
      source_width: 4,
      source_height: 4,
    },
  };
  for (const [type, entries] of Object.entries(fields))
    for (const [field, size] of Object.entries(entries)) abi.expectFieldSize(type, field, size);
  layouts.set(exports, abi);
  return abi;
}
