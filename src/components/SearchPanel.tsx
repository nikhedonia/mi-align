import type { DofKey, SamplingMode, SearchConfig, SearchMode } from '../lib/config';
import { DOF_META, DOF_ORDER, formatCount, planGrid } from '../lib/config';
import { NumInput } from './NumInput';

interface Props {
  cfg: SearchConfig;
  sampleCount: number;
  running: boolean;
  progress: { done: number; total: number };
  disabled: boolean;
  stale: boolean;
  onChange: (fn: (c: SearchConfig) => SearchConfig) => void;
  onRun: () => void;
  onStop: () => void;
}

export function SearchPanel({ cfg, sampleCount, running, progress, disabled, stale, onChange, onRun, onStop }: Props) {
  const plan = planGrid(cfg);
  const total = plan.count;
  const dofCount = plan.keys.length;
  const estWork = total * sampleCount;
  const heavy = total > 900_000 || estWork > 4e9;

  const setDof = (key: DofKey, patch: Partial<SearchConfig['dofs'][DofKey]>) =>
    onChange((c) => ({ ...c, dofs: { ...c.dofs, [key]: { ...c.dofs[key], ...patch } } }));

  const progressPct = progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;

  return (
    <section className="card">
      <h2>Search space</h2>
      <p className="hint">
        An affine transform has 6 degrees of freedom. Enable the ones you want to search; every enabled
        axis with <em>n</em> steps contributes <em>n</em> grid values.
      </p>

      <div className="dofTable">
        <div className="dofHead">
          <span />
          <span>min</span>
          <span>max</span>
          <span>steps</span>
        </div>
        {DOF_ORDER.map((key) => {
          const meta = DOF_META[key];
          const d = cfg.dofs[key];
          return (
            <div className={`dofRow ${d.enabled ? 'on' : 'off'}`} key={key}>
              <label className="dofLabel" title={meta.label}>
                <input type="checkbox" checked={d.enabled} onChange={(e) => setDof(key, { enabled: e.target.checked })} />
                <span className="dofShort">{meta.short}</span>
                <span className="dofName">{meta.label}</span>
              </label>
              <NumInput
                value={d.min * meta.uiScale}
                digits={meta.digits}
                step={(d.max - d.min) * meta.uiScale * 0.1}
                disabled={!d.enabled}
                onChange={(v) => setDof(key, { min: v / meta.uiScale })}
                suffix={meta.uiUnit}
              />
              <NumInput
                value={d.max * meta.uiScale}
                digits={meta.digits}
                step={(d.max - d.min) * meta.uiScale * 0.1}
                disabled={!d.enabled}
                onChange={(v) => setDof(key, { max: v / meta.uiScale })}
                suffix={meta.uiUnit}
              />
              <NumInput
                value={d.steps}
                digits={0}
                min={1}
                max={512}
                step={1}
                disabled={!d.enabled}
                onChange={(v) => setDof(key, { steps: Math.round(v) })}
              />
            </div>
          );
        })}
      </div>

      <div className="summary">
        <div>
          <span className="bigNum">{formatCount(total)}</span> candidates
          {dofCount > 1 ? <span className="dim"> · {dofCount}D</span> : null}
        </div>
        <div className="dim">
          ≈ {formatCount(estWork)} pixel fetches · {formatCount(sampleCount)} samples/candidate
        </div>
        {heavy ? <div className="warn">that is a lot — expect a few seconds and consider sampling</div> : null}
      </div>

      <h3>Sampling</h3>
      <label className="checkRow">
        <input
          type="checkbox"
          checked={cfg.sampling.enabled}
          onChange={(e) => onChange((c) => ({ ...c, sampling: { ...c.sampling, enabled: e.target.checked } }))}
        />
        <span>Sample pixels instead of using all of them</span>
      </label>
      <div className="fieldRow">
        <span className="fieldLabel">mode</span>
        <select
          value={cfg.sampling.mode}
          disabled={!cfg.sampling.enabled}
          onChange={(e) => onChange((c) => ({ ...c, sampling: { ...c.sampling, mode: e.target.value as SamplingMode } }))}
        >
          <option value="grid">stratified grid</option>
          <option value="random">uniform random</option>
          <option value="gradient">gradient-weighted</option>
        </select>
      </div>
      <div className="fieldRow">
        <span className="fieldLabel">count</span>
        <NumInput
          value={cfg.sampling.count}
          digits={0}
          min={64}
          max={131072}
          step={256}
          disabled={!cfg.sampling.enabled}
          onChange={(v) => onChange((c) => ({ ...c, sampling: { ...c.sampling, count: Math.round(v) } }))}
        />
        <span className="fieldLabel">seed</span>
        <NumInput
          value={cfg.sampling.seed}
          digits={0}
          step={1}
          min={1}
          onChange={(v) => onChange((c) => ({ ...c, sampling: { ...c.sampling, seed: Math.round(v) } }))}
        />
      </div>

      <h3>Strategy</h3>
      <div className="segmented">
        <button
          className={cfg.mode === 'grid' ? 'active' : ''}
          onClick={() => onChange((c) => ({ ...c, mode: 'grid' as SearchMode }))}
        >
          Exhaustive grid
        </button>
        <button
          className={cfg.mode === 'stochastic' ? 'active' : ''}
          onClick={() => onChange((c) => ({ ...c, mode: 'stochastic' as SearchMode }))}
        >
          Stochastic multi-start
        </button>
      </div>

      {cfg.mode === 'grid' ? (
        <>
          <label className="checkRow">
            <input
              type="checkbox"
              checked={cfg.refine}
              onChange={(e) => onChange((c) => ({ ...c, refine: e.target.checked }))}
            />
            <span>Polish winner with continuous local search</span>
          </label>
          <p className="hint">Every grid point is evaluated on the GPU — nothing is skipped.</p>
        </>
      ) : (
        <>
          <p className="hint">
            Draw random candidates, keep the best few as starting points, then hill-climb each one on the GPU. All
            probes of all seeds are scored in one dispatch.
          </p>
          <div className="fieldRow">
            <span className="fieldLabel">random samples</span>
            <NumInput
              value={cfg.stochastic.samples}
              digits={0}
              min={64}
              max={262144}
              step={512}
              onChange={(v) => onChange((c) => ({ ...c, stochastic: { ...c.stochastic, samples: Math.round(v) } }))}
            />
          </div>
          <div className="fieldRow">
            <span className="fieldLabel">starting points</span>
            <NumInput
              value={cfg.stochastic.seeds}
              digits={0}
              min={1}
              max={64}
              step={1}
              onChange={(v) => onChange((c) => ({ ...c, stochastic: { ...c.stochastic, seeds: Math.round(v) } }))}
            />
          </div>
          <div className="fieldRow">
            <span className="fieldLabel">iterations</span>
            <NumInput
              value={cfg.stochastic.iterations}
              digits={0}
              min={4}
              max={200}
              step={4}
              onChange={(v) => onChange((c) => ({ ...c, stochastic: { ...c.stochastic, iterations: Math.round(v) } }))}
            />
          </div>
        </>
      )}

      <details className="advanced">
        <summary>Matching limits</summary>
        <div className="fieldRow">
          <span className="fieldLabel">min overlap</span>
          <NumInput
            value={cfg.limits.minOverlap}
            digits={2}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => onChange((c) => ({ ...c, limits: { ...c.limits, minOverlap: v } }))}
          />
          <span className="fieldLabel">overlap penalty</span>
          <NumInput
            value={cfg.limits.overlapPenalty}
            digits={2}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => onChange((c) => ({ ...c, limits: { ...c.limits, overlapPenalty: v } }))}
          />
        </div>
        <p className="hint">
          Score = NCC − penalty·(1−overlap). Candidates whose samples fall mostly outside the target are rejected.
        </p>
      </details>

      <div className="runBar">
        {running ? (
          <button className="primary" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button className="primary" onClick={onRun} disabled={disabled}>
            {stale ? 'Re-run alignment' : 'Run alignment'}
          </button>
        )}
        <div className="progressOuter">
          <div className="progressInner" style={{ width: `${progressPct}%` }} />
        </div>
        <span className="progressText">
          {running ? `${formatCount(progress.done)} / ${formatCount(progress.total)}` : stale ? 'stale' : 'idle'}
        </span>
      </div>
    </section>
  );
}
