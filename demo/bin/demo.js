#!/usr/bin/env node

/**
 * @ghostty-web/demo - Cross-platform demo server
 *
 * Starts a local HTTP server with WebSocket PTY support.
 * Run with: npx @ghostty-web/demo
 */

import fs from 'fs';
import http from 'http';
import { homedir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// Node-pty for cross-platform PTY support. The 1.2.0-beta.x line adds a
// `pixelSize` argument to resize(), which sets ws_xpixel / ws_ypixel in
// the slave PTY's winsize struct so kitty kittens (icat etc.) can detect
// graphics support via TIOCGWINSZ instead of falling back to terminal
// queries. Lydell's fork is based on 1.1.0-beta14 (pre-pixelSize), so we
// use upstream's beta directly.
import pty from 'node-pty';
// WebSocket server
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEV_MODE = process.argv.includes('--dev');
const HTTP_PORT = process.env.PORT || (DEV_MODE ? 8000 : 8080);

// ============================================================================
// Locate ghostty-web assets
// ============================================================================

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

function findGhosttyWeb() {
  // In dev mode, we use Vite - no need to find built assets
  if (DEV_MODE) {
    const repoRoot = path.join(__dirname, '..', '..');
    const wasmPath = path.join(repoRoot, 'ghostty-vt.wasm');
    if (!fs.existsSync(wasmPath)) {
      console.error('Error: ghostty-vt.wasm not found.');
      console.error('Run: bun run build:wasm');
      process.exit(1);
    }
    return { distPath: null, wasmPath, repoRoot };
  }

  // First, check for local development (repo root dist/)
  const localDist = path.join(__dirname, '..', '..', 'dist');
  const localJs = path.join(localDist, 'ghostty-web.js');
  const localWasm = path.join(__dirname, '..', '..', 'ghostty-vt.wasm');

  if (fs.existsSync(localJs) && fs.existsSync(localWasm)) {
    return { distPath: localDist, wasmPath: localWasm, repoRoot: path.join(__dirname, '..', '..') };
  }

  // Use require.resolve to find the installed ghostty-web package
  try {
    const ghosttyWebMain = require.resolve('ghostty-web');
    // Strip dist/... from path to get package root (regex already gives us the root)
    const ghosttyWebRoot = ghosttyWebMain.replace(/[/\\]dist[/\\].*$/, '');
    const distPath = path.join(ghosttyWebRoot, 'dist');
    const wasmPath = path.join(ghosttyWebRoot, 'ghostty-vt.wasm');

    if (fs.existsSync(path.join(distPath, 'ghostty-web.js')) && fs.existsSync(wasmPath)) {
      return { distPath, wasmPath, repoRoot: null };
    }
  } catch (e) {
    // require.resolve failed, package not found
  }

  console.error('Error: Could not find ghostty-web package.');
  console.error('');
  console.error('If developing locally, run: bun run build');
  console.error('If using npx, the package should install automatically.');
  process.exit(1);
}

const { distPath, wasmPath, repoRoot } = findGhosttyWeb();

// ============================================================================
// HTML Template
// ============================================================================

const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ghostty-web</title>
    <style>
      @font-face {
        font-family: "JetBrainsMono NF";
        src: url("https://cdn.jsdelivr.net/gh/ryanoasis/nerd-fonts@latest/patched-fonts/JetBrainsMono/Ligatures/Regular/JetBrainsMonoNerdFont-Regular.ttf") format("truetype");
        font-weight: 400;
        font-style: normal;
        font-display: swap;
      }
      @font-face {
        font-family: "JetBrainsMono NF";
        src: url("https://cdn.jsdelivr.net/gh/ryanoasis/nerd-fonts@latest/patched-fonts/JetBrainsMono/Ligatures/Bold/JetBrainsMonoNerdFont-Bold.ttf") format("truetype");
        font-weight: 700;
        font-style: normal;
        font-display: swap;
      }
      @font-face {
        font-family: "JetBrainsMono NF";
        src: url("https://cdn.jsdelivr.net/gh/ryanoasis/nerd-fonts@latest/patched-fonts/JetBrainsMono/Ligatures/Italic/JetBrainsMonoNerdFont-Italic.ttf") format("truetype");
        font-weight: 400;
        font-style: italic;
        font-display: swap;
      }
      @font-face {
        font-family: "JetBrainsMono NF";
        src: url("https://cdn.jsdelivr.net/gh/ryanoasis/nerd-fonts@latest/patched-fonts/JetBrainsMono/Ligatures/BoldItalic/JetBrainsMonoNerdFont-BoldItalic.ttf") format("truetype");
        font-weight: 700;
        font-style: italic;
        font-display: swap;
      }
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }

      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 40px 20px;
      }

      .terminal-window {
        width: 100%;
        max-width: 1000px;
        background: #1e1e1e;
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        overflow: hidden;
      }

      .title-bar {
        background: #2d2d2d;
        padding: 12px 16px;
        display: flex;
        align-items: center;
        gap: 12px;
        border-bottom: 1px solid #1a1a1a;
      }

      .traffic-lights {
        display: flex;
        gap: 8px;
      }

      .light {
        width: 12px;
        height: 12px;
        border-radius: 50%;
      }

      .light.red { background: #ff5f56; }
      .light.yellow { background: #ffbd2e; }
      .light.green { background: #27c93f; }

      .title {
        color: #e5e5e5;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0.3px;
      }

      .connection-status {
        margin-left: auto;
        font-size: 11px;
        color: #888;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #888;
      }

      .status-dot.connected { background: #27c93f; }
      .status-dot.disconnected { background: #ff5f56; }
      .status-dot.connecting { background: #ffbd2e; animation: pulse 1s infinite; }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      .terminal-content {
        height: 600px;
        padding: 16px;
        background: #1e1e1e;
        position: relative;
        overflow: hidden;
      }

      /* Ensure terminal canvas can handle scrolling */
      .terminal-content canvas {
        display: block;
      }

      @media (max-width: 768px) {
        .terminal-content {
          height: 500px;
        }
      }
    </style>
  </head>
  <body>
    <div class="terminal-window">
      <div class="title-bar">
        <div class="traffic-lights">
          <div class="light red"></div>
          <div class="light yellow"></div>
          <div class="light green"></div>
        </div>
        <span class="title">ghostty-web</span>
        <div class="connection-status">
          <div class="status-dot connecting" id="status-dot"></div>
          <span id="status-text">Connecting...</span>
        </div>
      </div>
      <div class="terminal-content" id="terminal"></div>
    </div>

    <script type="module">
      import { init, Terminal, FitAddon } from '/dist/ghostty-web.js';

      await init();
      const term = new Terminal({
        cols: 80,
        rows: 24,
        fontFamily: '"JetBrainsMono NF", Menlo, Monaco, monospace',
        fontSize: 14,
        theme: {
          background: '#1e1e1e',
          foreground: '#d4d4d4',
        },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      const container = document.getElementById('terminal');
      await term.open(container);

      // Wait for JetBrainsMono NF to load, then re-measure fonts
      await document.fonts.load('14px "JetBrainsMono NF"');
      term.loadFonts();

      fitAddon.fit();
      fitAddon.observeResize(); // Auto-fit when container resizes

      // Status elements
      const statusDot = document.getElementById('status-dot');
      const statusText = document.getElementById('status-text');

      function setStatus(status, text) {
        statusDot.className = 'status-dot ' + status;
        statusText.textContent = text;
      }

      // Connect to WebSocket PTY server (use same origin as HTTP server)
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = protocol + '//' + window.location.host + '/ws?cols=' + term.cols + '&rows=' + term.rows;
      let ws;

      // Read total canvas pixel dims (CSS pixels). The server stuffs these
      // into ws_xpixel / ws_ypixel via node-pty's resize(cols, rows, pixelSize)
      // so kittens like icat see non-zero TIOCGWINSZ pixel fields.
      function getPixelSize() {
        const canvas = container.querySelector('canvas');
        return canvas
          ? { xpixel: canvas.clientWidth, ypixel: canvas.clientHeight }
          : { xpixel: 0, ypixel: 0 };
      }

      function connect() {
        setStatus('connecting', 'Connecting...');
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          setStatus('connected', 'Connected');
          // Push initial pixel dims so TIOCGWINSZ-gated tools see them
          // before the first resize event.
          const px = getPixelSize();
          ws.send(JSON.stringify({
            type: 'resize',
            cols: term.cols,
            rows: term.rows,
            xpixel: px.xpixel,
            ypixel: px.ypixel,
          }));
        };

        ws.onmessage = (event) => {
          term.write(event.data);
        };

        ws.onclose = () => {
          setStatus('disconnected', 'Disconnected');
          term.write('\\r\\n\\x1b[31mConnection closed. Reconnecting in 2s...\\x1b[0m\\r\\n');
          setTimeout(connect, 2000);
        };

        ws.onerror = () => {
          setStatus('disconnected', 'Error');
        };
      }

      connect();

      // Send terminal input to server
      term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      // Handle resize - notify PTY when terminal dimensions change
      term.onResize(({ cols, rows }) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const px = getPixelSize();
          ws.send(JSON.stringify({
            type: 'resize',
            cols,
            rows,
            xpixel: px.xpixel,
            ypixel: px.ypixel,
          }));
        }
      });

      // Also handle window resize (for browsers that don't trigger ResizeObserver on window resize)
      window.addEventListener('resize', () => {
        fitAddon.fit();
      });

      // Handle mobile keyboard showing/hiding using visualViewport API
      if (window.visualViewport) {
        const terminalContent = document.querySelector('.terminal-content');
        const terminalWindow = document.querySelector('.terminal-window');
        const originalHeight = terminalContent.style.height;
        const body = document.body;

        window.visualViewport.addEventListener('resize', () => {
          const keyboardHeight = window.innerHeight - window.visualViewport.height;
          if (keyboardHeight > 100) {
            body.style.padding = '0';
            body.style.alignItems = 'flex-start';
            terminalWindow.style.borderRadius = '0';
            terminalWindow.style.maxWidth = '100%';
            terminalContent.style.height = (window.visualViewport.height - 60) + 'px';
            window.scrollTo(0, 0);
          } else {
            body.style.padding = '40px 20px';
            body.style.alignItems = 'center';
            terminalWindow.style.borderRadius = '12px';
            terminalWindow.style.maxWidth = '1000px';
            terminalContent.style.height = originalHeight || '600px';
          }
          fitAddon.fit();
        });
      }
    </script>
  </body>
</html>`;

// ============================================================================
// MIME Types
// ============================================================================

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ============================================================================
// HTTP Server
// ============================================================================

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Cross-origin isolation headers (required for SharedArrayBuffer / WASM)
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');

  // Serve index page
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML_TEMPLATE);
    return;
  }

  // Graceful shutdown endpoint (for testing / programmatic control)
  if (pathname === '/shutdown' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('shutting down\n');
    setImmediate(gracefulShutdown);
    return;
  }

  // Serve dist files
  if (pathname.startsWith('/dist/')) {
    const filePath = path.join(distPath, pathname.slice(6));
    serveFile(filePath, res);
    return;
  }

  // Serve WASM file
  if (pathname === '/ghostty-vt.wasm') {
    serveFile(wasmPath, res);
    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not Found');
});

function serveFile(filePath, res) {
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ============================================================================
// Ring Buffer
// ============================================================================

class RingBuffer {
  constructor(maxLines = 1000) {
    this._maxLines = maxLines;
    this._buf = [];
    this._partial = '';
  }

  push(line) {
    this._buf.push(line);
    if (this._buf.length > this._maxLines) {
      this._buf.shift();
    }
  }

  tail(n = 20) {
    return this._buf.slice(-n);
  }

  capture() {
    return this._buf.slice();
  }

  write(data) {
    // Append to partial line, then split on newlines
    const combined = this._partial + data;
    const lines = combined.split('\n');
    // Last element is either '' or an incomplete line
    this._partial = lines.pop();
    for (const line of lines) {
      this.push(line);
    }
  }
}

// ============================================================================
// WebSocket Server (using ws package)
// ============================================================================

// sessionId → { pty, ws, buffer, id, createdAt }
const sessions = new Map();
// ws → sessionId  (reverse lookup)
const wsSessions = new Map();
let nextSessionId = 0;

function makeSessionId() {
  return `s_${String(nextSessionId++).padStart(3, '0')}`;
}

function getShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function createPtySession(cols, rows) {
  const shell = getShell();
  const shellArgs = process.platform === 'win32' ? [] : [];

  const ptyProcess = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols: cols,
    rows: rows,
    cwd: homedir(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });

  return ptyProcess;
}

// WebSocket server attached to HTTP server (same port)
const wss = new WebSocketServer({ noServer: true });

// WebSocket server for Control Plane endpoint
const cpWss = new WebSocketServer({ noServer: true });

// Handle HTTP upgrade for WebSocket connections
httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/ws') {
    // In production, consider validating req.headers.origin to prevent CSRF
    // For development/demo purposes, we allow all origins
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else if (url.pathname === '/cp') {
    cpWss.handleUpgrade(req, socket, head, (ws) => {
      cpWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cols = Number.parseInt(url.searchParams.get('cols') || '80');
  const rows = Number.parseInt(url.searchParams.get('rows') || '24');

  // Create PTY
  const ptyProcess = createPtySession(cols, rows);
  const sessionId = makeSessionId();
  const buffer = new RingBuffer();
  const session = { pty: ptyProcess, ws, buffer, id: sessionId, createdAt: new Date() };
  sessions.set(sessionId, session);
  wsSessions.set(ws, sessionId);

  // PTY -> WebSocket
  ptyProcess.onData((data) => {
    buffer.write(data);
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[33mShell exited (code: ${exitCode})\x1b[0m\r\n`);
      ws.close();
    }
  });

  // WebSocket -> PTY
  ws.on('message', (data) => {
    const message = data.toString('utf8');

    // Check for resize message
    if (message.startsWith('{')) {
      try {
        const msg = JSON.parse(message);
        if (msg.type === 'resize') {
          // node-pty 1.2.0+ accepts a third pixelSize arg that sets
          // ws_xpixel / ws_ypixel in the PTY winsize struct. Without it,
          // kitty kittens (icat, etc.) read zeros via TIOCGWINSZ and
          // refuse to render images.
          if (msg.xpixel > 0 && msg.ypixel > 0) {
            ptyProcess.resize(msg.cols, msg.rows, {
              width: msg.xpixel,
              height: msg.ypixel,
            });
          } else {
            ptyProcess.resize(msg.cols, msg.rows);
          }
          return;
        }
      } catch (e) {
        // Not JSON, treat as input
      }
    }

    // Send to PTY
    ptyProcess.write(message);
  });

  ws.on('close', () => {
    const sid = wsSessions.get(ws);
    wsSessions.delete(ws);
    if (sid !== undefined) {
      const session = sessions.get(sid);
      if (session) {
        session.pty.kill();
        sessions.delete(sid);
      }
    }
  });

  ws.on('error', () => {
    // Ignore socket errors (connection reset, etc.)
  });

  // Send welcome message
  const C = '\x1b[1;36m'; // Cyan
  const G = '\x1b[1;32m'; // Green
  const Y = '\x1b[1;33m'; // Yellow
  const R = '\x1b[0m'; // Reset
  ws.send(`${C}╔══════════════════════════════════════════════════════════════╗${R}\r\n`);
  ws.send(
    `${C}║${R}  ${G}Welcome to ghostty-web!${R}                                     ${C}║${R}\r\n`
  );
  ws.send(`${C}║${R}                                                              ${C}║${R}\r\n`);
  ws.send(`${C}║${R}  You have a real shell session with full PTY support.        ${C}║${R}\r\n`);
  ws.send(
    `${C}║${R}  Try: ${Y}ls${R}, ${Y}cd${R}, ${Y}top${R}, ${Y}vim${R}, or any command!                      ${C}║${R}\r\n`
  );
  ws.send(`${C}╚══════════════════════════════════════════════════════════════╝${R}\r\n\r\n`);
});

