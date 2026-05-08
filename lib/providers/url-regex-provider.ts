/**
 * URL Regex Link Provider
 *
 * Detects plain text URLs using regex pattern matching.
 * Supports common protocols but excludes file paths.
 *
 * This provider runs after OSC8LinkProvider, so explicit hyperlinks
 * take precedence over regex-detected URLs.
 */

import type { IBufferRange, ILink, ILinkProvider } from '../types';

/**
 * URL Regex Provider
 *
 * Detects plain text URLs using regex. Handles URLs that have been
 * soft-wrapped across multiple buffer rows by joining the rows in the
 * wrap chain that contains the queried row before applying the regex.
 *
 * Supported protocols:
 * - https://, http://
 * - mailto:
 * - ftp://, ssh://, git://
 * - tel:, magnet:
 * - gemini://, gopher://, news:
 *
 * Wrap-chain semantics: a buffer line's `isWrapped` flag is `true` when
 * the line is the *continuation* of a soft-wrap from the previous line.
 * To find the chain that contains row `y` we walk backwards from `y`
 * while the current row's `isWrapped` is true, then forwards from there
 * while the next row's `isWrapped` is true.
 */
export class UrlRegexProvider implements ILinkProvider {
  /**
   * URL regex pattern
   * Matches common protocols followed by valid URL characters
   * Excludes file paths (no ./ or ../ or bare /)
   */
  private static readonly URL_REGEX =
    /(?:https?:\/\/|mailto:|ftp:\/\/|ssh:\/\/|git:\/\/|tel:|magnet:|gemini:\/\/|gopher:\/\/|news:)[\w\-.~:\/?#@!$&*+,;=%]+/gi;

  /**
   * Characters to strip from end of URLs
   * Common punctuation that's unlikely to be part of the URL
   */
  private static readonly TRAILING_PUNCTUATION = /[.,;!?)\]]+$/;

  /**
   * Maximum number of soft-wrapped rows to traverse in either direction
   * when assembling a wrap chain. Bounds worst-case work on pathological
   * input (e.g. a screenful of unbroken characters); any real URL fits
   * easily.
   */
  private static readonly MAX_WRAP_CHAIN_ROWS = 256;

  constructor(private terminal: ITerminalForUrlProvider) {}

  /**
   * Provide all regex-detected URLs whose range intersects the given row.
   *
   * For wrapped URLs the same link is returned no matter which row in the
   * chain the caller queries. The link's `range` may span multiple rows;
   * `LinkManager.isPositionInLink` correctly handles such ranges.
   */
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const buffer = this.terminal.buffer.active;

    if (!buffer.getLine(y)) {
      callback(undefined);
      return;
    }

    // Walk back to the start of the wrap chain containing row y. The
    // current row is a continuation iff its own `isWrapped` is true.
    let startRow = y;
    let walked = 0;
    while (startRow > 0 && walked < UrlRegexProvider.MAX_WRAP_CHAIN_ROWS) {
      const cur = buffer.getLine(startRow);
      if (!cur || !cur.isWrapped) break;
      startRow--;
      walked++;
    }

    // Walk forward to the end of the chain by extending while the *next*
    // row is a continuation.
    let endRow = startRow;
    while (
      endRow - startRow < UrlRegexProvider.MAX_WRAP_CHAIN_ROWS &&
      endRow < buffer.length - 1
    ) {
      const next = buffer.getLine(endRow + 1);
      if (!next || !next.isWrapped) break;
      endRow++;
    }

    // Build the joined string and a per-row offset table so regex match
    // indices can be mapped back to (col, row).
    let joined = '';
    const rowStartIdx: number[] = [];
    for (let r = startRow; r <= endRow; r++) {
      rowStartIdx.push(joined.length);
      const line = buffer.getLine(r);
      if (!line) continue;
      joined += this.lineToText(line);
    }

    const links: ILink[] = [];

    // Reset regex state (global flag maintains state across calls)
    UrlRegexProvider.URL_REGEX.lastIndex = 0;

    let match: RegExpExecArray | null = UrlRegexProvider.URL_REGEX.exec(joined);
    while (match !== null) {
      let url = match[0];
      const startIdx = match.index;
      let endIdx = startIdx + url.length - 1; // Inclusive end

      // Strip trailing punctuation
      const stripped = url.replace(UrlRegexProvider.TRAILING_PUNCTUATION, '');
      if (stripped.length < url.length) {
        url = stripped;
        endIdx = startIdx + url.length - 1;
      }

      // Skip if URL is too short (e.g., just "http://")
      if (url.length > 8) {
        const startPos = this.joinedIdxToRowCol(startIdx, rowStartIdx, startRow);
        const endPos = this.joinedIdxToRowCol(endIdx, rowStartIdx, startRow);

        // Only surface links whose range intersects the queried row. The
        // LinkManager seeds its cache per scanned row; emitting links that
        // don't touch `y` would pollute the cache.
        if (startPos.y <= y && endPos.y >= y) {
          const range: IBufferRange = { start: startPos, end: endPos };
          const href = url;
          links.push({
            text: href,
            range,
            activate: (event) => {
              if (event.ctrlKey || event.metaKey) {
                openLinkFromEvent(event, href);
              }
            },
          });
        }
      }

      // Get next match
      match = UrlRegexProvider.URL_REGEX.exec(joined);
    }

    callback(links.length > 0 ? links : undefined);
  }

  /**
   * Convert a buffer line to plain text string. Control characters and
   * empty cells become spaces so column indices map 1:1 onto the string.
   */
  private lineToText(line: IBufferLineForUrlProvider): string {
    const chars: string[] = [];

    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) {
        chars.push(' ');
        continue;
      }

      const codepoint = cell.getCodepoint();
      // Skip null characters and control characters
      if (codepoint === 0 || codepoint < 32) {
        chars.push(' ');
      } else {
        chars.push(String.fromCodePoint(codepoint));
      }
    }

    return chars.join('');
  }

  /**
   * Map an index in the joined string back to a (col, row) buffer position.
   */
  private joinedIdxToRowCol(
    joinedIdx: number,
    rowStartIdx: number[],
    baseRow: number,
  ): { x: number; y: number } {
    for (let i = rowStartIdx.length - 1; i >= 0; i--) {
      if (joinedIdx >= rowStartIdx[i]) {
        return { x: joinedIdx - rowStartIdx[i], y: baseRow + i };
      }
    }
    return { x: 0, y: baseRow };
  }

  dispose(): void {
    // No resources to clean up
  }
}

/**
 * Minimal terminal interface required by UrlRegexProvider
 */
export function openLinkFromEvent(event: MouseEvent, url: string): void {
  event.view?.open(url, '_blank', 'noopener,noreferrer');
}

interface ITerminalForUrlProvider {
  buffer: {
    active: {
      /** Total number of rows accessible via `getLine` (viewport + scrollback). */
      length: number;
      getLine(y: number): IBufferLineForUrlProvider | undefined;
    };
  };
}

/**
 * Minimal buffer line interface for URL detection
 */
interface IBufferLineForUrlProvider {
  length: number;
  /**
   * `true` when this line is the continuation of a soft-wrap from the
   * previous line — i.e. the previous line was wider than `cols` and
   * spilled here.
   */
  isWrapped: boolean;
  getCell(x: number):
    | {
        getCodepoint(): number;
      }
    | undefined;
}
