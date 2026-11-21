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
  emptyText?: string;
}

export function WarpCanvas({ device, format, imgA, imgB, transform, opts, emptyText }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WarpRenderer | null>(null);
  const [version, setVersion] = useState(0);

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

  const aspect = imgB ? imgB.width / imgB.height : 4 / 3;

  return (
    <div className="canvasWrap" ref={wrapRef} style={{ aspectRatio: `${aspect}` }}>
      <canvas ref={canvasRef} className="warpCanvas" />
      {!imgA || !imgB ? <div className="canvasEmpty">{emptyText ?? 'Pick two images'}</div> : null}
    </div>
  );
}
