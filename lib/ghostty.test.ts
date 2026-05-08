/**
 * Tests for Ghostty WASM loading helpers
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { Ghostty } from './ghostty';
import { KittyImageFormat } from './types';

// Minimal WebAssembly.Instance stub — satisfies the Ghostty constructor which
// only reads exports.memory at instantiation time.
function makeInstance(): WebAssembly.Instance {
  const memory = new WebAssembly.Memory({ initial: 1 });
  return { exports: { memory } } as unknown as WebAssembly.Instance;
}

function makeModule(): WebAssembly.Module {
  return {} as WebAssembly.Module;
}

describe('Ghostty.loadFromResponse', () => {
  // Spy references — reset after each test
  let streamingSpy: ReturnType<typeof spyOn>;
  let compileSpy: ReturnType<typeof spyOn>;
  let instantiateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    const instance = makeInstance();
    const module = makeModule();

    streamingSpy = spyOn(WebAssembly, 'instantiateStreaming').mockImplementation(async () => ({
      instance,
      module,
    }));

    compileSpy = spyOn(WebAssembly, 'compile').mockImplementation(async () => module);

    // WebAssembly.instantiate(module, imports) returns Instance directly (not {instance,module}).
    // The {instance,module} form is only returned when the first arg is a BufferSource.
    instantiateSpy = spyOn(WebAssembly, 'instantiate').mockImplementation(
      async () => instance as unknown as WebAssembly.WebAssemblyInstantiatedSource
    );
  });

  afterEach(() => {
    streamingSpy.mockRestore();
    compileSpy.mockRestore();
    instantiateSpy.mockRestore();
  });

  test('uses instantiateStreaming when response has correct Content-Type', async () => {
    const response = new Response(new ArrayBuffer(8), {
      headers: { 'Content-Type': 'application/wasm' },
    });

    const ghostty = await Ghostty.loadFromResponse(response);

    expect(streamingSpy).toHaveBeenCalledTimes(1);
    expect(compileSpy).not.toHaveBeenCalled();
    expect(ghostty).toBeInstanceOf(Ghostty);
  });

  test('falls back to compile + instantiate when instantiateStreaming rejects', async () => {
    // Simulate wrong Content-Type (e.g. Tauri asset protocol without wasm header)
    streamingSpy.mockImplementation(() =>
      Promise.reject(new TypeError('Content-Type must be application/wasm'))
    );

    const response = new Response(new ArrayBuffer(8), {
      headers: { 'Content-Type': 'application/octet-stream' },
    });

    const ghostty = await Ghostty.loadFromResponse(response);

    expect(streamingSpy).toHaveBeenCalledTimes(1);
    expect(compileSpy).toHaveBeenCalledTimes(1);
    expect(instantiateSpy).toHaveBeenCalledTimes(1);
    expect(ghostty).toBeInstanceOf(Ghostty);
  });

  test('falls back to compile + instantiate when instantiateStreaming is unavailable', async () => {
    // Override the property directly so the typeof check in loadFromResponse returns false.
    const original = WebAssembly.instantiateStreaming;
    // @ts-expect-error — simulate environments where the API doesn't exist
    WebAssembly.instantiateStreaming = undefined;

    try {
      const response = new Response(new ArrayBuffer(8), {
        headers: { 'Content-Type': 'application/wasm' },
      });

      const ghostty = await Ghostty.loadFromResponse(response);

      expect(streamingSpy).not.toHaveBeenCalled();
      expect(compileSpy).toHaveBeenCalledTimes(1);
      expect(ghostty).toBeInstanceOf(Ghostty);
    } finally {
      WebAssembly.instantiateStreaming = original;
    }
  });
});

describe('Ghostty kitty graphics API', () => {
  test('stores and exposes a 1x1 RGB transmit-and-display image', async () => {
    const ghostty = await Ghostty.load();
    const term = ghostty.createTerminal(10, 5);

    try {
      // Kitty graphics transmit+display, direct RGB payload, 1x1 pixel.
      // f=24 => RGB, t=d => direct data, s/v => image pixels,
      // c/r => displayed cell size. Pixel dimensions are required for
      // placement render info, so seed the terminal with a known cell size.
      term.setCellPixelSize(8, 16);
      const redPixel = btoa(String.fromCharCode(255, 0, 0));
      term.write(`\x1b_Ga=T,f=24,t=d,i=1,s=1,v=1,c=1,r=1;${redPixel}\x1b\\`);
      term.update();

      const graphics = term.getKittyGraphics();
      expect(graphics).not.toBeNull();

      const placements = [...term.iterPlacements(graphics!, false)];
      expect(placements).toHaveLength(1);
      expect(placements[0]).toMatchObject({
        imageId: 1,
        pixelWidth: 8,
        pixelHeight: 16,
        gridCols: 1,
        gridRows: 1,
        viewportCol: 0,
        viewportRow: 0,
        viewportVisible: true,
        isVirtual: false,
      });

      const pixels = term.getKittyImagePixels(graphics!, 1);
      expect(pixels).not.toBeNull();
      expect(pixels!.width).toBe(1);
      expect(pixels!.height).toBe(1);
      expect(pixels!.format).toBe(KittyImageFormat.RGB);
      expect([...pixels!.data]).toEqual([255, 0, 0]);
    } finally {
      term.free();
    }
  });
});

describe('Ghostty.loadFromBytes', () => {
  let compileSpy: ReturnType<typeof spyOn>;
  let instantiateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    const instance = makeInstance();
    const module = makeModule();
    compileSpy = spyOn(WebAssembly, 'compile').mockImplementation(async () => module);
    instantiateSpy = spyOn(WebAssembly, 'instantiate').mockImplementation(
      async () => instance as unknown as WebAssembly.WebAssemblyInstantiatedSource
    );
  });

  afterEach(() => {
    compileSpy.mockRestore();
    instantiateSpy.mockRestore();
  });

  test('compiles from ArrayBuffer and returns a Ghostty instance', async () => {
    const bytes = new ArrayBuffer(8);
    const ghostty = await Ghostty.loadFromBytes(bytes);

    expect(compileSpy).toHaveBeenCalledWith(bytes);
    expect(instantiateSpy).toHaveBeenCalledTimes(1);
    expect(ghostty).toBeInstanceOf(Ghostty);
  });
});
