# Ghostty Web

A web-based terminal emulator that integrates [Ghostty's](https://github.com/ghostty-org/ghostty) VT100 parser via WebAssembly.

## Installation

```bash
npm install ghostty-web
```

Or install directly from GitHub (includes pre-built dist files):

```bash
# Latest from main branch
npm install github:rcarmo/ghostty-web

# Specific commit or branch
npm install github:rcarmo/ghostty-web#commit-sha
```

> **Note:** GitHub installs work without requiring Zig because the repository includes pre-built `dist/` files and `ghostty-vt.wasm`.

## Quick Start

```typescript
import { Terminal } from 'ghostty-web';

const term = new Terminal({ cols: 80, rows: 24 });
term.open(document.getElementById('terminal')!);
term.write('Hello, World!\r\n');
```

### Experimental WebGL Renderer

Canvas2D remains the default renderer. WebGL is explicit opt-in:

```typescript
const term = new Terminal({
  cols: 80,
  rows: 24,
  renderer: 'webgl',
});
```

When `renderer: 'webgl'` is requested, `ghostty-web` checks for `webgl2` support on a throwaway probe canvas before constructing the renderer. If WebGL2 is unavailable, or if WebGL initialization fails after binding a context, initialization safely falls back to the default Canvas2D renderer on a fresh canvas. The WebGL path is currently experimental: it uses a vendored adapter from `0xBigBoss/ghostty-webgl` and preserves the same terminal-facing renderer contract, but Canvas2D remains the production default.

The WebGL adapter mirrors the Canvas renderer contract for selection, hyperlinks, decorations/search highlights, cursor blink, IME preedit overlays, scrollback viewports, theme colors (including common CSS color forms), font changes, DPR changes, and scrollbar width. Both renderers are hardened for iframe/embedded browsing contexts by deriving DOM, timer, animation-frame, and device-pixel-ratio state from the terminal canvas' owner document/window instead of assuming globals. WebGL uses conservative full-row uploads for correctness and an RGBA glyph atlas for better WebKit/WKWebView compatibility. Kitty graphics and geometric box/block rendering remain Canvas-only for now; choose Canvas when those features are required.

The sections below cover the main integration and development workflows.

## Features

- ✅ Full xterm.js-compatible API
- ✅ Production-tested VT100 parser (via Ghostty)
- ✅ Upstream Ghostty C ABI / render-state integration (no local WASM patch required)
- ✅ ANSI colors (16, 256, RGB true color)
- ✅ CJK and wide-emoji cell width handling
- ✅ Styled scrollback and row-iterator based viewport rendering
- ✅ CSI `14/16/18 t` size responses and callback-based terminal query handling
- ✅ Event-driven Canvas rendering with dirty-row redraws
- ✅ Experimental opt-in WebGL renderer with Canvas fallback
- ✅ Scrollback buffer
- ✅ Text selection & clipboard
- ✅ FitAddon for responsive sizing
- ✅ TypeScript declarations included

## What's New in 0.9.1

Version `0.9.1` adds the experimental WebGL renderer path and hardens the shared renderer lifecycle on top of the upstream Ghostty ABI/render-state migration:

- Canvas remains the default renderer; WebGL2 is explicit opt-in via `new Terminal({ renderer: 'webgl' })` with safe Canvas fallback
- terminal/rendering code is event-driven rather than a perpetual frame loop, with explicit wakeups for writes, scrolls, cursor blink, selections, hover underlines, theme changes, clear/reset, and runtime option changes
- Canvas, Terminal, SelectionManager, and WebGL paths use the terminal canvas' owner browsing context for DOM nodes, timers, animation frames, font measurement, clipboard fallbacks, and DPR rather than assuming global `window`/`document`
- WebGL now tracks DPR changes, owner-document font measurement, runtime scrollbar width, decorations/search highlights, cursor blink, IME preedit, and scrollback viewport parity
- lifecycle cleanup is symmetric for document/canvas listeners, context-loss listeners, timers, animation frames, and renderer resources
- Canvas-only features remain documented: kitty graphics and geometric box/block rendering are still not implemented in the WebGL path

## Development & Demos

### Shell Terminal Demo

**Requires server**

```bash
# Builds/serves the package demo with PTY WebSocket support
bun run demo

# Development mode uses the repo sources and Vite-compatible assets
bun run demo:dev

# Open the printed local URL, typically http://localhost:8080/
```

This provides a **real persistent shell session**! You can:

- Use `cd` and it persists between commands
- Run interactive programs like `vim`, `nano`, `top`, `htop`
- Use tab completion and command history (↑/↓)
- Use pipes, redirects, and background jobs
- Access all your shell aliases and environment

**Renderer selection:** The demo uses the default Canvas renderer. The experimental WebGL renderer is available to library consumers with `new Terminal({ renderer: 'webgl' })`; Canvas remains recommended for kitty graphics and box/block geometry coverage. WebGL is safe to request in browsers without WebGL2 because initialization probes a throwaway canvas and falls back to Canvas on failure.

**Remote Access:** The demo serves HTTP and WebSocket traffic from the same origin, so reverse proxies only need to forward the demo HTTP port and preserve WebSocket upgrade headers.

The terminal will automatically connect to the WebSocket using the same hostname you're accessing the page from.

**Colors Demo** (no server needed)

```bash
bun run dev
# Open: http://localhost:8000/demo/colors-demo.html
```

See all ANSI colors (16, 256, RGB) and text styles in action.

## Usage

### Basic Terminal

```typescript
import { Terminal } from './lib/index.ts';
import { FitAddon } from './lib/addons/fit.ts';

// Create terminal
const term = new Terminal({
  cols: 80,
  rows: 24,
  cursorBlink: true,
  theme: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
  },
});

// Add FitAddon for responsive sizing
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

// Open in container
await term.open(document.getElementById('terminal'));
fitAddon.fit();

// Write output (supports ANSI colors)
term.write('Hello, World!\r\n');
term.write('\x1b[1;32mGreen bold text\x1b[0m\r\n');

// Handle user input
term.onData((data) => {
  console.log('User typed:', data);
  // Send to backend, echo, etc.
});
```

### WebSocket Integration

```typescript
const ws = new WebSocket('ws://localhost:3001/ws');

// Send user input to backend
term.onData((data) => {
  ws.send(JSON.stringify({ type: 'input', data }));
});

// Display backend output
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  term.write(msg.data);
};
```

### URL Detection

Ghostty-web automatically detects and makes clickable:

- **OSC 8 hyperlinks** - Explicit terminal escape sequences (e.g., from `ls --hyperlink`)
- **Plain text URLs** - Common protocols detected via regex (https, http, mailto, ssh, git, ftp, tel, magnet)

URLs are detected on hover and can be opened with Ctrl/Cmd+Click.

```typescript
// URL detection works automatically after opening terminal
await term.open(container);

// URLs in output become clickable automatically
term.write('Visit https://github.com for code\r\n');
term.write('Contact mailto:support@example.com\r\n');
```

**Custom Link Providers**

Register custom providers to detect additional link types:

```typescript
import { UrlRegexProvider } from 'ghostty-web';

// Create custom provider
const myProvider = {
  provideLinks(y, callback) {
    // Your detection logic here
    const links = detectCustomLinks(y);
    callback(links);
  },
};

// Register after opening terminal
term.registerLinkProvider(myProvider);
```

See [AGENTS.md](AGENTS.md) for development guide and code patterns.

### Custom Fonts

Ghostty-web supports custom font families. Font families with spaces are automatically quoted for proper CSS handling.

```typescript
const term = new Terminal({
  fontFamily: 'Fira Code, Consolas, monospace',
  fontSize: 14,
});

await term.open(container);
```

**Loading Web Fonts**

When using web fonts (e.g., Google Fonts, local `.woff2` files), you must wait for the font to load before the terminal can measure it correctly:

```typescript
// Option 1: Wait for specific font
await document.fonts.load('14px "Fira Code"');
term.loadFonts();

// Option 2: Wait for all fonts to be ready
await document.fonts.ready;
term.loadFonts();

// Option 3: Use FontFace API
const font = new FontFace('Fira Code', 'url(/fonts/FiraCode.woff2)');
await font.load();
document.fonts.add(font);
term.loadFonts();
```

**Changing Fonts at Runtime**

```typescript
// Change font family
term.options.fontFamily = 'JetBrains Mono, monospace';

// Change font size
term.options.fontSize = 16;

// If using a web font, wait for it to load
await document.fonts.load('16px "JetBrains Mono"');
term.loadFonts();
```

### Snapshot API (Playback Mode)

The Terminal supports a snapshot API for playback mode, enabling direct terminal state injection without re-parsing VT100 sequences. This is useful for terminal recordings and time-travel debugging.

```typescript
import { Terminal, GhosttyCell } from 'ghostty-web';

// Create cells array (flat row-major order: rows * cols cells)
const cells: GhosttyCell[] = recordedFrame.cells;
const cursor = { x: 10, y: 5 };

// Set snapshot - renderer will use this instead of WASM terminal
terminal.setSnapshot(cells, cursor);

// Check if in snapshot mode
if (terminal.hasSnapshot()) {
  console.log('Playback mode active');
}

// Clear snapshot and return to normal rendering
terminal.clearSnapshot();
```

Each `GhosttyCell` contains:

- `codepoint`: Unicode codepoint (number)
- `fg_r`, `fg_g`, `fg_b`: Foreground RGB (0-255)
- `bg_r`, `bg_g`, `bg_b`: Background RGB (0-255)
- `flags`: Style flags (bold, italic, etc.)
- `width`: Character width (1 or 2 for wide chars)

## Why This Approach?

**DON'T** re-implement VT100 parsing from scratch (years of work, thousands of edge cases).

**DO** use Ghostty's proven parser:

- ✅ Battle-tested by thousands of users
- ✅ Handles all VT100/ANSI quirks correctly
- ✅ Modern features (RGB colors, Kitty keyboard protocol)
- ✅ Get bug fixes and updates for free

**You build**: Screen buffer, rendering, UI (the "easy" parts in TypeScript)  
**Ghostty handles**: VT100 parsing (the hard part via WASM)

## Architecture

```
┌─────────────────────────────────────────┐
│  Terminal (lib/terminal.ts)             │
│  - Public xterm.js-compatible API       │
│  - Event handling (onData, onResize)    │
└───────────┬─────────────────────────────┘
            │
            ├─► GhosttyTerminal (lib/ghostty.ts)
            │   - Upstream Ghostty C ABI, render-state rows, scrollback
            │   - Kitty graphics, callbacks, terminal size/query responses
            │
            ├─► ITerminalRenderer (lib/renderer-contract.ts)
            │   ├─► CanvasRenderer (lib/renderer.ts)
            │   │   - Default renderer, kitty graphics, box/block geometry
            │   └─► WebGLRenderer (lib/webgl-renderer.ts)
            │       - Experimental opt-in WebGL2 adapter with Canvas fallback
            │
            ├─► SelectionManager (lib/selection-manager.ts)
            │   - Text selection, clipboard, renderer decoration ranges
            │
            └─► InputHandler (lib/input-handler.ts)
                - Keyboard/IME/mouse events → Ghostty-compatible input

Demo server (demo/bin/demo.js)
└─► Starts the Vite demo and WebSocket control/PTY plumbing
```

## Project Structure

```
├── lib/
│   ├── terminal.ts          - Main Terminal class (xterm.js-compatible)
│   ├── ghostty.ts           - Ghostty WASM/C ABI wrapper
│   ├── renderer-contract.ts - Shared Terminal-facing renderer contract
│   ├── renderer.ts          - Default Canvas renderer
│   ├── webgl-renderer.ts    - Experimental opt-in WebGL renderer adapter
│   ├── wasm-png-decoder.ts  - Vendored WASM PNG decoder wrapper for kitty graphics
│   ├── input-handler.ts     - Keyboard, IME, mouse input handling
│   ├── selection-manager.ts - Selection, clipboard, decorations
│   ├── types.ts             - TypeScript type definitions
│   ├── interfaces.ts        - xterm.js-compatible interfaces
│   ├── vendor/              - Vendored PNG/WebGL support code
│   └── addons/
│       └── fit.ts           - FitAddon for responsive sizing
│
├── demo/
│   ├── index.html           - Browser terminal demo
│   ├── colors-demo.html     - ANSI colors showcase
│   ├── render-test.html     - Browser render regression harness
│   └── bin/
│       ├── demo.js          - Demo server launcher
│       └── render-test.ts   - Screenshot regression runner
│
├── scripts/
│   ├── ensure-zig.sh        - Deterministic Zig bootstrap
│   └── build-wasm.sh        - Ghostty WASM build script
│
└── ghostty-vt.wasm          - Built Ghostty terminal WASM artifact
```

## Building WASM

The WASM binary is built from source, not committed to the repo.

**Requirements:**

- Zig 0.15.2+
- Git submodules initialized

**Build:**

```bash
# Initialize submodule (first time only)
git submodule update --init --recursive

# Build WASM
./scripts/build-wasm.sh
# or
bun run build:wasm
```

**What it does:**

1. Initializes `ghostty/` submodule (ghostty-org/ghostty)
2. Applies `patches/ghostty-wasm-api.patch` if it contains local patch content
3. Builds WASM with the deterministic Zig bootstrap from `scripts/ensure-zig.sh`
4. Outputs `ghostty-vt.wasm`
5. Keeps Zig cache/tooling outside linted source paths

**Updating Ghostty:**

```bash
cd ghostty
git fetch origin
git checkout <commit-or-tag>
cd ..
./scripts/build-wasm.sh
# Test, then commit the updated submodule pointer
```

**CI:** The WASM is built as part of the `test` and `build` jobs.

## Testing

Run the test suite:

```bash
bun test                # Run all tests
bun test --watch        # Watch mode
bun run typecheck       # Type checking
bun run build           # Build distribution
```

**Test Coverage:**

The current suite covers terminal integration, Ghostty ABI behavior, input handling, selection, renderer behavior, WebGL adapter/vendor pieces, FitAddon, kitty graphics, scrollback regressions, viewport corruption/merge regressions, and PNG decoding. As of this update the full suite reports `388 tests across 15 files`, with two intentionally skipped historical scrollback assumption tests.

## Documentation

- **[AGENTS.md](AGENTS.md)** - Development guide for AI agents and developers

## Links

- [Ghostty Terminal](https://github.com/ghostty-org/ghostty)
- [libghostty-vt API](https://github.com/ghostty-org/ghostty/tree/main/include/ghostty/vt)
- [VT100 Reference](https://vt100.net/docs/vt100-ug/)

## License

See cmux LICENSE (AGPL-3.0)
