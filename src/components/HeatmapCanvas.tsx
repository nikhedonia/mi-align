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

export const cellKey = (c: Cell) => `${c.x},${c.y}`;

/** one completed search, positioned inside the root grid */
export interface Layer {
  hm: HeatmapData;
  root: DataRect;
}

interface Props {
  /** coarse -> fine; the last one is the active search space */
  layers: Layer[];
  cfg: SearchConfig;
  root: { gx: number; gy: number };
  optima: Optimum[];
  hover: Cell | null;
  current: Affine | null;
  paths: Affine[][];
  selected: Cell | null;
  explored: Set<string>;
  camera: Camera;
  height?: number;
  autoRefine: boolean;
  busy: boolean;
  canPop: boolean;
  onCamera: (c: Camera) => void;
  onHover: (c: Cell | null) => void;
  onSelect: (c: Cell | null) => void;
  onExplore: (c: Cell) => void;
  /** rect in root data coordinates */
  onSubdivide: (rect: DataRect) => void;
  onAutoPop: () => void;
}

const PAD_L = 44;
const PAD_B = 22;
const PAD_T = 10;
const PAD_R = 12;
const MAX_ZOOM = 4096;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function buildBitmap(hm: HeatmapData): HTMLCanvasElement {
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
  const range = hm.hi - hm.lo || 1;
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
      const c = palette[clamp(Math.round(((v - hm.lo) / range) * (BUCKETS - 1)), 0, BUCKETS - 1)];
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
  explored,
  camera,
  height = 330,
  autoRefine,
  busy,
  canPop,
  onCamera,
  onHover,
  onSelect,
  onExplore,
  onSubdivide,
  onAutoPop,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const bitmaps = useRef<WeakMap<HeatmapData, HTMLCanvasElement>>(new WeakMap());
  const dragRef = useRef<{ x: number; y: number; cam: Camera; moved: boolean } | null>(null);

  const availW = Math.max(40, (wrapRef.current?.clientWidth ?? 420) - PAD_L - PAD_R);
  // match the plot area to the grid's aspect so the cells are square and there
  // are no black bands beside it
  const autoH = Math.round(availW * (root.gy / Math.max(1, root.gx))) + PAD_T + PAD_B;
  const boxH = clamp(Math.max(height ?? autoH, autoH), 170, 520);
  const viewW = availW;
  const viewH = Math.max(40, boxH - PAD_T - PAD_B);
  const fitCell = Math.min(viewW / root.gx, viewH / root.gy);
  const zoom = clamp(camera.zoom, 0.3, MAX_ZOOM);
  const cell = fitCell * zoom;
  const centreX = PAD_L + viewW / 2;
  const centreY = PAD_T + viewH / 2;
  const padX = Math.max(1, viewW / cell / 2 - 1);
  const padY = Math.max(1, viewH / cell / 2 - 1);
  const cx = root.gx * cell <= viewW ? root.gx / 2 : clamp(camera.cx || root.gx / 2, 1 - padX, root.gx - 1 + padX);
  const cy = root.gy * cell <= viewH ? root.gy / 2 : clamp(camera.cy || root.gy / 2, 1 - padY, root.gy - 1 + padY);

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

  const cellFromScreen = (offsetX: number, offsetY: number): Cell | null => {
    if (!active) return null;
    const dx = (offsetX - centreX) / cell + cx;
    const dy = cy - (offsetY - centreY) / cell;
    const i = Math.floor(((dx - active.root.x0) / Math.max(1e-6, active.root.x1 - active.root.x0)) * active.hm.gx);
    const j = Math.floor(((dy - active.root.y0) / Math.max(1e-6, active.root.y1 - active.root.y0)) * active.hm.gy);
    if (i < 0 || i >= active.hm.gx || j < 0 || j >= active.hm.gy) return null;
    return { x: i, y: j };
  };

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
    canvas.style.width = `${width}px`;
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
    for (const l of layers) {
      const bmp = bitmaps.current.get(l.hm) ?? buildBitmap(l.hm);
      bitmaps.current.set(l.hm, bmp);
      const x0 = sx(l.root.x0);
      const x1 = sx(l.root.x1);
      const y0 = sy(l.root.y1);
      const y1 = sy(l.root.y0);
      if (x1 < PAD_L || x0 > PAD_L + vw || y1 < PAD_T || y0 > PAD_T + viewH) continue;
      ctx.drawImage(bmp, x0, y0, Math.max(0.5, x1 - x0), Math.max(0.5, y1 - y0));
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

    if (active) {
      // sub-regions already explored get a dashed outline
      if (explored.size) {
        const cw = layerCellPx(active);
        ctx.setLineDash([Math.max(2, cw * 0.16), Math.max(2, cw * 0.14)]);
        ctx.lineWidth = Math.max(1.2, Math.min(2.5, cw * 0.09));
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        for (const key of explored) {
          const [xs, ys] = key.split(',');
          const i = Number(xs);
          const j = Number(ys);
          const p0 = layerToRoot(active, i - 0.5, j - 0.5);
          const p1 = layerToRoot(active, i + 0.5, j + 0.5);
          const px = sx(p0.x);
          const py = sy(p0.y);
          ctx.strokeRect(px, py, sx(p1.x) - px, sy(p1.y) - py);
        }
        ctx.setLineDash([]);
      }

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

      if (selected) {
        const p0 = layerToRoot(active, selected.x - 0.5, selected.y - 0.5);
        const p1 = layerToRoot(active, selected.x + 0.5, selected.y + 0.5);
        ctx.strokeStyle = '#6ea8fe';
        ctx.lineWidth = 2;
        ctx.strokeRect(sx(p0.x), sy(p0.y), sx(p1.x) - sx(p0.x), sy(p1.y) - sy(p0.y));
      }
      if (hover && (!selected || hover.x !== selected.x || hover.y !== selected.y)) {
        const p0 = layerToRoot(active, hover.x - 0.5, hover.y - 0.5);
        const p1 = layerToRoot(active, hover.x + 0.5, hover.y + 0.5);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.4;
        ctx.strokeRect(sx(p0.x) + 0.5, sy(p0.y) + 0.5, sx(p1.x) - sx(p0.x) - 1, sy(p1.y) - sy(p0.y) - 1);
      }
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
  }, [layers, cfg, root.gx, root.gy, optima, hover, current, paths, selected, explored, height, cell, cx, cy, viewW, viewH, zoom]);

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
      const nz = clamp(g.zoom * factor, 0.3, MAX_ZOOM);
      // zooming is never blocked by a search: apply it, then refine if needed
      onCamera({
        zoom: nz,
        cx: dxAt - (mx - g.centreX) / (g.fitCell * nz),
        cy: dyAt + (my - g.centreY) / (g.fitCell * nz),
      });
      if (!autoRefine || busy) return;

      const activeLayer = layers.length ? layers[layers.length - 1] : null;
      if (!activeLayer) return;

      const spanRoot = { x: activeLayer.root.x1 - activeLayer.root.x0, y: activeLayer.root.y1 - activeLayer.root.y0 };
      const cellPx = (spanRoot.x / activeLayer.hm.gx) * g.fitCell * nz;

      if (factor > 1) {
        // fewer than SUBDIVIDE_CELLS active cells on screen -> re-search the view
        const visible = (g.viewW / cellPx) * (g.viewH / cellPx);
        if (visible < SUBDIVIDE_CELLS && activeLayer.hm.gx * activeLayer.hm.gy > SUBDIVIDE_CELLS * 2) {
          onSubdivide(visibleRect({ ...g, zoom: nz }));
        }
      } else if (canPop && cellPx < 3) {
        // this level's cells became sub-pixel: climb to the parent, whose cells
        // are then roughly 4x bigger and readable again
        onAutoPop();
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [onCamera, onSubdivide, onAutoPop, autoRefine, busy, canPop, layers]);

  const chainRef = useRef(0);
  useEffect(() => {
    if (!autoRefine || busy || !layers.length) return;
    const l = layers[layers.length - 1];
    const cw = (l.root.x1 - l.root.x0) / l.hm.gx * cell;
    if (cw <= 0) return;
    const visible = (viewW / cw) * (viewH / cw);
    if (visible >= SUBDIVIDE_CELLS) return;
    if (l.hm.gx * l.hm.gy <= SUBDIVIDE_CELLS * 2) return;
    const now = Date.now();
    if (now - chainRef.current < 400) return;
    chainRef.current = now;
    onSubdivide(visibleRect({ fitCell, cx, cy, zoom, viewW, viewH }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, busy, autoRefine, zoom, cx, cy, cell, viewW, viewH, fitCell]);

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
        onCamera({ zoom: drag.cam.zoom, cx: clamp(drag.cam.cx - dx / cell, 0, root.gx), cy: clamp(drag.cam.cy + dy / cell, 0, root.gy) });
      }
    }
    onHover(cellFromScreen(ox, oy));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && !drag.moved) onSelect(cellFromScreen(e.nativeEvent.offsetX, e.nativeEvent.offsetY));
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
        style={{ cursor: dragRef.current?.moved ? 'grabbing' : 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => onHover(null)}
        onDoubleClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const c = cellFromScreen(e.clientX - rect.left, e.clientY - rect.top);
          if (c) onExplore(c);
        }}
      />
    </div>
  );
}
