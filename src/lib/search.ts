import type { Affine, DofKey, SearchConfig } from './config';
import { DOF_META, DOF_ORDER, IDENTITY, affineAtPlan, enabledDofs, planGrid } from './config';
import type { SearchResult } from './heatmap';
import { makeRng } from './rng';

/** evaluate `n` candidate transforms; returns n*8 rows (score, ncc, overlap, ...) */
export type EvalFn = (params: Float32Array, n: number) => Promise<Float32Array>;

const ROW = 8;

export interface RunOptions {
  evaluate: EvalFn;
  batch: number;
  cfg: SearchConfig;
  onProgress?: (done: number, total: number) => void;
}

class Store {
  params: Float32Array;
  scores: Float32Array;
  ncc: Float32Array;
  overlap: Float32Array;
  count = 0;
  private cap: number;

  constructor(expected: number) {
    this.cap = Math.max(256, expected);
    this.params = new Float32Array(this.cap * 6);
    this.scores = new Float32Array(this.cap);
    this.ncc = new Float32Array(this.cap);
    this.overlap = new Float32Array(this.cap);
  }

  private grow(): void {
    const cap = this.cap * 2;
    const p = new Float32Array(cap * 6);
    p.set(this.params);
    const s = new Float32Array(cap);
    s.set(this.scores);
    const n = new Float32Array(cap);
    n.set(this.ncc);
    const o = new Float32Array(cap);
    o.set(this.overlap);
    this.params = p;
    this.scores = s;
    this.ncc = n;
    this.overlap = o;
    this.cap = cap;
  }

  pushAffine(a: Affine, score: number, ncc: number, overlap: number): void {
    if (this.count >= this.cap) this.grow();
    const o = this.count * 6;
    this.params[o] = a.tx;
    this.params[o + 1] = a.ty;
    this.params[o + 2] = a.theta;
    this.params[o + 3] = a.scale;
    this.params[o + 4] = a.aspect;
    this.params[o + 5] = a.shear;
    this.scores[this.count] = score;
    this.ncc[this.count] = ncc;
    this.overlap[this.count] = overlap;
    this.count++;
  }

  pushRows(batch: Float32Array, n: number, rows: Float32Array): void {
    for (let i = 0; i < n; i++) {
      if (this.count >= this.cap) this.grow();
      const src = i * 6;
      const dst = this.count * 6;
      this.params[dst] = batch[src];
      this.params[dst + 1] = batch[src + 1];
      this.params[dst + 2] = batch[src + 2];
      this.params[dst + 3] = batch[src + 3];
      this.params[dst + 4] = batch[src + 4];
      this.params[dst + 5] = batch[src + 5];
      const r = i * ROW;
      this.scores[this.count] = rows[r];
      this.ncc[this.count] = rows[r + 1];
      this.overlap[this.count] = rows[r + 2];
      this.count++;
    }
  }

  affineAt(i: number): Affine {
    const o = i * 6;
    return {
      tx: this.params[o],
      ty: this.params[o + 1],
      theta: this.params[o + 2],
      scale: this.params[o + 3],
      aspect: this.params[o + 4],
      shear: this.params[o + 5],
    };
  }

  bestIndex(): number {
    let best = 0;
    for (let i = 1; i < this.count; i++) if (this.scores[i] > this.scores[best]) best = i;
    return best;
  }

  finish(mode: 'grid' | 'stochastic', paths: Affine[][], elapsedMs: number): SearchResult {
    let bestIndex = 0;
    for (let i = 1; i < this.count; i++) if (this.scores[i] > this.scores[bestIndex]) bestIndex = i;
    return {
      params: this.params.subarray(0, this.count * 6).slice(),
      scores: this.scores.subarray(0, this.count).slice(),
      ncc: this.ncc.subarray(0, this.count).slice(),
      overlap: this.overlap.subarray(0, this.count).slice(),
      count: this.count,
      bestIndex,
      elapsedMs,
      mode,
      paths,
    };
  }
}

function writeAffine(out: Float32Array, o: number, a: Affine): void {
  out[o] = a.tx;
  out[o + 1] = a.ty;
  out[o + 2] = a.theta;
  out[o + 3] = a.scale;
  out[o + 4] = a.aspect;
  out[o + 5] = a.shear;
}

export function randomAffine(cfg: SearchConfig, rng: () => number): Affine {
  const a: Affine = { ...IDENTITY };
  for (const k of DOF_ORDER) {
    const d = cfg.dofs[k];
    a[k] = d.enabled ? d.min + (d.max - d.min) * rng() : DOF_META[k].fixed;
  }
  return a;
}

function clampDof(cfg: SearchConfig, key: DofKey, v: number): number {
  const d = cfg.dofs[key];
  let out = v;
  if (d.enabled) out = Math.min(d.max, Math.max(d.min, out));
  const lim = DOF_META[key].limit;
  if (lim) out = Math.min(lim.max, Math.max(lim.min, out));
  return out;
}

