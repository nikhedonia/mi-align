import { matOfAffine } from '../lib/affine';
import type { Affine, Limits } from '../lib/config';
import type { Img } from '../lib/image';
import type { SampleSet } from '../lib/sampling';
import { EVAL_WGSL, UNIFORM_FLOATS } from './evalShader';
import { uploadTexture } from './device';

export interface EvalRow {
  score: number;
  ncc: number;
  overlap: number;
  meanA: number;
  meanB: number;
}

export const ROW_STRIDE = 8;
const DEFAULT_CHUNK = 8192;

/**
 * Scores batches of candidate affine transforms against a fixed image B and a
 * fixed set of source samples taken from image A.
 */
export class Aligner {
  private pipeline: GPUComputePipeline;
  private bindGroup: GPUBindGroup;
  private uniformData = new Float32Array(UNIFORM_FLOATS);
  private uniformBuf: GPUBuffer;
  private candBuf: GPUBuffer;
  private outBuf: GPUBuffer;
  private readBuf: GPUBuffer;
  private candScratch: Float32Array;
  private posBuf: GPUBuffer;
  private lumaBuf: GPUBuffer;
  private texture: GPUTexture;
  private sampler: GPUSampler;
  readonly sampleCount: number;
  readonly chunk: number;
  readonly imageB: Img;
  private disposed = false;
  private inFlight = 0;

  constructor(
    private device: GPUDevice,
    imgB: Img,
    samples: SampleSet,
    limits: Limits,
    chunk = DEFAULT_CHUNK,
  ) {
    this.imageB = imgB;
    this.sampleCount = samples.count;
    this.chunk = Math.max(64, Math.min(chunk, 32768));

    if (samples.count === 0) throw new Error('Sample set is empty');

    this.texture = uploadTexture(device, imgB, 'image-B');
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const module = device.createShaderModule({ code: EVAL_WGSL, label: 'align-eval' });
    this.pipeline = device.createComputePipeline({
      label: 'align-eval',
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });

    const cap = this.chunk;
    this.uniformBuf = device.createBuffer({
      label: 'eval-uniforms',
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.candBuf = device.createBuffer({
      label: 'eval-candidates',
      size: cap * ROW_STRIDE * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.outBuf = device.createBuffer({
      label: 'eval-out',
      size: cap * ROW_STRIDE * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.readBuf = device.createBuffer({
      label: 'eval-readback',
      size: cap * ROW_STRIDE * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.candScratch = new Float32Array(cap * ROW_STRIDE);

    const padded = align4(samples.count * 2);
    this.posBuf = device.createBuffer({
      label: 'eval-sample-pos',
      size: padded * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    writeF32(device, this.posBuf, samples.positions);

    this.lumaBuf = device.createBuffer({
      label: 'eval-sample-luma',
      size: align4(samples.count) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    writeF32(device, this.lumaBuf, samples.luma);

    this.uniformData[4] = imgB.width;
    this.uniformData[5] = imgB.height;
    this.uniformData[6] = Math.max(imgB.width, imgB.height) / 2;
    this.uniformData[7] = limits.minOverlap;
    this.uniformData[8] = limits.overlapPenalty;
    writeF32(device, this.uniformBuf, this.uniformData);

    this.bindGroup = device.createBindGroup({
      label: 'eval-bind-group',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: this.texture.createView() },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: { buffer: this.candBuf } },
        { binding: 4, resource: { buffer: this.posBuf } },
        { binding: 5, resource: { buffer: this.lumaBuf } },
        { binding: 6, resource: { buffer: this.outBuf } },
      ],
    });
  }

  /** estimated sample-fetches for a run of `n` candidates */
  cost(n: number): number {
    return n * this.sampleCount;
  }

  /**
   * Evaluate `n` candidate transforms (packed as n*6 affine params).
   * Returns n*ROW_STRIDE floats.
   */
  async evaluate(params: Float32Array, n: number): Promise<Float32Array> {
    if (this.disposed) throw new Error('__cancelled');
    this.inFlight++;
    try {
      return await this.evaluateInner(params, n);
    } finally {
      this.inFlight--;
      if (this.disposed && this.inFlight === 0) this.destroyNow();
    }
  }

  private async evaluateInner(params: Float32Array, n: number): Promise<Float32Array> {
    const device = this.device;
    const out = new Float32Array(n * ROW_STRIDE);
    const cap = this.chunk;
    const u = new Uint32Array(this.uniformData.buffer);

    for (let start = 0; start < n; start += cap) {
      if (this.disposed) throw new Error('__cancelled');
      const m = Math.min(cap, n - start);
      // pack matrices
      for (let k = 0; k < m; k++) {
        const o = (start + k) * 6;
        const a: Affine = {
          tx: params[o],
          ty: params[o + 1],
          theta: params[o + 2],
          scale: params[o + 3],
          aspect: params[o + 4],
          shear: params[o + 5],
        };
        const mat = matOfAffine(a);
        const d = k * ROW_STRIDE;
        this.candScratch[d] = mat.m0;
        this.candScratch[d + 1] = mat.m1;
        this.candScratch[d + 2] = mat.m2;
        this.candScratch[d + 3] = mat.m3;
        this.candScratch[d + 4] = mat.tx;
        this.candScratch[d + 5] = mat.ty;
        this.candScratch[d + 6] = 0;
        this.candScratch[d + 7] = 0;
      }
      writeF32(device, this.candBuf, this.candScratch, 0, m * ROW_STRIDE * 4);

      u[0] = m;
      u[1] = this.sampleCount;
      writeF32(device, this.uniformBuf, this.uniformData);

      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass({ label: 'align-eval' });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.dispatchWorkgroups(m);
      pass.end();
      const bytes = m * ROW_STRIDE * 4;
      enc.copyBufferToBuffer(this.outBuf, 0, this.readBuf, 0, bytes);
      device.queue.submit([enc.finish()]);

      await this.readBuf.mapAsync(GPUMapMode.READ, 0, bytes);
      const view = new Float32Array(this.readBuf.getMappedRange(0, bytes));
      out.set(view, start * ROW_STRIDE);
      this.readBuf.unmap();

      // let the UI breathe between chunks
      await yieldToBrowser();
    }
    return out;
  }

  /** safe to call at any time: buffers are released once no evaluation is in flight */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.inFlight === 0) this.destroyNow();
  }

  private destroyNow(): void {
    this.texture.destroy();
    this.uniformBuf.destroy();
    this.candBuf.destroy();
    this.outBuf.destroy();
    this.readBuf.destroy();
    this.posBuf.destroy();
    this.lumaBuf.destroy();
  }
}

/** writeBuffer with an explicit ArrayBuffer view (avoids SharedArrayBuffer typing) */
function writeF32(device: GPUDevice, buffer: GPUBuffer, data: Float32Array, byteOffset = 0, byteLength?: number): void {
  const start = data.byteOffset + byteOffset;
  const len = byteLength ?? data.byteLength - byteOffset;
  device.queue.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, start, len);
}

function align4(n: number): number {
  return Math.ceil(n / 4) * 4;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
