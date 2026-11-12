import { expect, test } from 'bun:test';
import { createIsolatedTerminal } from './test-helpers';

test('OSC 133 navigation uses core marks while preserving the live viewport', async () => {
  const term = await createIsolatedTerminal({ cols: 40, rows: 5 });
  term.open(document.createElement('div'));
  try {
    for (let i = 0; i < 8; i++)
      term.write(`\x1b]133;A\x07PROMPT ${i}\x1b]133;B\x07\r\noutput ${i}\r\n`);
    expect(term.scrollToPrompt()).toBe(true);
    const first = term.getViewportY();
    expect(first).toBeGreaterThan(0);
    expect(term.scrollToPrompt()).toBe(true);
    expect(term.getViewportY()).toBeGreaterThan(first);
    expect(term.scrollToPrompt(false)).toBe(true);
    term.write('\x1b[?1049h');
    expect(term.scrollToPrompt()).toBe(false);
  } finally {
    term.dispose();
  }
});
test('remote reply ownership suppresses parser responses, not keyboard input', async () => {
  const term = await createIsolatedTerminal({ emitTerminalResponses: false });
  term.open(document.createElement('div'));
  const data: string[] = [];
  term.onData((value) => data.push(value));
  try {
    term.write('\x1b[6n');
    expect(data).toEqual([]);
    term.input('typed', true);
    expect(data).toEqual(['typed']);
  } finally {
    term.dispose();
  }
});