interface SeedState {
  a: Affine;
  score: number;
  step: Affine;
  alive: boolean;
  path: Affine[];
}

/**
 * Batched pattern search (compass search) over the enabled DOFs.
 * Every seed probes ±step on every axis, moves to the best improvement, and
 * halves its step when it is stuck. All probes are evaluated on the GPU in a
 * single batch, so any number of seeds runs at the cost of one pass.
 */
async function patternSearch(
  opts: RunOptions,
  seeds: SeedState[],
  maxIters: number,
  onEval: ((batch: Float32Array, n: number, rows: Float32Array) => void) | null,
  report: (done: number) => void,
): Promise<SeedState[]> {
  const { cfg, evaluate } = opts;
  const dims = enabledDofs(cfg);
  const D = dims.length;
  if (D === 0) return seeds;

  const perIter = seeds.length * D * 2;
  let buf = new Float32Array(perIter * 6);

  for (let iter = 0; iter < maxIters; iter++) {
    const alive = seeds.filter((s) => s.alive);
    if (alive.length === 0) break;

    const n = alive.length * D * 2;
    if (buf.length < n * 6) buf = new Float32Array(n * 6);
    let o = 0;
    for (const s of alive) {
      for (const k of dims) {
        for (const sign of [1, -1]) {
          const cand: Affine = { ...s.a };
          cand[k] = clampDof(cfg, k, s.a[k] + sign * s.step[k]);
          writeAffine(buf, o * 6, cand);
          o++;
        }
      }
    }

    const rows = await evaluate(buf, n);
    if (onEval) onEval(buf, n, rows);

    let bi = 0;
    for (const s of alive) {
      let bestScore = -Infinity;
      let bestA = s.a;
      for (let j = 0; j < D * 2; j++) {
        const r = (bi + j) * ROW;
        const sc = rows[r];
        if (sc > bestScore) {
          bestScore = sc;
          const src = (bi + j) * 6;
          bestA = {
            tx: buf[src],
            ty: buf[src + 1],
            theta: buf[src + 2],
            scale: buf[src + 3],
            aspect: buf[src + 4],
            shear: buf[src + 5],
          };
        }
      }
      bi += D * 2;

      if (bestScore > s.score + 1e-7) {
        s.a = bestA;
        s.score = bestScore;
        s.path.push(bestA);
      } else {
        // stuck: shrink every step
        let tiny = true;
        for (const k of dims) {
          s.step[k] *= 0.5;
          const span = Math.max(1e-6, cfg.dofs[k].max - cfg.dofs[k].min);
          if (s.step[k] > span * 1.5e-3) tiny = false;
        }
        if (tiny) s.alive = false;
      }
    }
    report((iter + 1) * perIter);
  }

  return seeds;
}

function makeSeedState(a: Affine, score: number, initStep: Partial<Record<DofKey, number>>, cfg: SearchConfig): SeedState {
  const step: Affine = { ...IDENTITY };
  for (const k of enabledDofs(cfg)) {
    const span = cfg.dofs[k].max - cfg.dofs[k].min;
    step[k] = initStep[k] ?? span * 0.25;
  }
  return { a, score, step, alive: true, path: [a] };
}

/* ------------------------------------------------------------------ */
/* exhaustive grid                                                     */
/* ------------------------------------------------------------------ */

async function runGrid(opts: RunOptions, started: number): Promise<SearchResult> {
  const { cfg, evaluate, batch, onProgress } = opts;
  const plan = planGrid(cfg);
  const total = plan.count;
  const store = new Store(total);
  const buf = new Float32Array(Math.min(batch, total) * 6);

  for (let start = 0; start < total; start += batch) {
    const n = Math.min(batch, total - start);
    for (let k = 0; k < n; k++) writeAffine(buf, k * 6, affineAtPlan(plan, start + k));
    const rows = await evaluate(buf.subarray(0, n * 6), n);
    store.pushRows(buf, n, rows);
    onProgress?.(start + n, total);
  }

  // polish the winner with continuous local search (sub-grid accuracy)
  let paths: Affine[][] = [];
  const bestIdx = store.bestIndex();
  if (cfg.refine && enabledDofs(cfg).length > 0) {
    const startA = store.affineAt(bestIdx);
    const stepScale: Partial<Record<DofKey, number>> = {};
    for (const k of enabledDofs(cfg)) {
      const d = cfg.dofs[k];
      stepScale[k] = Math.max(1e-6, (d.max - d.min) / Math.max(1, d.steps - 1)) * 0.5;
    }
    const seeds = [makeSeedState(startA, store.scores[bestIdx], stepScale, cfg)];
    const polished = await patternSearch(
      opts,
      seeds,
      Math.max(24, cfg.stochastic.iterations),
      null,
      () => {},
    );
    const p = polished[0];
    if (p && p.score > store.scores[bestIdx] + 1e-9) {
      store.pushAffine(p.a, p.score, 0, 0);
      // fill ncc/overlap by a direct evaluation of the single winner
      const single = new Float32Array(6);
      writeAffine(single, 0, p.a);
      const rows = await evaluate(single, 1);
      const last = store.count - 1;
      store.ncc[last] = rows[1];
      store.overlap[last] = rows[2];
      paths = [p.path];
    }
  }

  return store.finish('grid', paths, performance.now() - started);
}

