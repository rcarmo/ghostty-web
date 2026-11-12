import { describe, expect, test } from 'bun:test';
import { Ghostty } from '../ghostty';
import { createIsolatedTerminal } from '../test-helpers';
import { SearchAddon } from './search';

describe('core-backed search', () => {
  test('finds Unicode and ASCII-folded matches without moving the live core viewport', async () => {
    const ghostty = await Ghostty.load();
    const terminal = ghostty.createTerminal(40, 5);
    try {
      terminal.write('Hello λ world\r\nHELLO λ again');
      const search = terminal.createSearch();
      search.setNeedle('hello λ');
      search.run();
      expect(search.count).toBe(2);
      expect(search.select()).toBe(true);
      expect(search.selectedMatch()?.startRow).toBe(1);
      expect(
        String.fromCodePoint(
          ...terminal
            .getLine(0)
            .slice(0, 5)
            .map((c) => c.codepoint)
        )
      ).toBe('Hello');
      search.setNeedle('missing');
      search.run();
      expect(search.count).toBe(0);
      expect(search.select()).toBe(false);
      expect(() => search.setNeedle('x'.repeat(1025))).toThrow();
    } finally {
      terminal.free();
    }
  });
  test('addon wraps, clears independently of caller decorations, and survives reset', async () => {
    const terminal = await createIsolatedTerminal({ cols: 40, rows: 5 });
    const host = document.createElement('div');
    terminal.open(host);
    const addon = new SearchAddon();
    terminal.loadAddon(addon);
    let result: any;
    addon.onDidChangeResults((value) => {
      result = value;
    });
    try {
      terminal.setDecorations([{ line: 0, column: 0, length: 1, background: 'red' }]);
      terminal.write('alpha\r\nbeta alpha\r\nlast alpha');
      expect(addon.findNext('alpha')).toBe(true);
      expect(result.resultCount).toBe(3);
      const initial = result.resultIndex;
      expect(addon.findNext('alpha')).toBe(true);
      expect(result.resultIndex).not.toBe(initial);
      addon.findNext('alpha');
      addon.findNext('alpha');
      expect(result.resultIndex).toBe(initial);
      addon.clearDecorations();
      expect((terminal as any).decorations).toHaveLength(1);
      expect((terminal as any).searchDecorations).toHaveLength(0);
      terminal.reset();
      terminal.write('fresh alpha');
      expect(addon.findNext('alpha')).toBe(true);
      expect(result.resultCount).toBe(1);
      terminal.write('\x1b[?1049honly alternate');
      expect(addon.findNext('alpha')).toBe(false);
      terminal.write('\x1b[?1049l');
      expect(addon.findNext('alpha')).toBe(true);
    } finally {
      terminal.dispose();
    }
  });
  test('frees native searches with their terminal and tolerates repeated disposal', async () => {
    const ghostty = await Ghostty.load();
    const terminal = ghostty.createTerminal(10, 3);
    const search = terminal.createSearch();
    terminal.free();
    expect(search.disposed).toBe(true);
    expect(() => search.dispose()).not.toThrow();
    expect(() => terminal.createSearch()).toThrow();
  });
});
