import type { Affine, DofKey, HeatmapMode, SearchConfig } from './config';
import { DOF_ORDER, binOf, enabledDofs } from './config';

/** rectangle of a grid in data space (cell edges at integers) */
export interface DataRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SearchResult {
  /** n*6 affine params, order = DOF_ORDER */
  params: Float32Array;
  scores: Float32Array;
  ncc: Float32Array;
  overlap: Float32Array;
  count: number;
  /** evaluated candidate used as the slice reference (best score) */
  bestIndex: number;
  elapsedMs: number;
  mode: 'grid' | 'stochastic';
  /** per-seed refinement trajectories (stochastic mode) */
  paths: Affine[][];
}

export interface HeatmapData {
  xKey: DofKey;
  yKey: DofKey;
  mode: HeatmapMode;
  gx: number;
  gy: number;
  /** gx*gy, NaN where nothing was evaluated */
  values: Float32Array;
  /** candidate index that produced `values`, -1 if empty */
  argIdx: Int32Array;
  xValues: Float32Array;
  yValues: Float32Array;
  filled: number;
  min: number;
  max: number;
  /** robust colour range (percentiles) */
  lo: number;
  hi: number;
  /** DOFs that were max-projected away */
  hidden: DofKey[];
}

export function candidateAt(r: SearchResult, i: number): Affine {
  const o = i * 6;
  return {
    tx: r.params[o],
    ty: r.params[o + 1],
    theta: r.params[o + 2],
    scale: r.params[o + 3],
    aspect: r.params[o + 4],
    shear: r.params[o + 5],
  };
}

export function bestOf(r: SearchResult): { params: Affine; score: number; ncc: number; overlap: number; index: number } {
  const i = r.bestIndex;
  return {
    params: candidateAt(r, i),
    score: r.scores[i],
    ncc: r.ncc[i],
    overlap: r.overlap[i],
    index: i,
  };
}

function axisValueOf(cfg: SearchConfig, key: DofKey, i: number): number {
  const d = cfg.dofs[key];
  return d.min + ((d.max - d.min) * i) / Math.max(1, Math.round(d.steps) - 1);
}

/**
 * Collapse the N-dimensional score field into a 2-D map.
 *
 * mode = 'projection': cell(x,y) = max over every remaining DOF. The result is
 *   a "shadow" of the full landscape: ridges and isolated peaks are exactly the
 *   local optima of the high-dimensional problem.
 * mode = 'slice': fix every remaining DOF at the best candidate's value and
 *   look at the true 2-D cross-section.
 */
