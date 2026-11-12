import { RE2JS } from 're2js';
import type { SearchMatch } from '../search';
import type { Terminal } from '../terminal';

export interface SearchOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}
export interface TextIndex {
  text: string;
  starts: number[];
  ends: number[];
  columns: number;
  truncated: boolean;
  lastCell: number;
}
const MAX_CELLS = 500000,
  MAX_TEXT = 1024 * 1024,
  MAX_MATCHES = 10000;

/** Freeze text and UTF-16-to-cell mappings cooperatively; cancel if VT state changes. */
export async function buildTextIndex(
  terminal: Terminal,
  cancelled: () => boolean
): Promise<TextIndex> {
  const buffer = terminal.buffer.active,
    columns = terminal.cols;
  let text = '',
    paragraph = '',
    starts: number[] = [],
    ends: number[] = [],
    paragraphStarts: number[] = [],
    paragraphEnds: number[] = [];
  let cells = 0,
    truncated = false,
    clock = performance.now(),
    flushed = false,
    previousEnd = 0;
  const flush = () => {
    const trimmed = paragraph.trimEnd();
    if (flushed) {
      text += '\n';
      starts.push(previousEnd);
      ends.push(previousEnd);
    }
    text += trimmed;
    for (let i = 0; i < trimmed.length; i++) {
      starts.push(paragraphStarts[i]);
      ends.push(paragraphEnds[i]);
    }
    previousEnd = paragraphEnds[Math.max(0, trimmed.length - 1)] ?? previousEnd;
    flushed = true;
    paragraph = '';
    paragraphStarts = [];
    paragraphEnds = [];
  };
  for (let row = 0; row < buffer.length; row++) {
    if (cancelled()) throw new Error('Search snapshot cancelled');
    const line = buffer.getLine(row);
    if (!line) continue;
    if (row > 0 && !line.isWrapped) flush();
    for (let col = 0; col < line.length; col++) {
      const cell = line.getCell(col);
      if (cell?.getWidth() === 0) continue;
      const chars = cell?.getChars() || ' ',
        width = Math.max(1, cell?.getWidth() ?? 1);
      if (++cells > MAX_CELLS || text.length + paragraph.length + chars.length > MAX_TEXT) {
        truncated = true;
        break;
      }
      paragraph += chars;
      for (let i = 0; i < chars.length; i++) {
        paragraphStarts.push(row * columns + col);
        paragraphEnds.push(row * columns + Math.min(columns - 1, col + width - 1));
      }
    }
    if (truncated) break;
    if (performance.now() - clock >= 8) {
      await new Promise<void>((resolve) => {
        const view = terminal.element?.ownerDocument.defaultView;
        if (view) view.setTimeout(resolve, 0);
        else setTimeout(resolve, 0);
      });
      clock = performance.now();
    }
  }
  flush();
  return { text, starts, ends, columns, truncated, lastCell: previousEnd };
}

const word = (text: string) => /[\p{L}\p{N}\p{M}_]/u.test(text);
function runeBefore(text: string, index: number): string {
  return Array.from(text.slice(Math.max(0, index - 2), index)).slice(-1)[0] ?? '';
}
function runeAfter(text: string, index: number): string {
  return String.fromCodePoint(text.codePointAt(index) ?? 0);
}

/** RE2's linear-time matcher avoids JavaScript backtracking/ReDoS. */
export function matchText(
  index: TextIndex,
  needle: string,
  options: SearchOptions
): { matches: SearchMatch[]; truncated: boolean } {
  const flags = RE2JS.MULTILINE | (options.caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE);
  const pattern = RE2JS.compile(options.regex ? needle : RE2JS.quote(needle), flags);
  const matcher = pattern.matcher(index.text);
  const matches: SearchMatch[] = [];
  let truncated = index.truncated;
  while (matcher.find()) {
    const start = matcher.start(),
      end = matcher.end();
    if (end < start) continue;
    if (
      options.wholeWord &&
      (word(runeBefore(index.text, start)) || word(runeAfter(index.text, end)))
    )
      continue;
    const first = index.starts[start] ?? index.lastCell,
      last = index.ends[Math.max(start, end - 1)] ?? first;
    if (first === undefined || last === undefined) continue;
    if (matches.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    matches.push({
      startCol: first % index.columns,
      startRow: Math.floor(first / index.columns),
      endCol: last % index.columns,
      endRow: Math.floor(last / index.columns),
    });
  }
  return { matches, truncated };
}
