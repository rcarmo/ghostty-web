import { describe, expect, test } from 'bun:test';
import { createIsolatedTerminal } from './test-helpers';

describe('core-managed selections', () => {
  test('copies rectangles and highlights bounded columns on every row', async () => {
    const term = await createIsolatedTerminal({ cols: 10, rows: 5 });
    term.open(document.createElement('div'));
    try {
      term.write('ABCDE\r\nFGHIJ\r\nKLMNO');
      term.selectRectangle(1, 0, 3, 2);
      expect(term.getSelection()).toBe('BCD\nGHI\nLMN');
      const range = (term as any).selectionManager.getSelectionCoords();
      expect(range.rectangle).toBe(true);
      expect(range.startCol).toBe(1);
      expect(range.endCol).toBe(3);
    } finally {
      term.dispose();
    }
  });
  test('reverse rectangles retain their bounded columns', async () => {
    const term = await createIsolatedTerminal({ cols: 10, rows: 5 });
    term.open(document.createElement('div'));
    try {
      term.write('ABCDE\r\nFGHIJ\r\nKLMNO');
      term.selectRectangle(3, 2, 1, 0);
      expect(term.getSelection()).toBe('BCD\nGHI\nLMN');
      const coords = (term as any).selectionManager.getSelectionCoords();
      expect(Math.min(coords.startCol, coords.endCol)).toBe(1);
      expect(Math.max(coords.startCol, coords.endCol)).toBe(3);
      const manager = (term as any).selectionManager;
      for (let i = 0; i < 5; i++) {
        manager.getSelectionCoords();
        expect(manager.selectionStart).toEqual({ col: 3, absoluteRow: 2 });
      }
    } finally {
      term.dispose();
    }
  });

  test('native pins preserve selected text after output scrolls', async () => {
    const term = await createIsolatedTerminal({ cols: 10, rows: 3 });
    term.open(document.createElement('div'));
    try {
      term.write('FIRST\r\nSECOND');
      term.select(0, 0, 5);
      expect(term.getSelection()).toBe('FIRST');
      term.write('\r\nthird\r\nfourth\r\nfifth');
      expect(term.getSelection()).toBe('FIRST');
    } finally {
      term.dispose();
    }
  });
  test('backward drag keeps its original anchor across normalization', async () => {
    const term = await createIsolatedTerminal({ cols: 10, rows: 5 });
    term.open(document.createElement('div'));
    const manager = (term as any).selectionManager;
    try {
      term.write('ABCDE\r\nFGHIJ');
      manager.selectionStart = { col: 4, absoluteRow: 1 };
      manager.selectionEnd = { col: 0, absoluteRow: 0 };
      manager.isSelecting = true;
      manager.dragThresholdMet = true;
      manager.getSelectionCoords();
      expect(manager.selectionStart).toEqual({ col: 4, absoluteRow: 1 });
      manager.selectionEnd = { col: 1, absoluteRow: 0 };
      expect(term.getSelection()).toBe('BCDE\nFGHIJ');
    } finally {
      term.dispose();
    }
  });
});
