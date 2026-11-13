import { describe, expect, test } from 'bun:test';
import bidiFactory from 'bidi-js';
import { RowBidiMapper } from './bidi';
import type { GhosttyCell } from './types';

function makeCell(overrides: Partial<GhosttyCell> = {}): GhosttyCell {
  return {
    codepoint: 0,
    fg_r: 0,
    fg_g: 0,
    fg_b: 0,
    bg_r: 0,
    bg_g: 0,
    bg_b: 0,
    fgIsDefault: true,
    bgIsDefault: true,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
    grapheme: null,
    ...overrides,
  };
}

/** One cell per codepoint of `s`, width 1. Wide chars: use makeWide below. */
function cellsFrom(s: string): GhosttyCell[] {
  return [...s].map((ch) => makeCell({ codepoint: ch.codePointAt(0)! }));
}

describe('bidi-js smoke test', () => {
  test('factory initializes and reorders Hebrew', () => {
    const bidi = bidiFactory();
    const text = 'שלום'; // שלום
    const levels = bidi.getEmbeddingLevels(text, 'ltr');
    const indices = bidi.getReorderedIndices(text, levels);
    expect(indices).toEqual([3, 2, 1, 0]);
  });
});

describe('RowBidiMapper fast path', () => {
  const mapper = new RowBidiMapper();

  test('pure ASCII row returns identity', () => {
    const map = mapper.getMap(cellsFrom('hello'));
    expect(map.isIdentity).toBe(true);
    expect([...map.visualToLogical]).toEqual([0, 1, 2, 3, 4]);
    expect(map.mirror).toBeNull();
  });

  test('CJK row (codepoints above U+0590 but not RTL) returns identity', () => {
    const map = mapper.getMap(cellsFrom('漢字'));
    expect(map.isIdentity).toBe(true);
  });

  test('kitty placeholder row returns identity', () => {
    const line = [
      makeCell({ codepoint: 0x10eeee, grapheme_len: 2, grapheme: [0x305, 0x305] }),
      makeCell(),
    ];
    expect(mapper.getMap(line).isIdentity).toBe(true);
  });

  test('identity maps are shared per row length', () => {
    const a = mapper.getMap(cellsFrom('abc'));
    const b = mapper.getMap(cellsFrom('xyz'));
    expect(a).toBe(b);
  });

  test('empty row returns identity', () => {
    expect(mapper.getMap([]).isIdentity).toBe(true);
  });
});

