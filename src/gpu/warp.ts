import type { Mat } from '../lib/affine';
import { invertMat } from '../lib/affine';

export const VIEW_MODES = [
  { id: 0, label: 'Blend' },
  { id: 1, label: 'Difference' },
  { id: 2, label: 'Checker' },
  { id: 3, label: 'A only' },
  { id: 4, label: 'B only' },
] as const;

export interface ViewOpts {
  mode: number;
  opacity: number;
  gain: number;
  checker: number;
}

export const DEFAULT_VIEW: ViewOpts = { mode: 0, opacity: 0.55, gain: 3.2, checker: 26 };

const WARP_WGSL = /* wgsl */ `
struct RU {
  inv0: vec4f, // m0, m1, tx, mode
  inv1: vec4f, // m2, m3, ty, checkerPx
  sA: vec4f,   // W, H, R, opacity
  sB: vec4f,   // W, H, R, gain
};

@group(0) @binding(0) var<uniform> R: RU;
@group(0) @binding(1) var texA: texture_2d<f32>;
@group(0) @binding(2) var texB: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let q = p[vi];
  var o: VOut;
  o.pos = vec4f(q, 0.0, 1.0);
  o.uv = vec2f((q.x + 1.0) * 0.5, 1.0 - (q.y + 1.0) * 0.5);
  return o;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let uv = in.uv;
  // canonical coords of this output pixel in B, then inverse-map into A
  let xb = (uv.x - 0.5) * R.sB.x / R.sB.z;
  let yb = (uv.y - 0.5) * R.sB.y / R.sB.z;
  let xa = R.inv0.x * xb + R.inv0.y * yb + R.inv0.z;
  let ya = R.inv1.x * xb + R.inv1.y * yb + R.inv1.z;
  let uva = vec2f(0.5 + xa * R.sA.z / R.sA.x, 0.5 + ya * R.sA.z / R.sA.y);

  let b = textureSample(texB, samp, uv);
  let a = textureSample(texA, samp, uva);
  let inside = uva.x >= 0.0 && uva.x <= 1.0 && uva.y >= 0.0 && uva.y <= 1.0;

  let mode = i32(R.inv0.w + 0.5);
  var col = b.rgb;

  if (mode == 0) {
    if (inside) {
      col = mix(b.rgb, a.rgb, R.sA.w);
    }
  } else if (mode == 1) {
    if (inside) {
      col = min(vec3f(1.0), abs(a.rgb - b.rgb) * R.sB.w);
      col = pow(col, vec3f(0.85));
    } else {
      col = b.rgb * 0.28;
    }
  } else if (mode == 2) {
    let px = uv * vec2f(R.sB.x, R.sB.y);
    let cell = i32(floor(px.x / R.inv1.w) + floor(px.y / R.inv1.w));
    let pick = (cell % 2) == 0;
    if (pick && inside) {
      col = a.rgb;
    } else if (pick) {
      col = b.rgb * 0.2;
    }
  } else if (mode == 3) {
    col = select(vec3f(0.05, 0.05, 0.06), a.rgb, inside);
  }

  return vec4f(col, 1.0);
}
`;

export class WarpRenderer {
  private pipeline: GPURenderPipeline;
  private uniformBuf: GPUBuffer;
  private uniformData = new Float32Array(16);
  private bindGroup: GPUBindGroup;
  private sampler: GPUSampler;
  private ctx: GPUCanvasContext | null = null;
  private configured = false;

  constructor(
    private device: GPUDevice,
    private canvas: HTMLCanvasElement,
    private format: GPUTextureFormat,
    texA: GPUTexture,
    texB: GPUTexture,
    sizeA: { width: number; height: number },
    sizeB: { width: number; height: number },
  ) {
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('Could not get a WebGPU canvas context');
    this.ctx = ctx;

    const module = device.createShaderModule({ code: WARP_WGSL, label: 'warp' });
    this.pipeline = device.createRenderPipeline({
      label: 'warp',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.uniformBuf = device.createBuffer({
      label: 'warp-uniforms',
      size: 16 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.uniformData[8] = sizeA.width;
    this.uniformData[9] = sizeA.height;
    this.uniformData[10] = Math.max(sizeA.width, sizeA.height) / 2;
    this.uniformData[12] = sizeB.width;
    this.uniformData[13] = sizeB.height;
    this.uniformData[14] = Math.max(sizeB.width, sizeB.height) / 2;
    device.queue.writeBuffer(this.uniformBuf, 0, this.uniformData);

    this.bindGroup = device.createBindGroup({
      label: 'warp-bind-group',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: texA.createView() },
        { binding: 2, resource: texB.createView() },
        { binding: 3, resource: this.sampler },
      ],
    });
  }

  resize(cssWidth: number, cssHeight: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.configured = false;
    }
    if (!this.configured && this.ctx) {
      this.ctx.configure({
        device: this.device,
        format: this.format,
        alphaMode: 'opaque',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      this.configured = true;
    }
  }

  dispose(): void {
    this.uniformBuf.destroy();
    this.ctx = null;
  }

  render(t: Mat, opts: ViewOpts): void {
    if (!this.ctx) return;
    const inv = invertMat(t);
    this.uniformData[0] = inv.m0;
    this.uniformData[1] = inv.m1;
    this.uniformData[2] = inv.tx;
    this.uniformData[3] = opts.mode;
    this.uniformData[4] = inv.m2;
    this.uniformData[5] = inv.m3;
    this.uniformData[6] = inv.ty;
    this.uniformData[7] = Math.max(2, opts.checker);
    this.uniformData[11] = opts.opacity;
    this.uniformData[15] = opts.gain;
    this.device.queue.writeBuffer(this.uniformBuf, 0, this.uniformData);

    const enc = this.device.createCommandEncoder({ label: 'warp' });
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.ctx.getCurrentTexture().createView(),
          clearValue: { r: 0.045, g: 0.05, b: 0.06, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }
}
