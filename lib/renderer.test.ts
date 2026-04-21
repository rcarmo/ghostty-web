/**
 * Tests for Canvas Renderer
 *
 * Note: Most renderer tests are visual and require a browser environment.
 * These tests verify non-visual aspects like theme configuration.
 * Full visual tests are in examples/renderer-demo.html
 */

import { describe, expect, test } from 'bun:test';
import { CanvasRenderer, DEFAULT_THEME } from './renderer';

describe('CanvasRenderer', () => {
  describe('Default Theme', () => {
    test('has all required ANSI colors', () => {
      expect(DEFAULT_THEME.black).toBe('#000000');
      expect(DEFAULT_THEME.red).toBe('#cd3131');
      expect(DEFAULT_THEME.green).toBe('#0dbc79');
      expect(DEFAULT_THEME.yellow).toBe('#e5e510');
      expect(DEFAULT_THEME.blue).toBe('#2472c8');
      expect(DEFAULT_THEME.magenta).toBe('#bc3fbc');
      expect(DEFAULT_THEME.cyan).toBe('#11a8cd');
      expect(DEFAULT_THEME.white).toBe('#e5e5e5');
    });

    test('has all bright ANSI colors', () => {
      expect(DEFAULT_THEME.brightBlack).toBe('#666666');
      expect(DEFAULT_THEME.brightRed).toBe('#f14c4c');
      expect(DEFAULT_THEME.brightGreen).toBe('#23d18b');
      expect(DEFAULT_THEME.brightYellow).toBe('#f5f543');
      expect(DEFAULT_THEME.brightBlue).toBe('#3b8eea');
      expect(DEFAULT_THEME.brightMagenta).toBe('#d670d6');
      expect(DEFAULT_THEME.brightCyan).toBe('#29b8db');
      expect(DEFAULT_THEME.brightWhite).toBe('#ffffff');
    });

    test('has foreground and background colors', () => {
      expect(DEFAULT_THEME.foreground).toBe('#d4d4d4');
      expect(DEFAULT_THEME.background).toBe('#1e1e1e');
    });

    test('has cursor colors', () => {
      expect(DEFAULT_THEME.cursor).toBe('#ffffff');
      expect(DEFAULT_THEME.cursorAccent).toBe('#1e1e1e');
    });

    test('has selection colors', () => {
      // Selection colors are now solid (not semi-transparent overlay)
      // Ghostty-style: selection bg = foreground color, selection fg = background color
      expect(DEFAULT_THEME.selectionBackground).toBe('#d4d4d4');
      expect(DEFAULT_THEME.selectionForeground).toBe('#1e1e1e');
    });
  });

  describe('Theme Color Format', () => {
    test('all colors are valid hex strings', () => {
      const hexPattern = /^#[0-9a-f]{6}$/i;

      expect(DEFAULT_THEME.black).toMatch(hexPattern);
      expect(DEFAULT_THEME.foreground).toMatch(hexPattern);
      expect(DEFAULT_THEME.background).toMatch(hexPattern);
      expect(DEFAULT_THEME.cursor).toMatch(hexPattern);
    });
  });
});

