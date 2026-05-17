import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlyphAtlas } from "./GlyphAtlas";

class FakeTexture {}

class FakeCanvasContext2D {
  font = "";
  textBaseline = "alphabetic";
  textAlign = "left";
  fillStyle = "#fff";

  measureText(text: string): TextMetrics {
    if (text === "TallGlyph") {
      return {
        width: 8,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: 8,
        actualBoundingBoxAscent: 18,
        actualBoundingBoxDescent: 2,
      } as TextMetrics;
    }

    return {
      width: 8,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 8,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
    } as TextMetrics;
  }

  clearRect(): void {}

  fillText(): void {}

  getImageData(_x: number, _y: number, width: number, height: number): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 3; i < data.length; i += 4) {
      data[i] = 255;
    }
    return { data, width, height } as ImageData;
  }
}

class FakeOffscreenCanvas {
  width: number;
  height: number;
  private readonly ctx = new FakeCanvasContext2D();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext(type: string): OffscreenCanvasRenderingContext2D | null {
    if (type !== "2d") return null;
    return this.ctx as unknown as OffscreenCanvasRenderingContext2D;
  }
}

class FakeGL {
  readonly MAX_TEXTURE_SIZE = 0x0d33;
  readonly TEXTURE_2D = 0x0de1;
  readonly TEXTURE_MIN_FILTER = 0x2801;
  readonly TEXTURE_MAG_FILTER = 0x2800;
  readonly TEXTURE_WRAP_S = 0x2802;
  readonly TEXTURE_WRAP_T = 0x2803;
  readonly CLAMP_TO_EDGE = 0x812f;
  readonly NEAREST = 0x2600;
  readonly R8 = 0x8229;
  readonly RGBA8 = 0x8058;
  readonly TEXTURE0 = 0x84c0;
  readonly TEXTURE1 = 0x84c1;
  readonly UNPACK_ALIGNMENT = 0x0cf5;
  readonly UNPACK_ROW_LENGTH = 0x0cf2;
  readonly UNPACK_FLIP_Y_WEBGL = 0x9240;
  readonly UNPACK_COLORSPACE_CONVERSION_WEBGL = 0x9243;
  readonly NONE = 0;
  readonly UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;
  readonly RGBA = 0x1908;
  readonly UNSIGNED_BYTE = 0x1401;
  readonly RED = 0x1903;

  createTextureCalls = 0;
  deleteTextureCalls = 0;
  texSubImage2DCalls = 0;

  getParameter(param: number): number {
    if (param === this.MAX_TEXTURE_SIZE) return 256;
    return 0;
  }

  createTexture(): WebGLTexture {
    this.createTextureCalls += 1;
    return new FakeTexture() as unknown as WebGLTexture;
  }

  deleteTexture(): void {
    this.deleteTextureCalls += 1;
  }

  activeTexture(): void {}

  bindTexture(): void {}

  texParameteri(): void {}

  texStorage2D(): void {}

  pixelStorei(): void {}

  texSubImage2D(): void {
    this.texSubImage2DCalls += 1;
  }
}

