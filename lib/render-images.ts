// Resolved image snapshot/cache adapted from NimbleMarkets 5d75d88 (MIT).
import type { AbiLayout } from './abi';
import { KittyGraphicsData, KittyGraphicsImageData, RenderStateData, TerminalData } from './types';
import type { GhosttyWasmExports, KittyImagePixels } from './types';

/** A resolved, viewport-relative rectangle. All geometry is in CSS pixels/cells. */
export interface RenderImage {
  imageId: number;
  generation: bigint;
  layer: number;
  z: number;
  viewportCol: number;
  viewportRow: number;
  offsetX: number;
  offsetY: number;
  pixelWidth: number;
  pixelHeight: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
}

/** A synchronous render snapshot; consume pixels before the next terminal mutation. */
export interface ImageFrame {
  /** Changes when geometry, image contents, pixel availability or terminal changes. */
  revision: number;
  placements: readonly RenderImage[];
  pixels(imageId: number): KittyImagePixels | null;
}

/** Merge adjacent, identically scaled strips without changing their draw order. */
export function coalesceImageRuns(
  placements: readonly RenderImage[],
  cellWidth: number,
  cellHeight: number
): RenderImage[] {
  const result: RenderImage[] = [];
  for (const p of placements) {
    const prev = result[result.length - 1];
    if (
      prev &&
      prev.imageId === p.imageId &&
      prev.generation === p.generation &&
      prev.layer === p.layer &&
      prev.z === p.z &&
      prev.viewportCol * cellWidth + prev.offsetX === p.viewportCol * cellWidth + p.offsetX &&
      prev.viewportRow * cellHeight + prev.offsetY + prev.pixelHeight ===
        p.viewportRow * cellHeight + p.offsetY &&
      prev.pixelWidth === p.pixelWidth &&
      prev.sourceX === p.sourceX &&
      prev.sourceWidth === p.sourceWidth &&
      prev.sourceY + prev.sourceHeight === p.sourceY &&
      prev.pixelHeight * p.sourceHeight === p.pixelHeight * prev.sourceHeight
    ) {
      prev.pixelHeight += p.pixelHeight;
      prev.sourceHeight += p.sourceHeight;
    } else result.push({ ...p });
  }
  return result;
}

let nextRevision = 0;

/** Copies the shared render state image list; text and images share dirty tracking. */
export class RenderImages {
  private iterator = 0;
  private scratch = 0;
  private lastKey = '';
  private frameKey = '';
  private frame?: ImageFrame;
  private placements: RenderImage[] = [];
  private placementGeneration = -1n;
  private cachedBytes = 0;
  private pixelCache = new Map<string, KittyImagePixels>();

  constructor(
    private wasm: GhosttyWasmExports,
    private terminal: number,
    private state: number,
    private updateState: () => void,
    private cellSize: () => { width: number; height: number },
    private readPixels: (graphics: number, id: number) => KittyImagePixels | null,
    private abi: AbiLayout
  ) {}

