import { useMemo, useRef } from 'react';
import type { Affine } from '../lib/config';
import type { Img } from '../lib/image';
import { thumbnail } from '../lib/image';
import { dofValueLabel } from '../lib/config';

interface Props {
  imgA: Img | null;
  imgB: Img | null;
  truth: Affine | null;
  busy: boolean;
  onFile: (which: 'a' | 'b', file: File) => void;
  onSwap: () => void;
  onClearTruth: () => void;
}

function Slot({
  label,
  img,
  onFile,
}: {
  label: string;
  img: Img | null;
  onFile: (f: File) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const src = useMemo(() => (img ? thumbnail(img) : null), [img]);

  return (
    <div className="slot">
      <div className="slotHead">
        <span className="slotLabel">{label}</span>
        {img ? (
          <span className="slotMeta">
            {img.width}×{img.height}
          </span>
        ) : null}
      </div>
      <div
        className={`slotBody ${src ? 'has' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.currentTarget.classList.add('drag');
        }}
        onDragLeave={(e) => e.currentTarget.classList.remove('drag')}
        onDrop={(e) => {
          e.preventDefault();
          e.currentTarget.classList.remove('drag');
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        onClick={() => ref.current?.click()}
        title="Drop an image or click to choose a file"
      >
        {src ? <img src={src} alt={img?.name ?? label} /> : <span className="slotHint">drop or click</span>}
      </div>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
      <button className="ghost small" onClick={() => ref.current?.click()}>
        Upload…
      </button>
    </div>
  );
}

export function DataPanel({ imgA, imgB, truth, busy, onFile, onSwap, onClearTruth }: Props) {
  return (
    <section className="card">
      <h2>Images</h2>
      <p className="hint tight">
        Any size, any aspect ratio — A and B are compared in a centre-normalised space, so they do not need to match.
      </p>
      <div className="slots">
        <Slot label="A · source" img={imgA} onFile={(f) => onFile('a', f)} />
        <Slot label="B · target" img={imgB} onFile={(f) => onFile('b', f)} />
      </div>
      <div className="row gap">
        <button className="ghost small" onClick={onSwap} disabled={!imgA || !imgB || busy}>
          ⇄ Swap A/B
        </button>
        {truth ? (
          <button className="ghost small" onClick={onClearTruth}>
            forget ground truth
          </button>
        ) : null}
      </div>

      {truth ? (
        <div className="truth">
          <span className="truthTag">ground truth</span>
          <span>
            {dofValueLabel('tx', truth.tx)} / {dofValueLabel('ty', truth.ty)} / {dofValueLabel('theta', truth.theta)} /{' '}
            {dofValueLabel('scale', truth.scale)}
            {truth.aspect !== 1 ? ` / a ${dofValueLabel('aspect', truth.aspect)}` : ''}
            {truth.shear !== 0 ? ` / sh ${dofValueLabel('shear', truth.shear)}` : ''}
          </span>
        </div>
      ) : null}
    </section>
  );
}
