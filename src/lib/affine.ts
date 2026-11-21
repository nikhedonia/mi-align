import type { Affine } from './config';
import { DOF_META, DOF_ORDER } from './config';

/** general affine matrix: [x', y'] = M * [x, y] + t  (canonical units) */
export interface Mat {
  m0: number;
  m1: number;
  m2: number;
  m3: number;
  tx: number;
  ty: number;
}

export const IDENTITY_MAT: Mat = { m0: 1, m1: 0, m2: 0, m3: 1, tx: 0, ty: 0 };

export function matOfAffine(a: Affine): Mat {
  const c = Math.cos(a.theta);
  const s = Math.sin(a.theta);
  const sx = a.scale * a.aspect;
  const sy = a.scale / a.aspect;
  const sh = a.shear;
  return {
    m0: c * sx,
    m1: c * sh * sy - s * sy,
    m2: s * sx,
    m3: s * sh * sy + c * sy,
    tx: a.tx,
    ty: a.ty,
  };
}

export function invertMat(m: Mat): Mat {
  const det = m.m0 * m.m3 - m.m1 * m.m2;
  const d = Math.abs(det) < 1e-12 ? 1e-12 : det;
  const i0 = m.m3 / d;
  const i1 = -m.m1 / d;
  const i2 = -m.m2 / d;
  const i3 = m.m0 / d;
  return {
    m0: i0,
    m1: i1,
    m2: i2,
    m3: i3,
    tx: -(i0 * m.tx + i1 * m.ty),
    ty: -(i2 * m.tx + i3 * m.ty),
  };
}

export function applyMat(m: Mat, x: number, y: number): [number, number] {
  return [m.m0 * x + m.m1 * y + m.tx, m.m2 * x + m.m3 * y + m.ty];
}

/** matrix that maps A-canonical coordinates into B-canonical coordinates */
export function affineToMat(a: Affine): Mat {
  return matOfAffine(a);
}

export function canonicalRadius(w: number, h: number): number {
  return Math.max(w, h) / 2;
}

export function pickParams(p: ArrayLike<number>, i: number): Affine {
  const o = i * 6;
  return {
    tx: p[o],
    ty: p[o + 1],
    theta: p[o + 2],
    scale: p[o + 3],
    aspect: p[o + 4],
    shear: p[o + 5],
  };
}

export function clampToLimits(a: Affine): Affine {
  const out = { ...a };
  for (const k of DOF_ORDER) {
    const lim = DOF_META[k].limit;
    if (lim) out[k] = Math.min(lim.max, Math.max(lim.min, out[k]));
  }
  return out;
}

export interface AffineDiff {
  /** displacement of the image centre, in % of the canonical radius */
  pos: number;
  /** rotation difference, degrees */
  angle: number;
  /** uniform scale ratio difference, % */
  scale: number;
}

export function compareAffine(found: Affine, truth: Affine): AffineDiff {
  const mf = matOfAffine(found);
  const mt = matOfAffine(truth);
  const [fx, fy] = applyMat(mf, 0, 0);
  const [tx, ty] = applyMat(mt, 0, 0);
  const angF = Math.atan2(found.theta, 1) * (180 / Math.PI);
  const angT = Math.atan2(truth.theta, 1) * (180 / Math.PI);
  let dAng = Math.abs(angF - angT);
  if (dAng > 180) dAng = 360 - dAng;
  return {
    pos: Math.hypot(fx - tx, fy - ty) * 100,
    angle: dAng,
    scale: Math.abs(found.scale - truth.scale) * 100,
  };
}