// ============================================================================
// Control Plane WebSocket (/cp) — ghostty-win compatible pipe protocol
// ============================================================================

// Resolve a session by optional sessionId argument.
// Returns the session object or null.
function resolveSession(sessionIdArg) {
  if (sessionIdArg) {
    return sessions.get(sessionIdArg) || null;
  }
  // No sessionId specified — return first session
  const first = sessions.values().next();
  return first.done ? null : first.value;
}

let cpCmdCounter = 0;
function nextCmdId() {
  return `cmd_${String(cpCmdCounter++).padStart(6, '0')}`;
}

cpWss.on('connection', (ws) => {
  let persistent = false;

  ws.on('message', (raw) => {
    const line = raw.toString('utf8').replace(/\n$/, '');
    const parts = line.split('|');
    const cmd = parts[0];

    function reply(msg) {
      if (ws.readyState === ws.OPEN) {
        ws.send(msg + '\n');
      }
    }

    function errReply(code) {
      reply(`ERR|ghostty-web|${code}`);
    }

    switch (cmd) {
      case 'PING': {
        reply(`PONG|ghostty-web|${process.pid}`);
        break;
      }

      case 'PERSIST': {
        persistent = true;
        reply(`OK|ghostty-web|PERSIST`);
        break;
      }

      case 'STATE': {
        // STATE[|sessionId]
        const sessionIdArg = parts[1] || '';
        const session = resolveSession(sessionIdArg);
        if (!session) {
          errReply('NO_TABS');
          break;
        }
        const shell = getShell();
        const tabCount = sessions.size;
        reply(`STATE|ghostty-web|${process.pid}|0x0|${shell}|tab_count=${tabCount}|active_tab=0`);
        break;
      }

      case 'TAIL': {
        // TAIL[|n][|sessionId]  — args are positional but both optional
        // Distinguish: if parts[1] looks numeric treat as n, else sessionId
        let n = 20;
        let sessionIdArg = '';
        if (parts[1] !== undefined) {
          const parsed = Number(parts[1]);
          if (!isNaN(parsed) && parts[1] !== '') {
            n = parsed;
            sessionIdArg = parts[2] || '';
          } else {
            sessionIdArg = parts[1];
          }
        }
        const session = resolveSession(sessionIdArg);
        if (!session) {
          errReply('NO_TABS');
          break;
        }
        const lines = session.buffer.tail(n);
        reply(`TAIL|ghostty-web|${lines.length}\n${lines.join('\n')}`);
        break;
      }

      case 'CAPTURE_PANE': {
        // CAPTURE_PANE[|sessionId]
        const sessionIdArg = parts[1] || '';
        const session = resolveSession(sessionIdArg);
        if (!session) {
          errReply('NO_TABS');
          break;
        }
        const lines = session.buffer.capture();
        const ms = Date.now();
        reply(`OK|ghostty-web|CAPTURE_PANE|epoch_ms=${ms}|lines=${lines.length}\n${lines.join('\n')}`);
        break;
      }

      case 'LIST_TABS': {
        const count = sessions.size;
        const shell = getShell();
        const tabLines = [];
        let idx = 0;
        for (const [sid, sess] of sessions) {
          tabLines.push(`TAB|${idx}|${shell}|${sid}|${sess.createdAt.toISOString()}`);
          idx++;
        }
        reply(`LIST_TABS|${count}|0\n${tabLines.join('\n')}`);
        break;
      }

      case 'INPUT': {
        // INPUT|{from}|{base64text}[|sessionId]
        const from = parts[1] || '';
        const b64 = parts[2] || '';
        const sessionIdArg = parts[3] || '';
        const session = resolveSession(sessionIdArg);
        if (!session) {
          errReply('NO_TABS');
          break;
        }
        const text = Buffer.from(b64, 'base64').toString('utf8');
        session.pty.write(text);
        const cmdId = nextCmdId();
        reply(`QUEUED|ghostty-web|INPUT|${cmdId}`);
        break;
      }

      case 'PASTE': {
        // PASTE|{from}|{base64text}[|sessionId]
        const from = parts[1] || '';
        const b64 = parts[2] || '';
        const sessionIdArg = parts[3] || '';
        const session = resolveSession(sessionIdArg);
        if (!session) {
          errReply('NO_TABS');
          break;
        }
        const text = Buffer.from(b64, 'base64').toString('utf8');
        // Bracketed paste: ESC[?2004h must already be enabled by the shell;
        // we just wrap in the bracketed paste sequences
        session.pty.write('\x1b[200~' + text + '\x1b[201~');
        const cmdId = nextCmdId();
        reply(`QUEUED|ghostty-web|PASTE|${cmdId}`);
        break;
      }

      case 'ACK_POLL': {
        // ACK_POLL|{cmdId}
        const cmdId = parts[1] || '';
        // node-pty writes are synchronous — always ACK immediately
        reply(`ACK|ghostty-web|${cmdId}`);
        break;
      }

      default: {
        errReply('UNKNOWN_CMD');
        break;
      }
    }
  });

  ws.on('error', () => {
    // Ignore socket errors
  });
});

