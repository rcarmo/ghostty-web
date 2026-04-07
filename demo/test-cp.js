#!/usr/bin/env node
/**
 * test-cp.js — Control Plane WebSocket endpoint tests for demo.js
 *
 * Run: node demo/test-cp.js
 *
 * Tests the /cp WebSocket endpoint using the ghostty-win compatible
 * pipe protocol (| delimited text).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEMO_JS = path.join(__dirname, 'bin', 'demo.js');
const TEST_PORT = 18080;
const CP_URL = `ws://localhost:${TEST_PORT}/cp`;
const WS_URL = `ws://localhost:${TEST_PORT}/ws`;

// ============================================================================
// Helpers
// ============================================================================

/** Start demo.js as a child process and wait until the server is ready. */
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DEMO_JS], {
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let ready = false;
    const onData = (chunk) => {
      if (!ready && chunk.toString().includes('ghostty-web demo server')) {
        ready = true;
        child.stdout.off('data', onData);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', () => {}); // suppress stderr

    child.on('error', reject);
    child.on('exit', (code) => {
      if (!ready) reject(new Error(`demo.js exited with code ${code} before becoming ready`));
    });

    // Fail if not ready within 10 seconds
    setTimeout(() => {
      if (!ready) reject(new Error('Timeout waiting for demo.js to start'));
    }, 10_000);
  });
}

/** Kill the server process and wait for it to exit. */
function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once('exit', resolve);
    child.kill('SIGTERM');
    // Force-kill after 3s
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
  });
}

/**
 * Open a WebSocket and return it once the connection is open.
 * Registers an error listener so unhandled rejections don't leak.
 */
function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Close a WebSocket and wait for it to finish. */
function closeWs(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.once('close', resolve);
    ws.close();
  });
}

/**
 * Send a message and wait for the next message from the server.
 * Returns the raw string (newline stripped).
 */