/* ------------------------------------------------------------------ */
/* stochastic multi-start                                              */
/* ------------------------------------------------------------------ */

async function runStochastic(opts: RunOptions, started: number): Promise<SearchResult> {
  const { cfg, evaluate, batch, onProgress } = opts;
  const st = cfg.stochastic;
  const dims = enabledDofs(cfg);
  const D = Math.max(1, dims.length);
  const nSamples = Math.max(64, Math.round(st.samples));
  const estTotal = nSamples + st.seeds * D * 2 * st.iterations;
  const store = new Store(estTotal);
  const rng = makeRng(cfg.sampling.seed * 2654435761);
  let done = 0;

  // 1. random exploration
  const buf = new Float32Array(Math.min(batch, nSamples) * 6);
  let cursor = 0;
  while (cursor < nSamples) {
    const n = Math.min(buf.length / 6, nSamples - cursor);
    for (let k = 0; k < n; k++) writeAffine(buf, k * 6, randomAffine(cfg, rng));
    const rows = await evaluate(buf.subarray(0, n * 6), n);
    store.pushRows(buf, n, rows);
    cursor += n;
    done += n;
    onProgress?.(done, estTotal);
  }

  // 2. pick diverse top-K seeds
  const order = Array.from({ length: store.count }, (_, i) => i).sort((a, b) => store.scores[b] - store.scores[a]);
  const k = Math.max(1, Math.min(st.seeds, order.length));
  const chosen: number[] = [];
  const norm = (a: Affine, key: DofKey) => {
    const d = cfg.dofs[key];
    const span = d.max - d.min;
    return Math.abs(span) < 1e-9 ? 0 : (a[key] - d.min) / span;
  };
  for (const idx of order) {
    if (chosen.length >= k) break;
    if (store.scores[idx] < -2) continue; // rejected candidates make poor seeds
    const cand = store.affineAt(idx);
    let ok = true;
    for (const c of chosen) {
      const other = store.affineAt(c);
      let dist = 0;
      for (const key of dims) {
        const dd = norm(cand, key) - norm(other, key);
        dist += dd * dd;
      }
      if (Math.sqrt(dist) < 0.22) {
        ok = false;
        break;
      }
    }
    if (ok) chosen.push(idx);
  }
  if (chosen.length === 0) chosen.push(order[0]);

  const seeds = chosen.map((idx) => makeSeedState(store.affineAt(idx), store.scores[idx], {}, cfg));

  // 3. local refinement of every seed
  const refined = await patternSearch(
    opts,
    seeds,
    st.iterations,
    (b, n, rows) => store.pushRows(b, n, rows),
    (d) => {
      done += d;
      onProgress?.(Math.min(done, estTotal), estTotal);
    },
  );

  const paths = refined.map((s) => s.path);
  const result = store.finish('stochastic', paths, performance.now() - started);

  // make sure the best converged seed is reported as the winner
  let bi = result.bestIndex;
  for (const s of refined) {
    if (s.score > result.scores[bi]) {
      for (let i = 0; i < store.count; i++) {
        if (Math.abs(store.scores[i] - s.score) < 1e-9) {
          bi = i;
          break;
        }
      }
    }
  }
  result.bestIndex = bi;
  return result;
}

export async function runSearch(opts: RunOptions): Promise<SearchResult> {
  const started = performance.now();
  if (opts.cfg.mode === 'grid') return runGrid(opts, started);
  return runStochastic(opts, started);
}

/** local refinement of an arbitrary transform (used by the "Polish" button) */
export async function polish(
  opts: RunOptions,
  from: Affine,
  iters = 80,
): Promise<{ params: Affine; score: number } | null> {
  const stepScale: Partial<Record<DofKey, number>> = {};
  for (const k of enabledDofs(opts.cfg)) {
    const d = opts.cfg.dofs[k];
    stepScale[k] = Math.max(1e-6, (d.max - d.min) / Math.max(1, d.steps - 1)) * 0.5;
  }
  const before = await opts.evaluate(Float32Array.from([
    from.tx, from.ty, from.theta, from.scale, from.aspect, from.shear,
  ]), 1);
  const seeds = [makeSeedState(from, before[0], stepScale, opts.cfg)];
  const out = await patternSearch(opts, seeds, iters, null, () => {});
  return out[0] ? { params: out[0].a, score: out[0].score } : null;
}
