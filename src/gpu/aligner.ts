import { matOfAffine } from '../lib/affine';
import type { Affine, Limits } from '../lib/config';
import type { Img } from '../lib/image';
import type { SampleSet } from '../lib/sampling';
import { EVAL_WGSL, MEASURE_WGSL, UNIFORM_FLOATS } from './evalShader';
import { uploadTexture } from './device';

export interface Measure {
  /** mutual information, bits */
  mi: number;
  /** 2*MI / (H(A)+H(B)) */
  nmi: number;
  ha: number;
  hb: number;
  ncc: number;
  overlap: number;
  score: number;
  valid: number;
  /** 32x32 joint histogram, row = B bin, col = A bin (raw counts) */
  hist: Float32Array;
}

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
  readonly limits: Limits;
  private disposed = false;
  private inFlight = 0;
  private lost: string | null = null;
  private failed = false;
  private static readonly CHUNK_TIMEOUT_MS = 15000;
  private static readonly MEASURE_TIMEOUT_MS = 5000;
  private measurePipeline: GPUComputePipeline;
  private measureGroup: GPUBindGroup;
  private measureUniform: GPUBuffer;
  private measureOut: GPUBuffer;
  private measureHist: GPUBuffer;
  private measureRead: GPUBuffer;
  private measureChain: Promise<unknown> = Promise.resolve();

  constructor(
    private device: GPUDevice,
    imgB: Img,
    samples: SampleSet,
    limits: Limits,
    chunk = DEFAULT_CHUNK,
  ) {
    this.imageB = imgB;
    this.limits = limits;
    device.lost
      .then((info) => {
        this.lost = info.message || String(info.reason ?? 'device lost');
        this.failed = true;
      })
      .catch(() => {});

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

    // ---- single-transform measurement (MI) resources
    const mModule = device.createShaderModule({ code: MEASURE_WGSL, label: 'align-measure' });
    this.measurePipeline = device.createComputePipeline({
      label: 'align-measure',
      layout: 'auto',
      compute: { module: mModule, entryPoint: 'main' },
    });
    this.measureUniform = device.createBuffer({
      label: 'measure-uniforms',
      size: 20 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.measureOut = device.createBuffer({
      label: 'measure-out',
      size: 8 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.measureHist = device.createBuffer({
      label: 'measure-hist',
      size: 1024 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.measureRead = device.createBuffer({
      label: 'measure-read',
      size: 8 * 4 + 1024 * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.measureGroup = device.createBindGroup({
      label: 'measure-bind-group',
      layout: this.measurePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.measureUniform } },
        { binding: 1, resource: this.texture.createView() },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: { buffer: this.posBuf } },
        { binding: 4, resource: { buffer: this.lumaBuf } },
        { binding: 5, resource: { buffer: this.measureOut } },
        { binding: 6, resource: { buffer: this.measureHist } },
      ],
    });

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
    if (this.lost) throw new Error(`GPU device lost: ${this.lost}`);
    if (this.failed) throw new Error('GPU stopped responding earlier in this session — reload to recover');
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

      await this.readChunk(bytes);
      const view = new Float32Array(this.readBuf.getMappedRange(0, bytes));
      out.set(view, start * ROW_STRIDE);
      this.readBuf.unmap();

      // let the UI breathe between chunks
      await yieldToBrowser();
    }
    return out;
  }

  /**
   * mapAsync with a watchdog: a lost or wedged device must never leave the UI
   * waiting forever on a readback.
   */
  private async readChunk(bytes: number): Promise<void> {
    const map = this.readBuf.mapAsync(GPUMapMode.READ, 0, bytes);
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error('__timeout')), Aligner.CHUNK_TIMEOUT_MS);
    });
    try {
      await Promise.race([map, timeout]);
    } catch (e) {
      if (e instanceof Error && e.message === '__timeout') {
        this.failed = true;
        // the map may still resolve later; make sure the buffer can be reused
        map.then(() => {
          try {
            this.readBuf.unmap();
          } catch {
            /* ignore */
          }
        }, () => {});
        throw new Error(
          'the GPU did not answer within 15s — it may have been reset (TDR) or be wedged. ' +
            'Reduce candidates or samples, or reload the page.',
        );
      }
      throw e;
    } finally {
      window.clearTimeout(timer);
    }
  }

  /**
   * Measure a single transform: NCC, score and mutual information plus the
   * joint intensity histogram. Serialised internally, so it is safe to call
   * on every pointer move.
   */
  measure(a: Affine): Promise<Measure> {
    const run = () => this.measureInner(a);
    const p = this.measureChain.then(run, run);
    this.measureChain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  private async measureInner(a: Affine): Promise<Measure> {
    if (this.disposed) throw new Error('__cancelled');
    const device = this.device;
    const u = new Float32Array(20);
    const u32 = new Uint32Array(u.buffer);
    u32[0] = this.sampleCount;
    u32[1] = 32;
    u[4] = this.imageB.width;
    u[5] = this.imageB.height;
    u[6] = Math.max(this.imageB.width, this.imageB.height) / 2;
    u[7] = this.limits.minOverlap;
    u[8] = this.limits.overlapPenalty;
    const mat = matOfAffine(a);
    u[12] = mat.m0;
    u[13] = mat.m1;
    u[14] = mat.m2;
    u[15] = mat.m3;
    u[16] = mat.tx;
    u[17] = mat.ty;
    writeF32(device, this.measureUniform, u);

    const enc = device.createCommandEncoder({ label: 'measure' });
    const pass = enc.beginComputePass();
    pass.setPipeline(this.measurePipeline);
    pass.setBindGroup(0, this.measureGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(this.measureOut, 0, this.measureRead, 0, 8 * 4);
    enc.copyBufferToBuffer(this.measureHist, 0, this.measureRead, 8 * 4, 1024 * 4);
    device.queue.submit([enc.finish()]);

    const bytes = 8 * 4 + 1024 * 4;
    if (this.lost) throw new Error(`GPU device lost: ${this.lost}`);
    const map = this.measureRead.mapAsync(GPUMapMode.READ, 0, bytes);
    let mt = 0;
    const mto = new Promise<never>((_, reject) => {
      mt = window.setTimeout(() => reject(new Error('__timeout')), Aligner.MEASURE_TIMEOUT_MS);
    });
    try {
      await Promise.race([map, mto]);
    } catch (e) {
      if (e instanceof Error && e.message === '__timeout') {
        map.then(() => {
          try {
            this.measureRead.unmap();
          } catch {
            /* ignore */
          }
        }, () => {});
        throw new Error('GPU measurement timed out');
      }
      throw e;
    } finally {
      window.clearTimeout(mt);
    }
    const view = new Float32Array(this.measureRead.getMappedRange(0, bytes));
    const out = view.slice(0, 8);
    const hist = view.slice(8, 8 + 1024);
    this.measureRead.unmap();
    return {
      mi: out[0],
      nmi: out[1],
      ha: out[2],
      hb: out[3],
      ncc: out[4],
      overlap: out[5],
      score: out[6],
      valid: out[7],
      hist,
    };
  }

  /** safe to call at any time: buffers are released once no evaluation is in flight */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.inFlight === 0) this.destroyNow();
  }

  private destroyNow(): void {
    this.measureUniform.destroy();
    this.measureOut.destroy();
    this.measureHist.destroy();
    this.measureRead.destroy();
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
