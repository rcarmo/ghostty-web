/**
 * URL Detection Tests
 *
 * Tests for the UrlRegexProvider to ensure plain text URLs
 * are correctly detected and made clickable.
 */

import { describe, expect, test } from 'bun:test';
import { UrlRegexProvider } from './providers/url-regex-provider';
import type { ILink } from './types';

interface MockLine {
  text: string;
  /** True if this line is the continuation of a soft-wrap from the line above. */
  isWrapped?: boolean;
}

/**
 * Mock terminal supporting one or more buffer lines, each with an
 * optional `isWrapped` flag. Lines are padded to `cols` so column
 * indices map 1:1 onto the cell array (matching the real BufferLine).
 */
function createMockTerminal(lines: MockLine[] | string, cols = 80) {
  const rows: MockLine[] =
    typeof lines === 'string' ? [{ text: lines, isWrapped: false }] : lines;

  function makeBufferLine(row: MockLine) {
    const chars = Array.from(row.text);
    while (chars.length < cols) chars.push(' ');
    return {
      length: cols,
      isWrapped: row.isWrapped ?? false,
      getCell: (x: number) => {
        if (x < 0 || x >= cols) return undefined;
        const ch = chars[x];
        return {
          getCodepoint: () => ch.codePointAt(0) || 0,
        };
      },
    };
  }

  return {
    buffer: {
      active: {
        length: rows.length,
        getLine: (y: number) => {
          if (y < 0 || y >= rows.length) return undefined;
          return makeBufferLine(rows[y]);
        },
      },
    },
  };
}

/**
 * Helper to get links from provider for a single-row terminal.
 */
function getLinks(lineText: string): Promise<ILink[] | undefined> {
  // biome-ignore lint/suspicious/noExplicitAny: matches existing test pattern
  const terminal = createMockTerminal(lineText) as any;
  const provider = new UrlRegexProvider(terminal);

  return new Promise((resolve) => {
    provider.provideLinks(0, resolve);
  });
}

/**
 * Helper to get links from a multi-row terminal at a specific row.
 */
function getLinksAt(
  rows: MockLine[],
  y: number,
  cols: number,
): Promise<ILink[] | undefined> {
  // biome-ignore lint/suspicious/noExplicitAny: matches existing test pattern
  const terminal = createMockTerminal(rows, cols) as any;
  const provider = new UrlRegexProvider(terminal);

  return new Promise((resolve) => {
    provider.provideLinks(y, resolve);
  });
}

describe('URL Detection', () => {
  test('detects HTTPS URLs', async () => {
    const links = await getLinks('Visit https://github.com for code');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://github.com');
    expect(links?.[0].range.start.x).toBe(6);
    // End is inclusive - last character is at index 23 (https://github.com is 19 chars, starts at 6)
    expect(links?.[0].range.end.x).toBe(23);
  });

  test('detects HTTP URLs', async () => {
    const links = await getLinks('Check http://example.com');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('http://example.com');
  });

  test('detects mailto: links', async () => {
    const links = await getLinks('Email: mailto:test@example.com');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('mailto:test@example.com');
  });

  test('detects ssh:// URLs', async () => {
    const links = await getLinks('Connect via ssh://user@server.com');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('ssh://user@server.com');
  });

  test('detects git:// URLs', async () => {
    const links = await getLinks('Clone git://github.com/repo.git');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('git://github.com/repo.git');
  });

  test('detects ftp:// URLs', async () => {
    const links = await getLinks('Download ftp://files.example.com/file');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('ftp://files.example.com/file');
  });

  test('strips trailing period', async () => {
    const links = await getLinks('Check https://example.com.');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://example.com');
    // Should NOT include the trailing period
    expect(links?.[0].text.endsWith('.')).toBe(false);
  });

  test('strips trailing comma', async () => {
    const links = await getLinks('See https://example.com, or else');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://example.com');
  });

  test('strips trailing parenthesis', async () => {
    const links = await getLinks('(see https://example.com)');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://example.com');
  });

  test('strips trailing exclamation', async () => {
    const links = await getLinks('Visit https://example.com!');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://example.com');
  });

  test('handles multiple URLs on same line', async () => {
    const links = await getLinks('https://a.com and https://b.com');
    expect(links).toBeDefined();
    expect(links?.length).toBe(2);
    expect(links?.[0].text).toBe('https://a.com');
    expect(links?.[1].text).toBe('https://b.com');
  });

  test('returns undefined when no URL present', async () => {
    const links = await getLinks('No URLs here');
    expect(links).toBeUndefined();
  });

  test('handles URLs with query parameters', async () => {
    const links = await getLinks('https://example.com?foo=bar&baz=qux');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://example.com?foo=bar&baz=qux');
  });

  test('handles URLs with fragments', async () => {
    const links = await getLinks('https://example.com/page#section');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://example.com/page#section');
  });

  test('handles URLs with ports', async () => {
    const links = await getLinks('https://example.com:8080/path');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://example.com:8080/path');
  });

  test('does not detect file paths', async () => {
    const links = await getLinks('/home/user/file.txt');
    expect(links).toBeUndefined();
  });

  test('does not detect relative paths', async () => {
    const links = await getLinks('./relative/path');
    expect(links).toBeUndefined();
  });

  test('link has activate function', async () => {
    const links = await getLinks('https://example.com');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(typeof links?.[0].activate).toBe('function');
  });

  test('detects tel: URLs', async () => {
    const links = await getLinks('Call tel:+1234567890');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('tel:+1234567890');
  });

  test('detects magnet: URLs', async () => {
    const links = await getLinks('Download magnet:?xt=urn:btih:abc123');
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toContain('magnet:?xt=urn:btih:abc123');
  });
});