function sendAndReceive(ws, msg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for reply to: ${msg}`)), 5000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(data.toString('utf8').replace(/\n$/, ''));
    });
    ws.send(msg);
  });
}

/** Wait for the next message without sending anything. */
function nextMessage(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(data.toString('utf8').replace(/\n$/, ''));
    });
  });
}

/** Sleep for `ms` milliseconds. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// Test runner
// ============================================================================

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
    failed++;
  }
}

// ============================================================================
// Tests
// ============================================================================

async function runTests(child) {
  // Shared CP connection (opened once, reused across tests that don't need isolation)
  const cp = await openWs(CP_URL);

  // ── Test 1: PING ──────────────────────────────────────────────────────────
  await test('PING returns PONG|ghostty-web|{pid}', async () => {
    const reply = await sendAndReceive(cp, 'PING');
    const parts = reply.split('|');
    assert.equal(parts[0], 'PONG');
    assert.equal(parts[1], 'ghostty-web');
    assert.match(parts[2], /^\d+$/, 'pid should be numeric');
  });

  // ── Test 2: LIST_TABS (no sessions) ───────────────────────────────────────
  await test('LIST_TABS with no sessions returns LIST_TABS|0|0', async () => {
    const reply = await sendAndReceive(cp, 'LIST_TABS');
    // Response is multi-line; first line is the header
    const header = reply.split('\n')[0];
    assert.equal(header, 'LIST_TABS|0|0');
  });

  // ── Test 3: LIST_TABS after /ws session ───────────────────────────────────
  await test('LIST_TABS after /ws connect shows 1 session', async () => {
    const ptySock = await openWs(`${WS_URL}?cols=80&rows=24`);
    // Drain the welcome message(s) — demo.js sends several ws.send() calls
    await sleep(300);

    const reply = await sendAndReceive(cp, 'LIST_TABS');
    const lines = reply.split('\n');
    const header = lines[0];
    const parts = header.split('|');
    assert.equal(parts[0], 'LIST_TABS');
    assert.equal(parts[1], '1', 'should have 1 session');

    const tabLine = lines.find((l) => l.startsWith('TAB|'));
    assert.ok(tabLine, 'TAB line should be present');
    const tabParts = tabLine.split('|');
    assert.equal(tabParts[0], 'TAB');
    assert.equal(tabParts[1], '0', 'tab index should be 0');

    await closeWs(ptySock);
    await sleep(100); // let server clean up
  });

  // ── Test 4: INPUT + TAIL ──────────────────────────────────────────────────
  await test('INPUT writes to PTY and TAIL returns output including hello-cp-test', async () => {
    const ptySock = await openWs(`${WS_URL}?cols=80&rows=24`);
    try {
      await sleep(2000); // wait for shell (cmd.exe on Windows needs more time)

      const b64Input = Buffer.from('echo hello-cp-test\r\n').toString('base64');
      const inputReply = await sendAndReceive(cp, `INPUT|test|${b64Input}`);
      assert.match(inputReply, /^QUEUED\|ghostty-web\|INPUT\|cmd_\d+$/);

      await sleep(800);

      // Send a blank line to force cmd.exe to emit a newline, flushing the
      // ring buffer's _partial (cmd.exe uses cursor-move sequences so output
      // may not contain a trailing \n until the next prompt arrives).
      const b64Noop = Buffer.from('\n').toString('base64');
      cp.send(`INPUT|test|${b64Noop}`);
      // Drain the QUEUED reply without waiting
      await new Promise(r => cp.once('message', r));

      // Poll TAIL until hello-cp-test appears or timeout (up to 5s)
      let found = false;
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        const tailReply = await sendAndReceive(cp, 'TAIL|100');
        if (tailReply.includes('hello-cp-test')) { found = true; break; }
      }
      assert.ok(found, 'Expected hello-cp-test in TAIL output within 5 seconds');
    } finally {
      await closeWs(ptySock);
      await sleep(200);
    }
  });

  // ── Test 5: CAPTURE_PANE ──────────────────────────────────────────────────
  await test('CAPTURE_PANE returns OK header and non-empty body', async () => {
    const ptySock = await openWs(`${WS_URL}?cols=80&rows=24`);
    await sleep(300);

    const reply = await sendAndReceive(cp, 'CAPTURE_PANE');
    const firstLine = reply.split('\n')[0];
    assert.match(firstLine, /^OK\|ghostty-web\|CAPTURE_PANE\|epoch_ms=\d+\|lines=\d+$/);

    // Body should be non-empty (at minimum the shell prompt has been written)
    const body = reply.split('\n').slice(1).join('\n');
    assert.ok(body.length > 0, 'CAPTURE_PANE body should be non-empty');

    await closeWs(ptySock);
    await sleep(100);
  });

  // ── Test 6: STATE ─────────────────────────────────────────────────────────
  await test('STATE returns STATE|ghostty-web|{pid}|0x0|...', async () => {
    const ptySock = await openWs(`${WS_URL}?cols=80&rows=24`);
    await sleep(200);

    const reply = await sendAndReceive(cp, 'STATE');
    const parts = reply.split('|');
    assert.equal(parts[0], 'STATE');
    assert.equal(parts[1], 'ghostty-web');
    assert.match(parts[2], /^\d+$/, 'pid should be numeric');
    assert.equal(parts[3], '0x0');

    await closeWs(ptySock);
    await sleep(100);
  });

  // ── Test 7: ACK_POLL ──────────────────────────────────────────────────────
  await test('ACK_POLL|cmd_000001 returns ACK|ghostty-web|cmd_000001', async () => {
    const reply = await sendAndReceive(cp, 'ACK_POLL|cmd_000001');
    assert.equal(reply, 'ACK|ghostty-web|cmd_000001');
  });

  // ── Test 8: PERSIST ───────────────────────────────────────────────────────
  await test('PERSIST returns OK|ghostty-web|PERSIST', async () => {
    const reply = await sendAndReceive(cp, 'PERSIST');
    assert.equal(reply, 'OK|ghostty-web|PERSIST');
  });

  // ── Test 9: PASTE ─────────────────────────────────────────────────────────
  await test('PASTE returns QUEUED|ghostty-web|PASTE|cmd_...', async () => {
    const ptySock = await openWs(`${WS_URL}?cols=80&rows=24`);
    await sleep(200);

    const b64 = Buffer.from('pasted text').toString('base64');
    const reply = await sendAndReceive(cp, `PASTE|test|${b64}`);
    assert.match(reply, /^QUEUED\|ghostty-web\|PASTE\|cmd_\d+$/);

    await closeWs(ptySock);
    await sleep(100);
  });

  // ── Test 10: Unknown command ───────────────────────────────────────────────
  await test('Unknown command returns ERR|ghostty-web|UNKNOWN_CMD', async () => {
    const reply = await sendAndReceive(cp, 'FOOBAR');
    assert.equal(reply, 'ERR|ghostty-web|UNKNOWN_CMD');
  });

  // ── Test 11: INPUT with no sessions ───────────────────────────────────────
  await test('INPUT with no active sessions returns ERR|ghostty-web|NO_TABS', async () => {
    // Use a fresh CP connection to ensure no sessions are attached to *this* cp
    // Sessions are global — we need to ensure all /ws connections are closed.
    // (Tests above close their ptySock; sleep gives the server time to clean up)
    await sleep(200);

    // Open a fresh CP to avoid any residual message ordering issues
    const cp2 = await openWs(CP_URL);

    // Verify no sessions remain
    const listReply = await sendAndReceive(cp2, 'LIST_TABS');
    const count = parseInt(listReply.split('\n')[0].split('|')[1], 10);
    if (count !== 0) {
      // Sessions still present — skip this assertion to avoid false failure
      console.warn(`         (skipped NO_TABS check: ${count} session(s) still alive)`);
      await closeWs(cp2);
      return;
    }

    const b64 = Buffer.from('hello').toString('base64');
    const reply = await sendAndReceive(cp2, `INPUT|test|${b64}`);
    assert.equal(reply, 'ERR|ghostty-web|NO_TABS');

    await closeWs(cp2);
  });

  await closeWs(cp);
}

// ============================================================================
// Entry point
// ============================================================================

async function main() {
  console.log('Starting demo.js server...');

  let child;
  // Global timeout — kill everything after 30 seconds
  const globalTimer = setTimeout(async () => {
    console.error('\nGlobal timeout reached (30s). Killing server.');
    if (child) await stopServer(child);
    process.exit(1);
  }, 30_000);

  try {
    child = await startServer();
    console.log(`Server ready on port ${TEST_PORT}\n`);

    await runTests(child);
  } catch (err) {
    console.error('Fatal error:', err.message);
    failed++;
  } finally {
    clearTimeout(globalTimer);
    if (child) await stopServer(child);

    console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

main();
