#!/usr/bin/env node
/**
 * Test: Control Plane session file creation and cleanup
 *
 * Tests that demo.js writes a session file on startup and removes it on SIGINT.
 *
 * Usage: node demo/test-session-file.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEMO_JS = path.join(__dirname, 'bin', 'demo.js');
const TEST_PORT = 18081;
const STARTUP_WAIT_MS = 3000;
const SHUTDOWN_WAIT_MS = 2000;
const TOTAL_TIMEOUT_MS = 15000;

// ── helpers ──────────────────────────────────────────────────────────────────

function getSessionFilePath(pid) {
  const dir =
    process.platform === 'win32'
      ? path.join(
          process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'),
          'ghostty',
          'control-plane',
          'web',
          'sessions'
        )
      : path.join(homedir(), '.local', 'share', 'ghostty', 'control-plane', 'web', 'sessions');
  return path.join(dir, `ghostty-web-${pid}.session`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpPost(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port, path, method: 'POST' }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.end();
  });
}

function checkDistExists() {
  const localDist = path.join(__dirname, '..', 'dist');
  const localJs = path.join(localDist, 'ghostty-web.js');
  const localWasm = path.join(__dirname, '..', 'ghostty-vt.wasm');
  return fs.existsSync(localJs) && fs.existsSync(localWasm);
}

// ── main ─────────────────────────────────────────────────────────────────────

const overallTimer = setTimeout(() => {
  console.error('FAIL: overall timeout (15s) exceeded');
  process.exit(1);
}, TOTAL_TIMEOUT_MS);
overallTimer.unref();

async function run() {
  // Skip gracefully if dist/ is not built
  if (!checkDistExists()) {
    console.log('SKIP: dist/ not found. Run `bun run build` first.');
    process.exit(0);
  }

  let child = null;
  let passed = 0;
  let failed = 0;

  function ok(name) {
    console.log(`  PASS: ${name}`);
    passed++;
  }

  function fail(name, err) {
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message || err}`);
    failed++;
  }

  try {
    // ── Test 1: session file is created on startup ──────────────────────────
    console.log('\nTest 1: session file creation');

    child = spawn(process.execPath, [DEMO_JS], {
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const pid = child.pid;
    console.log(`  demo.js started (pid=${pid}, port=${TEST_PORT})`);

    // Collect stderr for diagnostics
    child.stderr.on('data', () => {});
    child.stdout.on('data', () => {});

    // Wait for the server to start and write the session file
    await sleep(STARTUP_WAIT_MS);

    const sessionFilePath = getSessionFilePath(pid);
    console.log(`  session file path: ${sessionFilePath}`);

    // 1a. File exists
    try {
      assert.ok(fs.existsSync(sessionFilePath), 'session file should exist after startup');
      ok('session file exists');
    } catch (e) {
      fail('session file exists', e);
    }

    // 1b. File content format
    if (fs.existsSync(sessionFilePath)) {
      const content = fs.readFileSync(sessionFilePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      const kv = Object.fromEntries(lines.map((l) => l.split('=').map((s, i) => (i === 0 ? s : l.slice(l.indexOf('=') + 1)))));

      try {
        assert.strictEqual(kv['session_name'], `ghostty-web-${pid}`, 'session_name');
        ok('session_name field correct');
      } catch (e) {
        fail('session_name field correct', e);
      }

      try {
        assert.strictEqual(kv['safe_session_name'], 'ghostty-web', 'safe_session_name');
        ok('safe_session_name field correct');
      } catch (e) {
        fail('safe_session_name field correct', e);
      }

      try {
        assert.strictEqual(kv['pid'], String(pid), 'pid field');
        ok('pid field correct');
      } catch (e) {
        fail('pid field correct', e);
      }

      try {
        assert.strictEqual(kv['ws_url'], `ws://localhost:${TEST_PORT}/cp`, 'ws_url field');
        ok('ws_url field correct');
      } catch (e) {
        fail('ws_url field correct', e);
      }

      try {
        assert.strictEqual(kv['port'], String(TEST_PORT), 'port field');
        ok('port field correct');
      } catch (e) {
        fail('port field correct', e);
      }
    } else {
      // Already counted as fail above; skip content checks
      ['session_name field correct', 'safe_session_name field correct', 'pid field correct', 'ws_url field correct', 'port field correct'].forEach(
        (name) => fail(name, new Error('session file missing, cannot check content'))
      );
    }

    // ── Test 2: session file is removed on SIGINT ───────────────────────────
    console.log('\nTest 2: session file deletion on SIGINT');

    await httpPost(TEST_PORT, '/shutdown');
    await sleep(SHUTDOWN_WAIT_MS);

    try {
      assert.ok(!fs.existsSync(sessionFilePath), 'session file should be deleted after SIGINT');
      ok('session file removed after SIGINT');
    } catch (e) {
      fail('session file removed after SIGINT', e);
    }
  } finally {
    // Ensure child is terminated even if assertions throw
    if (child && !child.killed) {
      child.kill('SIGKILL');
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  clearTimeout(overallTimer);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
