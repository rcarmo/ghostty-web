# Agent Guide - Ghostty WASM Terminal

**For AI coding agents working on this repository.**

## Quick Start

```bash
bun install                          # Install dependencies
bun test                             # Run test suite
bun run dev                          # Start Vite dev server (http://localhost:8000)
```

**Before committing, always run:**

```bash
bun run fmt && bun run lint && bun run typecheck && bun test && bun run build:lib && bun run build:wasm-copy
```

**Run interactive terminal demo:**

```bash
bun run demo      # Launch demo server
# or: bun run dev # Static Vite dev server
# Open: http://localhost:8000/demo/
```

## Project State

This is a **fully functional terminal emulator** (MVP complete) that uses Ghostty's battle-tested VT100 parser compiled to WebAssembly.

**What works:**

- ✅ Full VT100/ANSI terminal emulation (vim, htop, colors, etc.)
- ✅ Event-driven Canvas renderer with dirty-row redraws
- ✅ Experimental opt-in WebGL2 renderer (`renderer: 'webgl'`) with Canvas fallback
- ✅ Keyboard input handling (Kitty keyboard protocol)
- ✅ Text selection and clipboard
- ✅ WebSocket PTY integration (real shell sessions)
- ✅ xterm.js-compatible API
- ✅ FitAddon for responsive sizing
- ✅ Comprehensive test suite (terminal, renderer, input, selection)

**Tech stack:**

- TypeScript + Bun runtime for tests
- Vite for dev server and bundling
- Ghostty WASM build artifacts for VT parsing/render-state access
- Canvas API for default rendering
- Optional WebGL2 adapter in `lib/webgl-renderer.ts` with vendored `libghostty-webgl`
- Renderer/terminal lifecycle code that derives DOM, timer, animation-frame, link-opening, clipboard fallback, and DPR state from the terminal canvas' owner browsing context

## Architecture

```
┌─────────────────────────────────────────┐
│  Terminal (lib/terminal.ts)             │  xterm.js-compatible API
│  - Public API, event handling           │
└───────────┬─────────────────────────────┘
            │
            ├─► GhosttyTerminal (WASM)
            │   └─ VT100 state machine, screen buffer
            │
            ├─► ITerminalRenderer (lib/renderer-contract.ts)
            │   ├─ CanvasRenderer (lib/renderer.ts) - default, kitty graphics + box/block geometry
            │   └─ WebGLRenderer (lib/webgl-renderer.ts) - opt-in experimental, Canvas fallback
            │
            ├─► InputHandler (lib/input-handler.ts)
            │   └─ Keyboard events → escape sequences
            │
            └─► SelectionManager (lib/selection-manager.ts)
                └─ Text selection + clipboard

Ghostty WASM Bridge (lib/ghostty.ts)
├─ Ghostty - WASM loader
├─ GhosttyTerminal - Terminal instance wrapper
└─ KeyEncoder - Keyboard event encoding
```

### Key Files

| File                       | Purpose                                      |
| -------------------------- | -------------------------------------------- |
| `lib/terminal.ts`          | Main Terminal class, xterm.js API            |
| `lib/ghostty.ts`           | Ghostty WASM/C ABI wrapper                   |
| `lib/renderer-contract.ts` | Shared Terminal-facing renderer contract     |
| `lib/renderer.ts`          | Default Canvas renderer                      |
| `lib/webgl-renderer.ts`    | Experimental opt-in WebGL renderer adapter   |
| `lib/input-handler.ts`     | Keyboard/IME/mouse input handling            |
| `lib/selection-manager.ts` | Text selection, clipboard, decorations       |
| `lib/types.ts`             | TypeScript definitions for WASM ABI          |
| `lib/wasm-png-decoder.ts`  | Vendored WASM PNG decoder for kitty graphics |
| `lib/addons/fit.ts`        | Responsive terminal sizing                   |
| `demo/bin/demo.js`         | Demo server with PTY/WebSocket support       |
| `demo/bin/render-test.ts`  | Browser screenshot regression runner         |

