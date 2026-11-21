import { useEffect, useRef, useState } from 'react';
import { matOfAffine } from '../lib/affine';
import type { Affine } from '../lib/config';
import type { Img } from '../lib/image';
import { uploadTexture } from '../gpu/device';
import { WarpRenderer, type ViewOpts } from '../gpu/warp';

interface Props {
  device: GPUDevice | null;
  format: GPUTextureFormat;
  imgA: Img | null;
  imgB: Img | null;
  transform: Affine;
  opts: ViewOpts;
  /** when provided, the image can be dragged / rotated / scaled */
  onManual?: (a: Affine) => void;
}

type Mode = 'move' | 'rot' | 'scale';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function WarpCanvas({ device, format, imgA, imgB, transform, opts, onManual }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WarpRenderer | null>(null);
  const dragRef = useRef<{ mode: Mode; x: number; y: number; base: Affine; w: number; h: number } | null>(null);
  const [version, setVersion] = useState(0);
  const [mode, setMode] = useState<Mode | null>(null);

  useEffect(() => {
    if (!device || !imgA || !imgB || !canvasRef.current) return;
    const texA = uploadTexture(device, imgA, 'warp-A');
    const texB = uploadTexture(device, imgB, 'warp-B');
    let renderer: WarpRenderer | null = null;
    try {
      renderer = new WarpRenderer(device, canvasRef.current, format, texA, texB, imgA, imgB);
      rendererRef.current = renderer;
      const el = wrapRef.current;
      if (el) renderer.resize(el.clientWidth, el.clientHeight);
      renderer.render(matOfAffine(transform), opts);
      setVersion((v) => v + 1);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err);
    }
    return () => {
      renderer?.dispose();
      rendererRef.current = null;
      texA.destroy();
      texB.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device, format, imgA, imgB]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const el = wrapRef.current;
    if (!renderer || !el) return;
    renderer.resize(el.clientWidth, el.clientHeight);
    renderer.render(matOfAffine(transform), opts);
  }, [transform, opts, version]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = rendererRef.current;
      if (!r) return;
      r.resize(el.clientWidth, el.clientHeight);
      r.render(matOfAffine(transform), opts);
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transform, opts, version]);

  /* ---- ctrl+wheel = scale down, wheel alone is left to the page ---- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !onManual || !imgB) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.002);
      onManual({ ...transform, scale: clamp(transform.scale * factor, 0.05, 20) });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [onManual, transform, imgB]);

  const local = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  };

  const centreOf = (a: Affine, w: number, h: number) => {
    if (!imgB) return { x: w / 2, y: h / 2 };
    const R = Math.max(imgB.width, imgB.height) / 2;
    return {
      x: (0.5 + (a.tx * R) / imgB.width) * w,
      y: (0.5 + (a.ty * R) / imgB.height) * h,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onManual || !imgB) return;
    const p = local(e);
    const m: Mode = e.shiftKey ? 'rot' : e.ctrlKey || e.metaKey ? 'scale' : 'move';
    dragRef.current = { mode: m, x: p.x, y: p.y, base: { ...transform }, w: p.w, h: p.h };
    setMode(m);
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers cannot be captured */
    }
    // commit whatever is currently displayed (may be a hovered cell preview)
    onManual({ ...transform });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    if (!d || !onManual || !imgB) return;
    const p = local(e);
    const RB = Math.max(imgB.width, imgB.height) / 2;
    if (d.mode === 'move') {
      const tx = d.base.tx + ((p.x - d.x) / d.w) * (imgB.width / RB);
      const ty = d.base.ty + ((p.y - d.y) / d.h) * (imgB.height / RB);
      onManual({ ...d.base, tx, ty });
    } else if (d.mode === 'rot') {
      // horizontal drag -> rotation, ~0.45 deg per pixel (no pivot singularity)
      const size = Math.max(120, Math.min(p.w, p.h));
      const dt = ((p.x - d.x) / size) * (Math.PI / 2);
      onManual({ ...d.base, theta: d.base.theta + dt });
    } else {
      // radial drag -> scale; exponential so it never explodes near the centre
      const c = centreOf(d.base, p.w, p.h);
      const size = Math.max(120, Math.min(p.w, p.h));
      const d0 = Math.hypot(d.x - c.x, d.y - c.y);
      const d1 = Math.hypot(p.x - c.x, p.y - c.y);
      onManual({ ...d.base, scale: clamp(d.base.scale * Math.exp((d1 - d0) / (0.25 * size)), 0.05, 20) });
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setMode(null);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const aspect = imgB ? imgB.width / imgB.height : 4 / 3;
  const cursor = !onManual ? 'default' : mode === 'rot' ? 'crosshair' : mode === 'scale' ? 'nwse-resize' : mode === 'move' ? 'grabbing' : 'grab';

  return (
    <div
      className="canvasWrap"
      ref={wrapRef}
      style={{ aspectRatio: `${aspect}`, maxWidth: `calc(64vh * ${aspect})`, margin: '0 auto' }}
    >
      <canvas
        ref={canvasRef}
        className="warpCanvas"
        data-drag={mode ?? 'none'}
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      {!imgA || !imgB ? <div className="canvasEmpty">Pick two images</div> : null}
    </div>
  );
}
