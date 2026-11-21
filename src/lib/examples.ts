import type { Affine, DofConfig, DofKey } from './config';
import type { Img } from './image';
import { imgFromCanvas } from './image';
import { clamp01, fbm, makeRng, mix } from './rng';

/* ------------------------------------------------------------------ */
/* scenes are generated once and then "photographed" from two viewpoints */
/* ------------------------------------------------------------------ */

export type SceneKind = 'terrain' | 'shapes' | 'landmarks';

export interface ViewSpec {
  /** output size in pixels */
  w: number;
  h: number;
  /** horizontal extent of the view as a fraction of the scene */
  spanX: number;
  /** view centre in normalised scene coordinates */
  cx: number;
  cy: number;
  /** rotation of the sensor, radians */
  rot?: number;
  /** vertical squash (anisotropic sampling → aspect change) */
  squashY?: number;
  /** shear applied in scene space before scaling */
  shearX?: number;
}

export interface ExampleSpec {
  id: string;
  label: string;
  blurb: string;
  tag: string;
  kind: SceneKind;
  seed: number;
  a: ViewSpec;
  b: ViewSpec;
  /** suggested search space overrides */
  suggest?: Partial<Record<DofKey, Partial<DofConfig>>>;
}

interface M2 {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/* ------------------------------------------------------------------ */
/* scene painters (normalised so any resolution looks the same)        */
/* ------------------------------------------------------------------ */

function newCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return [c, ctx];
}

