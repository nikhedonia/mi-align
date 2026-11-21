import type { Affine, DofKey, HeatmapMode, SearchConfig } from '../lib/config';
import { DOF_META, affineSummary, enabledDofs } from '../lib/config';
import type { HeatmapData, Optimum, SearchResult } from '../lib/heatmap';
import { candidateAt } from '../lib/heatmap';
import { heatCss } from '../lib/colormap';
import { HeatmapCanvas, type Cell } from './HeatmapCanvas';

interface Props {
  hm: HeatmapData | null;
  optima: Optimum[];
  cfg: SearchConfig;
  result: SearchResult | null;
  hover: Cell | null;
  picked: Affine | null;
  onHover: (c: Cell | null) => void;
  onClickCell: (c: Cell) => void;
  onAxis: (axis: 'x' | 'y', key: DofKey) => void;
  onMode: (m: HeatmapMode) => void;
  onPickOptimum: (o: Optimum) => void;
}

function paramText(hm: HeatmapData | null, key: DofKey, i: number): string {
  if (!hm) return '';
  const m = DOF_META[key];
  const v = (key === hm.xKey ? hm.xValues[i] : hm.yValues[i]) * m.uiScale;
  const d = Math.abs(v) >= 10 ? 1 : m.digits;
  return `${v.toFixed(d)}${m.uiUnit}`;
}

export function HeatmapPanel({ hm, optima, cfg, result, hover, picked, onHover, onClickCell, onAxis, onMode, onPickOptimum }: Props) {
  const axes = enabledDofs(cfg);
  const hovered =
    hm && result && hover && hm.argIdx[hover.y * hm.gx + hover.x] >= 0
      ? candidateAt(result, hm.argIdx[hover.y * hm.gx + hover.x])
      : null;

  const gradient = Array.from({ length: 24 }, (_, i) => heatCss(i / 23)).join(',');

  return (
    <section className="card">
      <h2>
        Score landscape
        {result ? <span className="badge">{result.mode === 'grid' ? 'dense scan' : 'sampled'}</span> : null}
      </h2>

      {!hm || !result ? (
        <p className="hint">Run a search to see where the good transforms live.</p>
      ) : (
        <>
          <div className="axisRow">
            <span className="fieldLabel">x</span>
            <select value={hm.xKey} onChange={(e) => onAxis('x', e.target.value as DofKey)}>
              {axes.map((k) => (
                <option key={k} value={k}>
                  {DOF_META[k].label}
                </option>
              ))}
            </select>
            <span className="fieldLabel">y</span>
            <select
              value={hm.yKey}
              onChange={(e) => onAxis('y', e.target.value as DofKey)}
              disabled={axes.length < 2}
            >
              {axes.map((k) => (
                <option key={k} value={k}>
                  {DOF_META[k].label}
                </option>
              ))}
            </select>
          </div>
          <div className="segmented small">
            <button className={hm.mode === 'projection' ? 'active' : ''} onClick={() => onMode('projection')}>
              max-projection
            </button>
            <button
              className={hm.mode === 'slice' ? 'active' : ''}
              onClick={() => onMode('slice')}
              disabled={result.mode === 'stochastic'}
              title={
                result.mode === 'stochastic'
                  ? 'only meaningful for a dense grid scan'
                  : 'cross-section through the best transform'
              }
            >
              slice at best
            </button>
          </div>
          <p className="hint tight">
            {hm.mode === 'projection'
              ? hm.hidden.length
                ? `each cell = best score over all ${hm.hidden.length} remaining dimension${hm.hidden.length > 1 ? 's' : ''} (${hm.hidden
                    .map((k) => DOF_META[k].short)
                    .join(', ')}) — the isolated peaks are the local optima of the full space`
                : 'each cell = the score of that exact transform'
              : 'the true 2-D cross-section through the best transform (other dims fixed)'}
          </p>

          <div className="heatWrap">
            <HeatmapCanvas
              hm={hm}
              optima={optima}
              cfg={cfg}
              hover={hover}
              current={picked}
              paths={result.paths}
              onHover={onHover}
              onClickCell={onClickCell}
            />
          </div>

          <div className="legendRow">
            <span className="dim">{hm.lo.toFixed(3)}</span>
            <div className="legendBar" style={{ background: `linear-gradient(90deg, ${gradient})` }} />
            <span className="dim">{hm.hi.toFixed(3)}</span>
            <span className="legendNote">NCC − penalty</span>
          </div>

          <div className={`readout ${hovered ? 'on' : ''}`}>
            {hovered ? (
              <>
                <div className="readoutHead">
                  cell {hover ? `${paramText(hm, hm.xKey, hover.x)} / ${hm.gy > 1 ? paramText(hm, hm.yKey, hover.y) : '—'}` : ''}
                  <span className="readoutScore">score {hm.values[hover!.y * hm.gx + hover!.x].toFixed(4)}</span>
                </div>
                <div className="mono small">{affineSummary(hovered)}</div>
              </>
            ) : (
              <span className="dim">hover a cell to preview its full 6-DOF transform</span>
            )}
          </div>

          <h3>
            Local optima <span className="dim">({optima.length})</span>
          </h3>
          <div className="optima">
            {optima.length === 0 ? <span className="dim">no distinct peaks found</span> : null}
            {optima.map((o, i) => (
              <button key={`${o.cellX}-${o.cellY}`} className={`optimum ${i === 0 ? 'top' : ''}`} onClick={() => onPickOptimum(o)}>
                <span className="optRank">{i + 1}</span>
                <span className="optBar">
                  <span
                    className="optBarFill"
                    style={{ width: `${Math.max(3, ((o.score - hm.lo) / (hm.hi - hm.lo || 1)) * 100)}%` }}
                  />
                </span>
                <span className="optScore">{o.score.toFixed(4)}</span>
                <span className="optParams mono">{affineSummary(o.params)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
