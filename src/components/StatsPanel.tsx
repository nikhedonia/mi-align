import type { Affine, SearchConfig } from '../lib/config';
import { DOF_META, DOF_ORDER, affineSummary, dofValueLabel, formatCount } from '../lib/config';
import { compareAffine } from '../lib/affine';
import type { SearchResult } from '../lib/heatmap';
import { bestOf } from '../lib/heatmap';

interface Props {
  result: SearchResult | null;
  cfg: SearchConfig;
  viewTransform: Affine | null;
  truth: Affine | null;
  polishing: boolean;
  onPolish: () => void;
}

export function StatsPanel({ result, cfg, viewTransform, truth, polishing, onPolish }: Props) {
  const best = result ? bestOf(result) : null;
  const err = viewTransform && truth ? compareAffine(viewTransform, truth) : null;
  const perCandidate = result && result.count > 0 ? result.elapsedMs / result.count : 0;

  return (
    <section className="card">
      <h2>Result</h2>
      {!best || !result ? (
        <p className="hint">Nothing yet.</p>
      ) : (
        <>
          <div className="scoreHero">
            <div>
              <div className="scoreValue">{best.score.toFixed(4)}</div>
              <div className="dim tiny">score</div>
            </div>
            <div className="scoreSplit">
              <div>
                <span className="k">NCC</span>
                <span className="v">{best.ncc.toFixed(4)}</span>
              </div>
              <div>
                <span className="k">overlap</span>
                <span className="v">{(best.overlap * 100).toFixed(1)}%</span>
              </div>
            </div>
          </div>

          <div className="paramLabel">transform in view</div>
          <div className="paramGrid">
            {DOF_ORDER.map((k) => {
              const on = cfg.dofs[k].enabled;
              return (
                <div key={k} className={`paramCell ${on ? 'on' : 'off'}`}>
                  <span className="paramKey" title={DOF_META[k].label}>
                    {DOF_META[k].short}
                  </span>
                  <span className="paramVal">{dofValueLabel(k, viewTransform ? viewTransform[k] : best.params[k])}</span>
                </div>
              );
            })}
          </div>
          <div className="mono tiny dim wrap">{affineSummary(viewTransform ?? best.params)}</div>

          {err ? (
            <div className="errRow">
              <span className="errLabel">vs truth</span>
              <span>{err.pos.toFixed(2)}% pos</span>
              <span>{err.angle.toFixed(2)}° rot</span>
              <span>{err.scale.toFixed(2)}% scale</span>
            </div>
          ) : null}

          <div className="statList">
            <div>
              <span className="k">candidates</span>
              <span className="v">{formatCount(result.count)}</span>
            </div>
            <div>
              <span className="k">time</span>
              <span className="v">{result.elapsedMs.toFixed(0)} ms</span>
            </div>
            <div>
              <span className="k">per candidate</span>
              <span className="v">{perCandidate < 0.01 ? perCandidate.toExponential(2) : perCandidate.toFixed(3)} ms</span>
            </div>
            <div>
              <span className="k">strategy</span>
              <span className="v">{result.mode === 'grid' ? 'exhaustive grid' : 'stochastic multi-start'}</span>
            </div>
          </div>

          <button className="ghost small" onClick={onPolish} disabled={polishing || !viewTransform}>
            {polishing ? 'polishing…' : 'Polish current transform'}
          </button>
        </>
      )}
    </section>
  );
}