### WASM Integration Pattern

**What's in Ghostty WASM:**

- VT100/ANSI state machine (the hard part)
- Screen buffer (2D cell grid)
- Cursor tracking
- Scrollback buffer
- SGR parsing (colors/styles)
- Key encoding

**What's in TypeScript:**

- Terminal API (xterm.js compatibility)
- Canvas rendering
- Input event handling
- Selection/clipboard
- Addons (FitAddon)
- WebSocket/PTY integration

**Memory Management:**

- WASM exports linear memory
- TypeScript reads cell data via typed arrays
- No manual malloc/free needed (Ghostty manages internally)
- Get cell pointer: `wasmTerm.getScreenCells()`
- Read cells: `new Uint8Array(memory.buffer, ptr, size)`

## Development Workflows

### Before Committing

**⚠️ Always run all CI checks before committing:**

```bash
bun run fmt                           # Check formatting (Prettier)
bun run lint                          # Run linter (Biome)
bun run typecheck                     # Type check (TypeScript)
bun test                              # Run tests
bun run build:lib                     # Build library dist files
bun run build:wasm-copy               # Copy WASM artifacts into dist
```

All at once: `bun run fmt && bun run lint && bun run typecheck && bun test && bun run build:lib && bun run build:wasm-copy`

Auto-fix formatting: `bun run fmt:fix`

### Running Tests

```bash
bun test                              # Run all tests
bun test lib/terminal.test.ts         # Run specific file
bun test --watch                      # Watch mode (may hang - use Ctrl+C and restart)
bun test -t "test name pattern"       # Run matching tests
```

**Test files:** `*.test.ts` in `lib/` (terminal, renderer, input-handler, selection-manager, fit)

### Visual Render Tests

Visual regression tests compare canvas rendering against baseline PNG images.

```bash
bun test:render                       # Run tests against baselines (CI)
bun test:render:update                # Update baselines after intentional changes
bun test:render:web                   # Start server for interactive debugging
                                      # Open: http://localhost:3000/demo/render-test
```

**How it works:**

- Headless Puppeteer runs tests and compares canvas output to `demo/baselines/*.png`
- Tests fail if pixel difference exceeds 0.1% threshold
- Web UI shows side-by-side current vs baseline for debugging

**When to update baselines:**

- After intentional rendering changes (fonts, colors, spacing)
- Run `bun test:render:update` then verify changes visually
- Commit updated `.png` files with your changes

**Test coverage:** Basic text, text styles, colors (ANSI/RGB), cursors, wide chars, selection, hyperlinks

### Running Demos

**⚠️ CRITICAL: Use Vite dev server!** Plain HTTP server won't handle TypeScript imports.

```bash
# ✅ CORRECT
bun run dev                           # Vite with TS support
# Open: http://localhost:8000/demo/

# ❌ WRONG
python3 -m http.server                # Can't handle .ts imports
```

**Available demos:**

- `demo/index.html` - Interactive shell terminal (requires PTY server)
- `demo/colors-demo.html` - ANSI color showcase (no server needed)

### Type Checking

```bash
bun run typecheck                     # Check types without compiling
```

### Debugging

**Browser console (F12):**

```javascript
// Access terminal instance (if exposed in demo)
term.write('Hello!\r\n');
(term.cols, term.rows);
term.wasmTerm.getCursor(); // WASM cursor state

// Check WASM memory
const cells = term.wasmTerm.getLine(0);
console.log(cells);
```

**Common issues:**

- Rendering glitches → Check `renderer.ts` dirty tracking
- Input not working → Check `input-handler.ts` key mappings
- Selection broken → Check `selection-manager.ts` mouse handlers
- WASM crashes → Check memory buffer validity (may change when memory grows)

## Code Patterns

### Adding Terminal Features

**1. Extend Terminal class (`lib/terminal.ts`):**

