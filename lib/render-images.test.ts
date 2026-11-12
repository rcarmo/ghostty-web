import { describe, expect, test } from 'bun:test';
import { Ghostty } from './ghostty';

const apc = (args: string, payload = '') => `\x1b_G${args}${payload ? ';' + payload : ''}\x1b\\`;
const rgba = (id: number, extra = '') =>
  apc(`a=T,f=32,s=1,v=1,i=${id},c=2,r=2,C=1${extra}`, '/wAA/w==');
async function terminal() {
  const term = (await Ghostty.load()).createTerminal(12, 5);
  term.setCellPixelSize(8, 16);
  return term;
}

describe('resolved image snapshots', () => {
  test('captures layers, offsets, ordering and stable idle identity', async () => {
    const term = await terminal();
    try {
      term.write(rgba(1, ',z=-2147483648,X=2,Y=3'));
      term.write('\x1b[1;4H' + apc('a=p,i=1,p=2,c=2,r=2,z=-1,C=1'));
      term.write('\x1b[1;7H' + apc('a=p,i=1,p=3,c=2,r=2,z=1,C=1'));
      const frame = term.getImageFrame();
      expect(frame.placements.map((p) => p.layer)).toEqual([0, 1, 2]);
      expect(frame.placements[0].offsetX).toBe(2);
      expect(frame.placements[0].offsetY).toBe(3);
      expect(term.getImageFrame()).toBe(frame);
      expect(frame.pixels(1)).toBe(frame.pixels(1));
    } finally {
      term.free();
    }
  });
  test('copies pixels across memory growth and retransmission', async () => {
    const term = await terminal();
    try {
      term.write(rgba(1));
      const old = term.getImageFrame().pixels(1)!;
      const bytes = old.data.slice();
      term.write(apc('a=T,f=32,s=1,v=1,i=1,c=2,r=2,C=1', 'AAD//w=='));
      const next = term.getImageFrame().pixels(1)!;
      expect(Array.from(old.data)).toEqual(Array.from(bytes));
      expect(Array.from(next.data)).not.toEqual(Array.from(bytes));
      expect(next.revision).not.toBe(old.revision);
    } finally {
      term.free();
    }
  });
  test('resolves inherited virtual placeholder geometry in the core', async () => {
    const term = await terminal();
    try {
      term.write(rgba(7, ',U=1'));
      term.write('\x1b[38;2;0;0;7m\u{10EEEE}\u0305\u0305\u{10EEEE}\x1b[0m');
      const frame = term.getImageFrame();
      expect(frame.placements.length).toBe(1);
      expect(frame.placements[0].imageId).toBe(7);
      expect(frame.placements[0].pixelWidth).toBe(16);
    } finally {
      term.free();
    }
  });
  test('animation advances copied pixels at core deadlines without VT writes', async () => {
    const term = await terminal();
    try {
      term.write(
        rgba(1) +
          apc('a=f,f=32,i=1,s=1,v=1,z=40', 'AAD//w==') +
          apc('a=a,i=1,r=1,z=30') +
          apc('a=a,i=1,s=3')
      );
      expect(term.tickImages(1000).next).toBe(1030);
      const first = term.getImageFrame();
      expect(Array.from(first.pixels(1)!.data)).toEqual([255, 0, 0, 255]);
      expect(term.tickImages(1010).next).toBe(1030);
      expect(term.getImageFrame()).toBe(first);
      expect(term.tickImages(1030).next).toBe(1070);
      expect(Array.from(term.getImageFrame().pixels(1)!.data)).toEqual([0, 0, 255, 255]);
      term.write(apc('a=a,i=1,s=1'));
      expect(term.tickImages(1100).next).toBeNull();
    } finally {
      term.free();
    }
  });

  test('Terminal owns animation timers and cancels them for hold/suspend/dispose', async () => {
    const { Terminal } = await import('./terminal');
    const term = new Terminal({ ghostty: await Ghostty.load(), cursorBlink: false });
    term.open(document.createElement('div'));
    const internal = term as any;
    try {
      term.write(
        rgba(1) +
          apc('a=f,f=32,i=1,s=1,v=1,z=40', 'AAD//w==') +
          apc('a=a,i=1,r=1,z=30') +
          apc('a=a,i=1,s=3')
      );
      expect(internal.cancelImageAnimation).toBeDefined();
      term.suspend();
      expect(internal.cancelImageAnimation).toBeUndefined();
      term.resume();
      expect(internal.cancelImageAnimation).toBeDefined();
      term.write('\x1b[?2026h');
      expect(internal.cancelImageAnimation).toBeUndefined();
      term.write('\x1b[?2026l');
      expect(internal.cancelImageAnimation).toBeDefined();
      term.dispose();
      expect(internal.cancelImageAnimation).toBeUndefined();
    } finally {
      term.dispose();
    }
  });

  test('ticks return bounded scheduling information and release resources', async () => {
    const term = await terminal();
    term.write(rgba(1));
    const tick = term.tickImages(1000);
    expect(tick.next).toBeNull();
    expect(tick.changed).toBe(false);
    expect(() => term.free()).not.toThrow();
  });
});
