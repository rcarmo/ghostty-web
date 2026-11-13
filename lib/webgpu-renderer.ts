/// <reference types="@webgpu/types" />
import {
  CanvasRenderer,
  type IRenderable,
  type IScrollbackProvider,
  type RendererOptions,
} from './renderer';
import type { ITheme } from './interfaces';

// CPU glyph rasterization deliberately shares Canvas's complete terminal semantics.
// WebGPU owns the presentation texture, WGSL pipeline and command submission;
// this is a compositor, not a claim of GPU-side glyph layout/instancing.
const SHADER = `
@group(0) @binding(0) var picture: texture_2d<f32>;
struct Vertex { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }
@vertex fn vertex(@builtin(vertex_index) i: u32) -> Vertex {
  let positions = array<vec2<f32>, 3>(vec2(-1., -1.), vec2(3., -1.), vec2(-1., 3.));
  var out: Vertex;
  out.position = vec4(positions[i], 0., 1.);
  out.uv = vec2((positions[i].x + 1.) * .5, (1. - positions[i].y) * .5);
  return out;
}
@fragment fn fragment(in: Vertex) -> @location(0) vec4<f32> {
  let dimensions = textureDimensions(picture);
  let pixel = clamp(vec2<i32>(in.uv * vec2<f32>(dimensions)), vec2(0), vec2<i32>(dimensions) - vec2(1));
  return textureLoad(picture, pixel, 0);
}`;

/** Opt-in WebGPU compositor with an in-place Canvas fallback. */
export class WebGPURenderer extends CanvasRenderer {
  private presentationCanvas: HTMLCanvasElement;
  private rasterCanvas: HTMLCanvasElement;
  private gpu?: GPU;
  private adapter?: GPUAdapter;
  private device?: GPUDevice;
  private context?: GPUCanvasContext;
  private pipeline?: GPURenderPipeline;
  private texture?: GPUTexture;
  private bindGroup?: GPUBindGroup;
  private textureWidth = 0;
  private textureHeight = 0;
  private disposed = false;
  private replacement?: (oldCanvas: HTMLCanvasElement, newCanvas: HTMLCanvasElement) => void;

  get backend(): 'webgpu' | 'canvas' {
    return this.device ? 'webgpu' : 'canvas';
  }

  static async create(
    canvas: HTMLCanvasElement,
    options: RendererOptions
  ): Promise<WebGPURenderer> {
    const gpu = (canvas.ownerDocument.defaultView?.navigator as Navigator | undefined)?.gpu;
    if (!gpu) throw new Error('WebGPU unavailable (requires a supported secure browser context)');
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    let renderer: WebGPURenderer | undefined;
    try {
      renderer = new WebGPURenderer(canvas, options);
      renderer.gpu = gpu;
      renderer.adapter = adapter;
      renderer.device = device;
      const context = canvas.getContext('webgpu');
      if (!context) throw new Error('No WebGPU canvas context');
      renderer.context = context;
      const format = gpu.getPreferredCanvasFormat();
      context.configure({
        device,
        format,
        alphaMode: 'premultiplied',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      device.pushErrorScope('validation');
      const shader = device.createShaderModule({ code: SHADER, label: 'terminal-compositor' });
      renderer.pipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module: shader, entryPoint: 'vertex' },
        fragment: { module: shader, entryPoint: 'fragment', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      const error = await device.popErrorScope();
      if (error) throw new Error(error.message);
      device.lost.then((info) =>
        renderer?.fallback(`GPU device lost: ${info.reason}: ${info.message}`)
      );
      device.addEventListener('uncapturederror', (event) =>
        renderer?.fallback(event.error.message)
      );
      return renderer;
    } catch (error) {
      renderer?.dispose();
      if (!renderer) device.destroy();
      throw error;
    }
  }

  private constructor(canvas: HTMLCanvasElement, options: RendererOptions) {
    const raster = canvas.ownerDocument.createElement('canvas');
    super(raster, options);
    this.rasterCanvas = raster;
    this.presentationCanvas = canvas;
    canvas.style.backgroundColor = raster.style.backgroundColor;
  }

  onCanvasReplacement(
    callback: (oldCanvas: HTMLCanvasElement, newCanvas: HTMLCanvasElement) => void
  ): void {
    this.replacement = callback;
  }

  override getCanvas(): HTMLCanvasElement {
    return this.presentationCanvas;
  }
  override setTheme(theme: ITheme): void {
    super.setTheme(theme);
    this.presentationCanvas.style.backgroundColor = this.rasterCanvas.style.backgroundColor;
  }
  override setAllowTransparency(allow: boolean): void {
    super.setAllowTransparency(allow);
    this.presentationCanvas.style.backgroundColor = this.rasterCanvas.style.backgroundColor;
  }

  override resize(cols: number, rows: number): void {
    super.resize(cols, rows);
    if (!this.device) return;
    const raster = this.rasterCanvas;
    this.presentationCanvas.width = raster.width;
    this.presentationCanvas.height = raster.height;
    this.presentationCanvas.style.width = raster.style.width;
    this.presentationCanvas.style.height = raster.style.height;
    // Bound additional GPU storage to 64 MiB. Oversized panes still work in Canvas.
    if (
      raster.width > this.device.limits.maxTextureDimension2D ||
      raster.height > this.device.limits.maxTextureDimension2D ||
      raster.width * raster.height > 16_777_216
    )
      this.fallback();
  }

  override render(
    buffer: IRenderable,
    forceAll = false,
    viewportY = 0,
    sb?: IScrollbackProvider,
    scrollbarOpacity = 1
  ): void {
    super.render(buffer, forceAll, viewportY, sb, scrollbarOpacity);
    if (!this.device || this.disposed) return;
    try {
      this.present();
    } catch (error) {
      this.fallback(String(error));
    }
  }

  private present(): void {
    const device = this.device!;
    const { width, height } = this.rasterCanvas;
    if (!width || !height || !this.pipeline || !this.context) return;
    if (width !== this.textureWidth || height !== this.textureHeight || !this.texture) {
      this.texture?.destroy();
      this.texture = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.textureWidth = width;
      this.textureHeight = height;
      this.bindGroup = device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: this.texture.createView() }],
      });
    }
    device.queue.copyExternalImageToTexture(
      { source: this.rasterCanvas },
      { texture: this.texture, premultipliedAlpha: true },
      [width, height]
    );
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup!);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /** Promote the already-painted raster canvas; keep VT, selection and timers intact. */
  private fallback(reason = 'GPU texture size limit exceeded'): void {
    if (this.disposed || !this.device) return;
    console.warn('WebGPU falling back to Canvas:', reason);
    const oldCanvas = this.presentationCanvas;
    this.releaseGPU();
    this.rasterCanvas.style.cssText = oldCanvas.style.cssText;
    oldCanvas.replaceWith(this.rasterCanvas);
    this.presentationCanvas = this.rasterCanvas;
    this.replacement?.(oldCanvas, this.rasterCanvas);
  }

  private releaseGPU(): void {
    const device = this.device;
    this.device = undefined;
    this.context?.unconfigure();
    this.context = undefined;
    this.texture?.destroy();
    this.texture = undefined;
    this.bindGroup = undefined;
    this.pipeline = undefined;
    device?.destroy();
    this.adapter = undefined;
    this.gpu = undefined;
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.replacement = undefined;
    this.releaseGPU();
    super.dispose();
    this.rasterCanvas.width = this.rasterCanvas.height = 0;
  }
}
