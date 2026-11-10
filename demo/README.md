# @ghostty-web/demo

Cross-platform demo server for [ghostty-web](https://github.com/rcarmo/ghostty-web) terminal emulator.

## Quick Start

```bash
npx @ghostty-web/demo@next
```

This starts a local web server with a fully functional terminal connected to your shell.
Works on **Linux** and **macOS** (no Windows support yet).

## What it does

- Starts an HTTP server on `127.0.0.1:8080` by default. Set `PORT` to change the port.
- Serves the browser terminal demo and PTY/control-plane WebSocket plumbing
- Opens a real shell session (bash, zsh, etc.)
- Provides full PTY support (colors, cursor positioning, resize, etc.)
- Uses the Canvas renderer by default; WebGL remains library-level opt-in via `new Terminal({ renderer: 'webgl' })` with safe Canvas fallback

## Usage

```bash
# Default (port 8080)
npx @ghostty-web/demo@next

# Custom port
PORT=3000 npx @ghostty-web/demo@next
```

Then open http://localhost:8080 in your browser.

## Shell access

The browser WebSocket requires a per-run token from the same origin. The demo checks the
`Host` header against an allowlist. If you use a reverse proxy, preserve the browser's Host
and Origin and set `GHOSTTY_ALLOWED_HOSTS` to a comma-separated list of permitted hostnames.

Anyone who can load the demo from an allowed host can open a shell. Keep it on loopback or
put access control in front of it. The control plane is local-only and uses a separate
token in the private session file's `ws_url`. Local control clients should use that URL as
written. A local program can send the same token as `Authorization: Bearer <token>` to
`POST /shutdown`.

## Renderer Notes

The packaged demo intentionally uses the default Canvas renderer because it covers the full current feature set, including kitty graphics and geometric box/block drawing. Library consumers can opt into the experimental WebGL2 renderer with:

```ts
const term = new Terminal({ renderer: 'webgl' });
```

If WebGL2 is unavailable or initialization fails, `ghostty-web` falls back to Canvas. Both renderer paths use the terminal canvas' owner browsing context for DOM/timer/DPR/link-opening behavior, which makes embedded or iframe-hosted demos safer than relying on global `window`/`document`.

The library also supports `allowTransparency: true` and an `onLinkClick(url, event)` override for hosts that want transparent backgrounds or in-app link handling instead of opening a new tab. Runtime renderer paths are event-driven and validate scroll/selection/decoration dimensions before updating canvas/WebGL state, which helps embedded hosts avoid stale or invalid UI state after rapid resizes or disposal.
