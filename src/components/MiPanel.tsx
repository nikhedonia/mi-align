import { useEffect, useRef } from 'react';
import type { Measure } from '../gpu/aligner';

interface Props {
  measure: Measure | null;
  pending: boolean;
}

/** joint intensity histogram + mutual information readout */
export function MiPanel({ measure, pending }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const size = canvas.clientWidth || 128;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0d12';
    ctx.fillRect(0, 0, size, size);
    if (!measure) return;

    let max = 1e-6;
    for (let i = 0; i < measure.hist.length; i++) if (measure.hist[i] > max) max = measure.hist[i];
    const off = document.createElement('canvas');
    off.width = 32;
    off.height = 32;
    const octx = off.getContext('2d')!;
    const img = octx.createImageData(32, 32);
    for (let b = 0; b < 32; b++) {
      for (let a = 0; a < 32; a++) {
        const v = measure.hist[b * 32 + a] / max;
        // sqrt so rare bins stay visible
        const t = Math.sqrt(v);
        const row = 31 - b;
        const o = (row * 32 + a) * 4;
        img.data[o] = Math.min(255, 30 + t * 40 + (t > 0.65 ? 215 : 0));
        img.data[o + 1] = Math.min(255, 30 + t * 225);
        img.data[o + 2] = Math.min(255, 40 + t * 90 + (t > 0.65 ? 120 : 0));
        img.data[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
  }, [measure]);

  return (
    <div className="miPanel">
      <div className="miHist">
        <canvas ref={canvasRef} />
        <span className="miAxis miAxisX">A intensity</span>
        <span className="miAxis miAxisY">B intensity</span>
      </div>
      <div className="miStats">
        <div className={`miBig ${pending ? 'pending' : ''}`}>
          <span className="miValue">{measure ? measure.mi.toFixed(3) : '—'}</span>
          <span className="miUnit">bits MI</span>
        </div>
        <div className="miRows">
          <div>
            <span className="k">normalised</span>
            <span className="v">{measure ? measure.nmi.toFixed(3) : '—'}</span>
          </div>
          <div>
            <span className="k">H(A)</span>
            <span className="v">{measure ? measure.ha.toFixed(2) : '—'}</span>
          </div>
          <div>
            <span className="k">H(B)</span>
            <span className="v">{measure ? measure.hb.toFixed(2) : '—'}</span>
          </div>
          <div>
            <span className="k">NCC</span>
            <span className="v">{measure ? measure.ncc.toFixed(4) : '—'}</span>
          </div>
          <div>
            <span className="k">overlap</span>
            <span className="v">{measure ? `${(measure.overlap * 100).toFixed(1)}%` : '—'}</span>
          </div>
          <div>
            <span className="k">score</span>
            <span className="v">{measure ? measure.score.toFixed(4) : '—'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
