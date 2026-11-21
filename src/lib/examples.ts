import type { Affine, DofKey } from './config';
import { IDENTITY } from './config';
import { matOfAffine } from './affine';
import type { Img } from './image';
import { imgFromCanvas } from './image';
import { clamp01, fbm, hash2, makeRng, mix } from './rng';

export interface Example {
  id: string;
  label: string;
  blurb: string;
  /** the transform that produced B from A */
  truth: Affine;
  /** DOFs worth enabling so that the true transform is reachable */
  suggest?: Partial<Record<DofKey, boolean>>;
  build: () => { a: HTMLCanvasElement; b: HTMLCanvasElement };
}

const S = 512;

function newCanvas(w = S, h = S): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return [c, ctx];
}

/* ------------------------------------------------------------------ */
/* generators                                                          */
/* ------------------------------------------------------------------ */

function buildTerrain(seed: number): HTMLCanvasElement {
  const [canvas, ctx] = newCanvas();
  const RAMP: [number, number, number][] = [
    [12, 26, 48],
    [22, 62, 83],
    [30, 106, 96],
    [96, 148, 92],
    [190, 178, 116],
    [232, 226, 206],
    [255, 255, 255],
  ];
  const height = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x / S) * 3.1;
      const v = (y / S) * 3.1;
      const base = fbm(u + 3.7, v + 1.3, seed, 6, 2.05, 0.52);
      const ridged = Math.pow(1 - Math.abs(fbm(u * 1.7 + 11, v * 1.7 + 5, seed + 77, 4) * 2 - 1), 2.2);
      height[y * S + x] = clamp01(base * 0.72 + ridged * 0.36);
    }
  }
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const hh = height[i];
      // hillshade from the height field
      const hl = height[y * S + Math.max(0, x - 1)];
      const hr = height[y * S + Math.min(S - 1, x + 1)];
      const hu = height[Math.max(0, y - 1) * S + x];
      const hd = height[Math.min(S - 1, y + 1) * S + x];
      const shade = clamp01(0.55 + (hl - hr) * 7.5 + (hu - hd) * 7.5);
      // colour ramp
      const t = clamp01(hh * 1.08 - 0.04) * (RAMP.length - 1);
      const i0 = Math.min(RAMP.length - 1, Math.floor(t));
      const i1 = Math.min(RAMP.length - 1, i0 + 1);
      const f = t - i0;
      let r = mix(RAMP[i0][0], RAMP[i1][0], f);
      let g = mix(RAMP[i0][1], RAMP[i1][1], f);
      let b = mix(RAMP[i0][2], RAMP[i1][2], f);
      const k = 0.42 + 0.9 * shade;
      r *= k;
      g *= k;
      b *= k;
      // contour lines
      const band = Math.abs(((hh * 16) % 1) - 0.5);
      if (band < 0.035) {
        r *= 0.78;
        g *= 0.78;
        b *= 0.82;
      }
      const o = i * 4;
      img.data[o] = Math.max(0, Math.min(255, r));
      img.data[o + 1] = Math.max(0, Math.min(255, g));
      img.data[o + 2] = Math.max(0, Math.min(255, b));
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function buildShapes(seed: number): HTMLCanvasElement {
  const [canvas, ctx] = newCanvas();
  const rng = makeRng(seed);
  ctx.fillStyle = '#111722';
  ctx.fillRect(0, 0, S, S);
  // subtle paper texture
  const tex = ctx.getImageData(0, 0, S, S);
  for (let i = 0; i < tex.data.length; i += 4) {
    const n = (rng() - 0.5) * 12;
    tex.data[i] += n;
    tex.data[i + 1] += n;
    tex.data[i + 2] += n;
  }
  ctx.putImageData(tex, 0, 0);

  const palette = ['#f2f5f7', '#6ea8fe', '#f5a97f', '#a6da95', '#c6a0f6', '#eed49f', '#ed8796'];
  for (let i = 0; i < 46; i++) {
    ctx.save();
    const x = rng() * S;
    const y = rng() * S;
    const rot = rng() * Math.PI * 2;
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.fillStyle = palette[Math.floor(rng() * palette.length)];
    ctx.globalAlpha = 0.55 + rng() * 0.45;
    const kind = Math.floor(rng() * 4);
    if (kind === 0) {
      const w = 12 + rng() * 70;
      const h = 12 + rng() * 70;
      ctx.fillRect(-w / 2, -h / 2, w, h);
    } else if (kind === 1) {
      ctx.beginPath();
      ctx.arc(0, 0, 8 + rng() * 34, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 2) {
      ctx.lineWidth = 3 + rng() * 7;
      ctx.strokeStyle = palette[Math.floor(rng() * palette.length)];
      ctx.beginPath();
      ctx.moveTo(-40 + rng() * 80, -40 + rng() * 80);
      ctx.lineTo(-40 + rng() * 80, -40 + rng() * 80);
      ctx.stroke();
    } else {
      ctx.beginPath();
      const n = 3 + Math.floor(rng() * 4);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const r = 16 + rng() * 30;
        if (k === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  // a few tiny high-frequency landmarks: corners are great for alignment
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 60; i++) {
    const x = 20 + rng() * (S - 40);
    const y = 20 + rng() * (S - 40);
    ctx.fillRect(x, y, 3, 3);
  }
  return canvas;
}

function buildLandmarks(seed: number): HTMLCanvasElement {
  const [canvas, ctx] = newCanvas();
  const rng = makeRng(seed);
  const g = ctx.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, '#1b2430');
  g.addColorStop(1, '#2b3a46');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  // faint grid
  ctx.strokeStyle = 'rgba(140,170,190,0.16)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 16; i++) {
    const p = (i / 16) * S;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, S);
    ctx.moveTo(0, p);
    ctx.lineTo(S, p);
    ctx.stroke();
  }

  // unique markers: each one is a different little glyph
  for (let i = 0; i < 90; i++) {
    const x = 18 + rng() * (S - 36);
    const y = 18 + rng() * (S - 36);
    const a = rng() * Math.PI * 2;
    const hue = Math.floor(rng() * 360);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.strokeStyle = `hsl(${hue} 80% 72%)`;
    ctx.fillStyle = `hsl(${hue} 80% 62%)`;
    ctx.lineWidth = 2 + rng() * 2.5;
    const kind = Math.floor(rng() * 5);
    const r = 6 + rng() * 14;
    ctx.beginPath();
    if (kind === 0) {
      ctx.moveTo(-r, 0);
      ctx.lineTo(r, 0);
      ctx.moveTo(0, -r);
      ctx.lineTo(0, r);
      ctx.stroke();
    } else if (kind === 1) {
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    } else if (kind === 2) {
      ctx.arc(0, 0, r, 0, Math.PI * 1.15);
      ctx.stroke();
    } else if (kind === 3) {
      ctx.fillRect(-r, -r / 3, r * 2, r * 0.66);
    } else {
      ctx.moveTo(-r, r);
      ctx.lineTo(0, -r);
      ctx.lineTo(r, r);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }
  // big low-frequency blobs for coarse structure
  for (let i = 0; i < 6; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const r = 60 + rng() * 90;
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    const hue = Math.floor(rng() * 360);
    rg.addColorStop(0, `hsla(${hue} 60% 60% / 0.5)`);
    rg.addColorStop(1, `hsla(${hue} 60% 40% / 0)`);
    ctx.fillStyle = rg;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return canvas;
}

/* ------------------------------------------------------------------ */
/* B = warp(A) + photometric drift                                     */
/* ------------------------------------------------------------------ */

function meanColor(data: ImageData): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < data.data.length; i += 4 * 37) {
    r += data.data[i];
    g += data.data[i + 1];
    b += data.data[i + 2];
    n++;
  }
  return [r / n, g / n, b / n];
}