describe('URL Detection across soft-wrapped rows', () => {
  test('joins a URL wrapped across two rows and reports it on both rows', async () => {
    // cols=20 forces wrapping. Continuation row is row 1 (isWrapped=true).
    const cols = 20;
    const rows: MockLine[] = [
      { text: 'visit https://exampl', isWrapped: false },
      { text: 'e.com/very/long/path here', isWrapped: true },
    ];

    const linksOnOrigin = await getLinksAt(rows, 0, cols);
    expect(linksOnOrigin).toBeDefined();
    expect(linksOnOrigin?.length).toBe(1);
    expect(linksOnOrigin?.[0].text).toBe('https://example.com/very/long/path');
    expect(linksOnOrigin?.[0].range.start).toEqual({ x: 6, y: 0 });
    expect(linksOnOrigin?.[0].range.end.y).toBe(1);

    // Clicking on the continuation row must also surface the full URL.
    const linksOnContinuation = await getLinksAt(rows, 1, cols);
    expect(linksOnContinuation).toBeDefined();
    expect(linksOnContinuation?.length).toBe(1);
    expect(linksOnContinuation?.[0].text).toBe('https://example.com/very/long/path');
  });

  test('walks across three wrapped rows', async () => {
    const cols = 10;
    const rows: MockLine[] = [
      { text: 'https://ex', isWrapped: false },
      { text: 'ample.com/', isWrapped: true },
      { text: 'deep/path ', isWrapped: true },
    ];

    const links = await getLinksAt(rows, 2, cols);
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://example.com/deep/path');
    expect(links?.[0].range.start).toEqual({ x: 0, y: 0 });
    expect(links?.[0].range.end.y).toBe(2);
  });

  test('does not cross a non-continuation boundary', async () => {
    // A non-wrapped line in the middle separates two chains. Querying
    // the last row must not include content from the first chain.
    const cols = 20;
    const rows: MockLine[] = [
      { text: 'not wrapped line    ', isWrapped: false },
      { text: 'see https://example.', isWrapped: false },
      { text: 'com/foo/bar here    ', isWrapped: true },
    ];

    const links = await getLinksAt(rows, 2, cols);
    expect(links).toBeDefined();
    expect(links?.length).toBe(1);
    expect(links?.[0].text).toBe('https://example.com/foo/bar');
  });

  test('does not return links for unrelated rows outside the URL chain', async () => {
    const cols = 80;
    const rows: MockLine[] = [
      { text: 'unrelated output', isWrapped: false },
      { text: 'see https://example.com/foo', isWrapped: false },
      { text: 'more output', isWrapped: false },
    ];

    const links = await getLinksAt(rows, 0, cols);
    expect(links).toBeUndefined();
  });
});
