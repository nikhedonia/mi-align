/**
 * Search-space definition: a 6-DOF affine parameterisation.
 *
 * The affine matrix maps *canonical* coordinates of image A into canonical
 * coordinates of image B, where canonical coordinates are centred and
 * normalised by R = max(W, H) / 2, so that a rotation is angle-preserving
 * even for non-square images.
 *
 *   X_b = m0 * X_a + m1 * Y_a + tx
 *   Y_b = m2 * X_a + m3 * Y_a + ty
 *
 * with   M = R(theta) * Shear(shear) * Scale(sx, sy)
 *        sx = scale * aspect,  sy = scale / aspect
 */

export type DofKey = 'tx' | 'ty' | 'theta' | 'scale' | 'aspect' | 'shear';

export const DOF_ORDER: DofKey[] = ['tx', 'ty', 'theta', 'scale', 'aspect', 'shear'];

export interface Affine {
  tx: number;
  ty: number;
  theta: number; // radians
  scale: number; // uniform
  aspect: number; // sx / sy
  shear: number;
}

export const IDENTITY: Affine = { tx: 0, ty: 0, theta: 0, scale: 1, aspect: 1, shear: 0 };

export interface DofMeta {
  key: DofKey;
  label: string;
  short: string;
  /** value used when the DOF is not part of the search */
  fixed: number;
  defaultValue: { min: number; max: number; steps: number };
  /** multiply canonical value to get the number shown in the UI */
  uiScale: number;
  uiUnit: string;
  digits: number;
  /** hard clamp for stochastic refinement */
  limit?: { min: number; max: number };
}

const DEG = Math.PI / 180;

export const DOF_META: Record<DofKey, DofMeta> = {
  tx: {
    key: 'tx',
    label: 'Translation X',
    short: 'tx',
    fixed: 0,
    defaultValue: { min: -0.2, max: 0.2, steps: 21 },
    uiScale: 1,
    uiUnit: '',
    digits: 3,
  },
  ty: {
    key: 'ty',
    label: 'Translation Y',
    short: 'ty',
    fixed: 0,
    defaultValue: { min: -0.2, max: 0.2, steps: 21 },
    uiScale: 1,
    uiUnit: '',
    digits: 3,
  },
  theta: {
    key: 'theta',
    label: 'Rotation',
    short: 'θ',
    fixed: 0,
    defaultValue: { min: -12 * DEG, max: 12 * DEG, steps: 15 },
    uiScale: 180 / Math.PI,
    uiUnit: '°',
    digits: 2,
  },
  scale: {
    key: 'scale',
    label: 'Scale',
    short: 's',
    fixed: 1,
    defaultValue: { min: 0.92, max: 1.08, steps: 9 },
    uiScale: 1,
    uiUnit: '×',
    digits: 3,
    limit: { min: 0.25, max: 4 },
  },
  aspect: {
    key: 'aspect',
    label: 'Aspect (sx/sy)',
    short: 'a',
    fixed: 1,
    defaultValue: { min: 0.96, max: 1.04, steps: 7 },
    uiScale: 1,
    uiUnit: '×',
    digits: 3,
    limit: { min: 0.25, max: 4 },
  },
  shear: {
    key: 'shear',
    label: 'Shear',
    short: 'sh',
    fixed: 0,
    defaultValue: { min: -0.06, max: 0.06, steps: 7 },
    uiScale: 1,
    uiUnit: '',
    digits: 3,
  },
};

export type SamplingMode = 'grid' | 'random' | 'gradient';
export type SearchMode = 'grid' | 'stochastic';
export type HeatmapMode = 'projection' | 'slice';
/** per-candidate scoring objective */
export type Objective = 'ncc' | 'mi';

export interface SamplingConfig {
  enabled: boolean;
  mode: SamplingMode;
  count: number;
  seed: number;
}

export interface DofConfig {
  enabled: boolean;
  min: number;
  max: number;
  steps: number;
  /** value used when the DOF is locked (disabled) */
  value: number;
}

export interface StochasticConfig {
  /** random candidates drawn before the local refinement */
  samples: number;
  /** how many distinct random points become refinement seeds */
  seeds: number;
  iterations: number;
}

export interface Limits {
  minOverlap: number;
  overlapPenalty: number;
}

export interface HeatmapConfig {
  x: DofKey;
  y: DofKey;
  mode: HeatmapMode;
}

export interface SearchConfig {
  dofs: Record<DofKey, DofConfig>;
  sampling: SamplingConfig;
  mode: SearchMode;
  /** what each candidate is scored with; MI is much more expensive */
  objective: Objective;
  stochastic: StochasticConfig;
  refine: boolean;
  limits: Limits;
  heatmap: HeatmapConfig;
}

