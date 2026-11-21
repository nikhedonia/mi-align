import type { Affine, DofKey, HeatmapMode, SearchConfig } from '../lib/config';
import { DOF_META, DOF_ORDER, affineSummary, dofValueLabel, enabledDofs } from '../lib/config';
import type { HeatmapData, Optimum, SearchResult } from '../lib/heatmap';
import { candidateAt } from '../lib/heatmap';
import { heatCss } from '../lib/colormap';
import { HeatmapCanvas, type Camera, type Cell, type Layer } from './HeatmapCanvas';
import type { DataRect } from '../lib/heatmap';

export interface Crumb {
  label: string;
}

interface Props {
  hm: HeatmapData | null;
  layers: Layer[];
  root: { gx: number; gy: number };
  optima: Optimum[];
  cfg: SearchConfig;
  result: SearchResult | null;
  hover: Cell | null;
  selected: Cell | null;
  explored: Set<string>;
  camera: Camera;
  current: Affine | null;
  crumbs: Crumb[];
  autoRefine: boolean;
  busy: boolean;
  canPop: boolean;
  onToggleAutoRefine: (v: boolean) => void;
  onAutoPop: () => void;
  onBack: () => void;
  onSubdivide: (rect: DataRect) => void;
  onHover: (c: Cell | null) => void;
  onSelect: (c: Cell | null) => void;
  onExplore: (c: Cell) => void;
  onCamera: (c: Camera) => void;
  onAxis: (axis: 'x' | 'y', key: DofKey) => void;
  onMode: (m: HeatmapMode) => void;
  onPickOptimum: (o: Optimum) => void;
}

function cellText(hm: HeatmapData, cell: Cell): string {
  const x = `${DOF_META[hm.xKey].short} ${dofValueLabel(hm.xKey, hm.xValues[cell.x])}`;
  if (hm.gy <= 1) return x;
  return `${x} · ${DOF_META[hm.yKey].short} ${dofValueLabel(hm.yKey, hm.yValues[cell.y])}`;
}

