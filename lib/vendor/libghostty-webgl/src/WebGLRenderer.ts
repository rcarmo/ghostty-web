import debug from "debug";
import type { CellMetrics, RenderInput, Renderer, TerminalTheme } from "./types";
import { CellBuffer } from "./CellBuffer";
import { GlyphAtlas } from "./GlyphAtlas";
import { profileDuration, profileStart } from "./profile";

// Namespaced debug loggers
const log = debug("bootty:webgl");
import { backgroundFragmentSource, backgroundVertexSource } from "./shaders/background";
import { glyphFragmentSource, glyphVertexSource } from "./shaders/glyph";
import { decorationFragmentSource, decorationVertexSource } from "./shaders/decoration";
import { solidFragmentSource, solidVertexSource } from "./shaders/solid";

const CELL_STRIDE = 32;
const MAX_CONTEXT_FAILURES = 3;

interface ProgramInfo {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  uniforms: Record<string, WebGLUniformLocation>;
}

export interface WebGLRendererOptions {
  fontSize?: number;
  fontFamily?: string;
  devicePixelRatio?: number;
  antialias?: boolean;
  alpha?: boolean;
  onContextLoss?: () => void;
}

export class WebGLRenderer implements Renderer {
  private canvas?: HTMLCanvasElement;
  private gl?: WebGL2RenderingContext;
  private options: WebGLRendererOptions;
  private fontSize: number;
  private fontFamily: string;
  private dpr: number;
  private metrics: CellMetrics;
  private theme: TerminalTheme;
  private cellBuffer?: CellBuffer;
  private glyphAtlas?: GlyphAtlas;
  private quadVbo?: WebGLBuffer;
  private background?: ProgramInfo;
  private glyph?: ProgramInfo;
  private decoration?: ProgramInfo;
  private solid?: ProgramInfo;
  private gridCols = 0;
  private gridRows = 0;
  private cellSizePx = { width: 0, height: 0, baseline: 0 };
  private contextValid = false;
  private contextLossCount = 0;
  private forceFullUpload = true;

