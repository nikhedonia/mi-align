import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DataPanel } from './components/DataPanel';
import { SearchPanel } from './components/SearchPanel';
import { StatsPanel } from './components/StatsPanel';
import { HeatmapPanel, type Crumb } from './components/HeatmapPanel';
import { ViewBar } from './components/ViewBar';
import { WarpCanvas } from './components/WarpCanvas';
import { MiPanel } from './components/MiPanel';
import { Landing } from './components/Landing';
import { InfoPage } from './components/InfoPage';
import { track, trackPageView } from './analytics';
import { INITIAL_CAMERA, type Camera, type Cell, type Target } from './components/HeatmapCanvas';
import { initGPU, type GPUEnv } from './gpu/device';
import { Aligner, type Measure } from './gpu/aligner';
import { DEFAULT_VIEW, type ViewOpts } from './gpu/warp';
import type { Affine, DofKey, HeatmapMode, Objective, SearchConfig } from './lib/config';
import {
  DOF_META,
  DOF_ORDER,
  IDENTITY,
  binOf,
  cellRangeForKey,
  createDefaultConfig,
  dofValueLabel,
  enabledDofs,
  narrowDof,
  planGrid,
} from './lib/config';
import type { HeatmapData, Optimum, SearchResult } from './lib/heatmap';
import { bestOf, buildHeatmap, candidateAt, dataToParam, describeCell, findOptima } from './lib/heatmap';
import type { DataRect } from './lib/heatmap';
import { buildExample, exampleById, type Example } from './lib/examples';
import { loadImageFile, type Img } from './lib/image';
import { buildSamples, type SampleSet } from './lib/sampling';
import { polish, runSearch } from './lib/search';

const BATCH = 8192;

type View = 'landing' | 'studio' | 'guide';

