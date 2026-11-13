/**
 * BiDi (Unicode Bidirectional Algorithm) support.
 * Adapted from NimbleMarkets/ghostty-web 64200917 (MIT, copyright 2025 Coder).
 *
 * Terminals store text in LOGICAL order (the order the PTY received it);
 * RTL scripts must be PAINTED in visual order. This module produces, for a
 * row of cells, the permutation between the two. Everything downstream —
 * both paint paths, selection copy, mouse reporting, cursor placement —
 * routes through this map. Strings are never reversed.
 *
 * Paragraph direction is fixed LTR (per spec: cursor-addressed TUIs expect
 * rows anchored at their left-hand columns; an all-RTL row reorders in
 * place). Reordering is row-local, not a document paragraph layout engine.
 *
 * Compatibility: bidi-js 1.0.3 uses Unicode Bidirectional Algorithm 13.0
 * tables. Ghostty's terminal, grapheme, and width behavior remains Unicode
 * 15.1; matching that version for BiDi classification requires updated tables
 * upstream in bidi-js.
 */
import bidiFactory from 'bidi-js';
import type { BidiApi } from 'bidi-js';
import { KITTY_PLACEHOLDER } from './kitty_diacritics';
import type { GhosttyCell } from './types';

export interface RowBidiMap {
  /**
   * True when the row needs no bidi work at all: identity permutation and
   * nothing to mirror. Consumers may skip map lookups entirely.
   */
  isIdentity: boolean;
  /** Visual column → logical column. Length === row length. */
  visualToLogical: Uint32Array;
  /** Logical column → visual column. Inverse of visualToLogical. */
  logicalToVisual: Uint32Array;
  /**
   * Logical column → replacement codepoint for UBA rule L4 glyph mirroring
   * (e.g. "(" inside an RTL run paints as ")"). Null when nothing mirrors.
   * Applies to PAINTING only — copy reads the logical cell untouched.
   */
  mirror: Map<number, number> | null;
}

/**
 * Codepoints that can trigger RTL reordering. Everything below U+0590 is
 * strongly LTR or neutral. Ranges: Hebrew through Arabic Extended-A
 * (0590–08FF), RTL directional formatting controls, Hebrew/Arabic
 * presentation forms, and the astral RTL blocks (ancient scripts at
 * 10800–10FFF, Adlam etc. at 1E800–1EFFF). Deliberately conservative:
 * a false positive only costs a UBA run that resolves to identity.
 */
function isRtlTrigger(cp: number): boolean {
  if (cp < 0x0590) return false;
  if (cp <= 0x08ff) return true;
  if (cp === 0x200f) return true; // RLM
  if (cp >= 0x202a && cp <= 0x202e) return true; // LRE/RLE/PDF/LRO/RLO
  if (cp >= 0x2066 && cp <= 0x2069) return true; // LRI/RLI/FSI/PDI
  if (cp >= 0xfb1d && cp <= 0xfdff) return true;
  if (cp >= 0xfe70 && cp <= 0xfeff) return true;
  if (cp >= 0x10800 && cp <= 0x10fff) return true;
  if (cp >= 0x1e800 && cp <= 0x1efff) return true;
  return false;
}

export class RowBidiMapper {
  private bidi: BidiApi | null;
  private identityByLen = new Map<number, RowBidiMap>();
  /** FNV-1a-hashed, content-verified LRU. 128 entries ≈ several screens of
   *  distinct RTL rows; maps are cheap to recompute on miss. */
  private static readonly CACHE_MAX = 128;
  private cache = new Map<number, { key: Uint32Array; map: RowBidiMap }>();

  constructor() {
    // Degrade to identity (today's behavior) rather than crash the
    // renderer if bidi-js ever fails to initialize.
    try {
      this.bidi = bidiFactory();
    } catch {
      this.bidi = null;
    }
  }

  getMap(line: GhosttyCell[]): RowBidiMap {
    let hasRtl = false;
    for (let i = 0; i < line.length; i++) {
      const cp = line[i]!.codepoint;
      if (cp >= 0x0590 && cp !== KITTY_PLACEHOLDER && isRtlTrigger(cp)) {
        hasRtl = true;
        break;
      }
    }
    if (!hasRtl || line.some((cell) => cell.codepoint === KITTY_PLACEHOLDER) || this.bidi === null)
      return this.identity(line.length);
    // Content key: codepoint + width per cell (width matters — it drives
    // wide-pair fusing). Verified on hit: a hash collision must recompute,
    // never silently permute with the wrong map.
    const key = new Uint32Array(line.length);
    let h = 0x811c9dc5;
    for (let i = 0; i < line.length; i++) {
      const k = ((line[i]!.codepoint << 2) | (line[i]!.width & 3)) >>> 0;
      key[i] = k;
      h = Math.imul(h ^ k, 0x01000193) >>> 0;
    }
    const hit = this.cache.get(h);
    if (hit && hit.key.length === key.length && hit.key.every((v, i) => v === key[i])) {
      this.cache.delete(h); // LRU touch: re-insert as newest
      this.cache.set(h, hit);
      return hit.map;
    }
    const map = this.compute(line);
    if (line.length <= 4096) this.cache.set(h, { key, map });
    if (this.cache.size > RowBidiMapper.CACHE_MAX) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return map;
  }

