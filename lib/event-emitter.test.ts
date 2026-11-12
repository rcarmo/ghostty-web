import { describe, expect, test } from 'bun:test';
import { EventEmitter } from './event-emitter';

describe('EventEmitter', () => {
  test('a listener that disposes itself during fire does not skip the next listener', () => {
    const emitter = new EventEmitter<number>();
    const seen: string[] = [];
    const first = emitter.event((n) => {
      seen.push(`first:${n}`);
      first.dispose();
    });
    emitter.event((n) => seen.push(`second:${n}`));
    emitter.fire(1);
    emitter.fire(2);
    expect(seen).toEqual(['first:1', 'second:1', 'second:2']);
  });
  test('listeners added during dispatch begin with the next event', () => {
    const emitter = new EventEmitter<number>();
    const seen: string[] = [];
    let registered = false;
    emitter.event((n) => {
      seen.push(`first:${n}`);
      if (!registered) {
        registered = true;
        emitter.event((next) => seen.push(`late:${next}`));
      }
    });
    emitter.fire(1);
    expect(seen).toEqual(['first:1']);
    emitter.fire(2);
    expect(seen).toEqual(['first:1', 'first:2', 'late:2']);
  });

  test('disposing another listener does not change the in-flight delivery', () => {
    const emitter = new EventEmitter<number>();
    const seen: string[] = [];
    emitter.event((n) => {
      seen.push(`first:${n}`);
      second.dispose();
    });
    const second = emitter.event((n) => seen.push(`second:${n}`));
    emitter.fire(1);
    emitter.fire(2);
    expect(seen).toEqual(['first:1', 'second:1', 'first:2']);
  });
});