  private init(): void {
    if (this.scratch) return;
    this.scratch = this.wasm.ghostty_wasm_alloc(256);
    if (!this.scratch) throw new Error('Cannot allocate image scratch space');
    const w = this.wasm;
    try {
      if (w.ghostty_render_state_image_iterator_new(0, this.scratch) !== 0)
        throw new Error('Cannot allocate image iterator');
      this.iterator = this.view().getUint32(this.scratch, true);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private view(): DataView {
    return new DataView(this.wasm.memory.buffer);
  }

  private graphics(): number {
    if (
      this.wasm.ghostty_terminal_get(this.terminal, TerminalData.KITTY_GRAPHICS, this.scratch) !== 0
    )
      return 0;
    return this.view().getUint32(this.scratch, true);
  }

  private generation(graphics: number): bigint {
    if (
      !graphics ||
      this.wasm.ghostty_kitty_graphics_get(graphics, KittyGraphicsData.GENERATION, this.scratch) !==
        0
    )
      return 0n;
    return this.view().getBigUint64(this.scratch, true);
  }

  private scroll(tag: number, delta = 0): void {
    // GhosttyTerminalScrollViewport: tag@0, 8-byte-aligned union@8 (24 bytes).
    const view = this.view();
    const size = this.abi.size('GhosttyTerminalScrollViewport');
    if (size > 64) throw new Error('Unsupported image viewport ABI');
    new Uint8Array(this.wasm.memory.buffer, this.scratch, size).fill(0);
    view.setUint32(
      this.scratch + this.abi.offset('GhosttyTerminalScrollViewport', 'tag'),
      tag,
      true
    );
    view.setInt32(
      this.scratch + this.abi.offset('GhosttyTerminalScrollViewport', 'value'),
      delta,
      true
    );
    this.wasm.ghostty_terminal_scroll_viewport(this.terminal, this.scratch);
  }

  getFrame(epoch: number, viewportY: number): ImageFrame {
    this.init();
    if (this.frame && `${epoch}:${viewportY}` === this.lastKey) return this.frame;
    // RenderState consumes terminal dirty flags: never use competing snapshots.
    // Temporarily capture history, copy its image list, then restore active rows
    // for the existing text API. No borrowed iterator data survives this call.
    try {
      if (viewportY > 0) {
        this.scroll(1);
        this.scroll(2, -Math.floor(viewportY));
      }
      return this.captureFrame(epoch, viewportY);
    } finally {
      if (viewportY > 0) {
        this.scroll(1);
        this.updateState();
      }
    }
  }

  private captureFrame(epoch: number, viewportY: number): ImageFrame {
    this.init();
    const key = `${epoch}:${viewportY}`;
    if (this.frame && key === this.lastKey) return this.frame;
    const w = this.wasm;
    const graphics = this.graphics();
    const storageGeneration = this.generation(graphics);
    w.ghostty_terminal_get(this.terminal, TerminalData.ACTIVE_SCREEN, this.scratch);
    const screen = this.view().getUint32(this.scratch, true);
    this.updateState();
    w.ghostty_render_state_get(
      this.state,
      RenderStateData.IMAGE_PLACEMENTS_GENERATION,
      this.scratch
    );
    const generation = this.view().getBigUint64(this.scratch, true);
    if (generation !== this.placementGeneration) {
      this.view().setUint32(this.scratch, this.iterator, true);
      w.ghostty_render_state_get(this.state, RenderStateData.IMAGE_ITERATOR, this.scratch);
      const placements: RenderImage[] = [];
      // One batched getter per rectangle; slots are 8-byte aligned for uint64_t.
      const keys = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 16, 17];
      for (let i = 0; i < keys.length; i++) {
        this.view().setUint32(this.scratch + i * 4, keys[i]!, true);
        this.view().setUint32(this.scratch + 64 + i * 4, this.scratch + 128 + i * 8, true);
      }
      while (
        placements.length < 10000 &&
        w.ghostty_render_state_image_iterator_next(this.iterator)
      ) {
        if (
          w.ghostty_render_state_image_get_multi(
            this.iterator,
            keys.length,
            this.scratch,
            this.scratch + 64,
            0
          ) !== 0
        )
          continue;
        const v = this.view();
        const u = (i: number) => v.getUint32(this.scratch + 128 + i * 8, true);
        const s = (i: number) => v.getInt32(this.scratch + 128 + i * 8, true);
        if (u(0) !== 0) continue;
        placements.push({
          imageId: u(1),
          generation: v.getBigUint64(this.scratch + 144, true),
          layer: u(3),
          z: s(4),
          viewportCol: s(5),
          viewportRow: s(6),
          offsetX: u(7),
          offsetY: u(8),
          pixelWidth: u(9),
          pixelHeight: u(10),
          sourceX: u(11),
          sourceY: u(12),
          sourceWidth: u(13),
          sourceHeight: u(14),
        });
      }
      placements.sort((a, b) => a.layer - b.layer || a.z - b.z);
      const size = this.cellSize();
      this.placements = coalesceImageRuns(placements, size.width, size.height);
      this.placementGeneration = generation;
    }
    // Placement generation tracks geometry only. Animation updates image generations
    // without changing rectangles, so refresh content stamps independently.
    const imageGenerations = new Map<number, bigint>();
    for (const p of this.placements) {
      if (imageGenerations.has(p.imageId)) continue;
      const image = w.ghostty_kitty_graphics_image(graphics, p.imageId);
      if (
        image &&
        w.ghostty_kitty_graphics_image_get(
          image,
          KittyGraphicsImageData.GENERATION,
          this.scratch
        ) === 0
      )
        imageGenerations.set(p.imageId, this.view().getBigUint64(this.scratch, true));
    }
    this.placements = this.placements.map((p) => ({
      ...p,
      generation: imageGenerations.get(p.imageId) ?? p.generation,
    }));
    const frameKey = `${screen}:${generation}:${storageGeneration}:${viewportY}`;
    if (!this.frame || frameKey !== this.frameKey) {
      const generations = new Map(this.placements.map((p) => [p.imageId, p.generation]));
      const retained = new Set([...generations].map(([id, gen]) => `${screen}:${id}:${gen}`));
      for (const [key, pixels] of this.pixelCache) {
        if (!retained.has(key)) {
          this.cachedBytes -= pixels.data.byteLength;
          this.pixelCache.delete(key);
        }
      }
      const pixels = (id: number): KittyImagePixels | null => {
        const gen = generations.get(id);
        if (gen === undefined) return null;
        const cacheKey = `${screen}:${id}:${gen}`;
        const cached = this.pixelCache.get(cacheKey);
        if (cached) return cached;
        // Never retain borrowed WASM memory across writes, ticks or memory growth.
        const raw = this.readPixels(this.graphics(), id);
        if (!raw) return null;
        if (this.cachedBytes + raw.data.byteLength > 64 * 1024 * 1024) return null;
        const value = { ...raw, data: raw.data.slice(), revision: ++nextRevision };
        this.pixelCache.set(cacheKey, value);
        this.cachedBytes += value.data.byteLength;
        return value;
      };
      this.frame = { revision: ++nextRevision, placements: this.placements, pixels };
      this.frameKey = frameKey;
    }
    this.lastKey = key;
    return this.frame;
  }

  /** Returns the next deadline on the caller's monotonic millisecond clock. */
  tick(now: number): { next: number | null; changed: boolean } {
    this.init();
    const graphics = this.graphics();
    if (!graphics) return { next: null, changed: false };
    const before = this.generation(graphics);
    const result = this.wasm.ghostty_kitty_graphics_animation_tick(
      graphics,
      BigInt(Math.floor(now)),
      this.scratch
    );
    const next = result === 0 ? Number(this.view().getBigUint64(this.scratch, true)) : null;
    const changed = before !== this.generation(this.graphics());
    if (changed) this.lastKey = '';
    return { next, changed };
  }

  dispose(): void {
    if (this.iterator) this.wasm.ghostty_render_state_image_iterator_free(this.iterator);
    if (this.scratch) this.wasm.ghostty_wasm_free(this.scratch, 256);
    this.iterator = this.scratch = 0;
    this.pixelCache.clear();
    this.cachedBytes = 0;
  }
}
