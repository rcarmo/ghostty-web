import { describe, expect, test } from "bun:test";
import type { GlyphAtlas } from "./GlyphAtlas";
import { CellBuffer } from "./CellBuffer";
import { DirtyState, ROW_DIRTY, type GhosttyCell, type RenderInput } from "./types";

class FakeWebGLBuffer {}

class FakeGL {
  readonly ARRAY_BUFFER = 0x8892;
  readonly DYNAMIC_DRAW = 0x88e8;

  createBuffer(): WebGLBuffer {
    return new FakeWebGLBuffer() as unknown as WebGLBuffer;
  }

  bindBuffer(): void {}

  bufferData(): void {}

  bufferSubData(): void {}
}

function createCell(overrides: Partial<GhosttyCell> = {}): GhosttyCell {
  return {
    codepoint: 32,
    fg_r: 255,
    fg_g: 255,
    fg_b: 255,
    bg_r: 0,
    bg_g: 0,
    bg_b: 0,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
    ...overrides,
  };
}

function createInput(): RenderInput {
  const cells = [createCell({ codepoint: 2325, grapheme_len: 1 }), createCell()];
  return {
    cols: 2,
    rows: 1,
    viewportCells: cells,
    graphemeRows: [["क्"]],
    rowFlags: new Uint8Array([ROW_DIRTY]),
    dirtyState: DirtyState.PARTIAL,
    selectionRange: null,
    hoveredLink: null,
    cursorX: 0,
    cursorY: 0,
    cursorVisible: false,
    cursorStyle: "block",
    theme: {
      foreground: { r: 255, g: 255, b: 255, a: 1 },
      background: { r: 0, g: 0, b: 0, a: 1 },
      cursor: { r: 255, g: 255, b: 255, a: 1 },
      cursorAccent: { r: 0, g: 0, b: 0, a: 1 },
      selectionBackground: { r: 64, g: 96, b: 192, a: 1 },
      selectionForeground: null,
      selectionOpacity: 0.4,
    },
    viewportY: 0,
    scrollbackLength: 0,
    scrollbarOpacity: 0,
  };
}

describe("CellBuffer", () => {
  test("uses pre-resolved grapheme rows without calling legacy callback", () => {
    const gl = new FakeGL() as unknown as WebGL2RenderingContext;
    const buffer = new CellBuffer(gl);
    const input = createInput();

    let callbackCalls = 0;
    input.getGraphemeString = () => {
      callbackCalls += 1;
      return "SHOULD_NOT_BE_USED";
    };

    const atlasCalls: string[] = [];
    const atlas = {
      getGlyph: (grapheme: string) => {
        atlasCalls.push(grapheme);
        return {
          atlasX: 1,
          atlasY: 1,
          atlasW: 1,
          atlasH: 1,
          bearingX: 0,
          bearingY: 0,
          width: 1,
          height: 1,
          isColor: false,
        };
      },
    } as unknown as GlyphAtlas;

    buffer.update(input, atlas, false);

    expect(callbackCalls).toBe(0);
    expect(atlasCalls).toContain("क्");
  });

  test("falls back per-row when forced full upload sees sparse grapheme rows", () => {
    const gl = new FakeGL() as unknown as WebGL2RenderingContext;
    const buffer = new CellBuffer(gl);
    const cells = [
      createCell({ codepoint: 2325, grapheme_len: 1 }),
      createCell(),
      createCell({ codepoint: 2336, grapheme_len: 1 }),
      createCell(),
    ];
    const input: RenderInput = {
      cols: 2,
      rows: 2,
      viewportCells: cells,
      graphemeRows: [["क्"]],
      rowFlags: new Uint8Array([ROW_DIRTY, 0]),
      dirtyState: DirtyState.PARTIAL,
      selectionRange: null,
      hoveredLink: null,
      cursorX: 0,
      cursorY: 0,
      cursorVisible: false,
      cursorStyle: "block",
      theme: {
        foreground: { r: 255, g: 255, b: 255, a: 1 },
        background: { r: 0, g: 0, b: 0, a: 1 },
        cursor: { r: 255, g: 255, b: 255, a: 1 },
        cursorAccent: { r: 0, g: 0, b: 0, a: 1 },
        selectionBackground: { r: 64, g: 96, b: 192, a: 1 },
        selectionForeground: null,
        selectionOpacity: 0.4,
      },
      viewportY: 0,
      scrollbackLength: 0,
      scrollbarOpacity: 0,
      getGraphemeString: (row, col) => (row === 1 && col === 0 ? "क्ष" : ""),
    };

    const atlasCalls: string[] = [];
    const atlas = {
      getGlyph: (grapheme: string) => {
        atlasCalls.push(grapheme);
        return {
          atlasX: 1,
          atlasY: 1,
          atlasW: 1,
          atlasH: 1,
          bearingX: 0,
          bearingY: 0,
          width: 1,
          height: 1,
          isColor: false,
        };
      },
    } as unknown as GlyphAtlas;

    buffer.update(input, atlas, true);

    expect(atlasCalls).toContain("क्");
    expect(atlasCalls).toContain("क्ष");
  });

  test("skips legacy row scans for sparse grapheme rows on forced full upload", () => {
    const gl = new FakeGL() as unknown as WebGL2RenderingContext;
    const buffer = new CellBuffer(gl);

    let callbackCalls = 0;
    const input: RenderInput = {
      cols: 2,
      rows: 2,
      viewportCells: [createCell(), createCell(), createCell(), createCell()],
      graphemeRows: [undefined, undefined],
      rowFlags: new Uint8Array([ROW_DIRTY, ROW_DIRTY]),
      dirtyState: DirtyState.PARTIAL,
      selectionRange: null,
      hoveredLink: null,
      cursorX: 0,
      cursorY: 0,
      cursorVisible: false,
      cursorStyle: "block",
      theme: {
        foreground: { r: 255, g: 255, b: 255, a: 1 },
        background: { r: 0, g: 0, b: 0, a: 1 },
        cursor: { r: 255, g: 255, b: 255, a: 1 },
        cursorAccent: { r: 0, g: 0, b: 0, a: 1 },
        selectionBackground: { r: 64, g: 96, b: 192, a: 1 },
        selectionForeground: null,
        selectionOpacity: 0.4,
      },
      viewportY: 0,
      scrollbackLength: 0,
      scrollbarOpacity: 0,
      getGraphemeString: () => {
        callbackCalls += 1;
        return "SHOULD_NOT_BE_USED";
      },
    };

    let legacyRowScans = 0;
    (buffer as any).resolveLegacyGraphemeRow = () => {
      legacyRowScans += 1;
      return ["unexpected", "unexpected"];
    };

    const atlas = {
      getGlyph: () => {
        throw new Error("getGlyph should not be called for ASCII spaces");
      },
    } as unknown as GlyphAtlas;

    buffer.update(input, atlas, true);

    expect(legacyRowScans).toBe(0);
    expect(callbackCalls).toBe(0);
  });
});
