import { describe, expect, test } from 'bun:test';
import { SearchAddon } from './search';
import { createIsolatedTerminal } from '../test-helpers';
import type { SearchOptions } from './text-search';

async function fixture(text: string, columns = 20) {
  const term = await createIsolatedTerminal({ cols: columns, rows: 5 });
  term.open(document.createElement('div'));
  term.write(text);
  const search = new SearchAddon();
  term.loadAddon(search);
  return { term, search };
}
async function find(search: SearchAddon, text: string, options: SearchOptions) {
  return new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error('search timeout'));
    }, 4000);
    const subscription = search.onDidChangeResults((result) => {
      if (!result.pending) {
        clearTimeout(timeout);
        subscription.dispose();
        resolve(result);
      }
    });
    search.refresh(text, options);
  });
}

describe('advanced search', () => {
  test('uses literal case, whole words and linear regex with cell mappings', async () => {
    const { term, search } = await fixture('Alpha alpha alphabet\r\ncode-123 λΛ');
    try {
      expect((await find(search, 'Alpha', { caseSensitive: true })).resultCount).toBe(1);
      expect((await find(search, 'alpha', { wholeWord: true })).resultCount).toBe(2);
      expect((await find(search, 'code-\\d+', { regex: true })).resultCount).toBe(1);
      expect((await find(search, 'λ', { caseSensitive: true })).resultCount).toBe(1);
      const result = await find(search, 'λ', { wholeWord: true });
      expect(result.resultCount).toBe(0);
    } finally {
      term.dispose();
    }
  });
  test('joins soft wraps including historical rows and retains combining graphemes', async () => {
    const { term, search } = await fixture(
      'xx e\u0301middleLONGword\r\nnext\r\nthird\r\nfourth\r\nfifth',
      10
    );
    try {
      expect(
        (await find(search, 'e\u0301middleLONGword', { caseSensitive: true })).resultCount
      ).toBe(1);
    } finally {
      term.dispose();
    }
  });
  test('rejects unsupported expressions and does not backtrack exponentially', async () => {
    const { term, search } = await fixture('a'.repeat(4000) + '!');
    try {
      const rejected = await find(search, '(a)\\1', { regex: true });
      expect(rejected.error).toBeDefined();
      const result = await find(search, '(a+)+$', { regex: true });
      expect(result.error).toBeUndefined();
      expect(result.resultCount).toBe(0);
    } finally {
      term.dispose();
    }
  });
  test('blank-line anchors use their own row positions', async () => {
    const { term, search } = await fixture('\r\n\r\nword');
    try {
      const result = await find(search, '^$', { regex: true });
      expect(result.resultCount).toBe(4);
      expect((term as any).searchDecorations[0].line).toBe(4);
    } finally {
      term.dispose();
    }
  });

  test('stale asynchronous queries do not replace the newest query', async () => {
    const { term, search } = await fixture('first second third');
    try {
      search.refresh('first', { regex: true });
      const result = await find(search, 'second', { caseSensitive: true });
      expect(result.resultCount).toBe(1);
      expect((term as any).searchDecorations[0].column).toBe(6);
    } finally {
      term.dispose();
    }
  });
});
