#!/usr/bin/env bun
/**
 * Headless visual regression test runner for the renderer.
 *
 * Usage:
 *   bun demo/bin/render-test.ts           # Run tests against baselines
 *   bun demo/bin/render-test.ts --update  # Update baselines from current renders
 *
 * Baselines are stored in demo/baselines/*.png
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Get script directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEMO_DIR = dirname(__dirname);
const BASELINES_DIR = join(DEMO_DIR, 'baselines');
const PROJECT_ROOT = dirname(DEMO_DIR);

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html',
  js: 'application/javascript',
  css: 'text/css',
  json: 'application/json',
  wasm: 'application/wasm',
  png: 'image/png',
  ttf: 'font/ttf',
};

// Parse args
const args = process.argv.slice(2);
const updateMode = args.includes('--update') || args.includes('-u');
const helpMode = args.includes('--help') || args.includes('-h');

if (helpMode) {
  console.log(`
Visual Render Test Runner

Usage:
  bun demo/bin/render-test.ts [options]

Options:
  --update, -u    Update baselines from current renders
  --help, -h      Show this help message

Baselines are stored in demo/baselines/*.png
`);
  process.exit(0);
}

// Ensure baselines directory exists
if (!existsSync(BASELINES_DIR)) {
  mkdirSync(BASELINES_DIR, { recursive: true });
}

interface TestResult {
  id: string;
  name: string;
  status: 'pass' | 'fail' | 'new' | 'error';
  diffPercent?: number;
  error?: string;
}

async function main() {
  console.log('🧪 Visual Render Test Runner\n');

  const puppeteer = await import('puppeteer');

  // Start local server
  console.log('🌐 Starting local server...');
  const server = Bun.serve({
    port: 0, // Let OS pick a free port
    async fetch(req) {
      const url = new URL(req.url);
      let filePath = join(PROJECT_ROOT, url.pathname);

      // Default to index.html for directories
      if (filePath.endsWith('/')) {
        filePath += 'index.html';
      }

      try {
        const file = Bun.file(filePath);
        if (await file.exists()) {
          const ext = filePath.split('.').pop() || '';
          return new Response(file, {
            headers: { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' },
          });
        }
      } catch {
        // Fall through to 404
      }
      return new Response('Not found', { status: 404 });
    },
  });

  const serverUrl = `http://localhost:${server.port}`;
  console.log(`   Server running at ${serverUrl}`);

  // Launch browser
  console.log('🚀 Launching headless browser...');
  const browser = await puppeteer.default.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();

  // Set viewport for consistent rendering
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });

  try {
    // Navigate to test page
    console.log('📄 Loading test page...\n');
    await page.goto(`${serverUrl}/demo/render-test.html`, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Wait for the page's runAllTests() to complete.
    // render-test.html sets window.__testsComplete = true when done.
    await page.waitForFunction('window.__testsComplete === true', { timeout: 60000 });

    // Get test cases from the page
    const testCases = await page.evaluate(() => {
      // Access the module's test cases through the window exports
      // We need to extract test info from the DOM since testCases is module-scoped
      const cards = document.querySelectorAll('.test-case');
      return Array.from(cards).map((card) => {
        const id = card.id.replace('test-', '');
        const name = card.querySelector('h3')?.textContent || id;
        return { id, name };
      });
    });

    if (testCases.length === 0) {
      throw new Error('No test cases found. Make sure the page loaded correctly.');
    }

    console.log(`Found ${testCases.length} tests\n`);

    // Run tests and collect results
    const results: TestResult[] = [];
    let passed = 0;
    let failed = 0;
    let newTests = 0;

    for (const test of testCases) {
      const baselinePath = join(BASELINES_DIR, `${test.id}.png`);
      const hasBaseline = existsSync(baselinePath);

      // Get the canvas data URL from the page
      const canvasDataUrl = await page.evaluate((testId: string) => {
        const canvas = document.getElementById(`canvas-${testId}`) as HTMLCanvasElement;
        return canvas?.toDataURL('image/png') || null;
      }, test.id);

      if (!canvasDataUrl) {
        results.push({ id: test.id, name: test.name, status: 'error', error: 'Canvas not found' });
        console.log(`  ❌ ${test.name}: Canvas not found`);
        failed++;
        continue;
      }

      const currentBuffer = Buffer.from(canvasDataUrl.split(',')[1], 'base64');

      if (updateMode) {
        // Update mode: save current as baseline
        writeFileSync(baselinePath, currentBuffer);
        console.log(`  📸 ${test.name}: Baseline ${hasBaseline ? 'updated' : 'created'}`);
        results.push({ id: test.id, name: test.name, status: 'new' });
        newTests++;
      } else if (!hasBaseline) {
        // No baseline exists
        console.log(`  🆕 ${test.name}: No baseline (run with --update to create)`);
        results.push({ id: test.id, name: test.name, status: 'new' });
        newTests++;
      } else {
        // Compare with baseline
        const baselineBuffer = readFileSync(baselinePath);

        // Simple byte comparison first
        if (currentBuffer.equals(baselineBuffer)) {
          console.log(`  ✅ ${test.name}: Pass (identical)`);
          results.push({ id: test.id, name: test.name, status: 'pass', diffPercent: 0 });
          passed++;
        } else {
          // Buffers differ - calculate difference percentage
          const diffPercent = calculateDiffPercent(currentBuffer, baselineBuffer);

          if (diffPercent <= 0.1) {
            // Within threshold
            console.log(`  ✅ ${test.name}: Pass (${diffPercent.toFixed(3)}% diff)`);
            results.push({ id: test.id, name: test.name, status: 'pass', diffPercent });
            passed++;
          } else {
            console.log(`  ❌ ${test.name}: Fail (${diffPercent.toFixed(3)}% diff)`);
            results.push({ id: test.id, name: test.name, status: 'fail', diffPercent });
            failed++;

            // Save the current render for debugging
            const failPath = join(BASELINES_DIR, `${test.id}.fail.png`);
            writeFileSync(failPath, currentBuffer);
          }
        }
      }
    }

    // Summary
    console.log('\n' + '─'.repeat(50));
    console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${newTests} new\n`);

    if (updateMode) {
      console.log(`✨ Baselines ${newTests > 0 ? 'updated' : 'unchanged'} in demo/baselines/\n`);
    }

    // Exit with appropriate code
    await browser.close();
    server.stop();

    if (failed > 0) {
      process.exit(1);
    } else if (newTests > 0 && !updateMode) {
      console.log('⚠️  New tests detected. Run with --update to create baselines.\n');
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error);
    await browser.close();
    server.stop();
    process.exit(1);
  }
}

/**
 * Heuristic difference percentage between two PNG buffers (byte-level, not pixel-level).
 * NOTE: compares compressed bytes — identical-looking renders with different metadata
 * may produce non-zero results. Replace with pixelmatch for pixel-accurate comparison.
 */
function calculateDiffPercent(buf1: Buffer, buf2: Buffer): number {
  const maxSize = Math.max(buf1.length, buf2.length);
  const sizeDiff = Math.abs(buf1.length - buf2.length);

  if (sizeDiff > 0) {
    return (sizeDiff / maxSize) * 100;
  }

  const threshold = maxSize * 0.001; // 0.1%
  let diffBytes = 0;
  for (let i = 0; i < buf1.length; i++) {
    if (buf1[i] !== buf2[i] && ++diffBytes > threshold) {
      return (diffBytes / maxSize) * 100;
    }
  }

  return (diffBytes / maxSize) * 100;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
