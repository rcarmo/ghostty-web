import { describe, expect, test } from 'bun:test';
import { createIsolatedTerminal } from './test-helpers';
import { WebGPURenderer } from './webgpu-renderer';

describe('WebGPU lifecycle', () => {
  test('unsupported browser falls back without claiming a GPU backend', async () => {
    const term = await createIsolatedTerminal({ renderer: 'webgpu', cursorBlink: false });
    const host = document.createElement('div');
    try {
      await term.openAsync(host);
      expect(term.renderer).not.toBeInstanceOf(WebGPURenderer);
      term.write('fallback');
      expect(term.buffer.active.getLine(0)?.translateToString()).toContain('fallback');
    } finally {
      term.dispose();
    }
  });

  test('submits GPU work, destroys resources and promotes Canvas without losing selection or VT', async () => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    const gpuDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'gpu');
    const usageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'GPUTextureUsage');
    let lose!: (value: unknown) => void;
    let submitted = 0,
      texturesDestroyed = 0,
      devicesDestroyed = 0,
      unconfigured = 0;
    const device = {
      limits: { maxTextureDimension2D: 8192 },
      lost: new Promise((resolve) => {
        lose = resolve;
      }),
      pushErrorScope() {},
      popErrorScope: async () => null,
      createShaderModule: () => ({}),
      createRenderPipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
      createTexture: () => ({
        createView: () => ({}),
        destroy: () => {
          texturesDestroyed++;
        },
      }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
        finish: () => ({}),
      }),
      queue: {
        copyExternalImageToTexture() {},
        submit() {
          submitted++;
        },
      },
      addEventListener() {},
      destroy() {
        devicesDestroyed++;
      },
    };
    Object.defineProperty(window.navigator, 'gpu', {
      configurable: true,
      value: {
        requestAdapter: async () => ({ requestDevice: async () => device }),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    });
    Object.defineProperty(globalThis, 'GPUTextureUsage', {
      configurable: true,
      value: { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 },
    });
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: any[]): any {
      return type === 'webgpu'
        ? {
            configure() {},
            unconfigure() {
              unconfigured++;
            },
            getCurrentTexture: () => ({ createView: () => ({}) }),
          }
        : getContext.call(this, type as any, ...args);
    };
    const term = await createIsolatedTerminal({ renderer: 'webgpu', cursorBlink: false });
    const host = document.createElement('div');
    try {
      await term.openAsync(host);
      const renderer = term.renderer as WebGPURenderer;
      expect(renderer.backend).toBe('webgpu');
      term.write('PRESERVED');
      term.select(0, 0, 9);
      const selection = term.getSelection();
      const oldCanvas = renderer.getCanvas();
      term.refresh();
      expect(submitted).toBeGreaterThan(0);
      lose({ reason: 'unknown' });
      await Promise.resolve();
      expect(renderer.backend).toBe('canvas');
      expect(renderer.getCanvas()).not.toBe(oldCanvas);
      expect(renderer.getCanvas().parentElement).toBe(host);
      expect(term.getSelection()).toBe(selection);
      term.write('\r\nSTILL RUNNING');
      expect(term.buffer.active.getLine(1)?.translateToString()).toContain('STILL RUNNING');
      expect(texturesDestroyed).toBe(1);
      expect(devicesDestroyed).toBe(1);
      expect(unconfigured).toBe(1);
      term.dispose();
      expect(devicesDestroyed).toBe(1);
    } finally {
      term.dispose();
      HTMLCanvasElement.prototype.getContext = getContext;
      if (gpuDescriptor) Object.defineProperty(window.navigator, 'gpu', gpuDescriptor);
      else delete (window.navigator as any).gpu;
      if (usageDescriptor) Object.defineProperty(globalThis, 'GPUTextureUsage', usageDescriptor);
      else delete (globalThis as any).GPUTextureUsage;
    }
  });
});