describe("GlyphAtlas", () => {
  const previousOffscreen = (globalThis as any).OffscreenCanvas;

  beforeEach(() => {
    (globalThis as any).OffscreenCanvas = FakeOffscreenCanvas;
  });

  afterEach(() => {
    (globalThis as any).OffscreenCanvas = previousOffscreen;
  });

  test("evicts least-recently-used shelf incrementally without texture rebuild", () => {
    const gl = new FakeGL();
    const atlas = new GlyphAtlas(gl as unknown as WebGL2RenderingContext, 15, "monospace", 1);

    const shelf = { id: 77, y: 0, height: 8, nextX: 64 };
    (atlas as any).page = {
      width: 64,
      height: 64,
      shelves: [shelf],
      nextShelfY: 8,
      nextShelfId: 78,
    };
    (atlas as any).glyphs = new Map([
      [
        "foo",
        {
          key: "foo",
          grapheme: "λ",
          bold: false,
          italic: false,
          isColor: false,
          pinned: false,
          lastUsed: 1,
          shelfId: 77,
          atlasX: 0,
          atlasY: 0,
          atlasW: 8,
          atlasH: 8,
          bearingX: 0,
          bearingY: 0,
          width: 8,
          height: 8,
        },
      ],
    ]);

    const didEvict = (atlas as any).evictLeastRecentlyUsedShelf(false);

    expect(didEvict).toBe(true);
    expect((atlas as any).glyphs.size).toBe(0);
    expect(shelf.nextX).toBe(0);
    expect(gl.deleteTextureCalls).toBe(0);
    expect(gl.texSubImage2DCalls).toBeGreaterThan(0);
  });

  test("does not trigger full texture rebuild when atlas fills", () => {
    const gl = new FakeGL();
    const atlas = new GlyphAtlas(gl as unknown as WebGL2RenderingContext, 15, "monospace", 1);
    const createTextureBaseline = gl.createTextureCalls;

    for (let i = 0; i < 1500; i++) {
      atlas.getGlyph(String.fromCodePoint(0x4e00 + i), false, false);
    }

    expect(gl.deleteTextureCalls).toBe(0);
    expect(gl.createTextureCalls).toBe(createTextureBaseline);
  });

  test("keeps evicting shelves until a glyph can be added", () => {
    const gl = new FakeGL();
    const atlas = new GlyphAtlas(gl as unknown as WebGL2RenderingContext, 15, "monospace", 1);
    let addAttempts = 0;
    let evictions = 0;

    (atlas as any).addGlyph = (request: {
      grapheme: string;
      bold: boolean;
      italic: boolean;
      isColor: boolean;
      pinned: boolean;
    }) => {
      addAttempts += 1;
      if (addAttempts < 5) return null;
      return {
        key: `${request.grapheme}|${request.bold ? "b" : ""}${request.italic ? "i" : ""}|${
          request.isColor ? "c" : "m"
        }|1`,
        grapheme: request.grapheme,
        bold: request.bold,
        italic: request.italic,
        isColor: request.isColor,
        pinned: request.pinned,
        lastUsed: 5,
        shelfId: 9,
        atlasX: 1,
        atlasY: 1,
        atlasW: 1,
        atlasH: 1,
        bearingX: 0,
        bearingY: 0,
        width: 1,
        height: 1,
      };
    };
    (atlas as any).evictLeastRecentlyUsedShelf = () => {
      evictions += 1;
      return evictions <= 4;
    };

    const result = atlas.getGlyph("𐐷", false, false);

    expect(result.width).toBe(1);
    expect(addAttempts).toBe(5);
    expect(evictions).toBe(4);
  });

  test("evicts shelf with oldest newest-use timestamp", () => {
    const gl = new FakeGL();
    const atlas = new GlyphAtlas(gl as unknown as WebGL2RenderingContext, 15, "monospace", 1);
    (atlas as any).page = {
      width: 64,
      height: 64,
      shelves: [
        { id: 1, y: 0, height: 10, nextX: 16 },
        { id: 2, y: 10, height: 10, nextX: 16 },
      ],
      nextShelfY: 20,
      nextShelfId: 3,
    };
    (atlas as any).glyphs = new Map([
      [
        "s1-old",
        {
          key: "s1-old",
          grapheme: "a",
          bold: false,
          italic: false,
          isColor: false,
          pinned: false,
          lastUsed: 1,
          shelfId: 1,
          atlasX: 0,
          atlasY: 0,
          atlasW: 8,
          atlasH: 8,
          bearingX: 0,
          bearingY: 0,
          width: 8,
          height: 8,
        },
      ],
      [
        "s1-new",
        {
          key: "s1-new",
          grapheme: "b",
          bold: false,
          italic: false,
          isColor: false,
          pinned: false,
          lastUsed: 100,
          shelfId: 1,
          atlasX: 0,
          atlasY: 0,
          atlasW: 8,
          atlasH: 8,
          bearingX: 0,
          bearingY: 0,
          width: 8,
          height: 8,
        },
      ],
      [
        "s2-mid",
        {
          key: "s2-mid",
          grapheme: "c",
          bold: false,
          italic: false,
          isColor: false,
          pinned: false,
          lastUsed: 50,
          shelfId: 2,
          atlasX: 0,
          atlasY: 0,
          atlasW: 8,
          atlasH: 8,
          bearingX: 0,
          bearingY: 0,
          width: 8,
          height: 8,
        },
      ],
      [
        "s2-new",
        {
          key: "s2-new",
          grapheme: "d",
          bold: false,
          italic: false,
          isColor: false,
          pinned: false,
          lastUsed: 60,
          shelfId: 2,
          atlasX: 0,
          atlasY: 0,
          atlasW: 8,
          atlasH: 8,
          bearingX: 0,
          bearingY: 0,
          width: 8,
          height: 8,
        },
      ],
    ]);

    const shelf = (atlas as any).findEvictionShelf((atlas as any).page, false);
    expect(shelf?.id).toBe(2);
  });

  test("re-packs page when evictions cannot fit taller glyph into full short-shelf atlas", () => {
    const gl = new FakeGL();
    const atlas = new GlyphAtlas(gl as unknown as WebGL2RenderingContext, 15, "monospace", 1);
    (atlas as any).page = {
      width: 32,
      height: 24,
      shelves: [
        { id: 1, y: 0, height: 12, nextX: 32 },
        { id: 2, y: 12, height: 12, nextX: 32 },
      ],
      nextShelfY: 24,
      nextShelfId: 3,
    };
    (atlas as any).glyphs = new Map([
      [
        "short-1",
        {
          key: "short-1",
          grapheme: "a",
          bold: false,
          italic: false,
          isColor: false,
          pinned: false,
          lastUsed: 1,
          shelfId: 1,
          atlasX: 0,
          atlasY: 0,
          atlasW: 8,
          atlasH: 8,
          bearingX: 0,
          bearingY: 0,
          width: 8,
          height: 8,
        },
      ],
      [
        "short-2",
        {
          key: "short-2",
          grapheme: "b",
          bold: false,
          italic: false,
          isColor: false,
          pinned: false,
          lastUsed: 2,
          shelfId: 2,
          atlasX: 0,
          atlasY: 0,
          atlasW: 8,
          atlasH: 8,
          bearingX: 0,
          bearingY: 0,
          width: 8,
          height: 8,
        },
      ],
    ]);

    const result = atlas.getGlyph("TallGlyph", false, false);

    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.atlasH).toBe(20);
  });
});
