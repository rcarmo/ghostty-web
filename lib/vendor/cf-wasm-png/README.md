# Vendored @cf-wasm/png runtime subset

This directory vendors the minimal synchronous PNG decode runtime from
`@cf-wasm/png` 0.3.3 (MIT), which is powered by `denosaurs/pngs`.

Only the files needed by `lib/wasm-png-decoder.ts` are kept:

- `png.js` / `png.d.ts` — wasm-bindgen JS glue exposing `decode()` and `initSync()`.
- `png_bg.wasm.inline.js` / `.d.ts` — inline WASM bytes for synchronous initialization.

The package-level wrappers and encoder-facing API are intentionally not used.
Ghostty's kitty graphics `DECODE_PNG` callback is synchronous, so this vendored
runtime lets us decode PNG payloads without adding a runtime dependency or using
async browser image APIs.
