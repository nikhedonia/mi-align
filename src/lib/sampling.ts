import type { SamplingConfig } from './config';
import type { Img } from './image';
import { canonicalRadius } from './affine';
import { clamp01, makeRng } from './rng';

export interface SampleSet {
  /** canonical A coordinates, interleaved [x0,y0,x1,y1,...] */
  positions: Float32Array;
  /** grayscale value of image A at each sample, in [0,1] */
  luma: Float32Array;
  count: number;
  mode: SamplingConfig['mode'] | 'all';
  /** true when "all pixels" had to be capped */
  capped: boolean;
}

const ALL_PIXELS_CAP = 262144;

function lumaAt(d: ImageData, x: number, y: number): number {
  const w = d.width;
  const h = d.height;
  const px = x - 0.5;
  const py = y - 0.5;
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const fx = px - x0;
  const fy = py - y0;
  const cx0 = Math.min(w - 1, Math.max(0, x0));
  const cx1 = Math.min(w - 1, Math.max(0, x0 + 1));
  const cy0 = Math.min(h - 1, Math.max(0, y0));
  const cy1 = Math.min(h - 1, Math.max(0, y0 + 1));
  const src = d.data;
  const i00 = (cy0 * w + cx0) * 4;
  const i10 = (cy0 * w + cx1) * 4;
  const i01 = (cy1 * w + cx0) * 4;
  const i11 = (cy1 * w + cx1) * 4;
  const l00 = (src[i00] * 0.299 + src[i00 + 1] * 0.587 + src[i00 + 2] * 0.114) / 255;
  const l10 = (src[i10] * 0.299 + src[i10 + 1] * 0.587 + src[i10 + 2] * 0.114) / 255;
  const l01 = (src[i01] * 0.299 + src[i01 + 1] * 0.587 + src[i01 + 2] * 0.114) / 255;
  const l11 = (src[i11] * 0.299 + src[i11 + 1] * 0.587 + src[i11 + 2] * 0.114) / 255;
  const top = l00 + (l10 - l00) * fx;
  const bot = l01 + (l11 - l01) * fx;
  return top + (bot - top) * fy;
}

function lumaField(d: ImageData): Float32Array {
  const n = d.width * d.height;
  const out = new Float32Array(n);
  const src = d.data;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = (src[o] * 0.299 + src[o + 1] * 0.587 + src[o + 2] * 0.114) / 255;
  }
  return out;
}

/**
 * Build the fixed set of source pixels used to score every candidate
 * transform. Sampling is the main knob for the cost of the search:
 * cost ≈ candidates × samples.
 */
export function buildSamples(img: Img, cfg: SamplingConfig): SampleSet {
  const w = img.width;
  const h = img.height;
  const R = canonicalRadius(w, h);
  const toCanonX = (u: number) => (u - 0.5) * (w / R);
  const toCanonY = (v: number) => (v - 0.5) * (h / R);

  // ---------------------------------------------------------------- all pixels
  if (!cfg.enabled) {
    const total = w * h;
    const n = Math.min(total, ALL_PIXELS_CAP);
    const positions = new Float32Array(n * 2);
    const luma = new Float32Array(n);
    const field = lumaField(img.data);
    const stride = Math.max(1, Math.floor(Math.sqrt(total / n)));
    let k = 0;
    outer: for (let y = 0; y < h; y += stride) {
      for (let x = 0; x < w; x += stride) {
        if (k >= n) break outer;
        positions[k * 2] = toCanonX((x + 0.5) / w);
        positions[k * 2 + 1] = toCanonY((y + 0.5) / h);
        luma[k] = field[y * w + x];
        k++;
      }
    }
    return {
      positions: positions.subarray(0, k * 2).slice(),
      luma: luma.subarray(0, k).slice(),
      count: k,
      mode: 'all',
      capped: n < total,
    };
  }

  const count = Math.max(32, Math.round(cfg.count));
  const rng = makeRng(cfg.seed || 1);

  // ---------------------------------------------------------------- gradient
  if (cfg.mode === 'gradient') {
    const field = lumaField(img.data);
    const weight = new Float32Array(w * h);
    let maxW = 1e-6;
    const gx = (x: number, y: number) => field[y * w + Math.min(w - 1, x + 1)] - field[y * w + Math.max(0, x - 1)];
    const gy = (x: number, y: number) => field[Math.min(h - 1, y + 1) * w + x] - field[Math.max(0, y - 1) * w + x];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const m = Math.hypot(gx(x, y), gy(x, y)) + 0.02;
        weight[y * w + x] = m;
        if (m > maxW) maxW = m;
      }
    }
    const positions = new Float32Array(count * 2);
    const luma = new Float32Array(count);
    let k = 0;
    let guard = 0;
    while (k < count && guard < count * 200) {
      guard++;
      const i = Math.floor(rng() * w * h);
      if (rng() * maxW > weight[i]) continue;
      const x = i % w;
      const y = (i - x) / w;
      positions[k * 2] = toCanonX((x + 0.5) / w);
      positions[k * 2 + 1] = toCanonY((y + 0.5) / h);
      luma[k] = field[i];
      k++;
    }
    return {
      positions: positions.subarray(0, k * 2).slice(),
      luma: luma.subarray(0, k).slice(),
      count: k,
      mode: 'gradient',
      capped: false,
    };
  }

  // ---------------------------------------------------------------- random
  if (cfg.mode === 'random') {
    const positions = new Float32Array(count * 2);
    const luma = new Float32Array(count);
    for (let k = 0; k < count; k++) {
      const u = rng();
      const v = rng();
      positions[k * 2] = toCanonX(u);
      positions[k * 2 + 1] = toCanonY(v);
      luma[k] = lumaAt(img.data, u * w, v * h);
    }
    return { positions, luma, count, mode: 'random', capped: false };
  }

  // ---------------------------------------------------------------- stratified grid
  // jittered stratified grid: even coverage, no aliasing with image structure
  const aspect = w / h;
  let cols = Math.max(1, Math.round(Math.sqrt(count * aspect)));
  cols = Math.min(cols, count);
  const rows = Math.max(1, Math.ceil(count / cols));
  const positions = new Float32Array(count * 2);
  const luma = new Float32Array(count);
  let k = 0;
  for (let r = 0; r < rows && k < count; r++) {
    for (let c = 0; c < cols && k < count; c++) {
      const jx = (rng() - 0.5) * 0.7;
      const jy = (rng() - 0.5) * 0.7;
      const u = clamp01((c + 0.5 + jx) / cols);
      const v = clamp01((r + 0.5 + jy) / rows);
      positions[k * 2] = toCanonX(u);
      positions[k * 2 + 1] = toCanonY(v);
      luma[k] = lumaAt(img.data, u * w, v * h);
      k++;
    }
  }
  return {
    positions: positions.subarray(0, k * 2).slice(),
    luma: luma.subarray(0, k).slice(),
    count: k,
    mode: 'grid',
    capped: false,
  };
}
