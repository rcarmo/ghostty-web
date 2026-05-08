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

The sections below cover the main integration and development workflows.

## Features

- ✅ Full xterm.js-compatible API
- ✅ Production-tested VT100 parser (via Ghostty)
- ✅ Upstream Ghostty C ABI / render-state integration (no local WASM patch required)
- ✅ ANSI colors (16, 256, RGB true color)
- ✅ CJK and wide-emoji cell width handling
- ✅ Styled scrollback and row-iterator based viewport rendering
- ✅ CSI `14/16/18 t` size responses and callback-based terminal query handling
- ✅ Canvas rendering at 60 FPS
- ✅ Scrollback buffer
- ✅ Text selection & clipboard
- ✅ FitAddon for responsive sizing
- ✅ TypeScript declarations included

## What's New in 0.8.0

Version `0.8.0` folds in the Nimble ABI/render-state migration on top of the earlier upstream/canopy/Yuuji work. In practice that means:

- the WASM build now targets the upstream Ghostty lib-vt ABI directly
- viewport/render-state access uses the newer key/value and row-iterator APIs
- wide-cell rendering, scrollback styling, grapheme handling, and wrapped-row state are restored on top of the new ABI
- terminal query responses such as CSI `14/16/18 t` are wired back through callback-based response handling

## Development & Demos

### Shell Terminal Demo

**Requires server**

```bash
# Terminal 1: Start PTY shell server
cd demo/server
bun install
bun run start

# Terminal 2: Start web server (from project root)
bun run dev

# Open: http://localhost:8000/demo/
```

This provides a **real persistent shell session**! You can:

- Use `cd` and it persists between commands
- Run interactive programs like `vim`, `nano`, `top`, `htop`
- Use tab completion and command history (↑/↓)
- Use pipes, redirects, and background jobs
- Access all your shell aliases and environment

**Alternative: Command-by-Command Mode**

For the original file browser (executes each command separately):

```bash
cd demo/server
bun run file-browser
```

**Remote Access:** If you're accessing via a forwarded hostname (e.g., `mux.coder`), make sure to forward both ports:

- Port 8000 (web server - Vite)
- Port 3001 (WebSocket server)

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
            ├─► ScreenBuffer (lib/buffer.ts)
            │   - 2D grid, cursor, scrollback
            │
            ├─► VTParser (lib/vt-parser.ts)
            │   - ANSI escape sequence parsing
            │   └─► Ghostty WASM (SGR parser)
            │
            ├─► CanvasRenderer (lib/renderer.ts)
            │   - Canvas-based rendering
            │   - 60 FPS, supports all colors
            │
            └─► InputHandler (lib/input-handler.ts)
                - Keyboard events → escape codes
                └─► Ghostty WASM (Key encoder)

WebSocket Server (server/file-browser-server.ts)
└─► Executes shell commands (ls, cd, cat, etc.)
```

## Project Structure

```
├── lib/
│   ├── terminal.ts       - Main Terminal class (xterm.js-compatible)
│   ├── buffer.ts         - Screen buffer with scrollback
│   ├── vt-parser.ts      - VT100/ANSI escape sequence parser
│   ├── renderer.ts       - Canvas-based renderer
│   ├── input-handler.ts  - Keyboard input handling
│   ├── ghostty.ts        - Ghostty WASM wrapper
│   ├── types.ts          - TypeScript type definitions
│   ├── interfaces.ts     - xterm.js-compatible interfaces
│   └── addons/
│       └── fit.ts        - FitAddon for responsive sizing
│
├── demo/
│   ├── index.html        - File browser terminal
│   ├── colors-demo.html  - ANSI colors showcase
│   └── server/
│       ├── file-browser-server.ts - WebSocket server
│       ├── package.json
│       └── start.sh      - Startup script (auto-kills port conflicts)
│
├── docs/
│   └── API.md            - Complete API documentation
│
└── ghostty-vt.wasm       - Ghostty VT100 parser (122 KB)
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
2. Applies patches from `patches/ghostty-wasm-api.patch`
3. Builds WASM with Zig (takes ~20 seconds)
4. Outputs `ghostty-vt.wasm` (404 KB)
5. Reverts patch to keep submodule clean

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

- ✅ ScreenBuffer (63 tests, 163 assertions)
- ✅ VTParser (45 tests)
- ✅ CanvasRenderer (11 tests)
- ✅ InputHandler (35 tests)
- ✅ Terminal integration (25 tests)
- ✅ FitAddon (12 tests)

## Documentation

- **[AGENTS.md](AGENTS.md)** - Development guide for AI agents and developers

## Links

- [Ghostty Terminal](https://github.com/ghostty-org/ghostty)
- [libghostty-vt API](https://github.com/ghostty-org/ghostty/tree/main/include/ghostty/vt)
- [VT100 Reference](https://vt100.net/docs/vt100-ug/)

## License

See cmux LICENSE (AGPL-3.0)
