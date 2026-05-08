/**
 * Minimal vendored synchronous PNG decoder wrapper for Ghostty's kitty graphics callback.
 *
 * Source: @cf-wasm/png 0.3.3, trimmed to the wasm-bindgen runtime pieces we need:
 *   - vendor/cf-wasm-png/png.js
 *   - vendor/cf-wasm-png/png_bg.wasm.inline.js
 *
 * The Ghostty DECODE_PNG callback is synchronous, so browser APIs such as
 * createImageBitmap() are not usable here. This wrapper initializes the vendored
 * PNG WASM module synchronously once and exposes a small RGBA-normalizing API.
 */

import { decode as decodePngWasm, initSync } from './vendor/cf-wasm-png/png.js';
import pngWasmBytes from './vendor/cf-wasm-png/png_bg.wasm.inline.js';

export enum WasmPngColorType {
  Grayscale = 0,
  RGB = 2,
  Indexed = 3,
  GrayscaleAlpha = 4,
  RGBA = 6,
}

export enum WasmPngBitDepth {
  One = 1,
  Two = 2,
  Four = 4,
  Eight = 8,
  Sixteen = 16,
}

export interface WasmPngDecodeResult {
  image: ArrayLike<number>;
  width: number;
  height: number;
  colorType: WasmPngColorType;
  bitDepth: WasmPngBitDepth;
  lineSize: number;
}

export interface DecodedRgbaPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

let initialized = false;

function ensureWasmPngInitialized(): void {
  if (initialized) return;
  // The generated wasm-bindgen initSync path expects a compiled module in
  // current runtimes despite its broader type declaration.
  initSync({ module: new WebAssembly.Module(pngWasmBytes) });
  initialized = true;
}

export function decodePngToRgba8(pngBytes: Uint8Array): DecodedRgbaPng | null {
  ensureWasmPngInitialized();
  const img = decodePngWasm(pngBytes) as WasmPngDecodeResult;
  const rgba = wasmPngToRgba8(img);
  if (!rgba) return null;
  return { width: img.width, height: img.height, rgba };
}

function wasmPngToRgba8(img: WasmPngDecodeResult): Uint8Array | null {
  const { width, height, colorType, bitDepth, image } = img;
  if (width <= 0 || height <= 0) return null;

  const px = width * height;
  if (!Number.isSafeInteger(px) || px > 0x3fffffff) return null;

  const out = new Uint8Array(px * 4);

  const channels =
    colorType === WasmPngColorType.RGBA
      ? 4
      : colorType === WasmPngColorType.RGB
        ? 3
        : colorType === WasmPngColorType.GrayscaleAlpha
          ? 2
          : colorType === WasmPngColorType.Grayscale
            ? 1
            : 0;
  if (channels === 0) return null;

  const bytesPerSample = bitDepth === WasmPngBitDepth.Sixteen ? 2 : 1;
  const requiredBytes = px * channels * bytesPerSample;
  if (!Number.isSafeInteger(requiredBytes) || image.length < requiredBytes) return null;

  // The vendored WASM decoder expands low-bit-depth PNGs to byte-aligned
  // channel samples. For 16-bit PNGs, samples are big-endian byte pairs.
  const get8 = (sampleIndex: number): number => {
    if (bitDepth === WasmPngBitDepth.Sixteen) return image[sampleIndex * 2] ?? 0;
    return image[sampleIndex] ?? 0;
  };

  switch (colorType) {
    case WasmPngColorType.RGBA:
      if (bitDepth === WasmPngBitDepth.Eight) {
        for (let i = 0; i < px * 4; i++) out[i] = image[i] ?? 0;
        return out;
      }
      for (let i = 0, o = 0; i < px * 4; i += 4, o += 4) {
        out[o] = get8(i);
        out[o + 1] = get8(i + 1);
        out[o + 2] = get8(i + 2);
        out[o + 3] = get8(i + 3);
      }
      return out;

    case WasmPngColorType.RGB:
      for (let i = 0, o = 0; i < px * 3; i += 3, o += 4) {
        out[o] = get8(i);
        out[o + 1] = get8(i + 1);
        out[o + 2] = get8(i + 2);
        out[o + 3] = 255;
      }
      return out;

    case WasmPngColorType.GrayscaleAlpha:
      for (let i = 0, o = 0; i < px * 2; i += 2, o += 4) {
        const v = get8(i);
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = get8(i + 1);
      }
      return out;

    case WasmPngColorType.Grayscale:
      for (let i = 0, o = 0; i < px; i++, o += 4) {
        const v = get8(i);
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = 255;
      }
      return out;

    // Indexed-color PNGs are normally expanded by the decoder; reject if a
    // future decoder version returns unresolved palette indices here.
    default:
      return null;
  }
}
