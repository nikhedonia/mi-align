import { useEffect, useRef } from 'react';
import type { SearchConfig } from '../lib/config';
import { dofValueLabel } from '../lib/config';
import type { Affine } from '../lib/config';
import { heatColor } from '../lib/colormap';
import type { HeatmapData, Optimum } from '../lib/heatmap';
import { cellOf } from '../lib/heatmap';

export interface Cell {
  x: number;
  y: number;
}

interface Props {
  hm: HeatmapData;
  optima: Optimum[];
  cfg: SearchConfig;
  hover: Cell | null;
  current: Affine | null;
  paths: Affine[][];
  onHover: (c: Cell | null) => void;
  onClickCell: (c: Cell) => void;
}

const PAD_L = 40;
const PAD_B = 20;
const PAD_T = 6;
const PAD_R = 8;

export function HeatmapCanvas({ hm, optima, cfg, hover, current, paths, onHover, onClickCell }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cellRef = useRef(12);
  const layoutRef = useRef({ x0: PAD_L, y0: PAD_T });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const avail = Math.max(160, parent.clientWidth - PAD_L - PAD_R);
    const cell = Math.max(7, Math.min(34, Math.floor(avail / hm.gx)));
    cellRef.current = cell;
    const gw = hm.gx * cell;
    const gh = hm.gy * cell;
    const cssW = PAD_L + gw + PAD_R;
    const cssH = PAD_T + gh + PAD_B;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    layoutRef.current = { x0: PAD_L, y0: PAD_T };

    const x0 = PAD_L;
    const y0 = PAD_T;

    // ---- heat cells
    const off = document.createElement('canvas');
    off.width = hm.gx;
    off.height = hm.gy;
    const octx = off.getContext('2d')!;
    const img = octx.createImageData(hm.gx, hm.gy);
    const range = hm.hi - hm.lo || 1;
    for (let y = 0; y < hm.gy; y++) {
      for (let x = 0; x < hm.gx; x++) {
        const v = hm.values[y * hm.gx + x];
        const row = hm.gy - 1 - y;
        const o = (row * hm.gx + x) * 4;
        if (Number.isNaN(v)) {
          img.data[o] = 26;
          img.data[o + 1] = 28;
          img.data[o + 2] = 35;
          img.data[o + 3] = 255;
        } else {
          heatColor((v - hm.lo) / range, img.data, o);
        }
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, x0, y0, hm.gx * cell, hm.gy * cell);

    // ---- faint cell separators
    if (cell >= 11) {
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 1; x < hm.gx; x++) {
        ctx.moveTo(x0 + x * cell + 0.5, y0);
        ctx.lineTo(x0 + x * cell + 0.5, y0 + hm.gy * cell);
      }
      for (let y = 1; y < hm.gy; y++) {
        ctx.moveTo(x0, y0 + y * cell + 0.5);
        ctx.lineTo(x0 + hm.gx * cell, y0 + y * cell + 0.5);
      }
      ctx.stroke();
    }

    const cx = (x: number) => x0 + (x + 0.5) * cell;
    const cy = (y: number) => y0 + (hm.gy - 1 - y + 0.5) * cell;

    // ---- stochastic search trajectories
    if (paths.length) {
      ctx.lineWidth = Math.max(1, cell * 0.11);
      for (const path of paths) {
        if (path.length < 2) continue;
        ctx.strokeStyle = 'rgba(255,255,255,0.34)';
        ctx.beginPath();
        path.forEach((p, i) => {
          const c = cellOf(hm, p, cfg);
          if (i === 0) ctx.moveTo(cx(c.x), cy(c.y));
          else ctx.lineTo(cx(c.x), cy(c.y));
        });
        ctx.stroke();
      }
      // start dots
      for (const path of paths) {
        const c = cellOf(hm, path[0], cfg);
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.beginPath();
        ctx.arc(cx(c.x), cy(c.y), Math.max(1.6, cell * 0.11), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ---- local optima
    optima.forEach((o, i) => {
      const px = cx(o.cellX);
      const py = cy(o.cellY);
      const r = Math.max(3.5, cell * 0.34);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.lineWidth = i === 0 ? 2.4 : 1.6;
      ctx.strokeStyle = i === 0 ? '#ffffff' : 'rgba(255,255,255,0.8)';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, py, Math.max(1, r * 0.28), 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#ffffff' : 'rgba(255,255,255,0.65)';
      ctx.fill();
    });

    // ---- best (reported) transform
    if (current) {
      const c = cellOf(hm, current, cfg);
      const px = cx(c.x);
      const py = cy(c.y);
      const s = Math.max(4, cell * 0.3);
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px - s, py);
      ctx.lineTo(px + s, py);
      ctx.moveTo(px, py - s);
      ctx.lineTo(px, py + s);
      ctx.stroke();
    }

    // ---- hover
    if (hover) {
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0 + hover.x * cell + 0.5, y0 + (hm.gy - 1 - hover.y) * cell + 0.5, cell - 1, cell - 1);
    }

    // ---- axes
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(200,210,225,0.72)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xStride = Math.max(1, Math.ceil(hm.gx / 8));
    for (let x = 0; x < hm.gx; x += xStride) {
      ctx.fillText(dofValueLabel(hm.xKey, hm.xValues[x]), cx(x), y0 + hm.gy * cell + 5);
    }
    if (hm.gy > 1) {
      const yStride = Math.max(1, Math.ceil(hm.gy / 7));
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let y = 0; y < hm.gy; y += yStride) {
        ctx.fillText(dofValueLabel(hm.yKey, hm.yValues[y]), x0 - 6, cy(y));
      }
    }
  }, [hm, cfg, optima, hover, current, paths]);

  const toCell = (evt: React.MouseEvent<HTMLCanvasElement>): Cell | null => {
    const rect = evt.currentTarget.getBoundingClientRect();
    const px = evt.clientX - rect.left;
    const py = evt.clientY - rect.top;
    const cell = cellRef.current;
    const { x0, y0 } = layoutRef.current;
    const gx = hm.gx;
    const gy = hm.gy;
    const cx = Math.floor((px - x0) / cell);
    const rowFromTop = Math.floor((py - y0) / cell);
    if (cx < 0 || cx >= gx || rowFromTop < 0 || rowFromTop >= gy) return null;
    return { x: cx, y: gy - 1 - rowFromTop };
  };

  return (
    <canvas
      ref={canvasRef}
      className="heatCanvas"
      onMouseMove={(e) => onHover(toCell(e))}
      onMouseLeave={() => onHover(null)}
      onClick={(e) => {
        const c = toCell(e);
        if (c) onClickCell(c);
      }}
    />
  );
}