```typescript
export class Terminal {
  // Add public method
  public myFeature(): void {
    if (!this.wasmTerm) throw new Error('Not open');
    // Use WASM terminal API
    this.wasmTerm.write('...');
  }

  // Add event
  private myEventEmitter = new EventEmitter<string>();
  public readonly onMyEvent = this.myEventEmitter.event;
}
```

**2. Create Addon (`lib/addons/`):**

```typescript
export class MyAddon implements ITerminalAddon {
  private terminal?: Terminal;

  activate(terminal: Terminal): void {
    this.terminal = terminal;
    // Initialize addon
  }

  dispose(): void {
    // Cleanup
  }
}
```

### Using Ghostty WASM API

```typescript
// Get terminal instance
const ghostty = await Ghostty.load('./ghostty-vt.wasm');
const wasmTerm = ghostty.createTerminal(80, 24);

// Write data (processes VT100 sequences)
wasmTerm.write('Hello\r\n\x1b[1;32mGreen\x1b[0m');

// Read screen state
const cursor = wasmTerm.getCursor(); // {x, y, visible, shape}
const cells = wasmTerm.getLine(0); // GhosttyCell[]
const cell = cells[0]; // {codepoint, fg, bg, flags}

// Check cell flags
const isBold = (cell.flags & CellFlags.BOLD) !== 0;
const isItalic = (cell.flags & CellFlags.ITALIC) !== 0;

// Color extraction
if (cell.fg.type === 'rgb') {
  const { r, g, b } = cell.fg.value;
} else if (cell.fg.type === 'palette') {
  const index = cell.fg.value; // 0-255
}

// Resize
wasmTerm.resize(100, 30);

// Clear screen
wasmTerm.write('\x1bc'); // RIS (Reset to Initial State)
```

### Event System

```typescript
// Terminal uses EventEmitter for xterm.js compatibility
private dataEmitter = new EventEmitter<string>();
public readonly onData = this.dataEmitter.event;

// Emit events
this.dataEmitter.fire('user input data');

// Subscribe (returns IDisposable)
const disposable = term.onData(data => {
  console.log(data);
});
disposable.dispose();  // Unsubscribe
```

### Testing Patterns

```typescript
import { describe, test, expect } from 'bun:test';

describe('MyFeature', () => {
  test('should do something', async () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    const container = document.createElement('div');
    await term.open(container);

    term.write('test\r\n');

    // Check WASM state
    const cursor = term.wasmTerm!.getCursor();
    expect(cursor.y).toBe(1);

    term.dispose();
  });
});
```

**Test helpers:**

- Use `document.createElement()` for DOM elements
- Always `await term.open()` before testing
- Always `term.dispose()` in cleanup
- Use `term.wasmTerm` to access WASM API directly

## Critical Gotchas

### 1. **Must Use Vite Dev Server**

```bash
# ✅ Works - Vite transpiles TypeScript
bun run dev

# ❌ Fails - Browser can't load .ts files directly
python3 -m http.server
```

**Why:** Demos import TypeScript modules directly (`from './lib/terminal.ts'`). Need Vite to transpile.

### 2. **Generated Artifacts Must Stay In Sync**

- `ghostty-vt.wasm` is built from the Ghostty submodule and copied into `dist/`
- `dist/ghostty-web.js`, `dist/ghostty-web.umd.cjs`, `dist/index.d.ts`, and WASM copies are tracked release artifacts
- Rebuild library artifacts with `bun run build:lib`
- Refresh WASM copies with `bun run build:wasm-copy` after WASM or packaging changes

### 3. **Test Timeouts**

- `bun test` may hang on completion (known issue)
- Use `Ctrl+C` to exit
- Tests actually pass before hang
- Use `bun test lib/specific.test.ts` to limit scope

### 4. **WASM Memory Buffer Invalidation**