export function buildHeatmap(
  result: SearchResult,
  cfg: SearchConfig,
  xKey: DofKey,
  yKey: DofKey,
  mode: HeatmapMode,
): HeatmapData {
  const enabled = enabledDofs(cfg);
  const useY = enabled.length > 1 && yKey !== xKey;
  const yDof = useY ? yKey : xKey;

  const gx = Math.max(1, Math.round(cfg.dofs[xKey].steps));
  const gy = useY ? Math.max(1, Math.round(cfg.dofs[yDof].steps)) : 1;

  const values = new Float32Array(gx * gy).fill(NaN);
  const argIdx = new Int32Array(gx * gy).fill(-1);
  const ix = DOF_ORDER.indexOf(xKey);
  const iy = DOF_ORDER.indexOf(yDof);

  // slice reference bins
  const refBins = new Int32Array(6);
  if (mode === 'slice') {
    const o = result.bestIndex * 6;
    for (let k = 0; k < 6; k++) refBins[k] = binOf(DOF_ORDER[k], result.params[o + k], cfg);
  }

  let filled = 0;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < result.count; i++) {
    const s = result.scores[i];
    if (!Number.isFinite(s)) continue;
    const o = i * 6;
    if (mode === 'slice') {
      let ok = true;
      for (let k = 0; k < 6; k++) {
        if (k === ix || k === iy) continue;
        if (!cfg.dofs[DOF_ORDER[k]].enabled) continue;
        if (binOf(DOF_ORDER[k], result.params[o + k], cfg) !== refBins[k]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
    }
    const cx = binOf(xKey, result.params[o + ix], cfg);
    const cy = useY ? binOf(yDof, result.params[o + iy], cfg) : 0;
    const cell = cy * gx + cx;
    const prev = values[cell];
    if (Number.isNaN(prev)) filled++;
    if (Number.isNaN(prev) || s > prev) {
      values[cell] = s;
      argIdx[cell] = i;
    }
    if (s < min) min = s;
    if (s > max) max = s;
  }

  // robust colour range from the filled cells
  const filledVals: number[] = [];
  for (let i = 0; i < values.length; i++) if (!Number.isNaN(values[i])) filledVals.push(values[i]);
  filledVals.sort((a, b) => a - b);
  const pick = (q: number) =>
    filledVals.length ? filledVals[Math.min(filledVals.length - 1, Math.max(0, Math.floor(q * (filledVals.length - 1))))] : 0;
  let lo = pick(0.02);
  let hi = pick(0.985);
  if (!(hi > lo)) {
    hi = Number.isFinite(max) ? max : 1;
    lo = Number.isFinite(min) ? min : 0;
  }
  if (hi - lo < 1e-6) hi = lo + 1e-6;

  const xValues = new Float32Array(gx);
  for (let i = 0; i < gx; i++) xValues[i] = axisValueOf(cfg, xKey, i);
  const yValues = new Float32Array(gy);
  for (let i = 0; i < gy; i++) yValues[i] = axisValueOf(cfg, yDof, i);

  const hidden = enabled.filter((k) => k !== xKey && (!useY || k !== yDof));

  return {
    xKey,
    yKey: useY ? yDof : xKey,
    mode,
    gx,
    gy,
    values,
    argIdx,
    xValues,
    yValues,
    filled,
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 0,
    lo,
    hi,
    hidden,
  };
}

export interface Optimum {
  cellX: number;
  cellY: number;
  score: number;
  params: Affine;
  index: number;
}

/** local maxima of the 2-D projection (8-neighbourhood, with plateau suppression) */
export function findOptima(hm: HeatmapData, result: SearchResult, maxCount = 14): Optimum[] {
  const { gx, gy, values, lo, hi } = hm;
  const thresh = lo + (hi - lo) * 0.3;
  const found: Optimum[] = [];

  for (let y = 0; y < gy; y++) {
    for (let x = 0; x < gx; x++) {
      const v = values[y * gx + x];
      if (!Number.isFinite(v) || v < thresh) continue;
      let isMax = true;
      let strictlyLess = false;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= gy) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= gx) continue;
          const n = values[yy * gx + xx];
          if (!Number.isFinite(n)) continue;
          if (n > v + 1e-6) {
            isMax = false;
            break;
          }
          if (n < v - 1e-6) strictlyLess = true;
        }
      }
      if (!isMax) continue;
      // on a flat plateau only keep the "edge" cells: require a strictly lower
      // neighbour, or (single-row maps / fully flat) any cell
      if (!strictlyLess && gy > 1) continue;
      const idx = hm.argIdx[y * gx + x];
      if (idx < 0) continue;
      found.push({
        cellX: x,
        cellY: y,
        score: v,
        index: idx,
        params: candidateAt(result, idx),
      });
    }
  }

  found.sort((a, b) => b.score - a.score);
  const kept: Optimum[] = [];
  for (const f of found) {
    let clash = false;
    for (const k of kept) {
      if (Math.abs(k.cellX - f.cellX) <= 1 && Math.abs(k.cellY - f.cellY) <= 1) {
        clash = true;
        break;
      }
    }
    if (!clash) kept.push(f);
    if (kept.length >= maxCount) break;
  }
  return kept;
}

export function cellOf(hm: HeatmapData, a: Affine, cfg: SearchConfig): { x: number; y: number } {
  return { x: binOf(hm.xKey, a[hm.xKey], cfg), y: binOf(hm.yKey, a[hm.yKey], cfg) };
}

/** subdivide the view whenever fewer than this many cells are on screen */
export const SUBDIVIDE_CELLS = 25;

/**
 * Camera zoom at which the viewport holds SUBDIVIDE_CELLS cells. Past it the
 * visible region is re-searched with the same step count over a smaller
 * interval, so the framing is unchanged and only the resolution improves.
 */
export function subdivideZoom(gx: number, gy: number): number {
  return Math.max(1.6, Math.sqrt((gx * gy) / SUBDIVIDE_CELLS));
}

/** map a data-space coordinate (cell edges at integers) to a parameter value */
export function dataToParam(cfg: SearchConfig, key: DofKey, d: number): number {
  const { min, max, steps } = cfg.dofs[key];
  const n = Math.max(1, Math.round(steps));
  if (n <= 1) return (min + max) / 2;
  return min + ((max - min) * (d - 0.5)) / (n - 1);
}