export function createDefaultConfig(): SearchConfig {
  const dofs = {} as Record<DofKey, DofConfig>;
  for (const k of DOF_ORDER) {
    const d = DOF_META[k].defaultValue;
    dofs[k] = {
      enabled: k === 'tx' || k === 'ty' || k === 'theta' || k === 'scale',
      min: d.min,
      max: d.max,
      steps: d.steps,
      value: DOF_META[k].fixed,
    };
  }
  return {
    dofs,
    sampling: { enabled: true, mode: 'grid', count: 2048, seed: 1234 },
    mode: 'grid',
    objective: 'ncc',
    stochastic: { samples: 4096, seeds: 12, iterations: 44 },
    refine: true,
    limits: { minOverlap: 0.3, overlapPenalty: 0.35 },
    heatmap: { x: 'tx', y: 'ty', mode: 'projection' },
  };
}

/* ------------------------------------------------------------------ */
/* grid planning                                                       */
/* ------------------------------------------------------------------ */

export interface GridPlan {
  keys: DofKey[];
  values: Float32Array[];
  strides: number[];
  count: number;
  base: Affine;
}

export function axisValues(min: number, max: number, steps: number): Float32Array {
  const n = Math.max(1, Math.round(steps));
  const out = new Float32Array(n);
  if (n === 1) {
    out[0] = (min + max) / 2;
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = min + ((max - min) * i) / (n - 1);
  return out;
}

export function enabledDofs(cfg: SearchConfig): DofKey[] {
  return DOF_ORDER.filter((k) => cfg.dofs[k].enabled);
}

export function planGrid(cfg: SearchConfig): GridPlan {
  const keys = enabledDofs(cfg);
  const values = keys.map((k) => axisValues(cfg.dofs[k].min, cfg.dofs[k].max, cfg.dofs[k].steps));
  const strides: number[] = new Array(keys.length).fill(1);
  for (let i = keys.length - 2; i >= 0; i--) strides[i] = strides[i + 1] * values[i + 1].length;
  let count = 1;
  for (const v of values) count *= v.length;
  const base: Affine = { ...IDENTITY };
  for (const k of DOF_ORDER) if (!cfg.dofs[k].enabled) base[k] = cfg.dofs[k].value;
  return { keys, values, strides, count, base };
}

export function affineAtPlan(plan: GridPlan, index: number): Affine {
  const a: Affine = { ...plan.base };
  for (let i = 0; i < plan.keys.length; i++) {
    const len = plan.values[i].length;
    const digit = Math.floor(index / plan.strides[i]) % len;
    a[plan.keys[i]] = plan.values[i][digit];
  }
  return a;
}

/** bin index of a continuous value for a given DOF configuration */
export function binOf(key: DofKey, value: number, cfg: SearchConfig): number {
  const d = cfg.dofs[key];
  const n = Math.max(1, Math.round(d.steps));
  if (n === 1) return 0;
  if (!(d.max > d.min)) return 0;
  const t = (value - d.min) / (d.max - d.min);
  return Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))));
}

export function dofValueLabel(key: DofKey, value: number): string {
  const m = DOF_META[key];
  const v = value * m.uiScale;
  const abs = Math.abs(v);
  const digits = abs >= 10 ? Math.max(0, m.digits - 2) : m.digits;
  return `${v >= 0 ? '' : '-'}${abs.toFixed(digits)}${m.uiUnit}`;
}

export function formatCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}

/** compact one-line description of a full 6-DOF transform */
export function affineSummary(a: Affine): string {
  return DOF_ORDER.map((k) => `${DOF_META[k].short} ${dofValueLabel(k, a[k])}`).join('  ');
}

/* ------------------------------------------------------------------ */
/* exploration helpers                                                 */
/* ------------------------------------------------------------------ */

/** the parameter interval covered by one heatmap cell */
export function cellRangeForKey(cfg: SearchConfig, key: DofKey, bin: number): { min: number; max: number } {
  const d = cfg.dofs[key];
  const n = Math.max(1, Math.round(d.steps));
  if (n <= 1 || !(d.max > d.min)) return { min: d.min, max: d.max };
  const step = (d.max - d.min) / (n - 1);
  const v = d.min + step * bin;
  return {
    min: Math.max(d.min, v - step / 2),
    max: Math.min(d.max, v + step / 2),
  };
}

/** restrict one DOF to a sub-interval (used to dive into a heatmap cell) */
export function narrowDof(
  cfg: SearchConfig,
  key: DofKey,
  min: number,
  max: number,
  steps?: number,
): SearchConfig {
  const d = cfg.dofs[key];
  let lo = min;
  let hi = max;
  if (!(hi > lo)) {
    const mid = (lo + hi) / 2;
    lo = mid - 1e-6;
    hi = mid + 1e-6;
  }
  return {
    ...cfg,
    dofs: {
      ...cfg.dofs,
      [key]: { ...d, min: lo, max: hi, steps: steps ?? d.steps, enabled: true },
    },
  };
}

/** lock a DOF at a concrete value (excluded from the search) */
export function lockDof(cfg: SearchConfig, key: DofKey, value: number): SearchConfig {
  return { ...cfg, dofs: { ...cfg.dofs, [key]: { ...cfg.dofs[key], enabled: false, value } } };
}

export function unlockDof(cfg: SearchConfig, key: DofKey): SearchConfig {
  return { ...cfg, dofs: { ...cfg.dofs, [key]: { ...cfg.dofs[key], enabled: true } } };
}