  private identity(len: number): RowBidiMap {
    let m = this.identityByLen.get(len);
    if (!m) {
      const v2l = new Uint32Array(len);
      for (let i = 0; i < len; i++) v2l[i] = i;
      // Identity is its own inverse; consumers must not mutate the arrays.
      m = { isIdentity: true, visualToLogical: v2l, logicalToVisual: v2l, mirror: null };
      if (this.identityByLen.size >= 16)
        this.identityByLen.delete(this.identityByLen.keys().next().value!);
      this.identityByLen.set(len, m);
    }
    return m;
  }

  private compute(line: GhosttyCell[]): RowBidiMap {
    const n = line.length;
    const bidi = this.bidi!; // caller guarantees non-null

    // Build the row string with one codepoint per non-spacer cell,
    // recording which cell owns each UTF-16 code unit (astral codepoints
    // occupy two units). Spacer cells (width 0) contribute nothing and are
    // re-attached after their wide base below. Grapheme extras are omitted:
    // they are combining marks (class NSM), which UBA rule W1 resolves to
    // the base character's class anyway — invisible at cell granularity.
    let text = '';
    const cellForUnit: number[] = [];
    for (let i = 0; i < n; i++) {
      const cell = line[i]!;
      if (cell.width === 0) continue;
      // Empty cells → space (neutral). Kitty placeholders → 'A' (strong
      // LTR): they are image slices whose row/col diacritics must never
      // reorder, so pin them, don't let them resolve like neutrals.
      const cp = cell.codepoint === KITTY_PLACEHOLDER ? 0x41 : cell.codepoint || 0x20;
      const s = String.fromCodePoint(cp);
      text += s;
      for (let u = 0; u < s.length; u++) cellForUnit.push(i);
    }

    const levels = bidi.getEmbeddingLevels(text, 'ltr');
    const indices = bidi.getReorderedIndices(text, levels);

    // Project the code-unit permutation to cell level: walk visual order,
    // appending each owning cell the first time one of its units appears.
    // (Both units of a surrogate pair own the same cell, so pair-order
    // inside the reordered output is irrelevant here.)
    const visualOrder: number[] = [];
    const seen = new Uint8Array(n);
    for (let v = 0; v < indices.length; v++) {
      const cellIdx = cellForUnit[indices[v]!]!;
      if (seen[cellIdx]) continue;
      seen[cellIdx] = 1;
      visualOrder.push(cellIdx);
      // Fuse wide pairs: the width-0 spacer that follows a wide base in
      // logical order rides immediately after it in visual order, keeping
      // the two-column glyph span intact for the renderers.
      if (line[cellIdx]!.width === 2 && cellIdx + 1 < n && line[cellIdx + 1]!.width === 0) {
        seen[cellIdx + 1] = 1;
        visualOrder.push(cellIdx + 1);
      }
    }
    // Defensive: any cell not seen (e.g. an orphaned spacer with no wide
    // base before it) keeps its relative order at the end.
    for (let i = 0; i < n; i++) if (!seen[i]) visualOrder.push(i);

    const visualToLogical = new Uint32Array(n);
    const logicalToVisual = new Uint32Array(n);
    let identityPerm = true;
    for (let v = 0; v < n; v++) {
      const l = visualOrder[v]!;
      visualToLogical[v] = l;
      logicalToVisual[l] = v;
      if (l !== v) identityPerm = false;
    }

    // UBA rule L4: mirror characters at odd embedding levels.
    let mirror: Map<number, number> | null = null;
    const mirrorUnits = bidi.getMirroredCharactersMap(text, levels.levels);
    if (mirrorUnits.size > 0) {
      mirror = new Map();
      for (const [unit, char] of mirrorUnits) {
        mirror.set(cellForUnit[unit]!, char.codePointAt(0)!);
      }
    }

    return {
      isIdentity: identityPerm && mirror === null,
      visualToLogical,
      logicalToVisual,
      mirror,
    };
  }
}