/**
 * Produce image B by applying `t` to image A (in the same canonical
 * convention the search uses) and then adding a mild photometric change
 * and sensor noise, so the correlation is not trivially perfect.
 */
export function warpToMakePair(src: HTMLCanvasElement, t: Affine, seed: number): HTMLCanvasElement {
  const W = src.width;
  const H = src.height;
  const R = Math.max(W, H) / 2;
  const m = matOfAffine(t);
  const [out, ctx] = newCanvas(W, H);
  const srcData = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H);
  const [mr, mg, mb] = meanColor(srcData);
  ctx.fillStyle = `rgb(${mr | 0},${mg | 0},${mb | 0})`;
  ctx.fillRect(0, 0, W, H);

  const e = -m.m0 * (W / 2) - m.m1 * (H / 2) + R * m.tx + W / 2;
  const f = -m.m2 * (W / 2) - m.m3 * (H / 2) + R * m.ty + H / 2;
  ctx.save();
  ctx.setTransform(m.m0, m.m2, m.m1, m.m3, e, f);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0);
  ctx.restore();

  // photometric drift + noise
  const rng = makeRng(seed * 7919 + 13);
  const img = ctx.getImageData(0, 0, W, H);
  const gamma = 0.94;
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.pow(v / 255, gamma) * 255 * 1.02 + 4;
  }
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rng() - 0.5) * 7;
    img.data[i] = Math.max(0, Math.min(255, (lut[img.data[i]] + n) | 0));
    img.data[i + 1] = Math.max(0, Math.min(255, (lut[img.data[i + 1]] + n) | 0));
    img.data[i + 2] = Math.max(0, Math.min(255, (lut[img.data[i + 2]] + n) | 0));
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/* ------------------------------------------------------------------ */
/* catalogue                                                           */
/* ------------------------------------------------------------------ */