// ============================================================================
// Startup
// ============================================================================

// Control Plane session file management
function getSessionFilePath() {
  const pid = process.pid;
  const dir =
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'ghostty', 'control-plane', 'web', 'sessions')
      : path.join(homedir(), '.local', 'share', 'ghostty', 'control-plane', 'web', 'sessions');
  return path.join(dir, `ghostty-web-${pid}.session`);
}

function writeSessionFile(port) {
  const pid = process.pid;
  const filePath = getSessionFilePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const content = [
    `session_name=ghostty-web-${pid}`,
    `safe_session_name=ghostty-web`,
    `pid=${pid}`,
    `ws_url=ws://localhost:${port}/cp`,
    `port=${port}`,
  ].join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf8');
}

function removeSessionFile() {
  try {
    fs.unlinkSync(getSessionFilePath());
  } catch (e) {
    // Ignore if file does not exist
  }
}

function printBanner(url) {
  console.log('\n' + '═'.repeat(60));
  console.log('  🚀 ghostty-web demo server' + (DEV_MODE ? ' (dev mode)' : ''));
  console.log('═'.repeat(60));
  console.log(`\n  📺 Open: ${url}`);
  console.log(`  📡 WebSocket PTY: same endpoint /ws`);
  console.log(`  🐚 Shell: ${getShell()}`);
  console.log(`  📁 Home: ${homedir()}`);
  if (DEV_MODE) {
    console.log(`  🔥 Hot reload enabled via Vite`);
  } else if (repoRoot) {
    console.log(`  📦 Using local build: ${distPath}`);
  }
  console.log('\n  ⚠️  This server provides shell access.');
  console.log('     Only use for local development.\n');
  console.log('═'.repeat(60));
  console.log('  Press Ctrl+C to stop.\n');
}

