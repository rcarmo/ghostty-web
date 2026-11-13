import { expect, test } from 'bun:test';
import { createIsolatedTerminal } from './test-helpers';

async function withRTL(run: (term: any, host: HTMLElement) => void | Promise<void>) {
  const term = await createIsolatedTerminal({
    bidi: true,
    cols: 16,
    rows: 4,
    cursorBlink: false,
    copyOnSelect: false,
  });
  const host = document.createElement('div');
  document.body.append(host);
  try {
    term.open(host);
    await run(term, host);
  } finally {
    term.dispose();
    host.remove();
  }
}

test('RTL paints visual order while core storage, cursor, selection and decorations remain logical', async () => {
  await withRTL((term) => {
    const renderer = term.renderer as any;
    const painted: { text: string; x: number }[] = [];
    renderer.ctx.fillText = (text: string, x: number) => painted.push({ text, x });
    term.write('אבגד\x1b[1;1H');
    (term as any).renderFrame(true);
    expect(
      painted
        .slice(0, 4)
        .map((p) => p.text)
        .join('')
    ).toBe('דגבא');
    expect(term.buffer.active.getLine(0).translateToString()).toContain('אבגד');
    expect(term.getVisualCursor()).toEqual({ x: 3, y: 0 });
    expect(term.visualToLogicalColumn(0, 0)).toBe(3);
    expect(term.visualToLogicalColumn(3, 0)).toBe(0);
    term.select(0, 0, 2);
    (term as any).renderFrame(true);
    expect(term.getSelection()).toBe('אב');
    expect(renderer.isInSelection(3, 0)).toBe(true);
    expect(renderer.isInSelection(2, 0)).toBe(true);
    expect(renderer.isInSelection(0, 0)).toBe(false);
    term.setSearchDecorations([{ line: 0, column: 0, length: 2, background: '#ff0000' }]);
    expect(renderer.getDecorationAt(3, 0)).not.toBeNull();
    expect(renderer.getDecorationAt(0, 0)).toBeNull();
    let preeditX = -1;
    renderer.drawPreedit = (_text: string, x: number) => {
      preeditX = x;
    };
    term.setPreedit('IME');
    expect(preeditX).toBe(3);
  });
});

test('RTL linear gestures map to logical cells; rectangle copy selects visual cells in logical order', async () => {
  await withRTL((term) => {
    term.write('אבגד');
    const manager = (term as any).selectionManager;
    const metrics = term.renderer.getMetrics();
    expect(manager.pixelToCell(metrics.width * 0.5, metrics.height * 0.5)).toEqual({
      col: 3,
      row: 0,
    });
    term.selectRectangle(0, 0, 1, 0);
    expect(term.getSelection()).toBe('גד');
    expect(manager.pixelToCell(metrics.width * 0.5, metrics.height * 0.5)).toEqual({
      col: 0,
      row: 0,
    });
    term.clearSelection();
    term.options.bidi = false;
    expect(term.visualToLogicalColumn(0, 0)).toBe(0);
  });
});

test('RTL history and terminal mouse reports use the same visual/logical map', async () => {
  await withRTL((term) => {
    term.write('אבגד\r\nline2\r\nline3\r\nline4\r\nline5');
    term.scrollToTop();
    expect(term.visualToLogicalColumn(0, 0)).toBe(3);
    term.selectRectangle(0, 0, 1, 0);
    expect(term.getSelection()).toBe('גד');
    const metrics = term.renderer.getMetrics();
    const canvas = term.renderer.getCanvas(),
      rect = canvas.getBoundingClientRect();
    const coordinates = (term as any).inputHandler.pixelToCell(
      new MouseEvent('mousemove', {
        clientX: rect.left + metrics.width * 0.5,
        clientY: rect.top + metrics.height * 0.5,
      })
    );
    expect(coordinates).toEqual({ col: 4, row: 1 });
  });
});

test('reset and reflow keep BiDi mapping based on current core contents', async () => {
  await withRTL((term) => {
    term.write('אבגד');
    expect(term.visualToLogicalColumn(0, 0)).toBe(3);
    term.reset();
    term.write('abcd');
    expect(term.visualToLogicalColumn(0, 0)).toBe(0);
    term.resize(8, 3);
    term.write('\r\nאב');
    expect(term.visualToLogicalColumn(0, 1)).toBe(1);
  });
});
