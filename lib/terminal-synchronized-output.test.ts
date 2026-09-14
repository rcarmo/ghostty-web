import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

type Internals = {
  renderTick(): void;
  renderFrame(forceAll?: boolean): boolean;
  synchronizedOutputTimer?: number;
  synchronizedOutputExpired: boolean;
};

describe('synchronized output presentation', () => {
  let terminal: Terminal;
  let container: HTMLElement;
  let internal: Internals;
  let paint: ReturnType<typeof jest.spyOn>;

  beforeEach(async () => {
    terminal = await createIsolatedTerminal();
    container = document.createElement('div');
    document.body.appendChild(container);
    terminal.open(container);
    internal = terminal as unknown as Internals;
    paint = jest.spyOn(terminal.renderer!, 'render');
  });

  afterEach(() => {
    paint.mockRestore();
    terminal.dispose();
    container.remove();
  });

  test('split writes keep the old frame and dirty state until DEC 2026 ends', () => {
    terminal.wasmTerm!.write('\x1b[?2026h\x1b[2J\x1b[HOLD HISTORY');
    internal.renderTick();
    terminal.wasmTerm!.write('\r\nMORE HISTORY');
    internal.renderFrame(true); // refresh/font/scrollbar paths must not bypass the guard
    expect(paint).not.toHaveBeenCalled();
    expect(terminal.wasmTerm!.isDirty()).toBe(true);
    expect(internal.synchronizedOutputTimer).toBeDefined();
    terminal.wasmTerm!.write('\x1b[?2026l');
    internal.renderTick();
    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint.mock.calls[0][1]).toBe(true); // preserve a deferred full repaint
    expect(internal.synchronizedOutputTimer).toBeUndefined();
  });

  test('synchronous keyboard echo cannot bypass a held frame', () => {
    terminal.input('x', true);
    terminal.write('\x1b[?2026hpartial echo');
    expect(paint).not.toHaveBeenCalled();
    expect(internal.synchronizedOutputTimer).toBeDefined();
    terminal.write('\x1b[?2026l');
    internal.renderTick();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  test('synchronous paste echo and refresh preserve a deferred full repaint', () => {
    terminal.paste('pasted text');
    terminal.write('\x1b[?2026hpartial paste echo');
    terminal.refresh();
    internal.renderTick();
    expect(paint).not.toHaveBeenCalled();
    terminal.write('\x1b[?2026l');
    internal.renderTick();
    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint.mock.calls[0][1]).toBe(true);
  });

  test('suspended terminals do not paint synchronous echoes', () => {
    terminal.suspend();
    terminal.input('x', true);
    terminal.write('echo while hidden');
    expect(paint).not.toHaveBeenCalled();
    terminal.resume();
    internal.renderTick();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  test('ordinary streaming paints immediately', () => {
    terminal.wasmTerm!.write('ordinary text');
    internal.renderTick();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  test('a missing end marker has one bounded deadline and does not rearm forever', () => {
    const view = container.ownerDocument.defaultView!;
    const callbacks: Array<() => void> = [];
    const timer = jest.spyOn(view, 'setTimeout').mockImplementation((callback: any) => {
      callbacks.push(callback);
      return 999;
    });
    try {
      terminal.wasmTerm!.write('\x1b[?2026hpartial');
      internal.renderTick();
      internal.renderTick();
      expect(callbacks).toHaveLength(1);
      callbacks[0]();
      internal.renderTick();
      expect(paint).toHaveBeenCalledTimes(1);
      internal.renderTick();
      expect(callbacks).toHaveLength(1);
      terminal.wasmTerm!.write('\x1b[?2026l');
      internal.renderTick();
      expect(internal.synchronizedOutputExpired).toBe(false);
      terminal.wasmTerm!.write('\x1b[?2026hnext');
      internal.renderTick();
      expect(callbacks).toHaveLength(2);
    } finally {
      timer.mockRestore();
    }
  });

  test('reset cancels the old transaction deadline', () => {
    terminal.wasmTerm!.write('\x1b[?2026hpartial');
    internal.renderTick();
    terminal.reset();
    expect(internal.synchronizedOutputTimer).toBeUndefined();
    internal.renderTick();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  test('suspension preserves the frame; resume presents completed writes', () => {
    terminal.suspend();
    terminal.wasmTerm!.write('\x1b[?2026hpartial');
    internal.renderTick();
    terminal.wasmTerm!.write('\x1b[?2026l');
    internal.renderTick();
    expect(paint).not.toHaveBeenCalled();
    terminal.resume();
    internal.renderTick();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  test('disposal cancels the deadline', () => {
    terminal.wasmTerm!.write('\x1b[?2026hpartial');
    internal.renderTick();
    terminal.dispose();
    expect(internal.synchronizedOutputTimer).toBeUndefined();
  });
});