// Graceful shutdown
function gracefulShutdown() {
  removeSessionFile();
  for (const [, session] of sessions.entries()) {
    session.pty.kill();
    session.ws.close();
  }
  wss.close();
  cpWss.close();
  process.exit(0);
}

process.on('SIGINT', () => {
  console.log('\n\nShutting down...');
  gracefulShutdown();
});

process.on('SIGTERM', () => {
  gracefulShutdown();
});

process.on('exit', () => {
  removeSessionFile();
});

// Start HTTP/Vite server
if (DEV_MODE) {
  // Dev mode: use Vite for hot reload
  const { createServer } = await import('vite');
  const vite = await createServer({
    root: repoRoot,
    server: {
      port: HTTP_PORT,
      strictPort: true,
    },
  });

  await vite.listen();
  writeSessionFile(HTTP_PORT);

  // Attach WebSocket handler AFTER Vite has fully initialized
  // Use prependListener (not prependOnceListener) so it runs for every request
  // This ensures our handler runs BEFORE Vite's handlers
  if (vite.httpServer) {
    vite.httpServer.prependListener('upgrade', (req, socket, head) => {
      const pathname = req.url?.split('?')[0] || req.url || '';

      // Handle /ws and /cp — everything else passes through unchanged to Vite
      if (pathname === '/ws') {
        if (!socket.destroyed && !socket.readableEnded) {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
          });
        }
        // Stop here - we handled it, socket is consumed
        // Don't call other listeners
        return;
      }

      if (pathname === '/cp') {
        if (!socket.destroyed && !socket.readableEnded) {
          cpWss.handleUpgrade(req, socket, head, (ws) => {
            cpWss.emit('connection', ws, req);
          });
        }
        return;
      }

      // For non-/ws and non-/cp paths, explicitly do nothing and let the event propagate
      // The key is: don't return, don't touch the socket, just let it pass through
      // Vite's handlers (which were added before ours via prependListener) will process it
    });
  }

  printBanner(`http://localhost:${HTTP_PORT}/demo/`);
} else {
  // Production mode: static file server
  httpServer.listen(HTTP_PORT, () => {
    writeSessionFile(HTTP_PORT);
    printBanner(`http://localhost:${HTTP_PORT}`);
  });
}