function clearUrlHash(): void {
  if (typeof window === 'undefined' || !window.location.hash) return;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

interface Frame {
  id: number;
  cfg: SearchConfig;
  result: SearchResult | null;
  signature: string | null;
  /** the parent heatmap cell this frame was opened from */
  cell: Cell | null;
  /** region this level covers, in ROOT data coordinates (null for the root) */
  root: DataRect | null;
  label: string;
  explored: Cell[];
}

function signatureOf(imgA: string | null, imgB: string | null, cfg: SearchConfig): string {
  return JSON.stringify({
    a: imgA,
    b: imgB,
    sampling: cfg.sampling,
    limits: cfg.limits,
    objective: cfg.objective,
    dofs: cfg.dofs,
    mode: cfg.mode,
    stochastic: cfg.stochastic,
    refine: cfg.refine,
  });
}

/** heatmap grid size a config produces (mirrors buildHeatmap) */
function gridDims(cfg: SearchConfig): { gx: number; gy: number } {
  const gx = Math.max(1, Math.round(cfg.dofs[cfg.heatmap.x].steps));
  const gy =
    enabledDofs(cfg).length > 1 && cfg.heatmap.y !== cfg.heatmap.x
      ? Math.max(1, Math.round(cfg.dofs[cfg.heatmap.y].steps))
      : 1;
  return { gx, gy };
}

interface CellInfo {
  levelId: number;
  cell: Cell;
  text: string;
  params: Affine | null;
  score: number;
  known: boolean;
}

interface Level {
  frame: Frame;
  cfg: SearchConfig;
  result: SearchResult;
  root: DataRect;
  hm: HeatmapData;
}

function cfgForExample(ex: Example): SearchConfig {
  const cfg = createDefaultConfig();
  for (const k of DOF_ORDER) {
    const sug = ex.suggest?.[k];
    if (!sug) continue;
    cfg.dofs[k] = { ...cfg.dofs[k], ...sug, enabled: sug.enabled ?? true };
  }
  return cfg;
}

export default function App() {
  const [gpu, setGpu] = useState<GPUEnv | null>(null);
  const [gpuError, setGpuError] = useState<string | null>(null);
  const [view, setView] = useState<View>(() =>
    typeof window !== 'undefined' && window.location.hash === '#guide' ? 'guide' : 'landing',
  );
  const [guideFrom, setGuideFrom] = useState<'landing' | 'studio'>('landing');

  const [imgA, setImgA] = useState<Img | null>(null);
  const [imgB, setImgB] = useState<Img | null>(null);
  const [truth, setTruth] = useState<Affine | null>(null);
  const [activeExample, setActiveExample] = useState<string | null>(null);
  const [busyLoad, setBusyLoad] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const frameIdRef = useRef(1);
  const [frames, setFrames] = useState<Frame[]>(() => [
    { id: 0, cfg: createDefaultConfig(), result: null, signature: null, cell: null, root: null, label: 'full space', explored: [] },
  ]);

  const [aligner, setAligner] = useState<Aligner | null>(null);
  const [alignerError, setAlignerError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [runError, setRunError] = useState<string | null>(null);

  const [hover, setHover] = useState<Target | null>(null);
  const [selected, setSelected] = useState<Target | null>(null);
  const [picked, setPicked] = useState<Affine | null>(null);
  const [camera, setCamera] = useState<Camera>(INITIAL_CAMERA);
  const [viewOpts, setViewOpts] = useState<ViewOpts>(DEFAULT_VIEW);
  const [measure, setMeasure] = useState<Measure | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [queued, setQueued] = useState<{ id: number; cfg: SearchConfig } | null>(null);
  const [autoRefine, setAutoRefine] = useState(true);

  const frame = frames[frames.length - 1];
  const cfg = frame.cfg;
  const result = frame.result;

  /* ------------------------------------------------------------- analytics */
  useEffect(() => {
    trackPageView(view);
    if (view !== 'guide') clearUrlHash();
  }, [view]);

  const openGuide = useCallback(() => {
    setGuideFrom(view === 'studio' ? 'studio' : 'landing');
    setView('guide');
    track('guide_open');
    if (window.location.hash !== '#guide') {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#guide`);
    }
  }, [view]);

  const closeGuide = useCallback(() => {
    setView(guideFrom);
    clearUrlHash();
  }, [guideFrom]);

  // A same-document navigation to #guide (pasting the URL while the app is
  // already open) does not remount the app, so listen for it explicitly.
  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash !== '#guide') return;
      setGuideFrom((prev) => (view === 'studio' ? 'studio' : view === 'landing' ? 'landing' : prev));
      setView('guide');
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [view]);

  /* ---------------------------------------------------------------- gpu */
  useEffect(() => {
    let alive = true;
    initGPU()
      .then((g) => alive && setGpu(g))
      .catch((e: unknown) => {
        if (!alive) return;
        track('webgpu_unavailable');
        setGpuError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  /* ---------------------------------------------------------------- samples + evaluator */
  const samples: SampleSet | null = useMemo(() => {
    if (!imgA) return null;
    try {
      return buildSamples(imgA, cfg.sampling);
    } catch {
      return null;
    }
  }, [imgA, cfg.sampling]);

  useEffect(() => {
    if (!gpu || !imgB || !samples || samples.count === 0) {
      setAligner(null);
      return;
    }
    try {
      const a = new Aligner(gpu.device, imgB, samples, cfg.limits, BATCH);
      setAlignerError(null);
      setAligner(a);
      return () => a.dispose();
    } catch (e) {
      setAlignerError(e instanceof Error ? e.message : String(e));
      setAligner(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpu, imgB, samples, cfg.limits]);

  const alignerRef = useRef<Aligner | null>(null);
  const frameRef = useRef<Frame>(frame);
  const framesRef = useRef<Frame[]>(frames);
  const imgIdsRef = useRef<{ a: string | null; b: string | null }>({ a: null, b: null });
  useEffect(() => {
    alignerRef.current = aligner;
  }, [aligner]);
  frameRef.current = frame;
  framesRef.current = frames;
  useEffect(() => {
    imgIdsRef.current = { a: imgA?.id ?? null, b: imgB?.id ?? null };
  }, [imgA, imgB]);

  /* ---------------------------------------------------------------- running */
  const stopRef = useRef(false);

  const runFrame = useCallback(async (frameId: number, cfgNow: SearchConfig) => {
    const al = alignerRef.current;
    if (!al) return;
    stopRef.current = false;
    setRunning(true);
    setRunError(null);
    setPicked(null);
    setHover(null);
    setSelected(null);
    setProgress({ done: 0, total: 1 });
    const sigNow = signatureOf(imgIdsRef.current.a, imgIdsRef.current.b, cfgNow);
    track('search_run', {
      strategy: cfgNow.mode,
      objective: cfgNow.objective,
      dofs: enabledDofs(cfgNow).length,
      candidates: planGrid(cfgNow).count,
      samples: al.sampleCount,
    });
    try {
      const r = await runSearch({
        evaluate: (p, n) => {
          if (alignerRef.current !== al) throw new Error('__cancelled');
          return al.evaluate(p, n, cfgNow.objective);
        },
        batch: BATCH,
        cfg: cfgNow,
        onProgress: (done, total) => {
          if (stopRef.current) throw new Error('__cancelled');
          setProgress({ done, total });
        },
      });
      track('search_complete', {
        strategy: cfgNow.mode,
        objective: cfgNow.objective,
        candidates: r.count,
        best_score: Number(bestOf(r).score.toFixed(4)),
      });
      setFrames((fs) => fs.map((f) => (f.id === frameId ? { ...f, result: r, signature: sigNow } : f)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== '__cancelled') {
        track('search_error');
        setRunError(msg);
      }
    } finally {
      setRunning(false);
    }
  }, []);

  /* if the GPU goes away mid-session, say so instead of silently stopping */
  useEffect(() => {
    if (!gpu) return;
    let alive = true;
    gpu.device.lost.then((info) => {
      if (!alive) return;
      setRunning(false);
      setGpuError(`GPU device lost (${info.reason}): ${info.message || 'the driver reset the device'}`);
    });
    return () => {
      alive = false;
    };
  }, [gpu]);

  useEffect(() => {
    if (!queued) return;
    setQueued(null);
    void runFrame(queued.id, queued.cfg);
  }, [queued, runFrame]);

  /* auto-run whenever a new evaluator appears (new images / sampling) */
  const autoRanFor = useRef<Aligner | null>(null);
  useEffect(() => {
    if (!aligner || !imgA || !imgB) return;
    if (autoRanFor.current === aligner) return;
    autoRanFor.current = aligner;
    const top = frameRef.current;
    void runFrame(top.id, top.cfg);
  }, [aligner, imgA, imgB, runFrame]);

  /* ---------------------------------------------------------------- derived */
  // every completed level is kept as a layer of the detail pyramid, positioned
  // in root-grid coordinates so the camera can be shared by all of them
  const rootDims = useMemo(() => gridDims(frames[0].cfg), [frames]);
  const rootRect: DataRect = useMemo(
    () => ({ x0: 0, y0: 0, x1: rootDims.gx, y1: rootDims.gy }),
    [rootDims],
  );
  const levelLayers: Level[] = useMemo(
    () =>
      frames
        .filter((f) => f.result !== null)
        .map((f) => ({
          frame: f,
          cfg: f.cfg,
          result: f.result as SearchResult,
          root: f.root ?? rootRect,
          hm: buildHeatmap(f.result as SearchResult, f.cfg, f.cfg.heatmap.x, f.cfg.heatmap.y, f.cfg.heatmap.mode),
        })),
    [frames, rootRect],
  );
  const activeLevelRef = useRef<Level | null>(null);
  activeLevelRef.current = levelLayers.length ? levelLayers[levelLayers.length - 1] : null;
  const levelLayersRef = useRef<Level[]>([]);
  levelLayersRef.current = levelLayers;
  const layers = useMemo(() => levelLayers.map((l) => ({ id: l.frame.id, hm: l.hm, root: l.root })), [levelLayers]);
  const activeLevel = levelLayers.length ? levelLayers[levelLayers.length - 1] : null;
  const hm: HeatmapData | null = activeLevel?.hm ?? null;
  const activeResult: SearchResult | null = activeLevel?.result ?? null;
  const optima: Optimum[] = useMemo(
    () => (hm && activeResult ? findOptima(hm, activeResult, 14) : []),
    [hm, activeResult],
  );
  const bestInfo = activeResult ? bestOf(activeResult) : null;

  /** resolve a hit on any layer into label + transform */
  const infoFor = useCallback(
    (t: Target | null): CellInfo | null => {
      if (!t) return null;
      const lvl = levelLayers.find((l) => l.frame.id === t.levelId);
      if (!lvl) return null;
      const { hm: lhm, result: lres } = lvl;
      if (t.cell.x < 0 || t.cell.x >= lhm.gx || t.cell.y < 0 || t.cell.y >= lhm.gy) return null;
      const idx = lhm.argIdx[t.cell.y * lhm.gx + t.cell.x];
      return {
        levelId: t.levelId,
        cell: t.cell,
        text: describeCell(lhm, t.cell),
        params: idx >= 0 ? candidateAt(lres, idx) : null,
        score: lhm.values[t.cell.y * lhm.gx + t.cell.x],
        known: idx >= 0,
      };
    },
    [levelLayers],
  );
  const hoverInfo = useMemo(() => infoFor(hover), [infoFor, hover]);
  const selectedInfo = useMemo(() => infoFor(selected), [infoFor, selected]);
  const exploredByLayer = useMemo(() => {
    const m = new Map<number, Set<string>>();
    for (const f of frames) m.set(f.id, new Set(f.explored.map((c) => `${c.x},${c.y}`)));
    return m;
  }, [frames]);

  const hoveredParams: Affine | null = hoverInfo?.params ?? null;

  const current = picked ?? bestInfo?.params ?? IDENTITY;
  const viewTransform = hoveredParams ?? current;
  const viewKey = JSON.stringify(viewTransform);
  const stale = !!result && frame.signature !== signatureOf(imgA?.id ?? null, imgB?.id ?? null, cfg);

  /* live mutual information for whatever transform is displayed */
  const measureRef = useRef(0);
  useEffect(() => {
    const al = alignerRef.current;
    if (!al || !imgB) return;
    const ticket = ++measureRef.current;
    const raf = requestAnimationFrame(() => {
      setMeasuring(true);
      al.measure(viewTransform)
        .then((m) => {
          if (measureRef.current === ticket) {
            setMeasure(m);
            setMeasuring(false);
          }
        })
        .catch(() => {
          if (measureRef.current === ticket) setMeasuring(false);
        });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, aligner, imgB]);

  /* the camera is expressed in root-grid coordinates and only resets with the pair */
  const pairKey = `${imgA?.id ?? ''}:${imgB?.id ?? ''}`;
  useEffect(() => {
    setCamera(INITIAL_CAMERA);
    setSelected(null);
  }, [pairKey]);

  /* ---------------------------------------------------------------- actions */
  const openExample = useCallback((ex: Example) => {
    track('example_open', { example: ex.id });
    setBusyLoad(true);
    setLoadError(null);
    setView('studio');
    setFrames([
      { id: frameIdRef.current++, cfg: cfgForExample(ex), result: null, signature: null, cell: null, root: null, label: 'full space', explored: [] },
    ]);
    setPicked(null);
    setHover(null);
    setSelected(null);
    setMeasure(null);
    // let the shell paint before the (synchronous) scene synthesis
    setTimeout(() => {
      try {
        const { a, b } = buildExample(ex);
        setImgA(a);
        setImgB(b);
        setTruth(ex.truth);
        setActiveExample(ex.id);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyLoad(false);
      }
    }, 10);
  }, []);

  const newProject = useCallback(() => {
    track('new_project');
    setView('studio');
    setImgA(null);
    setImgB(null);
    setTruth(null);
    setActiveExample(null);
    setFrames([
      { id: frameIdRef.current++, cfg: createDefaultConfig(), result: null, signature: null, cell: null, root: null, label: 'full space', explored: [] },
    ]);
    setPicked(null);
    setHover(null);
    setSelected(null);
    setMeasure(null);
    setLoadError(null);
  }, []);

  const onFile = useCallback(async (which: 'a' | 'b', file: File) => {
    setBusyLoad(true);
    setLoadError(null);
    try {
      const img = await loadImageFile(file);
      track('image_load', { slot: which });
      if (which === 'a') setImgA(img);
      else setImgB(img);
      setTruth(null);
      setActiveExample(null);
      setFrames((fs) => fs.map((f) => ({ ...f, result: null, signature: null, explored: [] })));
      setPicked(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyLoad(false);
    }
  }, []);

  const onSwap = useCallback(() => {
    track('image_swap');
    setImgA(imgB);
    setImgB(imgA);
    setTruth(null);
    setFrames((fs) => fs.map((f) => ({ ...f, result: null, signature: null, explored: [] })));
    setPicked(null);
  }, [imgA, imgB]);

  const patchCfg = useCallback((fn: (c: SearchConfig) => SearchConfig) => {
    setFrames((fs) => fs.map((f, i) => (i === fs.length - 1 ? { ...f, cfg: fn(f.cfg) } : f)));
  }, []);

  /**
   * Switching the objective changes the meaning of every stored score, so the
   * detail pyramid is reset and the root space is re-run with the new metric.
   */
  const onObjective = useCallback(
    (objective: Objective) => {
      const root = framesRef.current[0];
      if (running || !root || root.cfg.objective === objective) return;
      track('objective_change', { objective });
      const id = frameIdRef.current++;
      const cfgNext = { ...root.cfg, objective };
      setFrames([
        { id, cfg: cfgNext, result: null, signature: null, cell: null, root: null, label: 'full space', explored: [] },
      ]);
      setCamera(INITIAL_CAMERA);
      setPicked(null);
      setHover(null);
      setSelected(null);
      setQueued({ id, cfg: cfgNext });
    },
    [running],
  );

  const onAxis = useCallback(
    (axis: 'x' | 'y', key: DofKey) => {
      track('heatmap_axis', { axis, key });
      patchCfg((c) => {
        const next = { ...c.heatmap, [axis]: key } as SearchConfig['heatmap'];
        if (next.x === next.y) {
          const other = axis === 'x' ? 'y' : 'x';
          next[other] = DOF_ORDER.find((k) => c.dofs[k].enabled && k !== key) ?? key;
        }
        return { ...c, heatmap: next };
      });
    },
    [patchCfg],
  );

  const onMode = useCallback(
    (m: HeatmapMode) => {
      track('heatmap_mode', { mode: m });
      patchCfg((c) => ({ ...c, heatmap: { ...c.heatmap, mode: m } }));
    },
    [patchCfg],
  );

  const exploreCell = useCallback(
    (target: Target) => {
      const all = levelLayersRef.current;
      const level = all.find((l) => l.frame.id === target.levelId) ?? activeLevelRef.current;
      const cell = target.cell;
      if (!level || running) return;
      track('heatmap_dive', { depth: all.length + 1 });
      const { hm: lhm, cfg: lcfg, root: lroot, result: lres } = level;
      const idx = lhm.argIdx[cell.y * lhm.gx + cell.x];
      // an unexplored cell has no representative transform — we still narrow the
      // two mapped axes and leave the hidden ones at their current range
      const base = idx >= 0 ? candidateAt(lres, idx) : null;
      const xKey = lhm.xKey;
      const yKey = lhm.yKey;
      const rx = cellRangeForKey(lcfg, xKey, cell.x);
      const ry = lhm.gy > 1 ? cellRangeForKey(lcfg, yKey, cell.y) : null;
      let next = narrowDof(lcfg, xKey, rx.min, rx.max);
      if (ry) next = narrowDof(next, yKey, ry.min, ry.max);
      if (base) {
        // freeze the hidden dimensions inside the cell that produced this value
        for (const k of enabledDofs(lcfg)) {
          if (k === xKey || (ry && k === yKey)) continue;
          const b = binOf(k, base[k], lcfg);
          const r = cellRangeForKey(lcfg, k, b);
          next = narrowDof(next, k, r.min, r.max);
        }
      }
      const id = frameIdRef.current++;
      const xVal = base ? base[xKey] : (rx.min + rx.max) / 2;
      const yVal = base && ry ? base[yKey] : ry ? (ry.min + ry.max) / 2 : 0;
      const label =
        `${DOF_META[xKey].short} ${dofValueLabel(xKey, xVal)}` +
        (ry ? ` · ${DOF_META[yKey].short} ${dofValueLabel(yKey, yVal)}` : '');
      // the cell's extent in root coordinates
      const lx = (i: number) => lroot.x0 + (i / lhm.gx) * (lroot.x1 - lroot.x0);
      const ly = (j: number) => lroot.y0 + (j / lhm.gy) * (lroot.y1 - lroot.y0);
      const cellRoot: DataRect = { x0: lx(cell.x), y0: ly(cell.y), x1: lx(cell.x + 1), y1: ly(cell.y + 1) };
      setFrames((fs) => {
        const at = fs.findIndex((f) => f.id === level.frame.id);
        const cut = at >= 0 ? at + 1 : fs.length;
        return [
          ...fs.slice(0, cut).map((f, i) =>
            i === cut - 1 ? { ...f, explored: [...f.explored, cell] } : f,
          ),
          { id, cfg: next, result: null, signature: null, cell, root: cellRoot, label, explored: [] },
        ];
      });
      setPicked(null);
      setHover(null);
      setSelected(null);
      setQueued({ id, cfg: next });
    },
    [running],
  );

  /**
   * Re-search exactly the visible region with the same step count. The new grid
   * spans the same physical interval, so the camera only has to reset to "fit"
   * and the framing is untouched — infinite zoom, no snap.
   */
  const subdivide = useCallback(
    (rectRoot: DataRect) => {
      const all = levelLayersRef.current;
      if (running || !all.length) return;
      track('heatmap_subdivide', { layers: all.length + 1 });
      // base the new search on the deepest level that covers the middle of the
      // window; if we have panned outside every level, fall back to the root and
      // let the parameter range extrapolate
      const mx = (rectRoot.x0 + rectRoot.x1) / 2;
      const my = (rectRoot.y0 + rectRoot.y1) / 2;
      let baseIndex = 0;
      for (let i = all.length - 1; i >= 0; i--) {
        const r = all[i].root;
        if (mx >= Math.min(r.x0, r.x1) && mx <= Math.max(r.x0, r.x1) && my >= Math.min(r.y0, r.y1) && my <= Math.max(r.y0, r.y1)) {
          baseIndex = i;
          break;
        }
      }
      const level = all[baseIndex];
      const { hm: lhm, cfg: lcfg, root: lroot } = level;
      // root data coords -> this level's cell coordinates
      const toLevel = (d: number, lo: number, hi: number, n: number) => ((d - lo) / Math.max(1e-9, hi - lo)) * n;
      const xKey = lhm.xKey;
      const yKey = lhm.yKey;
      const xa = dataToParam(lcfg, xKey, toLevel(rectRoot.x0, lroot.x0, lroot.x1, lhm.gx));
      const xb = dataToParam(lcfg, xKey, toLevel(rectRoot.x1, lroot.x0, lroot.x1, lhm.gx));
      let next = narrowDof(lcfg, xKey, Math.min(xa, xb), Math.max(xa, xb));
      if (lhm.gy > 1) {
        const ya = dataToParam(lcfg, yKey, toLevel(rectRoot.y0, lroot.y0, lroot.y1, lhm.gy));
        const yb = dataToParam(lcfg, yKey, toLevel(rectRoot.y1, lroot.y0, lroot.y1, lhm.gy));
        next = narrowDof(next, yKey, Math.min(ya, yb), Math.max(ya, yb));
      }
      const id = frameIdRef.current++;
      const spanCells = Math.abs(
        toLevel(rectRoot.x1, lroot.x0, lroot.x1, lhm.gx) - toLevel(rectRoot.x0, lroot.x0, lroot.x1, lhm.gx),
      );
      const gain = lhm.gx / Math.max(0.2, spanCells);
      setFrames((fs) => {
        const at = fs.findIndex((f) => f.id === level.frame.id);
        const cut = at >= 0 ? at + 1 : fs.length;
        return [
          ...fs.slice(0, cut),
          {
            id,
            cfg: next,
            result: null,
            signature: null,
            cell: null,
            root: rectRoot,
            label: gain >= 1.05 ? `×${gain.toFixed(1)}` : `view ${(1 / gain).toFixed(1)}× wider`,
            explored: [],
          },
        ];
      });
      setPicked(null);
      setHover(null);
      setSelected(null);
      setQueued({ id, cfg: next });
    },
    [running],
  );

  const back = useCallback(() => {
    if (frames.length <= 1) return;
    setFrames((fs) => fs.slice(0, -1));
    setPicked(null);
    setHover(null);
    setSelected(null);
  }, [frames.length]);

  const onClickCell = useCallback(
    (t: Target | null) => {
      setSelected(t);
      const info = infoFor(t);
      if (info?.params) setPicked(info.params);
    },
    [infoFor],
  );

  const onManual = useCallback((a: Affine) => {
    setHover(null);
    setPicked(a);
  }, []);

  const onPolish = useCallback(async () => {
    const al = alignerRef.current;
    if (!al || !viewTransform) return;
    track('polish');
    setPolishing(true);
    try {
      const out = await polish(
        { evaluate: (p, n) => al.evaluate(p, n, frameRef.current.cfg.objective), batch: BATCH, cfg: frameRef.current.cfg },
        viewTransform,
      );
      if (out) setPicked(out.params);
    } catch {
      /* ignore */
    } finally {
      setPolishing(false);
    }
  }, [viewTransform]);

  /* ---------------------------------------------------------------- render */
  const canRun = !!aligner && !running && !!imgA && !!imgB;
  const crumbs: Crumb[] = frames.map((f) => ({ label: f.label }));
  const hasSession = !!imgA && !!imgB;

  if (view === 'guide') {
    return <InfoPage onBack={closeGuide} onNew={newProject} onExample={openExample} />;
  }

  if (view === 'landing') {
    return (
      <Landing
        gpu={gpu}
        gpuError={gpuError}
        hasSession={hasSession}
        onNew={newProject}
        onResume={() => {
          track('resume_session');
          setView('studio');
        }}
        onExample={openExample}
        onGuide={openGuide}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <button className="backBtn" onClick={() => setView('landing')} title="Back to projects">
            ←
          </button>
          <span className="logo">mi-align</span>
          <span className="tagline">
            {activeExample ? exampleById(activeExample)?.label : imgA && imgB ? 'custom pair' : 'new project'}
            {imgA && imgB ? ` · A ${imgA.width}×${imgA.height} → B ${imgB.width}×${imgB.height}` : ''}
          </span>
        </div>
        <div className="topRight">
          {running ? <span className="chip live">searching…</span> : null}
          <button className="ghost small" onClick={openGuide} title="How the search and mutual information work">
            Field guide
          </button>
          {gpu ? (
            <span className="chip ok" title={gpu.info}>
              WebGPU · {gpu.info}
            </span>
          ) : gpuError ? (
            <span className="chip bad">WebGPU unavailable</span>
          ) : (
            <span className="chip">initialising GPU…</span>
          )}
        </div>
      </header>

      {gpuError ? (
        <div className="fatal">
          <h2>WebGPU could not start</h2>
          <p>{gpuError}</p>
          <p className="dim">
            Try Chrome or Edge 113+, make sure hardware acceleration is enabled, and check chrome://gpu.
          </p>
          <button className="primary" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      ) : (
        <main className="layout">
          <aside className="col left">
            <DataPanel
              imgA={imgA}
              imgB={imgB}
              truth={truth}
              busy={running || busyLoad}
              onFile={onFile}
              onSwap={onSwap}
              onClearTruth={() => setTruth(null)}
            />
            <SearchPanel
              cfg={cfg}
              current={viewTransform}
              sampleCount={samples?.count ?? 0}
              running={running}
              progress={progress}
              disabled={!canRun}
              stale={stale}
              onChange={patchCfg}
              onObjective={onObjective}
              onRun={() => void runFrame(frame.id, cfg)}
              onStop={() => {
                stopRef.current = true;
              }}
            />
            {loadError ? <div className="errorBox">{loadError}</div> : null}
            {alignerError ? <div className="errorBox">GPU setup: {alignerError}</div> : null}
            {runError ? <div className="errorBox">Search: {runError}</div> : null}
          </aside>

          <section className="col center">
            <div className="card viewerCard">
              <div className="viewerHead">
                <h2>Overlay</h2>
                <div className="headRight">
                  <span className="dim tiny">
                    {hoveredParams ? 'previewing hovered cell' : picked ? 'manual transform' : 'best transform'}
                  </span>
                  {picked ? (
                    <button className="linkBtn" onClick={() => setPicked(null)}>
                      reset to best
                    </button>
                  ) : null}
                </div>
              </div>
              <WarpCanvas
                device={gpu?.device ?? null}
                format={gpu?.format ?? 'bgra8unorm'}
                imgA={imgA}
                imgB={imgB}
                transform={viewTransform}
                opts={viewOpts}
                onManual={hasSession ? onManual : undefined}
              />
              <ViewBar opts={viewOpts} onChange={setViewOpts} />
              <p className="hint tight">
                drag the moving image to translate · <kbd>shift</kbd>+drag sideways to rotate · <kbd>ctrl</kbd>+drag
                radially to scale · <kbd>ctrl</kbd>+scroll to zoom out
              </p>
            </div>

            <div className="card">
              <div className="viewerHead">
                <h2>Mutual information</h2>
                <div className="dim tiny">live · updates while you drag</div>
              </div>
              <MiPanel measure={measure} pending={measuring} />
              <p className="hint tight">
                MI makes no assumption about brightness: a tight diagonal joint histogram means the two images agree.
                Rotating away from the optimum smears the histogram and the value drops.
              </p>
            </div>

            <StatsPanel
              result={activeResult}
              cfg={activeLevel?.cfg ?? cfg}
              viewTransform={viewTransform}
              truth={truth}
              polishing={polishing}
              onPolish={() => void onPolish()}
            />
          </section>

          <aside className="col right">
            <HeatmapPanel
              hm={hm}
              layers={layers}
              root={rootDims}
              optima={optima}
              cfg={cfg}
              result={activeResult}
              hover={hover}
              selected={selected}
              hoverInfo={hoverInfo}
              selectedInfo={selectedInfo}
              exploredByLayer={exploredByLayer}
              camera={camera}
              current={current}
              crumbs={crumbs}
              autoRefine={autoRefine}
              busy={running || !frame.result}
              onToggleAutoRefine={(v) => {
                track('auto_refine_toggle', { enabled: v });
                setAutoRefine(v);
              }}
              onSubdivide={subdivide}
              onBack={back}
              onHover={setHover}
              onSelect={onClickCell}
              onExplore={exploreCell}
              onCamera={setCamera}
              onAxis={onAxis}
              onMode={onMode}
              onPickOptimum={(o) => {
                track('optimum_pick');
                setPicked(o.params);
                const topId = layers.length ? layers[layers.length - 1].id : -1;
                setSelected({ levelId: topId, cell: { x: o.cellX, y: o.cellY } });
              }}
            />
            <div className="card foot">
              <p className="hint tight">
                {result?.objective === 'mi'
                  ? 'Score = normalised mutual information (NMI) between sampled pixels of A (mapped through the candidate transform) and the target B, minus an overlap penalty.'
                  : 'Score = zero-mean NCC between sampled pixels of A (mapped through the candidate transform) and the target B, minus an overlap penalty.'}{' '}
                {samples ? `${samples.count.toLocaleString()} source samples` : ''}
                {samples?.capped ? ' (capped)' : ''}.
              </p>
              <p className="hint tight">
                The landscape is 6-dimensional, so the map shows a 2-D shadow: each cell is the maximum over the
                dimensions you did not pick. Peaks are real local optima of the full space — dive into a cell to
                re-search just that neighbourhood, or lock axes and re-run to slice through the space.
              </p>
            </div>
          </aside>
        </main>
      )}
    </div>
  );
}
