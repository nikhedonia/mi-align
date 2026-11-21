import { useEffect, useRef } from 'react';
import type { Affine, SearchConfig } from '../lib/config';
import { dofValueLabel } from '../lib/config';
import { heatColor } from '../lib/colormap';
import type { DataRect, HeatmapData, Optimum } from '../lib/heatmap';
import { SUBDIVIDE_CELLS, cellOf } from '../lib/heatmap';

export interface Cell {
  x: number;
  y: number;
}

export interface Camera {
  zoom: number;
  cx: number;
  cy: number;
}

export const INITIAL_CAMERA: Camera = { zoom: 1, cx: 0, cy: 0 };

/** one completed search, positioned inside the root grid */
export interface Layer {
  /** frame id */
  id: number;
  hm: HeatmapData;
  root: DataRect;
}

/** a cell addressed in the coordinate space of a particular layer */
export interface Target {
  levelId: number;
  cell: Cell;
}

interface Props {
  /** coarse -> fine; the last one is the active search space */
  layers: Layer[];
  cfg: SearchConfig;
  root: { gx: number; gy: number };
  optima: Optimum[];
  hover: Target | null;
  current: Affine | null;
  paths: Affine[][];
  selected: Target | null;
  exploredByLayer: Map<number, Set<string>>;
  camera: Camera;
  height?: number;
  autoRefine: boolean;
  busy: boolean;
  onCamera: (c: Camera) => void;
  onHover: (t: Target | null) => void;
  onSelect: (t: Target | null) => void;
  onExplore: (t: Target) => void;
  /** rect in root data coordinates */
  onSubdivide: (rect: DataRect) => void;
  /** the colour range actually used, so the legend can match the pixels */
  onRange: (lo: number, hi: number) => void;
}

