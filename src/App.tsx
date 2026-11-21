import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DataPanel } from './components/DataPanel';
import { SearchPanel } from './components/SearchPanel';
import { StatsPanel } from './components/StatsPanel';
import { HeatmapPanel } from './components/HeatmapPanel';
import { ViewBar } from './components/ViewBar';
import { WarpCanvas } from './components/WarpCanvas';
import type { Cell } from './components/HeatmapCanvas';
import { initGPU, type GPUEnv } from './gpu/device';
import { Aligner } from './gpu/aligner';
import { DEFAULT_VIEW, type ViewOpts } from './gpu/warp';
import type { Affine, DofKey, HeatmapMode, SearchConfig } from './lib/config';
import { DOF_ORDER, IDENTITY, createDefaultConfig } from './lib/config';
import type { SearchResult, HeatmapData, Optimum } from './lib/heatmap';
import { bestOf, buildHeatmap, candidateAt, findOptima } from './lib/heatmap';
import { EXAMPLES, buildExample, type Example } from './lib/examples';
import { loadImageFile, type Img } from './lib/image';
import { buildSamples, type SampleSet } from './lib/sampling';
import { polish, runSearch } from './lib/search';

const BATCH = 8192;

export default function App() {
  const [gpu, setGpu] = useState<GPUEnv | null>(null);
  const [gpuError, setGpuError] = useState<string | null>(null);

  const [imgA, setImgA] = useState<Img | null>(null);
  const [imgB, setImgB] = useState<Img | null>(null);
  const [truth, setTruth] = useState<Affine | null>(null);
  const [activeExample, setActiveExample] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyLoad, setBusyLoad] = useState(false);

  const [cfg, setCfg] = useState<SearchConfig>(createDefaultConfig);
  const [viewOpts, setViewOpts] = useState<ViewOpts>(DEFAULT_VIEW);

  const [aligner, setAligner] = useState<Aligner | null>(null);
  const [alignerError, setAlignerError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [runError, setRunError] = useState<string | null>(null);

  const [result, setResult] = useState<SearchResult | null>(null);
  const [runSignature, setRunSignature] = useState<string | null>(null);
  const [hover, setHover] = useState<Cell | null>(null);
  const [picked, setPicked] = useState<Affine | null>(null);
  const [polishing, setPolishing] = useState(false);

  /* ---------------------------------------------------------------- gpu */
  useEffect(() => {
    let alive = true;
    initGPU()
      .then((g) => {
        if (alive) setGpu(g);
      })
      .catch((e: unknown) => {
        if (alive) setGpuError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  /* ---------------------------------------------------------------- samples */
  const samples: SampleSet | null = useMemo(() => {
    if (!imgA) return null;
    try {
      return buildSamples(imgA, cfg.sampling);
    } catch {
      return null;
    }
  }, [imgA, cfg.sampling]);

  /* ---------------------------------------------------------------- evaluator */
  useEffect(() => {
    if (!gpu || !imgB || !samples || samples.count === 0) {
      setAligner(null);
      return;
    }
    try {
      const a = new Aligner(gpu.device, imgB, samples, cfg.limits, BATCH);
      setAlignerError(null);
      setAligner(a);
      return () => {
        a.dispose();
      };
    } catch (e) {
      setAlignerError(e instanceof Error ? e.message : String(e));
      setAligner(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpu, imgB, samples, cfg.limits]);

  const alignerRef = useRef<Aligner | null>(null);
  useEffect(() => {
    alignerRef.current = aligner;
  }, [aligner]);

  const cfgRef = useRef(cfg);
  useEffect(() => {
    cfgRef.current = cfg;
  }, [cfg]);

  /* ---------------------------------------------------------------- signature */
  const signature = useMemo(
    () =>
      JSON.stringify({
        a: imgA?.id ?? null,
        b: imgB?.id ?? null,
        sampling: cfg.sampling,
        limits: cfg.limits,
        dofs: cfg.dofs,
        mode: cfg.mode,
        stochastic: cfg.stochastic,
        refine: cfg.refine,
      }),
    [imgA, imgB, cfg],
  );

  const stale = !!result && runSignature !== signature;

  /* ---------------------------------------------------------------- run */
  const stopRef = useRef(false);

  const imgAIdRef = useRef<string | null>(null);
  const imgBIdRef = useRef<string | null>(null);
  useEffect(() => {
    imgAIdRef.current = imgA?.id ?? null;
    imgBIdRef.current = imgB?.id ?? null;
  }, [imgA, imgB]);

  const run = useCallback(async () => {
    const al = alignerRef.current;
    if (!al) return;
    stopRef.current = false;
    setRunning(true);
    setRunError(null);
    setPicked(null);
    setHover(null);
    setProgress({ done: 0, total: 1 });
    const cfgNow = cfgRef.current;
    const sigNow = JSON.stringify({
      a: imgAIdRef.current,
      b: imgBIdRef.current,
      sampling: cfgNow.sampling,
      limits: cfgNow.limits,
      dofs: cfgNow.dofs,
      mode: cfgNow.mode,
      stochastic: cfgNow.stochastic,
      refine: cfgNow.refine,
    });
    try {
      const r = await runSearch({
        evaluate: (p, n) => {
          if (alignerRef.current !== al) throw new Error('__cancelled');
          return al.evaluate(p, n);
        },
        batch: BATCH,
        cfg: cfgNow,
        onProgress: (done, total) => {
          if (stopRef.current) throw new Error('__cancelled');
          setProgress({ done, total });
        },
      });
      setResult(r);
      setRunSignature(sigNow);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== '__cancelled') setRunError(msg);
    } finally {
      setRunning(false);
    }
  }, []);

  /* auto-run once per evaluator instance (new images, new sampling, ...) */
  const autoRanFor = useRef<Aligner | null>(null);
  useEffect(() => {
    if (!aligner || !imgA || !imgB) return;
    if (autoRanFor.current === aligner) return;
    autoRanFor.current = aligner;
    void run();
  }, [aligner, imgA, imgB, run]);

  /* ---------------------------------------------------------------- boot example */
  useEffect(() => {
    const t = setTimeout(() => {
      const ex = EXAMPLES[0];
      try {
        const { a, b } = buildExample(ex);
        setImgA(a);
        setImgB(b);
        setTruth(ex.truth);
        setActiveExample(ex.id);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    }, 20);
    return () => clearTimeout(t);
  }, []);

  /* ---------------------------------------------------------------- derived */
  const hm: HeatmapData | null = useMemo(
    () => (result ? buildHeatmap(result, cfg, cfg.heatmap.x, cfg.heatmap.y, cfg.heatmap.mode) : null),
    [result, cfg],
  );

  const optima: Optimum[] = useMemo(() => (hm && result ? findOptima(hm, result, 14) : []), [hm, result]);

  const bestInfo = result ? bestOf(result) : null;

  const hoveredParams: Affine | null = useMemo(() => {
    if (!hm || !result || !hover) return null;
    const idx = hm.argIdx[hover.y * hm.gx + hover.x];
    return idx >= 0 ? candidateAt(result, idx) : null;
  }, [hm, result, hover]);

  const current = picked ?? bestInfo?.params ?? IDENTITY;
  const viewTransform = hoveredParams ?? current;

  /* ---------------------------------------------------------------- handlers */
  const patchCfg = useCallback((fn: (c: SearchConfig) => SearchConfig) => setCfg((c) => fn(c)), []);

  const loadPair = useCallback((ex: Example) => {
    setBusyLoad(true);
    setLoadError(null);
    // let the spinner paint before the (synchronous) generation
    setTimeout(() => {
      try {
        const { a, b } = buildExample(ex);
        setImgA(a);
        setImgB(b);
        setTruth(ex.truth);
        setActiveExample(ex.id);
        setResult(null);
        setRunSignature(null);
        setPicked(null);
        if (ex.suggest) {
          setCfg((c) => {
            const dofs = { ...c.dofs };
            for (const k of DOF_ORDER) {
              if (ex.suggest && ex.suggest[k] !== undefined) dofs[k] = { ...dofs[k], enabled: !!ex.suggest[k] };
            }
            return { ...c, dofs };
          });
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyLoad(false);
      }
    }, 10);
  }, []);

  const onFile = useCallback(async (which: 'a' | 'b', file: File) => {
    setBusyLoad(true);
    setLoadError(null);
    try {
      const img = await loadImageFile(file);
      if (which === 'a') setImgA(img);
      else setImgB(img);
      setTruth(null);
      setActiveExample(null);
      setResult(null);
      setRunSignature(null);
      setPicked(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyLoad(false);
    }
  }, []);

  const onSwap = useCallback(() => {
    setImgA(imgB);
    setImgB(imgA);
    setTruth(null);
    setResult(null);
    setRunSignature(null);
    setPicked(null);
  }, [imgA, imgB]);

  const onClickCell = useCallback(
    (cell: Cell) => {
      if (!hm || !result) return;
      const idx = hm.argIdx[cell.y * hm.gx + cell.x];
      if (idx >= 0) setPicked(candidateAt(result, idx));
    },
    [hm, result],
  );

  const onAxis = useCallback(
    (axis: 'x' | 'y', key: DofKey) =>
      patchCfg((c) => {
        const next = { ...c.heatmap, [axis]: key } as SearchConfig['heatmap'];
        if (next.x === next.y) {
          const other = axis === 'x' ? 'y' : 'x';
          const alt = DOF_ORDER.find((k) => c.dofs[k].enabled && k !== key) ?? key;
          next[other] = alt;
        }
        return { ...c, heatmap: next };
      }),
    [patchCfg],
  );

  const onMode = useCallback((m: HeatmapMode) => patchCfg((c) => ({ ...c, heatmap: { ...c.heatmap, mode: m } })), [patchCfg]);

  const onPolish = useCallback(async () => {
    const al = alignerRef.current;
    if (!al || !viewTransform) return;
    setPolishing(true);
    try {
      const out = await polish({ evaluate: (p, n) => al.evaluate(p, n), batch: BATCH, cfg: cfgRef.current }, viewTransform);
      if (out) setPicked(out.params);
    } catch {
      /* ignore */
    } finally {
      setPolishing(false);
    }
  }, [viewTransform]);

  /* ---------------------------------------------------------------- render */
  const canRun = !!aligner && !running && !!imgA && !!imgB;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">mi-align</span>
          <span className="tagline">affine image alignment · exhaustive WebGPU search</span>
        </div>
        <div className="topRight">
          {running ? <span className="chip live">searching…</span> : null}
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
        </div>
      ) : (
        <main className="layout">
          <aside className="col left">
            <DataPanel
              imgA={imgA}
              imgB={imgB}
              truth={truth}
              activeExample={activeExample}
              busy={running || busyLoad}
              onFile={onFile}
              onSwap={onSwap}
              onExample={loadPair}
              onClearTruth={() => setTruth(null)}
            />
            <SearchPanel
              cfg={cfg}
              sampleCount={samples?.count ?? 0}
              running={running}
              progress={progress}
              disabled={!canRun}
              stale={stale}
              onChange={patchCfg}
              onRun={() => void run()}
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
                <div className="dim tiny">
                  {hoveredParams ? 'previewing hovered cell' : picked ? 'picked transform' : 'best transform'}
                  {imgA && imgB ? ` · A→B` : ''}
                </div>
              </div>
              <WarpCanvas
                device={gpu?.device ?? null}
                format={gpu?.format ?? 'bgra8unorm'}
                imgA={imgA}
                imgB={imgB}
                transform={viewTransform}
                opts={viewOpts}
              />
              <ViewBar opts={viewOpts} onChange={setViewOpts} />
            </div>
            <StatsPanel
              result={result}
              cfg={cfg}
              viewTransform={viewTransform}
              truth={truth}
              polishing={polishing}
              onPolish={() => void onPolish()}
            />
          </section>

          <aside className="col right">
            <HeatmapPanel
              hm={hm}
              optima={optima}
              cfg={cfg}
              result={result}
              hover={hover}
              picked={picked ?? bestInfo?.params ?? null}
              onHover={setHover}
              onClickCell={onClickCell}
              onAxis={onAxis}
              onMode={onMode}
              onPickOptimum={(o) => setPicked(o.params)}
            />
            <div className="card foot">
              <p className="hint tight">
                Score = zero-mean NCC between sampled pixels of A (mapped through the candidate transform) and the
                target B, minus an overlap penalty. {samples ? `${samples.count.toLocaleString()} source samples` : ''}
                {samples?.capped ? ' (capped)' : ''}.
              </p>
              <p className="hint tight">
                The landscape is 6-dimensional. The map above shows a 2-D shadow: each cell is the maximum score over
                the dimensions you did not pick, so peaks are genuine local optima of the full space. Hover a cell to
                see the hidden dimensions' best values in the overlay.
              </p>
            </div>
          </aside>
        </main>
      )}
    </div>
  );
}
