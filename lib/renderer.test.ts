/**
 * Tests for Canvas Renderer
 *
 * Note: Most renderer tests are visual and require a browser environment.
 * These tests verify non-visual aspects like theme configuration.
 * Full visual tests are in examples/renderer-demo.html
 */

import { describe, expect, test } from 'bun:test';
import { CanvasRenderer, DEFAULT_THEME, type IRenderable } from './renderer';
import { type GhosttyCell, KittyImageFormat, type KittyPlacementInfo } from './types';

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

describe('CanvasRenderer – kitty graphics', () => {
  function makeCell(overrides: Partial<GhosttyCell> = {}): GhosttyCell {
    return {
      codepoint: 32,
      width: 1,
      grapheme_len: 0,
      fg_r: 212,
      fg_g: 212,
      fg_b: 212,
      bg_r: 30,
      bg_g: 30,
      bg_b: 30,
      fgIsDefault: true,
      bgIsDefault: true,
      flags: 0,
      hyperlink_id: 0,
      ...overrides,
    } as GhosttyCell;
  }

  function makeRenderable(placement: KittyPlacementInfo): IRenderable {
    const line = Array.from({ length: 10 }, () => makeCell());
    const pixels = {
      width: 1,
      height: 1,
      format: KittyImageFormat.RGBA,
      data: new Uint8Array([255, 0, 0, 255]),
    };
    return {
      getLine: () => line,
      getCursor: () => ({ x: 0, y: 0, visible: false }),
      getDimensions: () => ({ cols: 10, rows: 5 }),
      isRowDirty: () => false,
      clearDirty: () => {},
      getKittyGraphics: () => 1,
      iterPlacements: function* () {
        yield placement;
      },
      getKittyImagePixels: () => pixels,
    };
  }

  test('direct kitty placements move with the viewport when scrolling', () => {
    const canvas = document.createElement('canvas');
    const renderer = new CanvasRenderer(canvas, { devicePixelRatio: 1 });
    const drawImageCalls: unknown[][] = [];
    (renderer as any).ctx.drawImage = (...args: unknown[]) => drawImageCalls.push(args);
    const originalImageData = (globalThis as any).ImageData;
    (globalThis as any).ImageData = class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number
      ) {}
    };

    try {
      renderer.render(
        makeRenderable({
          imageId: 1,
          pixelWidth: 8,
          pixelHeight: 16,
          gridCols: 1,
          gridRows: 1,
          viewportCol: 2,
          viewportRow: 3,
          viewportVisible: true,
          sourceX: 0,
          sourceY: 0,
          sourceWidth: 1,
          sourceHeight: 1,
          isVirtual: false,
        }),
        true,
        2,
        { getScrollbackLength: () => 2, getScrollbackLine: () => null }
      );

      const compositeCall = drawImageCalls.at(-1)!;
      const metrics = (renderer as any).metrics;
      expect(compositeCall[5]).toBe(2 * metrics.width);
      expect(compositeCall[6]).toBe((3 - 2) * metrics.height);
    } finally {
      (globalThis as any).ImageData = originalImageData;
      renderer.dispose();
    }
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
