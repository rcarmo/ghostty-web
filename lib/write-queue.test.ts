import { describe, expect, test } from 'bun:test';
import { splitWrite, WriteQueue } from './write-queue';

describe('cooperative output parser', () => {
  test('splits Unicode strings and bytes without damaging boundaries', () => {
    const text = 'a'.repeat(7) + '😀' + 'λ'.repeat(8);
    let remaining: string | Uint8Array | null = text;
    let joined = '';
    while (remaining !== null) {
      const [part, rest] = splitWrite(remaining, 8);
      joined += part;
      remaining = rest;
    }
    expect(joined).toBe(text);
    remaining = new TextEncoder().encode(text);
    joined = '';
    while (remaining !== null) {
      const [part, rest] = splitWrite(remaining, 8);
      joined += new TextDecoder('utf-8', { fatal: true }).decode(part as Uint8Array);
      remaining = rest;
    }
    expect(joined).toBe(text);
  });
  test('yields, preserves order and completes only after all chunks parse', async () => {
    let clock = 0;
    const work: (() => void)[] = [];
    const seen: string[] = [];
    const done: string[] = [];
    const queue = new WriteQueue(
      (data) => {
        seen.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
        clock += 10;
      },
      (fn) => {
        work.push(fn);
        return () => {
          const i = work.indexOf(fn);
          if (i >= 0) work.splice(i, 1);
        };
      },
      () => {
        throw new Error('unexpected');
      },
      () => clock
    );
    const text = 'x'.repeat(50000);
    queue.enqueue(text, () => done.push('large'));
    queue.enqueue('tail', () => done.push('tail'));
    queue.enqueue('', () => done.push('barrier'));
    expect(seen.join('').length).toBeLessThan(text.length);
    expect(done).toEqual([]);
    while (work.length) work.shift()!();
    await Promise.resolve();
    expect(seen.join('')).toBe(text + 'tail');
    expect(done).toEqual(['large', 'tail', 'barrier']);
  });
  test('owns queued bytes and cancels discarded callbacks on clear/disposal', async () => {
    let clock = 0;
    const tasks: (() => void)[] = [];
    const seen: string[] = [];
    let calls = 0;
    const queue = new WriteQueue(
      (data) => {
        seen.push(new TextDecoder().decode(data as Uint8Array));
        clock += 10;
      },
      (fn) => {
        tasks.push(fn);
        return () => {};
      },
      () => {},
      () => clock
    );
    const bytes = new TextEncoder().encode('a'.repeat(40000));
    queue.enqueue(bytes, () => calls++);
    bytes.fill(98);
    while (tasks.length) tasks.shift()!();
    await Promise.resolve();
    expect(seen.join('')).toBe('a'.repeat(40000));
    expect(calls).toBe(1);
    queue.enqueue(new Uint8Array(50000), () => calls++);
    queue.clear();
    while (tasks.length) tasks.shift()!();
    await Promise.resolve();
    expect(calls).toBe(1);
    queue.dispose();
    queue.enqueue(new Uint8Array(4), () => calls++);
    await Promise.resolve();
    expect(calls).toBe(1);
  });
  test('bounds pending memory and reports async parse errors', () => {
    const tasks: (() => void)[] = [];
    let count = 0;
    const errors: Error[] = [];
    const queue = new WriteQueue(
      () => {
        if (++count > 1) throw new Error('parse failed');
      },
      (fn) => {
        tasks.push(fn);
        return () => {};
      },
      (e) => errors.push(e),
      () => count * 10
    );
    expect(() => queue.enqueue(new Uint8Array(8 * 1024 * 1024 + 1))).toThrow('8 MiB');
    queue.enqueue(new Uint8Array(40000));
    tasks.shift()!();
    expect(errors[0].message).toBe('parse failed');
  });
});