const PAD_L = 44;
const PAD_B = 22;
const PAD_T = 10;
const PAD_R = 12;
const MAX_ZOOM = 4096;
const MIN_ZOOM = 0.2;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function buildBitmap(hm: HeatmapData, lo: number, hi: number): HTMLCanvasElement {
  const off = document.createElement('canvas');
  off.width = hm.gx;
  off.height = hm.gy;
  const ctx = off.getContext('2d')!;
  const img = ctx.createImageData(hm.gx, hm.gy);
  const BUCKETS = 96;
  const palette: [number, number, number][] = [];
  const tmp = new Uint8ClampedArray(4);
  for (let i = 0; i < BUCKETS; i++) {
    heatColor(i / (BUCKETS - 1), tmp, 0);
    palette.push([tmp[0], tmp[1], tmp[2]]);
  }
  const range = hi - lo || 1;
  for (let y = 0; y < hm.gy; y++) {
    for (let x = 0; x < hm.gx; x++) {
      const v = hm.values[y * hm.gx + x];
      const row = hm.gy - 1 - y;
      const o = (row * hm.gx + x) * 4;
      if (Number.isNaN(v)) {
        // unexplored: stay transparent so the coarser level shows through
        img.data[o + 3] = 0;
        continue;
      }
      const c = palette[clamp(Math.round(((v - lo) / range) * (BUCKETS - 1)), 0, BUCKETS - 1)];
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return off;
}

export function HeatmapCanvas({
  layers,
  cfg,
  root,
  optima,
  hover,
  current,
  paths,
  selected,
  exploredByLayer,
  camera,
  height = 330,
  autoRefine,
  busy,
  onCamera,
  onHover,
  onSelect,
  onExplore,
  onSubdivide,
  onRange,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const bitmaps = useRef<WeakMap<HeatmapData, Map<string, HTMLCanvasElement>>>(new WeakMap());
  const dragRef = useRef<{ x: number; y: number; cam: Camera; moved: boolean } | null>(null);

  const availW = Math.max(40, (wrapRef.current?.clientWidth ?? 420) - PAD_L - PAD_R);
  // match the plot area to the grid's aspect so the cells are square and there
  // are no black bands beside it
  const autoH = Math.round(availW * (root.gy / Math.max(1, root.gx))) + PAD_T + PAD_B;
  const boxH = clamp(Math.max(height ?? autoH, autoH), 170, 520);
  const viewW = availW;
  const viewH = Math.max(40, boxH - PAD_T - PAD_B);
  const fitCell = Math.min(viewW / root.gx, viewH / root.gy);
  // the camera is completely free: position and zoom are only bounded by the
  // useful range, never by where data happens to be
  const zoom = clamp(camera.zoom, MIN_ZOOM, MAX_ZOOM);
  const cell = fitCell * zoom;
  const centreX = PAD_L + viewW / 2;
  const centreY = PAD_T + viewH / 2;
  const pristine = camera.cx === 0 && camera.cy === 0;
  const cx = pristine ? root.gx / 2 : camera.cx;
  const cy = pristine ? root.gy / 2 : camera.cy;

  const sx = (d: number) => centreX + (d - cx) * cell;
  const sy = (d: number) => centreY - (d - cy) * cell;

  const active = layers.length ? layers[layers.length - 1] : null;
  const spanOf = (l: Layer, axis: 'x' | 'y') =>
    axis === 'x' ? (l.root.x1 - l.root.x0) / l.hm.gx : (l.root.y1 - l.root.y0) / l.hm.gy;
  const layerCellPx = (l: Layer) => spanOf(l, 'x') * cell;

  const layerToRoot = (l: Layer, i: number, j: number) => ({
    x: l.root.x0 + ((i + 0.5) / l.hm.gx) * (l.root.x1 - l.root.x0),
    y: l.root.y0 + ((j + 0.5) / l.hm.gy) * (l.root.y1 - l.root.y0),
  });

  /**
   * Resolve a screen point to a cell of the finest layer that covers it, so the
   * coarser context around a refined region stays clickable.
   */
  const targetFromScreen = (offsetX: number, offsetY: number): Target | null => {
    const dx = (offsetX - centreX) / cell + cx;
    const dy = cy - (offsetY - centreY) / cell;
    for (let li = layers.length - 1; li >= 0; li--) {
      const l = layers[li];
      const spanX = l.root.x1 - l.root.x0;
      const spanY = l.root.y1 - l.root.y0;
      if (spanX <= 0 || spanY <= 0) continue;
      const fx = (dx - l.root.x0) / spanX;
      const fy = (dy - l.root.y0) / spanY;
      if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) continue;
      const i = Math.min(l.hm.gx - 1, Math.max(0, Math.floor(fx * l.hm.gx)));
      const j = Math.min(l.hm.gy - 1, Math.max(0, Math.floor(fy * l.hm.gy)));
      return { levelId: l.id, cell: { x: i, y: j } };
    }
    return null;
  };
  const layerById = (id: number) => layers.find((l) => l.id === id) ?? null;
  // One colour scale for the whole pyramid, derived from the cells currently on
  // screen. Every level then shares a palette, so a refined patch is directly
  // comparable with the coarser context around it.
  const colorRange = (() => {
    const visX0 = cx - viewW / 2 / cell;
    const visX1 = cx + viewW / 2 / cell;
    const visY0 = cy - viewH / 2 / cell;
    const visY1 = cy + viewH / 2 / cell;
    const vals: number[] = [];
    for (const l of layers) {
      const spanX = l.root.x1 - l.root.x0;
      const spanY = l.root.y1 - l.root.y0;
      if (spanX <= 0 || spanY <= 0) continue;
      if (l.root.x1 < visX0 || l.root.x0 > visX1 || l.root.y1 < visY0 || l.root.y0 > visY1) continue;
      const i0 = Math.max(0, Math.floor(((visX0 - l.root.x0) / spanX) * l.hm.gx));
      const i1 = Math.min(l.hm.gx - 1, Math.floor(((visX1 - l.root.x0) / spanX) * l.hm.gx));
      const j0 = Math.max(0, Math.floor(((visY0 - l.root.y0) / spanY) * l.hm.gy));
      const j1 = Math.min(l.hm.gy - 1, Math.floor(((visY1 - l.root.y0) / spanY) * l.hm.gy));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const v = l.hm.values[j * l.hm.gx + i];
          if (Number.isFinite(v)) vals.push(v);
        }
      }
    }
    const activeHm = layers.length ? layers[layers.length - 1].hm : null;
    if (vals.length < 12 || !activeHm) {
      return activeHm ? { lo: activeHm.lo, hi: activeHm.hi } : { lo: 0, hi: 1 };
    }
    vals.sort((a, b) => a - b);
    const pick = (q: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(q * (vals.length - 1))))];
    let lo = pick(0.02);
    let hi = pick(0.985);
    if (!(hi > lo)) {
      lo = vals[0];
      hi = vals[vals.length - 1] || lo + 1e-6;
    }
    if (hi - lo < 1e-6) hi = lo + 1e-6;
    // quantise so tiny camera moves do not flicker the palette
    const q = Math.pow(10, Math.max(2, Math.min(6, Math.round(-Math.log10((hi - lo) / 400)))));
    return { lo: Math.round(lo * q) / q, hi: Math.round(hi * q) / q };
  })();
  const colorKey = `${colorRange.lo}:${colorRange.hi}`;

  useEffect(() => {
    onRange(colorRange.lo, colorRange.hi);
  }, [onRange, colorRange.lo, colorRange.hi]);

  const geom = useRef({ cell, cx, cy, centreX, centreY, fitCell, viewW, viewH, zoom });
  geom.current = { cell, cx, cy, centreX, centreY, fitCell, viewW, viewH, zoom };

  /* ------------------------------------------------------------ drawing */
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const width = Math.max(220, wrap.clientWidth);
    const vw = Math.max(40, width - PAD_L - PAD_R);
    const boxHeight = PAD_T + viewH + PAD_B;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(boxHeight * dpr);
    canvas.style.height = `${boxHeight}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, boxHeight);

    ctx.fillStyle = '#000000';
    ctx.fillRect(PAD_L, PAD_T, vw, viewH);

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD_L, PAD_T, vw, viewH);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;

    // coarse -> fine: unexplored cells of a finer layer let the coarser show
    const ordered = [...layers].sort(
      (a, b) => (b.root.x1 - b.root.x0) / b.hm.gx - (a.root.x1 - a.root.x0) / a.hm.gx,
    );
    for (let li = 0; li < ordered.length; li++) {
      const l = ordered[li];
      let cache = bitmaps.current.get(l.hm);
      if (!cache) {
        cache = new Map();
        bitmaps.current.set(l.hm, cache);
      }
      let bmp = cache.get(colorKey);
      if (!bmp) {
        bmp = buildBitmap(l.hm, colorRange.lo, colorRange.hi);
        cache.clear();
        cache.set(colorKey, bmp);
      }
      // coarser levels read as context
      ctx.globalAlpha = li === ordered.length - 1 ? 1 : 0.72;
      const x0 = sx(l.root.x0);
      const x1 = sx(l.root.x1);
      const y0 = sy(l.root.y1);
      const y1 = sy(l.root.y0);
      if (x1 < PAD_L || x0 > PAD_L + vw || y1 < PAD_T || y0 > PAD_T + viewH) continue;
      ctx.drawImage(bmp, x0, y0, Math.max(0.5, x1 - x0), Math.max(0.5, y1 - y0));
    }
    ctx.globalAlpha = 1;

    // outline the refined region so it is obvious where the finer data ends
    if (layers.length > 1) {
      const a = layers[layers.length - 1];
      ctx.strokeStyle = 'rgba(110,168,254,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx(a.root.x0) + 0.5, sy(a.root.y1) + 0.5, sx(a.root.x1) - sx(a.root.x0) - 1, sy(a.root.y0) - sy(a.root.y1) - 1);
    }

    // pick the finest layer whose cells are readable for the grid/labels
    let tickLayer: Layer | null = null;
    for (const l of layers) {
      if (layerCellPx(l) >= 9) tickLayer = l;
    }
    if (!tickLayer && layers.length) tickLayer = layers[0];

    if (tickLayer && layerCellPx(tickLayer) >= 8) {
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const nx = tickLayer.hm.gx;
      const ny = tickLayer.hm.gy;
      const rx = (tickLayer.root.x1 - tickLayer.root.x0) / nx;
      const ry = (tickLayer.root.y1 - tickLayer.root.y0) / ny;
      for (let i = 1; i < nx; i++) {
        const px = sx(tickLayer.root.x0 + i * rx);
        if (px < PAD_L || px > PAD_L + vw) continue;
        ctx.moveTo(Math.round(px) + 0.5, PAD_T);
        ctx.lineTo(Math.round(px) + 0.5, PAD_T + viewH);
      }
      for (let j = 1; j < ny; j++) {
        const py = sy(tickLayer.root.y0 + j * ry);
        if (py < PAD_T || py > PAD_T + viewH) continue;
        ctx.moveTo(PAD_L, Math.round(py) + 0.5);
        ctx.lineTo(PAD_L + vw, Math.round(py) + 0.5);
      }
      ctx.stroke();
    }

    // sub-regions already explored get a dashed outline on their own layer
    for (const l of layers) {
      const cells = exploredByLayer.get(l.id);
      if (!cells || !cells.size) continue;
      const cw = layerCellPx(l);
      if (cw < 2) continue;
      ctx.setLineDash([Math.max(2, cw * 0.16), Math.max(2, cw * 0.14)]);
      ctx.lineWidth = Math.max(1.2, Math.min(2.5, cw * 0.09));
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      for (const key of cells) {
        const [xs, ys] = key.split(',');
        const i = Number(xs);
        const j = Number(ys);
        const p0 = layerToRoot(l, i - 0.5, j - 0.5);
        const p1 = layerToRoot(l, i + 0.5, j + 0.5);
        const px = sx(p0.x);
        const py = sy(p0.y);
        ctx.strokeRect(px, py, sx(p1.x) - px, sy(p1.y) - py);
      }
      ctx.setLineDash([]);
    }

    if (active) {

      if (paths.length) {
        ctx.lineWidth = Math.max(1, layerCellPx(active) * 0.1);
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        for (const path of paths) {
          if (path.length < 2) continue;
          ctx.beginPath();
          path.forEach((p, i) => {
            const c = cellOf(active.hm, p, cfg);
            const r = layerToRoot(active, c.x, c.y);
            if (i === 0) ctx.moveTo(sx(r.x), sy(r.y));
            else ctx.lineTo(sx(r.x), sy(r.y));
          });
          ctx.stroke();
        }
      }

      const cw = layerCellPx(active);
      optima.forEach((o, i) => {
        const r = layerToRoot(active, o.cellX, o.cellY);
        const px = sx(r.x);
        const py = sy(r.y);
        const rad = Math.max(3.4, Math.min(cw * 0.34, 9));
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.lineWidth = i === 0 ? 2.4 : 1.5;
        ctx.strokeStyle = i === 0 ? '#ffffff' : 'rgba(255,255,255,0.72)';
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px, py, Math.max(1, rad * 0.28), 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#fff' : 'rgba(255,255,255,0.6)';
        ctx.fill();
      });

      if (current) {
        const c = cellOf(active.hm, current, cfg);
        const r = layerToRoot(active, c.x, c.y);
        const px = sx(r.x);
        const py = sy(r.y);
        const s = Math.max(4, Math.min(cw * 0.3, 8));
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px - s, py);
        ctx.lineTo(px + s, py);
        ctx.moveTo(px, py - s);
        ctx.lineTo(px, py + s);
        ctx.stroke();
      }

    }

    // selection / hover are drawn on whichever layer they belong to
    const outline = (t: Target | null, color: string, width: number) => {
      if (!t) return;
      const l = layerById(t.levelId);
      if (!l) return;
      const p0 = layerToRoot(l, t.cell.x - 0.5, t.cell.y - 0.5);
      const p1 = layerToRoot(l, t.cell.x + 0.5, t.cell.y + 0.5);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.strokeRect(sx(p0.x) + 0.5, sy(p0.y) + 0.5, sx(p1.x) - sx(p0.x) - 1, sy(p1.y) - sy(p0.y) - 1);
    };
    outline(selected, '#6ea8fe', 2);
    if (hover && (!selected || hover.levelId !== selected.levelId || hover.cell.x !== selected.cell.x || hover.cell.y !== selected.cell.y)) {
      outline(hover, 'rgba(255,255,255,0.9)', 1.4);
    }
    ctx.restore();

    ctx.strokeStyle = 'rgba(120,135,155,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(PAD_L + 0.5, PAD_T + 0.5, vw - 1, viewH - 1);

    // axis labels from the readable layer
    if (tickLayer) {
      const lx = layerCellPx(tickLayer);
      const stride = Math.max(1, Math.ceil(38 / Math.max(1, lx)));
      ctx.font = '9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = 'rgba(200,210,225,0.72)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let i = 0; i < tickLayer.hm.gx; i += stride) {
        const r = layerToRoot(tickLayer, i, 0);
        const px = sx(r.x);
        if (px < PAD_L + 10 || px > PAD_L + vw - 10) continue;
        ctx.fillText(dofValueLabel(tickLayer.hm.xKey, tickLayer.hm.xValues[i]), px, PAD_T + viewH + 5);
      }
      if (tickLayer.hm.gy > 1) {
        const ys = Math.max(1, Math.ceil(15 / Math.max(1, lx)));
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let j = 0; j < tickLayer.hm.gy; j += ys) {
          const r = layerToRoot(tickLayer, 0, j);
          const py = sy(r.y);
          if (py < PAD_T + 6 || py > PAD_T + viewH - 6) continue;
          ctx.fillText(dofValueLabel(tickLayer.hm.yKey, tickLayer.hm.yValues[j]), PAD_L - 6, py);
        }
      }
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(220,230,245,0.5)';
      ctx.fillText(`×${zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}`, PAD_L + vw - 6, PAD_T + 5);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, cfg, root.gx, root.gy, optima, hover, current, paths, selected, exploredByLayer, height, cell, cx, cy, viewW, viewH, zoom, colorKey, colorRange.lo, colorRange.hi]);

  /** the region currently on screen, in root data coordinates */
  const visibleRect = (c: { fitCell: number; cx: number; cy: number; zoom: number; viewW: number; viewH: number }): DataRect => {
    const halfX = c.viewW / 2 / (c.fitCell * c.zoom);
    const halfY = c.viewH / 2 / (c.fitCell * c.zoom);
    return { x0: c.cx - halfX, y0: c.cy - halfY, x1: c.cx + halfX, y1: c.cy + halfY };
  };

  /* ------------------------------------------------------------ input */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const g = geom.current;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const dxAt = (mx - g.centreX) / g.cell + g.cx;
      const dyAt = g.cy - (my - g.centreY) / g.cell;
      const factor = Math.exp(-e.deltaY * 0.0022);
      const nz = clamp(g.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      // pure navigation: the grid redraws immediately, the search catches up later
      onCamera({
        zoom: nz,
        cx: dxAt - (mx - g.centreX) / (g.fitCell * nz),
        cy: dyAt + (my - g.centreY) / (g.fitCell * nz),
      });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [onCamera]);

  // Once navigation settles, make the search match what is on screen: too few
  // cells (zoomed in) or too little coverage (panned/zoomed away) both mean the
  // visible window deserves its own search. Calculations lag; the view never does.
  const refineKey = `${layers.length}:${zoom.toFixed(4)}:${cx.toFixed(3)}:${cy.toFixed(3)}:${viewW}x${viewH}`;
  useEffect(() => {
    if (!autoRefine || busy || !layers.length) return;
    const t = window.setTimeout(() => {
      const level = layers[layers.length - 1];
      const vis = visibleRect({ fitCell, cx, cy, zoom, viewW, viewH });
      const spanRoot = { x: level.root.x1 - level.root.x0, y: level.root.y1 - level.root.y0 };
      const cellPx = (spanRoot.x / level.hm.gx) * cell;
      const visibleCells = (viewW / Math.max(1e-6, cellPx)) * (viewH / Math.max(1e-6, cellPx));
      const ovX = Math.max(0, Math.min(vis.x1, level.root.x1) - Math.max(vis.x0, level.root.x0));
      const ovY = Math.max(0, Math.min(vis.y1, level.root.y1) - Math.max(vis.y0, level.root.y0));
      const area = Math.max(1e-9, (vis.x1 - vis.x0) * (vis.y1 - vis.y0));
      const coverage = (ovX * ovY) / area;
      if (visibleCells < SUBDIVIDE_CELLS * 1.6 || coverage < 0.55) {
        onSubdivide(vis);
      }
    }, 340);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refineKey, autoRefine, busy, cell, fitCell, viewW, viewH]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    dragRef.current = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY, cam: { zoom, cx, cy }, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ox = e.nativeEvent.offsetX;
    const oy = e.nativeEvent.offsetY;
    const drag = dragRef.current;
    if (drag) {
      const dx = ox - drag.x;
      const dy = oy - drag.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved) {
        onCamera({ zoom: drag.cam.zoom, cx: drag.cam.cx - dx / cell, cy: drag.cam.cy + dy / cell });
      }
    }
    onHover(targetFromScreen(ox, oy));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && !drag.moved) onSelect(targetFromScreen(e.nativeEvent.offsetX, e.nativeEvent.offsetY));
  };

  return (
    <div className="heatWrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="heatCanvas"
        data-zoom={zoom.toFixed(3)}
        data-cam={`${cx.toFixed(2)},${cy.toFixed(2)}`}
        data-grid={active ? `${active.hm.gx}x${active.hm.gy}` : ''}
        data-cells={active ? layerCellPx(active).toFixed(2) : ''}
        data-layers={layers.length}
        data-view={`${(cx - viewW / 2 / cell).toFixed(2)},${(cy - viewH / 2 / cell).toFixed(2)},${(cx + viewW / 2 / cell).toFixed(2)},${(cy + viewH / 2 / cell).toFixed(2)}`}
        data-active={active ? `${active.root.x0.toFixed(2)},${active.root.y0.toFixed(2)},${active.root.x1.toFixed(2)},${active.root.y1.toFixed(2)}` : ''}
        style={{ cursor: dragRef.current?.moved ? 'grabbing' : 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => onHover(null)}
        onDoubleClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const t = targetFromScreen(e.clientX - rect.left, e.clientY - rect.top);
          if (t) onExplore(t);
        }}
      />
    </div>
  );
}
