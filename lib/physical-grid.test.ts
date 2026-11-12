import { expect, test } from 'bun:test';
import { CanvasRenderer } from './renderer';

test('font pitch and baseline resolve to integral physical pixels at fractional DPR', () => {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind: any, ...args: any[]) {
    const context = original.call(this, kind, ...args) as any;
    if (kind === '2d')
      context.measureText = () => ({
        width: 8.3,
        fontBoundingBoxAscent: 10.7,
        fontBoundingBoxDescent: 3.1,
      });
    return context;
  } as any;
  try {
    for (const ratio of [1, 1.25, 1.5, 2, 2.5]) {
      const canvas = document.createElement('canvas');
      const renderer = new CanvasRenderer(canvas, { devicePixelRatio: ratio });
      renderer.resize(11, 7);
      const metrics = renderer.getMetrics();
      expect(metrics.width * ratio).toBeCloseTo(Math.round(8.3 * ratio), 10);
      expect(metrics.height * ratio).toBeCloseTo(Math.round(13.8 * ratio), 10);
      expect(metrics.baseline * ratio).toBeCloseTo(Math.round(metrics.baseline * ratio), 10);
      expect(canvas.width).toBe(11 * Math.round(8.3 * ratio));
      expect(canvas.height).toBe(7 * Math.round(13.8 * ratio));
      renderer.dispose();
    }
  } finally {
    HTMLCanvasElement.prototype.getContext = original;
  }
});
