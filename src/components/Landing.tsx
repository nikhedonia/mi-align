import { useEffect, useMemo, useState } from 'react';
import type { Example } from '../lib/examples';
import { EXAMPLES, previewPair } from '../lib/examples';
import type { GPUEnv } from '../gpu/device';

interface Preview {
  a: string;
  b: string;
  aw: number;
  ah: number;
  bw: number;
  bh: number;
}

interface Props {
  gpu: GPUEnv | null;
  gpuError: string | null;
  hasSession: boolean;
  onNew: () => void;
  onResume: () => void;
  onExample: (ex: Example) => void;
  onGuide: () => void;
}

function truthLine(ex: Example): string {
  const bits: string[] = [];
  if (Math.abs(ex.truth.scale - 1) > 1e-3) bits.push(`scale ${ex.truth.scale.toFixed(3)}×`);
  const deg = (ex.truth.theta * 180) / Math.PI;
  if (Math.abs(deg) > 0.05) bits.push(`rotation ${deg.toFixed(1)}°`);
  const aspd = Math.abs(ex.truth.aspect - 1) > 1e-3;
  const shd = Math.abs(ex.truth.shear) > 1e-3;
  if (aspd) bits.push(`aspect ${ex.truth.aspect.toFixed(3)}`);
  if (shd) bits.push(`shear ${ex.truth.shear.toFixed(3)}`);
  const px = Math.hypot(ex.truth.tx, ex.truth.ty);
  if (px > 0.01) bits.push(`shift ${(px * 100).toFixed(0)}%`);
  return bits.length ? bits.join(' · ') : 'identity';
}

function Pair({
  preview,
  aW,
  aH,
  bW,
  bH,
}: {
  preview?: Preview;
  aW: number;
  aH: number;
  bW: number;
  bH: number;
}) {
  const maxH = 96;
  const scale = Math.min(maxH / aH, maxH / bH, 92 / aW, 92 / bW, 1);
  return (
    <div className="pair">
      <div className="pairSlot" style={{ width: aW * scale, height: aH * scale }}>
        {preview ? <img src={preview.a} alt="image A" /> : <span className="skeleton" />}
        <span className="pairTag">A</span>
      </div>
      <svg className="pairArrow" width="22" height="10" viewBox="0 0 22 10" aria-hidden>
        <path d="M0 5h16M13 1.5 17 5l-4 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
      <div className="pairSlot" style={{ width: bW * scale, height: bH * scale }}>
        {preview ? <img src={preview.b} alt="image B" /> : <span className="skeleton" />}
        <span className="pairTag">B</span>
      </div>
    </div>
  );
}

export function Landing({ gpu, gpuError, hasSession, onNew, onResume, onExample, onGuide }: Props) {
  const [previews, setPreviews] = useState<Record<string, Preview>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const ex of EXAMPLES) {
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, 16));
        if (cancelled) return;
        try {
          const p = previewPair(ex, 150);
          if (cancelled) return;
          setPreviews((prev) => ({ ...prev, [ex.id]: p }));
        } catch {
          /* ignore a broken preview */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const gpuLabel = useMemo(() => {
    if (gpuError) return 'WebGPU unavailable';
    if (!gpu) return 'initialising GPU…';
    return gpu.info;
  }, [gpu, gpuError]);

  return (
    <div className="landing">
      <header className="landing-top">
        <div className="brand">
          <span className="logo">mi-align</span>
          <span className="tagline">affine image alignment · WebGPU</span>
        </div>
        <div className="topgap" />
        <span className={`chip ${gpuError ? 'bad' : gpu ? 'ok' : ''}`} title={gpuLabel}>
          {gpuLabel}
        </span>
        <button className="ghost" onClick={onGuide} title="How the search and mutual information work">
          Field guide
        </button>
        <button className="primary" onClick={onNew}>
          New project
        </button>
      </header>

      <main className="landing-main">
        <section className="landing-hero">
          <h1>
            Find the transform.
            <br />
            <em>Brute-force it on the GPU.</em>
          </h1>
          <p>
            Load two images and let the GPU score tens of thousands of candidate affine transforms in a
            single pass. The result is a map of the whole similarity landscape — global optimum, competing
            local optima, and the ridges in between.
          </p>
          <div className="landing-actions">
            <button className="primary" onClick={onNew}>
              Start aligning
            </button>
            <button className="ghost" onClick={onGuide}>
              How it works
            </button>
          </div>
        </section>

        {gpuError ? (
          <div className="errorBox">
            <strong>WebGPU could not start.</strong> {gpuError}
          </div>
        ) : null}

        <section className="landing-section">
          <div className="section-head">
            <h2>Start</h2>
            <span className="section-sub">bring your own pair, or resume this session</span>
          </div>
          <div className="start-grid">
            <button className="start-tile" onClick={onNew}>
              <span className="startIcon">＋</span>
              <span className="startTitle">New project</span>
              <span className="startBlurb">
                Drop two images (any size, any aspect) and search the affine space between them.
              </span>
            </button>
            {hasSession ? (
              <button className="start-tile" onClick={onResume}>
                <span className="startIcon">↩</span>
                <span className="startTitle">Continue session</span>
                <span className="startBlurb">Go back to the pair and search results you already had open.</span>
              </button>
            ) : null}
          </div>
        </section>

        <section className="landing-section">
          <div className="section-head">
            <h2>Examples</h2>
            <span className="section-sub">each one opens with a known ground truth to check against</span>
          </div>
          <div className="ex-grid">
            {EXAMPLES.map((ex) => (
              <article className="ex-card" key={ex.id}>
                <button className="ex-top" onClick={() => onExample(ex)} title={`Open ${ex.label}`}>
                  <Pair preview={previews[ex.id]} aW={ex.a.w} aH={ex.a.h} bW={ex.b.w} bH={ex.b.h} />
                </button>
                <div className="ex-body">
                  <div className="ex-head">
                    <h3>{ex.label}</h3>
                    <span className="ex-tag">{ex.tag}</span>
                  </div>
                  <p>{ex.blurb}</p>
                  <div className="ex-meta">
                    <span className="mono">
                      A {ex.a.w}×{ex.a.h} · B {ex.b.w}×{ex.b.h}
                    </span>
                    <span className="mono dim">truth: {truthLine(ex)}</span>
                  </div>
                  <button className="ghost small" onClick={() => onExample(ex)}>
                    open example
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <footer className="landing-foot">
          <span>zero-mean NCC · overlap penalty · mutual information</span>
          <span className="sep">·</span>
          <span>everything runs locally on your GPU</span>
          <span className="sep">·</span>
          <button className="linkBtn" onClick={onGuide}>
            read the field guide
          </button>
        </footer>
      </main>
    </div>
  );
}