```typescript
// ❌ WRONG - buffer may become invalid
const buffer = this.memory.buffer;
// ... time passes, memory grows ...
const view = new Uint8Array(buffer);  // May be detached!

// ✅ CORRECT - get fresh buffer each time
private getBuffer(): ArrayBuffer {
  return this.memory.buffer;
}
const view = new Uint8Array(this.getBuffer(), ptr, size);
```

### 5. **PTY Server Required for Interactive Demos**

```bash
# Terminal demo with PTY/WebSocket support
bun run demo
# or, during source development:
bun run demo:dev
```

The demo serves HTTP and WebSocket traffic from the same origin, so reverse proxies must preserve WebSocket upgrade headers.

### 6. **Renderer Lifecycle and Browsing Contexts**

- Canvas is the default renderer; WebGL is opt-in via `renderer: 'webgl'`
- Do not make WebGL extend `CanvasRenderer`; a canvas cannot own both 2D and WebGL contexts
- Use `ITerminalRenderer` for terminal-facing renderer behavior
- Use the terminal canvas/parent owner document/window for DOM nodes, timers, animation frames, computed styles, DPR, link opening, and clipboard fallbacks
- When adding visible state changes, wake the event-driven renderer with `requestRender()` or `requestFullRender()` rather than relying on a perpetual frame loop
- Guard async UI lookups (link hover/click, providers, etc.) with request ids or disposal checks so stale promises cannot mutate disposed/newer state
- Keep Canvas/WebGL runtime option parity where practical (`theme`, cursor, font, decorations, transparency, scrollbar width, DPR)

### 7. **Canvas Rendering Requires Container Resize**

```typescript
// After opening terminal, must call fit
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
await term.open(container);
fitAddon.fit(); // ⚠️ Required! Otherwise terminal may not render

// On window resize
window.addEventListener('resize', () => fitAddon.fit());
```

### 8. **Font Loading for Visual Tests**

Visual render tests require all font variants to be loaded before rendering:

```typescript
// Must load ALL 4 variants for consistent rendering
await document.fonts.load('14px "JetBrainsMono NF"');
await document.fonts.load('bold 14px "JetBrainsMono NF"');
await document.fonts.load('italic 14px "JetBrainsMono NF"');
await document.fonts.load('bold italic 14px "JetBrainsMono NF"');
await document.fonts.ready;
```

**Why:** Missing font variants cause browser to synthesize them, leading to inconsistent rendering between page loads.

## Common Tasks

### Add New Escape Sequence Support

**Option 1: If Ghostty WASM already supports it**

- Just write data, WASM handles it
- Update renderer if new visual features needed

**Option 2: If not in WASM**

- Feature needs to be added to Ghostty upstream
- Then rebuild WASM binary

### Fix Rendering Issue

1. Check if cells are correct: `wasmTerm.getLine(y)`
2. Check if dirty tracking works: `renderer.render()`
3. Check font metrics and DPR on the active renderer
4. Check color conversion in both renderer and WASM config paths when theme colors affect cell defaults
5. Check whether the state change explicitly wakes the event-driven renderer

### Add Keyboard Shortcut

```typescript
// In input-handler.ts
if (e.ctrlKey && e.key === 'c') {
  // Handle Ctrl+C
  return '\x03'; // ETX character
}
```

### Debug Selection

```typescript
// In selection-manager.ts
console.log('Selection:', this.start, this.end);
console.log('Selected text:', this.getSelectedText());
```

## Resources

- **Ghostty Source:** https://github.com/ghostty-org/ghostty
- **VT100 Reference:** https://vt100.net/docs/vt100-ug/
- **ANSI Escape Codes:** https://en.wikipedia.org/wiki/ANSI_escape_code
- **xterm.js API:** https://xtermjs.org/docs/api/terminal/

## Questions?

When stuck:

1. Read the test files - they show all API usage patterns
2. Look at demo code in `demo/*.html`
3. Read Ghostty source for WASM implementation details
4. Check xterm.js docs for API compatibility questions