describe('RowBidiMapper full path', () => {
  const mapper = new RowBidiMapper();

  test('pure Hebrew row reverses', () => {
    const map = mapper.getMap(cellsFrom('שלום')); // 4 cells, class R
    expect(map.isIdentity).toBe(false);
    expect([...map.visualToLogical]).toEqual([3, 2, 1, 0]);
    expect([...map.logicalToVisual]).toEqual([3, 2, 1, 0]);
  });

  test('mixed LTR/RTL reorders only the RTL run', () => {
    // logical: a b ␠ ש ל ו ם ␠ c d   (indices 0..9)
    const map = mapper.getMap(cellsFrom('ab שלום cd'));
    expect([...map.visualToLogical]).toEqual([0, 1, 2, 6, 5, 4, 3, 7, 8, 9]);
  });

  test('logicalToVisual is the exact inverse of visualToLogical', () => {
    const map = mapper.getMap(cellsFrom('ab שלום cd'));
    for (let v = 0; v < map.visualToLogical.length; v++) {
      expect(map.logicalToVisual[map.visualToLogical[v]!]).toBe(v);
    }
  });

  test('Arabic (class AL) reverses like Hebrew (class R)', () => {
    const map = mapper.getMap(cellsFrom('عربي'));
    expect([...map.visualToLogical]).toEqual([3, 2, 1, 0]);
  });

  test('European digits (EN) inside Hebrew stay in LTR order', () => {
    // אב 12 גד — digits must read left-to-right within the RTL context
    const map = mapper.getMap(cellsFrom('אב 12 גד'));
    const d1 = map.logicalToVisual[3]!; // '1'
    const d2 = map.logicalToVisual[4]!; // '2'
    expect(d2).toBe(d1 + 1); // adjacent, '1' left of '2'
    // Hebrew still reversed: א paints right of ב
    expect(map.logicalToVisual[0]!).toBeGreaterThan(map.logicalToVisual[1]!);
  });

  test('Arabic-Indic digits (AN) inside Arabic stay in LTR order', () => {
    // ﻋﺮﺑﻲ + ٤٥٦ (U+0664..0666, class AN)
    const map = mapper.getMap(cellsFrom('عربي ٤٥٦'));
    const d4 = map.logicalToVisual[5]!; // ٤
    const d5 = map.logicalToVisual[6]!; // ٥
    const d6 = map.logicalToVisual[7]!; // ٦
    expect(d5).toBe(d4 + 1);
    expect(d6).toBe(d5 + 1);
  });

  test('Persian Extended digits (EN class) inside Persian stay in LTR order', () => {
    // ۴۵۶ are U+06F4..06F6, class EN — different class from ٤٥٦, same visual expectation
    const map = mapper.getMap(cellsFrom('فارسی ۴۵۶'));
    const d4 = map.logicalToVisual[6]!;
    const d5 = map.logicalToVisual[7]!;
    expect(d5).toBe(d4 + 1);
  });

  test('parentheses in an RTL run are mirrored (UBA L4)', () => {
    // א(ב)ג — the parens sit between strong R chars → odd level → mirrored
    const line = cellsFrom('א(ב)ג');
    const map = mapper.getMap(line);
    expect(map.mirror).not.toBeNull();
    expect(map.mirror!.get(1)).toBe(')'.codePointAt(0)!); // logical '(' paints as ')'
    expect(map.mirror!.get(3)).toBe('('.codePointAt(0)!); // logical ')' paints as '('
  });

  test('wide cell and its spacer move as a fused unit', () => {
    // logical: a b 漢 [spacer] ש ל ו ם   (漢 is width 2, spacer width 0)
    const line = [
      ...cellsFrom('ab'),
      makeCell({ codepoint: '漢'.codePointAt(0)!, width: 2 }),
      makeCell({ codepoint: 0, width: 0 }),
      ...cellsFrom('שלום'),
    ];
    const map = mapper.getMap(line);
    expect([...map.visualToLogical]).toEqual([0, 1, 2, 3, 7, 6, 5, 4]);
    // spacer (logical 3) immediately follows its base (logical 2) visually
    expect(map.logicalToVisual[3]).toBe(map.logicalToVisual[2]! + 1);
  });

  test('trailing empty cells stay in place (LTR base direction)', () => {
    const line = [...cellsFrom('שלום'), makeCell(), makeCell()];
    const map = mapper.getMap(line);
    expect([...map.visualToLogical]).toEqual([3, 2, 1, 0, 4, 5]);
  });
});

describe('RowBidiMapper cache', () => {
  test('same content returns the same map object', () => {
    const mapper = new RowBidiMapper();
    const a = mapper.getMap(cellsFrom('שלום'));
    const b = mapper.getMap(cellsFrom('שלום'));
    expect(a).toBe(b);
  });

  test('different content with same length gets a different map', () => {
    const mapper = new RowBidiMapper();
    const a = mapper.getMap(cellsFrom('שלום'));
    const b = mapper.getMap(cellsFrom('םולש'));
    expect(a).not.toBe(b);
  });

  test('width participates in the cache key', () => {
    const mapper = new RowBidiMapper();
    // Same codepoints, different width layout must not collide.
    const narrow = [...cellsFrom('ש'), makeCell({ codepoint: 0x6f22, width: 1 })];
    const wide = [...cellsFrom('ש'), makeCell({ codepoint: 0x6f22, width: 2 })];
    expect(mapper.getMap(narrow)).not.toBe(mapper.getMap(wide));
  });

  test('cache evicts oldest beyond capacity without breaking correctness', () => {
    const mapper = new RowBidiMapper();
    const first = cellsFrom('שלום');
    const firstMap = mapper.getMap(first);
    for (let i = 0; i < 600; i++) {
      // 600 DISTINCT rows (0x0591+i stays within the 0x0590–0x08FF RTL
      // trigger range for i < 600) — must exceed CACHE_MAX=512 to evict.
      mapper.getMap([...cellsFrom('א'), makeCell({ codepoint: 0x0591 + i })]);
    }
    // Recompute after eviction: equal content, correct values (object identity not required).
    expect([...mapper.getMap(first).visualToLogical]).toEqual([...firstMap.visualToLogical]);
  });
});