  constructor(options: WebGLRendererOptions = {}) {
    log("WebGLRenderer constructor called");
    this.options = options;
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? "monospace";
    this.dpr =
      options.devicePixelRatio ??
      (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    this.metrics = this.measureFont();
    this.theme = {
      foreground: { r: 0, g: 0, b: 0, a: 1 },
      background: { r: 0, g: 0, b: 0, a: 1 },
      cursor: { r: 255, g: 255, b: 255, a: 1 },
      cursorAccent: { r: 0, g: 0, b: 0, a: 1 },
      selectionBackground: { r: 0, g: 0, b: 0, a: 1 },
      selectionForeground: null,
      selectionOpacity: 0.4,
    };
  }

  attach(canvas: HTMLCanvasElement): void {
    log("attach() called");
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      antialias: this.options.antialias ?? false,
      alpha: this.options.alpha ?? true,
      premultipliedAlpha: true,
    });
    if (!gl) {
      throw new Error("WebGL2 is not available");
    }
    this.gl = gl;
    this.contextValid = true;
    this.initResources();
    canvas.addEventListener("webglcontextlost", this.handleContextLost, false);
    canvas.addEventListener("webglcontextrestored", this.handleContextRestored, false);
  }

  resize(cols: number, rows: number): void {
    if (!this.canvas || !this.gl) {
      throw new Error("WebGLRenderer is not attached");
    }
    this.gridCols = cols;
    this.gridRows = rows;

    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.width = Math.floor(cssWidth * this.dpr);
    this.canvas.height = Math.floor(cssHeight * this.dpr);

    this.cellSizePx = {
      width: this.metrics.width * this.dpr,
      height: this.metrics.height * this.dpr,
      baseline: this.metrics.baseline * this.dpr,
    };

    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.cellBuffer?.resize(cols, rows);
    this.forceFullUpload = true;
  }

  render(input: RenderInput): void {
    if (!this.prepareFrame(input)) return;
    const renderStart = profileStart();

    this.updateInstanceData(input);

    const instanceCount = input.cols * input.rows;
    const drawStart = profileStart();
    this.drawFramePasses(input, instanceCount);
    this.drawOverlays(input);
    profileDuration("bootty:webgl:draw", drawStart, {
      cols: input.cols,
      rows: input.rows,
      instanceCount,
      cursorVisible: input.cursorVisible,
      scrollbarOpacity: input.scrollbarOpacity,
    });

    profileDuration("bootty:webgl:render", renderStart, {
      cols: input.cols,
      rows: input.rows,
      instanceCount,
    });
  }

  updateTheme(theme: TerminalTheme): void {
    this.theme = theme;
  }

  setFontSize(size: number): void {
    this.fontSize = size;
    this.metrics = this.measureFont();
    this.glyphAtlas?.reset(this.fontSize, this.fontFamily, this.dpr);
    this.forceFullUpload = true;
  }

  setFontFamily(family: string): void {
    this.fontFamily = family;
    this.metrics = this.measureFont();
    this.glyphAtlas?.reset(this.fontSize, this.fontFamily, this.dpr);
    this.forceFullUpload = true;
  }

  getMetrics(): CellMetrics {
    return { ...this.metrics };
  }

  getCanvas(): HTMLCanvasElement {
    if (!this.canvas) {
      throw new Error("WebGLRenderer is not attached");
    }
    return this.canvas;
  }

  get charWidth(): number {
    return this.metrics.width;
  }

  get charHeight(): number {
    return this.metrics.height;
  }

  clear(): void {
    if (!this.gl || !this.canvas) return;
    const bg = this.theme.background;
    this.gl.clearColor((bg.r / 255) * bg.a, (bg.g / 255) * bg.a, (bg.b / 255) * bg.a, bg.a);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  dispose(): void {
    if (this.canvas) {
      this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
      this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
    }
    this.background = undefined;
    this.glyph = undefined;
    this.decoration = undefined;
    this.solid = undefined;
    this.cellBuffer = undefined;
    this.glyphAtlas = undefined;
    this.gl = undefined;
    this.canvas = undefined;
  }

  private initResources(): void {
    if (!this.gl) return;
    const gl = this.gl;

    const quadVbo = gl.createBuffer();
    if (!quadVbo) {
      throw new Error("Failed to create quad buffer");
    }
    this.quadVbo = quadVbo;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

    this.cellBuffer = new CellBuffer(gl);
    this.glyphAtlas = new GlyphAtlas(gl, this.fontSize, this.fontFamily, this.dpr);

    this.background = this.createProgramInfo(backgroundVertexSource, backgroundFragmentSource, [
      "u_cellSize",
      "u_gridSize",
    ]);
    this.glyph = this.createProgramInfo(glyphVertexSource, glyphFragmentSource, [
      "u_cellSize",
      "u_gridSize",
      "u_atlasSize",
      "u_baseline",
      "u_atlas",
      "u_colorAtlas",
    ]);
    this.decoration = this.createProgramInfo(decorationVertexSource, decorationFragmentSource, [
      "u_cellSize",
      "u_gridSize",
      "u_baseline",
    ]);
    this.solid = this.createProgramInfo(
      solidVertexSource,
      solidFragmentSource,
      ["u_rectOrigin", "u_rectSize", "u_canvasSize", "u_color"],
      true,
    );

    this.forceFullUpload = true;
  }

  private prepareFrame(input: RenderInput): boolean {
    if (!this.contextValid || !this.gl || !this.canvas) return false;

    const currentDpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : this.dpr;
    if (currentDpr !== this.dpr) {
      this.setDevicePixelRatio(currentDpr);
    }

    if (input.cols !== this.gridCols || input.rows !== this.gridRows) {
      this.resize(input.cols, input.rows);
    }

    this.theme = input.theme;

    return !!this.cellBuffer && !!this.glyphAtlas;
  }

  private updateInstanceData(input: RenderInput): void {
    if (!this.cellBuffer || !this.glyphAtlas) return;

    const cellBufferStart = profileStart();
    this.cellBuffer.update(input, this.glyphAtlas, this.forceFullUpload);
    profileDuration("bootty:webgl:cellbuffer-update", cellBufferStart, {
      cols: input.cols,
      rows: input.rows,
      dirtyState: input.dirtyState,
      forceFullUpload: this.forceFullUpload,
    });
    this.forceFullUpload = false;
  }

  private drawFramePasses(input: RenderInput, instanceCount: number): void {
    if (!this.gl || !this.glyphAtlas) return;
    const gl = this.gl;
    const cellSize = this.cellSizePx;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);

    const bg = input.theme.background;
    gl.clearColor((bg.r / 255) * bg.a, (bg.g / 255) * bg.a, (bg.b / 255) * bg.a, bg.a);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.background) {
      gl.useProgram(this.background.program);
      gl.bindVertexArray(this.background.vao);
      gl.uniform2f(this.background.uniforms["u_cellSize"], cellSize.width, cellSize.height);
      gl.uniform2f(this.background.uniforms["u_gridSize"], input.cols, input.rows);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instanceCount);
    }

    if (this.glyph) {
      gl.useProgram(this.glyph.program);
      gl.bindVertexArray(this.glyph.vao);
      gl.uniform2f(this.glyph.uniforms["u_cellSize"], cellSize.width, cellSize.height);
      gl.uniform2f(this.glyph.uniforms["u_gridSize"], input.cols, input.rows);
      gl.uniform2f(this.glyph.uniforms["u_atlasSize"], this.glyphAtlas.size, this.glyphAtlas.size);
      gl.uniform1f(this.glyph.uniforms["u_baseline"], cellSize.baseline);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.glyphAtlas.texture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.glyphAtlas.colorAtlas);

      gl.uniform1i(this.glyph.uniforms["u_atlas"], 0);
      gl.uniform1i(this.glyph.uniforms["u_colorAtlas"], 1);

      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instanceCount);
    }

    if (this.decoration) {
      gl.useProgram(this.decoration.program);
      gl.bindVertexArray(this.decoration.vao);
      gl.uniform2f(this.decoration.uniforms["u_cellSize"], cellSize.width, cellSize.height);
      gl.uniform2f(this.decoration.uniforms["u_gridSize"], input.cols, input.rows);
      gl.uniform1f(this.decoration.uniforms["u_baseline"], cellSize.baseline);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instanceCount);
    }
  }

  private drawOverlays(input: RenderInput): void {
    const cellSize = this.cellSizePx;
    if (input.cursorVisible) {
      const cursorSize = computeCursorSizePx(input.cursorStyle, this.metrics, this.dpr);
      const originX = input.cursorX * cellSize.width;
      const originY = input.cursorY * cellSize.height;
      this.drawSolidRect(
        { x: originX + cursorSize.offsetX, y: originY + cursorSize.offsetY },
        { width: cursorSize.width, height: cursorSize.height },
        this.theme.cursor,
      );
    }

    if (input.scrollbarOpacity > 0 && input.scrollbackLength > 0) {
      this.drawScrollbar(input.scrollbarOpacity, input.scrollbackLength, input.viewportY);
    }
  }

  private createProgramInfo(
    vertexSource: string,
    fragmentSource: string,
    uniformNames: string[],
    solid = false,
  ): ProgramInfo {
    if (!this.gl || !this.quadVbo) {
      throw new Error("WebGLRenderer is not initialized");
    }
    const gl = this.gl;
    const program = createProgram(gl, vertexSource, fragmentSource);
    const vao = gl.createVertexArray();
    if (!vao) {
      throw new Error("Failed to create VAO");
    }
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    if (!solid) {
      if (!this.cellBuffer) {
        throw new Error("CellBuffer not initialized");
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cellBuffer.handle);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribIPointer(1, 4, gl.UNSIGNED_SHORT, CELL_STRIDE, 0);
      gl.vertexAttribDivisor(1, 1);

      gl.enableVertexAttribArray(2);
      gl.vertexAttribIPointer(2, 2, gl.SHORT, CELL_STRIDE, 8);
      gl.vertexAttribDivisor(2, 1);

      gl.enableVertexAttribArray(3);
      gl.vertexAttribIPointer(3, 4, gl.UNSIGNED_BYTE, CELL_STRIDE, 12);
      gl.vertexAttribDivisor(3, 1);

      gl.enableVertexAttribArray(4);
      gl.vertexAttribIPointer(4, 4, gl.UNSIGNED_BYTE, CELL_STRIDE, 16);
      gl.vertexAttribDivisor(4, 1);

      gl.enableVertexAttribArray(5);
      gl.vertexAttribIPointer(5, 4, gl.UNSIGNED_BYTE, CELL_STRIDE, 20);
      gl.vertexAttribDivisor(5, 1);

      gl.enableVertexAttribArray(6);
      gl.vertexAttribIPointer(6, 4, gl.UNSIGNED_BYTE, CELL_STRIDE, 24);
      gl.vertexAttribDivisor(6, 1);

      gl.enableVertexAttribArray(7);
      gl.vertexAttribIPointer(7, 1, gl.UNSIGNED_INT, CELL_STRIDE, 28);
      gl.vertexAttribDivisor(7, 1);
    }

    gl.bindVertexArray(null);

    const uniforms: Record<string, WebGLUniformLocation> = {};
    for (const name of uniformNames) {
      const location = gl.getUniformLocation(program, name);
      if (!location) {
        throw new Error(`Missing uniform ${name}`);
      }
      uniforms[name] = location;
    }

    return { program, vao, uniforms };
  }

  private drawSolidRect(
    origin: { x: number; y: number },
    size: { width: number; height: number },
    color: { r: number; g: number; b: number; a: number },
  ): void {
    if (!this.gl || !this.solid || !this.canvas) return;
    const gl = this.gl;
    gl.useProgram(this.solid.program);
    gl.bindVertexArray(this.solid.vao);
    gl.uniform2f(this.solid.uniforms["u_rectOrigin"], origin.x, origin.y);
    gl.uniform2f(this.solid.uniforms["u_rectSize"], size.width, size.height);
    gl.uniform2f(this.solid.uniforms["u_canvasSize"], this.canvas.width, this.canvas.height);
    const a = color.a;
    gl.uniform4f(
      this.solid.uniforms["u_color"],
      (color.r / 255) * a,
      (color.g / 255) * a,
      (color.b / 255) * a,
      a,
    );
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private drawScrollbar(opacity: number, scrollbackLength: number, viewportY: number): void {
    if (!this.canvas) return;
    const cssWidth = this.gridCols * this.metrics.width;
    const cssHeight = this.gridRows * this.metrics.height;
    const scrollbarWidth = 8;
    const padding = 4;
    const trackHeight = cssHeight - padding * 2;
    if (scrollbackLength <= 0 || trackHeight <= 0) return;

    const totalLines = scrollbackLength + this.gridRows;
    const thumbHeight = Math.max(20, (this.gridRows / totalLines) * trackHeight);
    const rawPosition = scrollbackLength > 0 ? viewportY / scrollbackLength : 0;
    const scrollPosition = Math.min(1, Math.max(0, rawPosition));
    const thumbY = padding + (trackHeight - thumbHeight) * (1 - scrollPosition);
    const scrollbarX = cssWidth - scrollbarWidth - padding;

    const toPx = (v: number) => v * this.dpr;
    const trackColor = { r: 128, g: 128, b: 128, a: 0.1 * opacity };
    const thumbColor = {
      r: 128,
      g: 128,
      b: 128,
      a: (viewportY > 0 ? 0.5 : 0.3) * opacity,
    };

    this.drawSolidRect(
      { x: toPx(scrollbarX), y: toPx(padding) },
      { width: toPx(scrollbarWidth), height: toPx(trackHeight) },
      trackColor,
    );
    this.drawSolidRect(
      { x: toPx(scrollbarX), y: toPx(thumbY) },
      { width: toPx(scrollbarWidth), height: toPx(thumbHeight) },
      thumbColor,
    );
  }

  private measureFont(): CellMetrics {
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(1, 1)
        : typeof document !== "undefined"
          ? document.createElement("canvas")
          : null;
    const ctx = canvas?.getContext("2d") ?? null;
    if (!ctx) {
      return { width: this.fontSize, height: this.fontSize, baseline: this.fontSize };
    }
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;
    const metrics = ctx.measureText("M");
    const width = Math.ceil(metrics.width);
    const ascent = metrics.actualBoundingBoxAscent || this.fontSize * 0.8;
    const descent = metrics.actualBoundingBoxDescent || this.fontSize * 0.2;
    const height = Math.ceil(ascent + descent) + 2;
    const baseline = Math.ceil(ascent) + 1;
    return { width, height, baseline };
  }

  private setDevicePixelRatio(dpr: number): void {
    this.dpr = dpr;
    this.metrics = this.measureFont();
    this.glyphAtlas?.reset(this.fontSize, this.fontFamily, this.dpr);
    if (this.gridCols > 0 && this.gridRows > 0) {
      this.resize(this.gridCols, this.gridRows);
    }
    this.forceFullUpload = true;
  }

  private handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextValid = false;
    this.contextLossCount += 1;
    if (this.contextLossCount >= MAX_CONTEXT_FAILURES) {
      this.options.onContextLoss?.();
    }
  };

  private handleContextRestored = (): void => {
    if (!this.canvas || !this.gl) return;
    this.initResources();
    this.contextValid = true;
    this.forceFullUpload = true;
    if (this.contextLossCount >= MAX_CONTEXT_FAILURES) {
      this.contextValid = false;
    }
  };
}

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Failed to create shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${info ?? "unknown error"}`);
  }
  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vs = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) {
    throw new Error("Failed to create program");
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed: ${info ?? "unknown error"}`);
  }
  return program;
}

function computeCursorSizePx(
  style: "block" | "underline" | "bar",
  metrics: CellMetrics,
  dpr: number,
): { width: number; height: number; offsetX: number; offsetY: number } {
  const cellWidth = metrics.width * dpr;
  const cellHeight = metrics.height * dpr;
  switch (style) {
    case "underline": {
      const height = Math.max(2 * dpr, metrics.height * 0.15 * dpr);
      return { width: cellWidth, height, offsetX: 0, offsetY: cellHeight - height };
    }
    case "bar": {
      const width = Math.max(2 * dpr, metrics.width * 0.15 * dpr);
      return { width, height: cellHeight, offsetX: 0, offsetY: 0 };
    }
    case "block":
    default:
      return { width: cellWidth, height: cellHeight, offsetX: 0, offsetY: 0 };
  }
}