const DEG = Math.PI / 180;

interface Spec {
  id: string;
  label: string;
  blurb: string;
  truth: Affine;
  suggest?: Partial<Record<DofKey, boolean>>;
  make: (seed: number) => HTMLCanvasElement;
  seed: number;
}

const SPECS: Spec[] = [
  {
    id: 'terrain',
    label: 'Terrain',
    blurb: 'Fractal ridges with contours — smooth, wide correlation basin.',
    truth: { tx: 0.083, ty: -0.061, theta: 5.5 * DEG, scale: 1.035, aspect: 1, shear: 0 },
    make: buildTerrain,
    seed: 3,
  },
  {
    id: 'shapes',
    label: 'Shapes',
    blurb: 'Hard-edged polygons and dots — sharp, narrow optimum.',
    truth: { tx: -0.114, ty: 0.072, theta: -7.5 * DEG, scale: 0.968, aspect: 1, shear: 0 },
    make: buildShapes,
    seed: 11,
  },
  {
    id: 'landmarks',
    label: 'Landmarks',
    blurb: 'Repeated glyphs on a grid — lots of competing local optima.',
    truth: { tx: 0.052, ty: 0.049, theta: 2.5 * DEG, scale: 1.014, aspect: 1, shear: 0 },
    make: buildLandmarks,
    seed: 5,
  },
  {
    id: 'shear',
    label: 'Shear test',
    blurb: 'Aspect + shear are non-zero: needs the full 6-DOF space.',
    truth: { tx: 0.041, ty: -0.033, theta: -4 * DEG, scale: 1.028, aspect: 1.03, shear: 0.045 },
    suggest: { aspect: true, shear: true },
    make: buildTerrain,
    seed: 19,
  },
];

export const EXAMPLES: Example[] = SPECS.map((s) => ({
  id: s.id,
  label: s.label,
  blurb: s.blurb,
  truth: s.truth,
  suggest: s.suggest,
  build: () => {
    const a = s.make(s.seed);
    const b = warpToMakePair(a, s.truth, s.seed);
    return { a, b };
  },
}));

export function buildExample(ex: Example): { a: Img; b: Img } {
  const { a, b } = ex.build();
  return {
    a: imgFromCanvas(a, `${ex.id}-A`, `ex-${ex.id}-a`),
    b: imgFromCanvas(b, `${ex.id}-B`, `ex-${ex.id}-b`),
  };
}

export const TRUTH_OF: Record<string, Affine> = Object.fromEntries(
  EXAMPLES.map((e) => [e.id, e.truth]),
);

export { IDENTITY, hash2 };