export function HeatmapPanel(props: Props) {
  const {
    hm,
    layers,
    root,
    optima,
    cfg,
    result,
    hover,
    selected,
    explored,
    camera,
    current,
    crumbs,
    autoRefine,
    busy,
    canPop,
    onToggleAutoRefine,
    onAutoPop,
    onSubdivide,
    onBack,
    onHover,
    onSelect,
    onExplore,
    onCamera,
    onAxis,
    onMode,
    onPickOptimum,
  } = props;

  const axes = enabledDofs(cfg);
  // a finer level can be running while we keep drawing the coarser one
  const refining = layers.length > 0 && layers[layers.length - 1].hm !== hm;

  const hovered =
    hm && result && hover && hm.argIdx[hover.y * hm.gx + hover.x] >= 0
      ? candidateAt(result, hm.argIdx[hover.y * hm.gx + hover.x])
      : null;
  const selectedInfo =
    hm && result && selected && hm.argIdx[selected.y * hm.gx + selected.x] >= 0
      ? candidateAt(result, hm.argIdx[selected.y * hm.gx + selected.x])
      : null;
  const selectedKnown = !!selectedInfo;
  const selectedScore =
    hm && selected ? hm.values[selected.y * hm.gx + selected.x] : Number.NaN;

  const gradient = Array.from({ length: 24 }, (_, i) => heatCss(i / 23)).join(',');

  return (
    <section className="card">
      <div className="hmHead">
        <h2>
          Score landscape
          {result ? <span className="badge">{result.mode === 'grid' ? 'dense scan' : 'sampled'}</span> : null}
        </h2>
        {crumbs.length > 1 ? (
          <button className="ghost small" onClick={onBack} title="Back to the previous search space">
            ← up
          </button>
        ) : null}
      </div>

      <div className="crumbs">
        {crumbs.map((c, i) => (
          <span key={i} className={`crumb ${i === crumbs.length - 1 ? 'last' : ''}`}>
            {c.label}
          </span>
        ))}
      </div>

      <div className="spaceChips" title="the space currently being searched — after a dive these ranges are centred on the cell you picked">
        {DOF_ORDER.map((k) => {
          const d = cfg.dofs[k];
          if (!d.enabled) {
            if (Math.abs(d.value - DOF_META[k].fixed) < 1e-9) return null;
            return (
              <span key={k} className="spaceChip locked">
                🔒 {DOF_META[k].short} {dofValueLabel(k, d.value)}
              </span>
            );
          }
          return (
            <span key={k} className="spaceChip">
              {DOF_META[k].short} {dofValueLabel(k, d.min)}…{dofValueLabel(k, d.max)}
              <span className="spaceSteps">{Math.round(d.steps)}</span>
            </span>
          );
        })}
      </div>

      {!hm || !result ? (
        <p className="hint">
          {refining && crumbs.length > 1
            ? 'Searching this region…'
            : 'Run a search to see where the good transforms live.'}
        </p>
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
          <div className="hmControls">
            <label className="autoRefine" title="when the viewport only spans a few cells, re-run the search on a finer grid for that region">
              <input type="checkbox" checked={autoRefine} onChange={(e) => onToggleAutoRefine(e.target.checked)} />
              <span>auto-refine with zoom</span>
            </label>
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
          </div>
          <p className="hint tight">
            {hm.mode === 'projection'
              ? hm.hidden.length
                ? `each cell = best score over the other ${hm.hidden.length} dimension${hm.hidden.length > 1 ? 's' : ''} (${hm.hidden
                    .map((k) => DOF_META[k].short)
                    .join(', ')})`
                : 'each cell = the score of that exact transform'
              : 'the true 2-D cross-section through the best transform'}
            {' · '}scroll to zoom — the visible region is re-searched on a finer grid when fewer than{' '}
            {25} cells fit; coarser levels stay visible behind it · drag to pan · double-click to dive
          </p>

          <HeatmapCanvas
            optima={optima}
            hover={hover}
            current={current}
            paths={result.paths}
            selected={selected}
            explored={explored}
            layers={layers}
            cfg={cfg}
            root={root}
            camera={camera}
            autoRefine={autoRefine}
            busy={busy}
            canPop={canPop}
            onSubdivide={onSubdivide}
            onAutoPop={onAutoPop}
            onCamera={onCamera}
            onHover={onHover}
            onSelect={onSelect}
            onExplore={onExplore}
          />

          <div className="legendRow">
            <span className="dim">{hm.lo.toFixed(3)}</span>
            <div className="legendBar" style={{ background: `linear-gradient(90deg, ${gradient})` }} />
            <span className="dim">{hm.hi.toFixed(3)}</span>
            <span className="legendNote">NCC − penalty</span>
          </div>

          <div className={`readout ${hovered || selected ? 'on' : ''}`}>
            {selected ? (
              <div className="readoutBlock">
                <div className="readoutHead">
                  <span className="readoutTag">selected</span>
                  <span className="readoutCell">{cellText(hm, selected)}</span>
                  <span className="readoutScore">
                    {selectedKnown && Number.isFinite(selectedScore) ? `score ${selectedScore.toFixed(4)}` : 'unexplored'}
                  </span>
                </div>
                {selectedInfo ? <div className="mono small">{affineSummary(selectedInfo)}</div> : null}
                <div className="readoutActions">
                  <button className="ghost small" onClick={() => onExplore(selected)}>
                    dive inside this cell →
                  </button>
                  {explored.has(`${selected.x},${selected.y}`) ? (
                    <span className="dim tiny">explored before</span>
                  ) : !selectedKnown ? (
                    <span className="dim tiny">nothing scanned here yet</span>
                  ) : null}
                  <button className="linkBtn" onClick={() => onSelect(null)}>
                    clear
                  </button>
                </div>
              </div>
            ) : null}
            {hovered && hover && (!selected || hover.x !== selected.x || hover.y !== selected.y) ? (
              <div className="readoutBlock hoveredBlock">
                <div className="readoutHead">
                  <span className="readoutTag">hover</span>
                  <span className="readoutCell">{cellText(hm, hover)}</span>
                  <span className="readoutScore">
                    {Number.isFinite(hm.values[hover.y * hm.gx + hover.x])
                      ? `score ${hm.values[hover.y * hm.gx + hover.x].toFixed(4)}`
                      : 'unexplored'}
                  </span>
                </div>
                <div className="mono small">{affineSummary(hovered)}</div>
              </div>
            ) : null}
            {!selected && !hovered ? (
              <span className="dim">
                hover a cell to preview its transform · click to select · dive to search inside it · double-click to dive
                directly
              </span>
            ) : null}
          </div>

          <h3>
            Local optima <span className="dim">({optima.length})</span>
          </h3>
          <div className="optima">
            {optima.length === 0 ? <span className="dim">no distinct peaks found</span> : null}
            {optima.map((o, i) => (
              <button
                key={`${o.cellX}-${o.cellY}`}
                className={`optimum ${i === 0 ? 'top' : ''}`}
                onClick={() => onPickOptimum(o)}
                onDoubleClick={() => onExplore({ x: o.cellX, y: o.cellY })}
                title="click to apply · double-click to dive in"
              >
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
