// The engine canvas over the slides.
//
// The engine paints the page's background first, opaque (Renderer.cpp clears with alpha 1), and
// draws its overlays (selection, handles, size badges, smart guides, spacing, marquee, safe-area
// bands) over it. The editor's page is black and the layer nodes paint nothing, so after a frame
// every pixel is an overlay composited over black: its colour is the overlay's premultiplied
// colour. This pass, run right after each engine render on the same WebGL2 context, turns that
// into a transparent canvas: alpha = the brightest channel (exact for the engine's overlay
// colours, which all have one channel at full strength; dark overlay pixels come out see-through),
// and the engine's selection blue becomes the app's accent. The slides (HTML, under the canvas)
// show through everywhere else.
//
// The engine caches GL state between draws (gfx/gl/GLDevice.cpp: reset at every pass start), so
// everything touched here is put back as it was.

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D frame;
uniform vec3 accent;
uniform vec3 selection;
out vec4 color;
void main() {
  vec4 c = texelFetch(frame, ivec2(gl_FragCoord.xy), 0);
  float a = max(c.r, max(c.g, c.b));
  if (a <= 0.0) { color = vec4(0.0); return; }
  // The overlay's own colour, at full strength, compared with the selection colour's.
  vec3 hue = c.rgb / a;
  vec3 sel = selection / max(selection.r, max(selection.g, selection.b));
  if (distance(hue, sel) < 0.16) {
    float alpha = min(1.0, a / max(selection.r, max(selection.g, selection.b)));
    color = vec4(accent * alpha, alpha);
    return;
  }
  color = vec4(c.rgb, a);
}`;

type GL = WebGL2RenderingContext;

function compile(gl: GL, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("[post-editor] alpha pass:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function hexToRgb(hex: string): [number, number, number] {
  const v = hex.trim().replace(/^#/, "");
  const full =
    v.length === 3
      ? v
          .split("")
          .map((c) => c + c)
          .join("")
      : v.slice(0, 6);
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n)) return [1, 0.4, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The engine's selection colour in its dark theme (ChromePalette: Selection, dark). */
export const ENGINE_SELECTION = "#0c8ce9";

export class AlphaPass {
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private texture: WebGLTexture | null = null;
  private size = { w: 0, h: 0 };
  private uniforms: {
    frame: WebGLUniformLocation | null;
    accent: WebGLUniformLocation | null;
    selection: WebGLUniformLocation | null;
  } | null = null;
  private accent: [number, number, number] = [0.97, 0.45, 0.09];
  private selection = hexToRgb(ENGINE_SELECTION);
  readonly ok: boolean;

  constructor(private readonly gl: GL) {
    this.ok = this.init();
  }

  /** The canvas's context, as the engine made it (null: not WebGL2 — no pass possible). */
  static forCanvas(canvas: HTMLCanvasElement): AlphaPass | null {
    const gl = canvas.getContext("webgl2") as GL | null;
    if (!gl) return null;
    const pass = new AlphaPass(gl);
    return pass.ok ? pass : null;
  }

  setAccent(hex: string): void {
    this.accent = hexToRgb(hex);
  }

  private init(): boolean {
    const gl = this.gl;
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vs || !fs) return false;
    const program = gl.createProgram();
    if (!program) return false;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn("[post-editor] alpha pass:", gl.getProgramInfoLog(program));
      return false;
    }
    this.program = program;
    this.uniforms = {
      frame: gl.getUniformLocation(program, "frame"),
      accent: gl.getUniformLocation(program, "accent"),
      selection: gl.getUniformLocation(program, "selection"),
    };
    const savedVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(savedVao);
    return true;
  }

  /** Turns the frame the engine just drew into its transparent version. */
  run(): void {
    const gl = this.gl;
    if (!this.program || !this.vao || gl.isContextLost()) return;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    if (w <= 0 || h <= 0) return;

    // Save what the engine may count on.
    const saved = {
      program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
      vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null,
      active: gl.getParameter(gl.ACTIVE_TEXTURE) as number,
      drawFb: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
      readFb: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
      viewport: gl.getParameter(gl.VIEWPORT) as Int32Array,
      blend: gl.isEnabled(gl.BLEND),
      scissor: gl.isEnabled(gl.SCISSOR_TEST),
      stencil: gl.isEnabled(gl.STENCIL_TEST),
      mask: gl.getParameter(gl.COLOR_WRITEMASK) as boolean[],
      unpackBuffer: gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING) as WebGLBuffer | null,
    };
    gl.activeTexture(gl.TEXTURE0);
    const savedTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;

    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      if (!this.texture) this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      if (this.size.w !== w || this.size.h !== h) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.size = { w, h };
      }
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.colorMask(true, true, true, true);
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.uniform1i(this.uniforms?.frame ?? null, 0);
      gl.uniform3f(this.uniforms?.accent ?? null, ...this.accent);
      gl.uniform3f(this.uniforms?.selection ?? null, ...this.selection);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } finally {
      gl.bindTexture(gl.TEXTURE_2D, savedTexture);
      gl.activeTexture(saved.active);
      gl.useProgram(saved.program);
      gl.bindVertexArray(saved.vao);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, saved.drawFb);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, saved.readFb);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, saved.unpackBuffer);
      gl.viewport(
        saved.viewport[0] ?? 0,
        saved.viewport[1] ?? 0,
        saved.viewport[2] ?? w,
        saved.viewport[3] ?? h,
      );
      if (saved.blend) gl.enable(gl.BLEND);
      if (saved.scissor) gl.enable(gl.SCISSOR_TEST);
      if (saved.stencil) gl.enable(gl.STENCIL_TEST);
      gl.colorMask(
        saved.mask[0] ?? true,
        saved.mask[1] ?? true,
        saved.mask[2] ?? true,
        saved.mask[3] ?? true,
      );
    }
  }

  dispose(): void {
    const gl = this.gl;
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.texture = null;
    this.vao = null;
    this.program = null;
  }
}