function paintTerrain(n: number, seed: number): HTMLCanvasElement {
  const [canvas, ctx] = newCanvas(n, n);
  const RAMP: [number, number, number][] = [
    [12, 26, 48],
    [22, 62, 83],
    [30, 106, 96],
    [96, 148, 92],
    [190, 178, 116],
    [232, 226, 206],
    [255, 255, 255],
  ];
  const height = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x / n) * 3.1;
      const v = (y / n) * 3.1;
      const base = fbm(u + 3.7, v + 1.3, seed, 6, 2.05, 0.52);
      const ridged = Math.pow(1 - Math.abs(fbm(u * 1.7 + 11, v * 1.7 + 5, seed + 77, 4) * 2 - 1), 2.2);
      height[y * n + x] = clamp01(base * 0.72 + ridged * 0.36);
    }
  }
  const img = ctx.createImageData(n, n);
  const shadeK = 7.5 * (512 / n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const hh = height[i];
      const hl = height[y * n + Math.max(0, x - 1)];
      const hr = height[y * n + Math.min(n - 1, x + 1)];
      const hu = height[Math.max(0, y - 1) * n + x];
      const hd = height[Math.min(n - 1, y + 1) * n + x];
      const shade = clamp01(0.55 + (hl - hr) * shadeK + (hu - hd) * shadeK);
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

function paintShapes(n: number, seed: number): HTMLCanvasElement {
  const [canvas, ctx] = newCanvas(n, n);
  const K = n / 512;
  const rng = makeRng(seed);
  ctx.fillStyle = '#111722';
  ctx.fillRect(0, 0, n, n);
  const tex = ctx.getImageData(0, 0, n, n);
  for (let i = 0; i < tex.data.length; i += 4) {
    const nn = (rng() - 0.5) * 12;
    tex.data[i] += nn;
    tex.data[i + 1] += nn;
    tex.data[i + 2] += nn;
  }
  ctx.putImageData(tex, 0, 0);

  const palette = ['#f2f5f7', '#6ea8fe', '#f5a97f', '#a6da95', '#c6a0f6', '#eed49f', '#ed8796'];
  for (let i = 0; i < 46; i++) {
    ctx.save();
    ctx.translate(rng() * n, rng() * n);
    ctx.rotate(rng() * Math.PI * 2);
    ctx.fillStyle = palette[Math.floor(rng() * palette.length)];
    ctx.globalAlpha = 0.55 + rng() * 0.45;
    const kind = Math.floor(rng() * 4);
    if (kind === 0) {
      const w = (12 + rng() * 70) * K;
      const h = (12 + rng() * 70) * K;
      ctx.fillRect(-w / 2, -h / 2, w, h);
    } else if (kind === 1) {
      ctx.beginPath();
      ctx.arc(0, 0, (8 + rng() * 34) * K, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 2) {
      ctx.lineWidth = (3 + rng() * 7) * K;
      ctx.strokeStyle = palette[Math.floor(rng() * palette.length)];
      ctx.beginPath();
      ctx.moveTo((-40 + rng() * 80) * K, (-40 + rng() * 80) * K);
      ctx.lineTo((-40 + rng() * 80) * K, (-40 + rng() * 80) * K);
      ctx.stroke();
    } else {
      ctx.beginPath();
      const sides = 3 + Math.floor(rng() * 4);
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2;
        const r = (16 + rng() * 30) * K;
        if (k === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 60; i++) {
    ctx.fillRect((20 + rng() * (n - 40)), (20 + rng() * (n - 40)), 3 * K, 3 * K);
  }
  return canvas;
}

function paintLandmarks(n: number, seed: number): HTMLCanvasElement {
  const [canvas, ctx] = newCanvas(n, n);
  const K = n / 512;
  const rng = makeRng(seed);
  const g = ctx.createLinearGradient(0, 0, n, n);
  g.addColorStop(0, '#1b2430');
  g.addColorStop(1, '#2b3a46');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, n, n);

  ctx.strokeStyle = 'rgba(140,170,190,0.16)';
  ctx.lineWidth = Math.max(1, K);
  for (let i = 0; i <= 16; i++) {
    const p = (i / 16) * n;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, n);
    ctx.moveTo(0, p);
    ctx.lineTo(n, p);
    ctx.stroke();
  }

  for (let i = 0; i < 90; i++) {
    const x = (18 + rng() * (n - 36)) | 0;
    const y = (18 + rng() * (n - 36)) | 0;
    const a = rng() * Math.PI * 2;
    const hue = Math.floor(rng() * 360);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.strokeStyle = `hsl(${hue} 80% 72%)`;
    ctx.fillStyle = `hsl(${hue} 80% 62%)`;
    ctx.lineWidth = (2 + rng() * 2.5) * K;
    const kind = Math.floor(rng() * 5);
    const r = (6 + rng() * 14) * K;
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
  for (let i = 0; i < 6; i++) {
    const x = rng() * n;
    const y = rng() * n;
    const r = (60 + rng() * 90) * K;
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    const hue = Math.floor(rng() * 360);
    rg.addColorStop(0, `hsla(${hue} 60% 60% / 0.5)`);
    rg.addColorStop(1, `hsla(${hue} 60% 40% / 0)`);
    ctx.fillStyle = rg;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return canvas;
}

export function paintScene(kind: SceneKind, n: number, seed: number): HTMLCanvasElement {
  if (kind === 'terrain') return paintTerrain(n, seed);
  if (kind === 'shapes') return paintShapes(n, seed);
  return paintLandmarks(n, seed);
}

/* ------------------------------------------------------------------ */
/* viewpoint maths                                                     */
/* ------------------------------------------------------------------ */

/** scene pixels -> output pixels for a view */
function viewMatrix(v: ViewSpec, sceneSize: number): M2 {
  const zx = v.w / (v.spanX * sceneSize);
  const zy = zx * (v.squashY ?? 1);
  const rot = v.rot ?? 0;
  const sh = v.shearX ?? 0;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  // M = R(rot) * Shear(sh) * diag(zx, zy)
  const a = cs * zx;
  const c = cs * sh * zy - sn * zy;
  const b = sn * zx;
  const d = sn * sh * zy + cs * zy;
  const cx = v.cx * sceneSize;
  const cy = v.cy * sceneSize;
  return { a, b, c, d, e: v.w / 2 - (a * cx + c * cy), f: v.h / 2 - (b * cx + d * cy) };
}

function invertM(m: M2): M2 {
  const det = m.a * m.d - m.c * m.b;
  const i = Math.abs(det) < 1e-12 ? 1e-12 : det;
  const a = m.d / i;
  const c = -m.c / i;
  const b = -m.b / i;
  const d = m.a / i;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}

function composeM(outer: M2, inner: M2): M2 {
  // outer(inner(p))
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

/**
 * Exact A→B affine parameters implied by two viewpoints on the same scene.
 * `T` maps A pixels to B pixels; convert to the canonical (centre + R)
 * convention and decompose M = R(theta) * Shear(sh) * Scale(sx, sy).
 */
export function deriveTruth(A: ViewSpec, B: ViewSpec, sceneSize: number): Affine {
  const mA = viewMatrix(A, sceneSize);
  const mB = viewMatrix(B, sceneSize);
  const T = composeM(mB, invertM(mA));
  const RA = Math.max(A.w, A.h) / 2;
  const RB = Math.max(B.w, B.h) / 2;

  // linear part in canonical units
  const k = RA / RB;
  const m0 = T.a * k;
  const m1 = T.c * k;
  const m2 = T.b * k;
  const m3 = T.d * k;

  // translation: T maps the A centre to some point; canonicalise
  const cxA = A.w / 2;
  const cyA = A.h / 2;
  const px = T.a * cxA + T.c * cyA + T.e;
  const py = T.b * cxA + T.d * cyA + T.f;
  const tx = (px - B.w / 2) / RB;
  const ty = (py - B.h / 2) / RB;

  // decompose
  const theta = Math.atan2(m2, m0);
  const cs = Math.cos(-theta);
  const sn = Math.sin(-theta);
  const n00 = cs * m0 - sn * m2;
  const n01 = cs * m1 - sn * m3;
  const n11 = sn * m1 + cs * m3;
  const sx = n00;
  const sy = n11;
  const scale = Math.sqrt(Math.abs(sx * sy));
  const aspect = Math.sqrt(Math.abs(sx / sy));
  const shear = sy === 0 ? 0 : n01 / sy;
  return { tx, ty, theta, scale, aspect, shear };
}

function renderView(
  scene: HTMLCanvasElement,
  sceneSize: number,
  v: ViewSpec,
  bg: string,
  opts: { gamma?: number; noise?: number; seed?: number } = {},
): HTMLCanvasElement {
  const [out, ctx] = newCanvas(Math.round(v.w), Math.round(v.h));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, out.width, out.height);
  const m = viewMatrix(v, sceneSize);
  ctx.save();
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(scene, 0, 0);
  ctx.restore();

  if (opts.gamma !== undefined || opts.noise) {
    const img = ctx.getImageData(0, 0, out.width, out.height);
    const gamma = opts.gamma ?? 1;
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) lut[i] = Math.pow(i / 255, gamma) * 255 * 1.02 + 4;
    const rng = makeRng((opts.seed ?? 1) * 7919 + 13);
    const noise = opts.noise ?? 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const nn = (rng() - 0.5) * noise;
      img.data[i] = Math.max(0, Math.min(255, (lut[img.data[i]] + nn) | 0));
      img.data[i + 1] = Math.max(0, Math.min(255, (lut[img.data[i + 1]] + nn) | 0));
      img.data[i + 2] = Math.max(0, Math.min(255, (lut[img.data[i + 2]] + nn) | 0));
    }
    ctx.putImageData(img, 0, 0);
  }
  return out;
}

function meanCss(scene: HTMLCanvasElement): string {
  const ctx = scene.getContext('2d', { willReadFrequently: true })!;
  const d = ctx.getImageData(0, 0, Math.min(64, scene.width), Math.min(64, scene.height));
  let r = 0;
  let g = 0;
  let b = 0;
  let c = 0;
  for (let i = 0; i < d.data.length; i += 4) {
    r += d.data[i];
    g += d.data[i + 1];
    b += d.data[i + 2];
    c++;
  }
  return `rgb(${(r / c) | 0},${(g / c) | 0},${(b / c) | 0})`;
}

/* ------------------------------------------------------------------ */
/* catalogue                                                           */
/* ------------------------------------------------------------------ */

const DEG = Math.PI / 180;

const SPECS: ExampleSpec[] = [
  {
    id: 'ridges',
    label: 'Ridges',
    tag: 'same size',
    blurb: 'Fractal terrain, contours and soft shading. Smooth, forgiving basin — a good warm-up.',
    kind: 'terrain',
    seed: 3,
    a: { w: 512, h: 512, spanX: 0.62, cx: 0.5, cy: 0.5 },
    b: { w: 512, h: 512, spanX: 0.66, cx: 0.525, cy: 0.475, rot: 4 * DEG },
  },
  {
    id: 'detail',
    label: 'Detail → overview',
    tag: 'A 640×480 · B 420×560',
    blurb:
      'A is a zoomed-in landscape detail, B a portrait overview of the same valley. Different sizes and a 0.64× scale change.',
    kind: 'terrain',
    seed: 19,
    a: { w: 640, h: 480, spanX: 0.58, cx: 0.5, cy: 0.48 },
    b: { w: 420, h: 560, spanX: 0.68, cx: 0.53, cy: 0.46, rot: 3 * DEG },
    suggest: {
      scale: { min: 0.54, max: 0.76, steps: 9 },
      tx: { min: -0.18, max: 0.18, steps: 19 },
      ty: { min: -0.18, max: 0.18, steps: 19 },
      theta: { min: -8 * DEG, max: 8 * DEG, steps: 13 },
    },
  },
  {
    id: 'shapes',
    label: 'Shapes',
    tag: 'A 560×420 · B 560×420',
    blurb: 'Hard-edged polygons and dots — sharp, narrow optimum that punishes coarse rotation steps.',
    kind: 'shapes',
    seed: 11,
    a: { w: 560, h: 420, spanX: 0.56, cx: 0.48, cy: 0.52 },
    b: { w: 560, h: 420, spanX: 0.6, cx: 0.51, cy: 0.49, rot: -6 * DEG },
    suggest: { theta: { min: -12 * DEG, max: 12 * DEG, steps: 17 } },
  },
  {
    id: 'landmarks',
    label: 'Landmarks',
    tag: 'multi-modal',
    blurb: 'Repeated glyphs on a grid. Many near-equivalent alignments — the landscape is full of local optima.',
    kind: 'landmarks',
    seed: 5,
    a: { w: 480, h: 480, spanX: 0.55, cx: 0.47, cy: 0.53 },
    b: { w: 480, h: 480, spanX: 0.55, cx: 0.5, cy: 0.5, rot: 2.5 * DEG },
    suggest: { theta: { min: -8 * DEG, max: 8 * DEG, steps: 17 } },
  },
  {
    id: 'shear',
    label: 'Shear + aspect',
    tag: '6 DOF',
    blurb:
      'B was scanned with a sheared, stretched sensor. Only reachable when aspect and shear are part of the search.',
    kind: 'landmarks',
    seed: 23,
    a: { w: 520, h: 520, spanX: 0.56, cx: 0.49, cy: 0.51 },
    b: { w: 460, h: 520, spanX: 0.64, cx: 0.52, cy: 0.5, rot: -3 * DEG, squashY: 1.03, shearX: 0.05 },
    suggest: {
      aspect: { enabled: true, min: 0.95, max: 1.05, steps: 7 },
      shear: { enabled: true, min: -0.08, max: 0.08, steps: 7 },
      theta: { min: -8 * DEG, max: 8 * DEG, steps: 13 },
      scale: { min: 0.72, max: 0.86, steps: 9 },
    },
  },
];

export const SCENE_SIZE = 1024;

export interface Example extends ExampleSpec {
  /** exact transform that produced B (computed at the canonical scene size) */
  truth: Affine;
  /** build the pair; `scale` shrinks everything (used for previews) */
  build: (scale?: number) => { a: Img; b: Img };
}

function scaledSpec(spec: ExampleSpec, scale: number): { a: ViewSpec; b: ViewSpec } {
  const s = (v: ViewSpec): ViewSpec => ({
    ...v,
    w: Math.max(24, Math.round(v.w * scale)),
    h: Math.max(24, Math.round(v.h * scale)),
  });
  return { a: s(spec.a), b: s(spec.b) };
}

export const EXAMPLES: Example[] = SPECS.map((spec) => {
  const truth = deriveTruth(spec.a, spec.b, SCENE_SIZE);
  return {
    ...spec,
    truth,
    build: (scale = 1) => {
      const sceneSize = Math.max(64, Math.round(SCENE_SIZE * scale));
      const { a: va, b: vb } = scaledSpec(spec, scale);
      const scene = paintScene(spec.kind, sceneSize, spec.seed);
      const bg = meanCss(scene);
      const ca = renderView(scene, sceneSize, va, bg);
      const cb = renderView(scene, sceneSize, vb, bg, { gamma: 0.94, noise: 7, seed: spec.seed });
      return {
        a: imgFromCanvas(ca, `${spec.id}-A`, `ex-${spec.id}-a`),
        b: imgFromCanvas(cb, `${spec.id}-B`, `ex-${spec.id}-b`),
      };
    },
  };
});

export function buildExample(ex: Example, scale = 1): { a: Img; b: Img } {
  return ex.build(scale);
}

export function exampleById(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}

/** small thumbnails for the landing page */
export function previewPair(ex: Example, maxSide = 168): { a: string; b: string; aw: number; ah: number; bw: number; bh: number } {
  const scale = maxSide / Math.max(ex.a.w, ex.a.h, ex.b.w, ex.b.h);
  const { a, b } = ex.build(scale);
  return {
    a: a.canvas.toDataURL('image/png'),
    b: b.canvas.toDataURL('image/png'),
    aw: a.width,
    ah: a.height,
    bw: b.width,
    bh: b.height,
  };
}

