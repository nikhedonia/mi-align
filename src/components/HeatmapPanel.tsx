import type { Affine, DofKey, HeatmapMode, SearchConfig } from '../lib/config';
import { DOF_META, DOF_ORDER, affineSummary, dofValueLabel, enabledDofs } from '../lib/config';
import type { HeatmapData, Optimum, SearchResult } from '../lib/heatmap';
import { heatCss } from '../lib/colormap';
import { useCallback, useState } from 'react';
import { HeatmapCanvas, type Camera, type Cell, type Layer, type Target } from './HeatmapCanvas';
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
  hover: Target | null;
  selected: Target | null;
  hoverInfo: CellInfoView | null;
  selectedInfo: CellInfoView | null;
  exploredByLayer: Map<number, Set<string>>;
  camera: Camera;
  current: Affine | null;
  crumbs: Crumb[];
  autoRefine: boolean;
  busy: boolean;
  onToggleAutoRefine: (v: boolean) => void;
  onBack: () => void;
  onSubdivide: (rect: DataRect) => void;
  onHover: (t: Target | null) => void;
  onSelect: (t: Target | null) => void;
  onExplore: (t: Target) => void;
  onCamera: (c: Camera) => void;
  onAxis: (axis: 'x' | 'y', key: DofKey) => void;
  onMode: (m: HeatmapMode) => void;
  onPickOptimum: (o: Optimum) => void;
}

export interface CellInfoView {
  levelId: number;
  cell: Cell;
  text: string;
  params: Affine | null;
  score: number;
  known: boolean;
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
    hoverInfo,
    selectedInfo,
    exploredByLayer,
    camera,
    current,
    crumbs,
    autoRefine,
    busy,
    onToggleAutoRefine,
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

  // the canvas reports the palette it actually used; the legend must match it
  const [shared, setShared] = useState<{ lo: number; hi: number } | null>(null);
  const onRange = useCallback((lo: number, hi: number) => {
    setShared((prev) => (prev && Math.abs(prev.lo - lo) < 1e-9 && Math.abs(prev.hi - hi) < 1e-9 ? prev : { lo, hi }));
  }, []);
  const legendLo = shared?.lo ?? (hm ? hm.lo : 0);
  const legendHi = shared?.hi ?? (hm ? hm.hi : 1);

  const axes = enabledDofs(cfg);
  // a finer level can be running while we keep drawing the coarser one


  const hovered = hoverInfo?.params ?? null;
  const selectedKnown = !!selectedInfo?.known;
  const selectedScore = selectedInfo ? selectedInfo.score : Number.NaN;
  const selectedExplored =
    !!selectedInfo && !!exploredByLayer.get(selectedInfo.levelId)?.has(`${selectedInfo.cell.x},${selectedInfo.cell.y}`);

  const gradient = Array.from({ length: 24 }, (_, i) => heatCss(i / 23)).join(',');
  const metric = result?.objective === 'mi' ? 'NMI' : 'NCC';

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
            {' · '}free pan &amp; zoom; the view redraws instantly and the search for this window catches up a
            moment later · coarser levels stay visible behind it · double-click to dive into a cell
          </p>

          <HeatmapCanvas
            optima={optima}
            hover={hover}
            current={current}
            paths={result.paths}
            selected={selected}
            exploredByLayer={exploredByLayer}
            layers={layers}
            cfg={cfg}
            root={root}
            camera={camera}
            autoRefine={autoRefine}
            busy={busy}
            onSubdivide={onSubdivide}
            onRange={onRange}
            onCamera={onCamera}
            onHover={onHover}
            onSelect={onSelect}
            onExplore={onExplore}
          />

          <div className="legendRow">
            <span className="dim">{legendLo.toFixed(3)}</span>
            <div className="legendBar" style={{ background: `linear-gradient(90deg, ${gradient})` }} />
            <span className="dim">{legendHi.toFixed(3)}</span>
            <span className="legendNote">
              {layers.length > 1 ? `shared across levels · ${metric} − penalty` : `${metric} − penalty`}
            </span>
          </div>

          <div className={`readout ${hovered || selected ? 'on' : ''}`}>
            {selected ? (
              <div className="readoutBlock">
                <div className="readoutHead">
                  <span className="readoutTag">selected</span>
                  <span className="readoutCell">{selectedInfo ? selectedInfo.text : ''}</span>
                  <span className="readoutScore">
                    {selectedKnown && Number.isFinite(selectedScore) ? `score ${selectedScore.toFixed(4)}` : 'unexplored'}
                  </span>
                </div>
                {selectedInfo?.params ? <div className="mono small">{affineSummary(selectedInfo.params)}</div> : null}
                <div className="readoutActions">
                  <button className="ghost small" onClick={() => onExplore(selected)}>
                    dive inside this cell →
                  </button>
                  {selectedExplored ? (
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
            {hovered &&
            hover &&
            (!selected || hover.levelId !== selected.levelId || hover.cell.x !== selected.cell.x || hover.cell.y !== selected.cell.y) ? (
              <div className="readoutBlock hoveredBlock">
                <div className="readoutHead">
                  <span className="readoutTag">hover</span>
                  <span className="readoutCell">{hoverInfo ? hoverInfo.text : ''}</span>
                  <span className="readoutScore">
                    {hoverInfo && Number.isFinite(hoverInfo.score) ? `score ${hoverInfo.score.toFixed(4)}` : 'unexplored'}
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
                onDoubleClick={() => onExplore({ levelId: layers[layers.length - 1].id, cell: { x: o.cellX, y: o.cellY } })}
                title="click to apply · double-click to dive in"
              >
                <span className="optRank">{i + 1}</span>
                <span className="optBar">
                  <span
                    className="optBarFill"
                    style={{ width: `${Math.max(3, ((o.score - legendLo) / (legendHi - legendLo || 1)) * 100)}%` }}
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