describe('CanvasRenderer – preedit overlay', () => {
  function makeCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = 800;
    c.height = 400;
    c.style.width = '800px';
    c.style.height = '400px';
    return c;
  }

  test('attachOverlayTo appends overlay canvas as child of parent', () => {
    const canvas = makeCanvas();
    const renderer = new CanvasRenderer(canvas);
    const parent = document.createElement('div');
    parent.appendChild(canvas);
    document.body.appendChild(parent);

    renderer.attachOverlayTo(parent);

    // Parent should now contain 2 children: main canvas + overlay canvas
    expect(parent.children.length).toBe(2);
    const overlay = parent.children[1] as HTMLCanvasElement;
    expect(overlay.tagName).toBe('CANVAS');
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.style.pointerEvents).toBe('none');
    expect(overlay.style.zIndex).toBe('1');
    expect(overlay.style.position).toBe('absolute');

    renderer.dispose();
    document.body.removeChild(parent);
  });

  test('attachOverlayTo is idempotent (calling twice does not add a second overlay)', () => {
    const canvas = makeCanvas();
    const renderer = new CanvasRenderer(canvas);
    const parent = document.createElement('div');
    parent.appendChild(canvas);
    document.body.appendChild(parent);

    renderer.attachOverlayTo(parent);
    renderer.attachOverlayTo(parent);

    // Still only 2 children
    expect(parent.children.length).toBe(2);

    renderer.dispose();
    document.body.removeChild(parent);
  });

  test('parent position is set to relative when previously static', () => {
    const canvas = makeCanvas();
    const renderer = new CanvasRenderer(canvas);
    const parent = document.createElement('div');
    parent.appendChild(canvas);
    document.body.appendChild(parent);

    // Happy-dom default position should be static
    renderer.attachOverlayTo(parent);

    expect(parent.style.position).toBe('relative');

    renderer.dispose();
    document.body.removeChild(parent);
  });

  test('resizeOverlay mirrors main canvas dimensions', () => {
    const canvas = makeCanvas();
    const renderer = new CanvasRenderer(canvas);
    const parent = document.createElement('div');
    parent.appendChild(canvas);
    document.body.appendChild(parent);

    renderer.attachOverlayTo(parent);
    const overlay = parent.children[1] as HTMLCanvasElement;

    // Initial sync
    expect(overlay.width).toBe(canvas.width);
    expect(overlay.height).toBe(canvas.height);
    expect(overlay.style.width).toBe(canvas.style.width);
    expect(overlay.style.height).toBe(canvas.style.height);

    // Simulate main canvas resize
    canvas.width = 1600;
    canvas.height = 800;
    canvas.style.width = '1600px';
    canvas.style.height = '800px';
    renderer.resizeOverlay();

    expect(overlay.width).toBe(1600);
    expect(overlay.height).toBe(800);

    renderer.dispose();
    document.body.removeChild(parent);
  });

  test('drawPreedit and clearPreedit do not throw when overlay is attached', () => {
    const canvas = makeCanvas();
    const renderer = new CanvasRenderer(canvas);
    const parent = document.createElement('div');
    parent.appendChild(canvas);
    document.body.appendChild(parent);

    renderer.attachOverlayTo(parent);

    expect(() => renderer.drawPreedit('hello', 0, 0)).not.toThrow();
    expect(() => renderer.clearPreedit()).not.toThrow();
    expect(() => renderer.drawPreedit('', 0, 0)).not.toThrow();

    renderer.dispose();
    document.body.removeChild(parent);
  });

  test('drawPreedit and clearPreedit are no-ops when overlay is not attached', () => {
    const canvas = makeCanvas();
    const renderer = new CanvasRenderer(canvas);

    // No attachOverlayTo call – should not throw
    expect(() => renderer.drawPreedit('hello', 0, 0)).not.toThrow();
    expect(() => renderer.clearPreedit()).not.toThrow();

    renderer.dispose();
  });

  test('dispose removes overlay canvas from DOM', () => {
    const canvas = makeCanvas();
    const renderer = new CanvasRenderer(canvas);
    const parent = document.createElement('div');
    parent.appendChild(canvas);
    document.body.appendChild(parent);

    renderer.attachOverlayTo(parent);
    expect(parent.children.length).toBe(2);

    renderer.dispose();
    // Overlay should have been removed; only main canvas remains
    expect(parent.querySelectorAll('[aria-hidden="true"]').length).toBe(0);

    document.body.removeChild(parent);
  });

  test('resize() call synchronises overlay dimensions', () => {
    const canvas = makeCanvas();
    const renderer = new CanvasRenderer(canvas);
    const parent = document.createElement('div');
    parent.appendChild(canvas);
    document.body.appendChild(parent);

    renderer.attachOverlayTo(parent);
    const overlay = parent.children[1] as HTMLCanvasElement;

    renderer.resize(100, 30);

    expect(overlay.width).toBe(canvas.width);
    expect(overlay.height).toBe(canvas.height);

    renderer.dispose();
    document.body.removeChild(parent);
  });
});
