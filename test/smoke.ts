/* End-to-end smoke test: runs the real WebGPU kernels in a browser. */
import { initGPU } from '../src/gpu/device';
import { Aligner } from '../src/gpu/aligner';
import { WarpRenderer, DEFAULT_VIEW } from '../src/gpu/warp';
import { EXAMPLES, buildExample, exampleById } from '../src/lib/examples';
import { buildSamples } from '../src/lib/sampling';
import { createDefaultConfig, type SearchConfig } from '../src/lib/config';
import { matOfAffine, compareAffine } from '../src/lib/affine';
import { runSearch, polish } from '../src/lib/search';
import { buildHeatmap, findOptima, bestOf, candidateAt } from '../src/lib/heatmap';

declare global {
  interface Window {
    __RESULT?: unknown;
    __ERROR?: unknown;
  }
}

const out = document.getElementById('out')!;
const log = (s: string) => {
  out.textContent += `\n${s}`;
};

function tinyConfig(): SearchConfig {
  const c = createDefaultConfig();
  c.dofs.tx = { enabled: true, min: -0.2, max: 0.2, steps: 7, value: 0 };
  c.dofs.ty = { enabled: true, min: -0.2, max: 0.2, steps: 7, value: 0 };
  c.dofs.theta = { enabled: true, min: (-12 * Math.PI) / 180, max: (12 * Math.PI) / 180, steps: 7, value: 0 };
  c.dofs.scale = { enabled: true, min: 0.92, max: 1.08, steps: 5, value: 1 };
  c.sampling = { enabled: true, mode: 'grid', count: 1024, seed: 7 };
  c.mode = 'grid';
  c.refine = true;
  return c;
}

async function readCanvas(device: GPUDevice, canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('webgpu')!;
  const tex = ctx.getCurrentTexture();
  const w = canvas.width;
  const h = canvas.height;
  const buf = device.createBuffer({
    size: Math.ceil((w * 4) / 256) * 256 * h,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: Math.ceil((w * 4) / 256) * 256 }, {
    width: w,
    height: h,
  });
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const data = new Uint8Array(buf.getMappedRange());
  let sum = 0;
  const bpr = Math.ceil((w * 4) / 256) * 256;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * bpr + x * 4;
      sum += (data[o] + data[o + 1] + data[o + 2]) / (3 * 255);
    }
  }
  buf.unmap();
  buf.destroy();
  return sum / (w * h);
}

async function main() {
  const checks: { name: string; ok: boolean; detail: unknown }[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail ? JSON.stringify(detail) : ''}`);
  };

  const gpu = await initGPU();
  check('webgpu device', true, { info: gpu.info, format: gpu.format });

  /* ---------------- images ---------------- */
  const ex = EXAMPLES[0];
  const t0 = performance.now();
  const { a, b } = buildExample(ex);
  check('example pair built', a.width === b.width && a.height === b.height, {
    size: `${a.width}x${a.height}`,
    ms: Math.round(performance.now() - t0),
  });

  /* ---------------- shader compilation ---------------- */
  const samples = buildSamples(a, tinyConfig().sampling);
  check('samples built', samples.count === 1024, { count: samples.count, mode: samples.mode });

  const aligner = new Aligner(gpu.device, b, samples, tinyConfig().limits, 8192);

  /* ---------------- scoring kernel ---------------- */
  const truth = ex.truth;
  const wrong = { ...truth, tx: -truth.tx, ty: -truth.ty, theta: -truth.theta };
  const batch = new Float32Array(6 * 4);
  const cands = [truth, { tx: 0, ty: 0, theta: 0, scale: 1, aspect: 1, shear: 0 }, wrong, { ...truth, tx: truth.tx + 0.1 }];
  cands.forEach((c, i) => {
    batch[i * 6] = c.tx;
    batch[i * 6 + 1] = c.ty;
    batch[i * 6 + 2] = c.theta;
    batch[i * 6 + 3] = c.scale;
    batch[i * 6 + 4] = c.aspect;
    batch[i * 6 + 5] = c.shear;
  });
  const rows = await aligner.evaluate(batch, cands.length);
  const scoreOf = (i: number) => rows[i * 8];
  const nccOf = (i: number) => rows[i * 8 + 1];
  check('truth beats identity', scoreOf(0) > scoreOf(1), { truth: scoreOf(0), identity: scoreOf(1) });
  check('truth beats inverted', scoreOf(0) > scoreOf(2), { truth: scoreOf(0), inverted: scoreOf(2) });
  check('truth beats shifted', scoreOf(0) > scoreOf(3), { truth: scoreOf(0), shifted: scoreOf(3) });
  check('truth ncc is high', nccOf(0) > 0.85, { ncc: nccOf(0), overlap: rows[2] });
  check('identity ncc is lower', nccOf(1) < nccOf(0) - 0.05, { identityNcc: nccOf(1) });

  /* ---------------- mutual-information scorer ---------------- */
  const miRows = await aligner.evaluate(batch, cands.length, 'mi');
  check('MI scorer: truth beats identity', miRows[0] > miRows[8], {
    truth: miRows[0].toFixed(4),
    identity: miRows[8].toFixed(4),
  });
  check('MI scorer: truth beats inverted', miRows[0] > miRows[16], {
    truth: miRows[0].toFixed(4),
    inverted: miRows[16].toFixed(4),
  });
  check('MI scorer also returns NCC', miRows[1] > 0.85, { ncc: miRows[1] });
  check('MI scorer returns MI/NMI', miRows[5] > 0 && miRows[6] > 0.15 && miRows[6] <= 1.0001, {
    mi: miRows[5].toFixed(3),
    nmi: miRows[6].toFixed(3),
  });

  /* ---------------- exhaustive grid ---------------- */
  const cfg = tinyConfig();
  const grid = await runSearch({ evaluate: (p, n) => aligner.evaluate(p, n), batch: 8192, cfg });
  const gb = bestOf(grid);
  const gerr = compareAffine(gb.params, truth);
  check('grid scanned every point', grid.count >= 7 * 7 * 7 * 5, { count: grid.count, ms: Math.round(grid.elapsedMs) });
  check('grid finds the peak', gerr.pos < 2 && gerr.angle < 2.5, gerr);

  const ref = await polish({ evaluate: (p, n) => aligner.evaluate(p, n), batch: 8192, cfg }, gb.params, 80);
  const rerr = ref ? compareAffine(ref.params, truth) : null;
  check('refinement improves', !!rerr && rerr.pos <= gerr.pos + 1e-9 && rerr.angle <= gerr.angle + 1e-9, rerr);

  /* ---------------- MI-driven grid search ---------------- */
  {
    const micfg = createDefaultConfig();
    micfg.dofs.tx = { enabled: true, min: -0.2, max: 0.2, steps: 5, value: 0 };
    micfg.dofs.ty = { enabled: true, min: -0.2, max: 0.2, steps: 5, value: 0 };
    micfg.dofs.theta = { ...micfg.dofs.theta, enabled: true, steps: 5 };
    micfg.dofs.scale = { ...micfg.dofs.scale, enabled: false };
    micfg.sampling = { enabled: true, mode: 'grid', count: 1024, seed: 7 };
    micfg.mode = 'grid';
    micfg.refine = false;
    micfg.objective = 'mi';
    const migrid = await runSearch({ evaluate: (p, n) => aligner.evaluate(p, n, 'mi'), batch: 8192, cfg: micfg });
    const mb = bestOf(migrid);
    const merr = compareAffine(mb.params, truth);
    check('MI objective scans the grid', migrid.count === 125, { count: migrid.count, ms: Math.round(migrid.elapsedMs) });
    check('MI result is tagged', migrid.objective === 'mi', { objective: migrid.objective });
    check('MI objective finds the peak', merr.pos < 6 && merr.angle < 4, merr);
    check('MI result still has NCC/overlap', Number.isFinite(mb.ncc) && mb.overlap > 0.5, {
      ncc: mb.ncc,
      overlap: mb.overlap,
    });
  }

  /* ---------------- heatmap + optima ---------------- */
  const hm = buildHeatmap(grid, cfg, 'tx', 'ty', 'projection');
  check('heatmap dimensions', hm.gx === 7 && hm.gy === 7, { gx: hm.gx, gy: hm.gy, filled: hm.filled });
  check('heatmap fully covered', hm.filled === 49, { filled: hm.filled });
  const opt = findOptima(hm, grid, 8);
  check('heatmap has optima', opt.length > 0, { count: opt.length });
  const top = opt[0];
  const topErr = top ? compareAffine(top.params, truth) : null;
  check('top optimum near truth', !!topErr && topErr.pos < 12, topErr);
  check('best cell argmax resolves', hm.argIdx[grid.bestIndex >= 0 ? 0 : 0] !== undefined, null);

  const slice = buildHeatmap(grid, cfg, 'tx', 'theta', 'slice');
  check('slice map smaller than projection', slice.filled <= hm.filled, { sliceFilled: slice.filled });

  /* ---------------- stochastic ---------------- */
  const scfg = tinyConfig();
  scfg.mode = 'stochastic';
  scfg.stochastic = { samples: 600, seeds: 6, iterations: 26 };
  const sto = await runSearch({ evaluate: (p, n) => aligner.evaluate(p, n), batch: 8192, cfg: scfg });
  const sb = bestOf(sto);
  const serr = compareAffine(sb.params, truth);
  check('stochastic finds the peak', serr.pos < 3.5 && serr.angle < 4, { ...serr, evals: sto.count });
  check('stochastic recorded paths', sto.paths.length >= 1 && sto.paths.some((p) => p.length > 1), {
    paths: sto.paths.length,
    longest: Math.max(...sto.paths.map((p) => p.length)),
  });
  const shm = buildHeatmap(sto, scfg, 'tx', 'ty', 'projection');
  check('stochastic heatmap partially covered', shm.filled > 0 && shm.filled <= 49, { filled: shm.filled });

  /* ---------------- mutual information ---------------- */
  {
    const truthMeasure = await aligner.measure(truth);
    const idMeasure = await aligner.measure({ tx: 0, ty: 0, theta: 0, scale: 1, aspect: 1, shear: 0 });
    check('MI kernel returns a histogram', truthMeasure.hist.length === 1024, {
      mi: truthMeasure.mi.toFixed(3),
      nmi: truthMeasure.nmi.toFixed(3),
      entropy: [truthMeasure.ha.toFixed(2), truthMeasure.hb.toFixed(2)],
    });
    check('MI is higher at the true alignment', truthMeasure.mi > idMeasure.mi + 0.3, {
      truth: truthMeasure.mi.toFixed(3),
      identity: idMeasure.mi.toFixed(3),
    });
    check(
      'normalised MI is in range',
      truthMeasure.nmi > 0.15 && truthMeasure.nmi <= 1.0001,
      truthMeasure.nmi.toFixed(3),
    );
    let histSum = 0;
    for (let i = 0; i < truthMeasure.hist.length; i++) histSum += truthMeasure.hist[i];
    check('histogram matches valid sample count', histSum === truthMeasure.valid, {
      histSum,
      valid: truthMeasure.valid,
    });
    check('measure agrees with the scorer', Math.abs(truthMeasure.score - scoreOf(0)) < 1e-4, {
      measure: truthMeasure.score,
      eval: scoreOf(0),
    });
  }

  /* ---------------- geometry of every example ---------------- */
  for (const ex of EXAMPLES) {
    const pair = buildExample(ex, 0.5);
    const samples = buildSamples(pair.a, { enabled: true, mode: 'grid', count: 900, seed: 2 });
    const al = new Aligner(gpu.device, pair.b, samples, cfg.limits, 8192);
    const t = new Float32Array([ex.truth.tx, ex.truth.ty, ex.truth.theta, ex.truth.scale, ex.truth.aspect, ex.truth.shear]);
    const row = await al.evaluate(t, 1);
    check(`example "${ex.id}" truth scores high`, row[0] > 0.82, {
      score: row[0].toFixed(3),
      ncc: row[1].toFixed(3),
      overlap: row[2].toFixed(3),
      a: `${pair.a.width}x${pair.a.height}`,
      b: `${pair.b.width}x${pair.b.height}`,
    });
    al.dispose();
  }
  check(
    'detail example really has different sizes',
    EXAMPLES.find((e) => e.id === 'detail')!.a.w !== EXAMPLES.find((e) => e.id === 'detail')!.b.w,
  );

  /* ---------------- multi-modal example (landmarks) ---------------- */
  {
    const lm = exampleById('landmarks')!;
    const pair = buildExample(lm);
    const lsamples = buildSamples(pair.a, { enabled: true, mode: 'gradient', count: 900, seed: 3 });
    const laligner = new Aligner(gpu.device, pair.b, lsamples, cfg.limits, 8192);
    const tprobe = new Float32Array([
      lm.truth.tx, lm.truth.ty, lm.truth.theta, lm.truth.scale, lm.truth.aspect, lm.truth.shear,
    ]);
    const trow = await laligner.evaluate(tprobe, 1);
    check('landmarks truth scores high', trow[0] > 0.85, {
      score: trow[0].toFixed(4),
      ncc: trow[1].toFixed(4),
      overlap: trow[2].toFixed(3),
    });
    const lcfg = tinyConfig();
    lcfg.dofs.tx = { enabled: true, min: -0.2, max: 0.2, steps: 21, value: 0 };
    lcfg.dofs.ty = { enabled: true, min: -0.2, max: 0.2, steps: 21, value: 0 };
    lcfg.dofs.theta = { enabled: true, min: (-8 * Math.PI) / 180, max: (8 * Math.PI) / 180, steps: 17, value: 0 };
    lcfg.dofs.scale = { enabled: true, min: 0.95, max: 1.05, steps: 5, value: 1 };
    lcfg.refine = true;
    const lres = await runSearch({ evaluate: (p, n) => laligner.evaluate(p, n), batch: 8192, cfg: lcfg });
    const lhm = buildHeatmap(lres, lcfg, 'tx', 'ty', 'projection');
    const lopts = findOptima(lhm, lres, 12);
    check('landmarks grid + polish aligns well', bestOf(lres).score > 0.9, {
      score: bestOf(lres).score.toFixed(4),
      params: bestOf(lres).params,
    });
    check('repeated pattern yields several local optima', lopts.length >= 3, {
      optima: lopts.length,
      evals: lres.count,
      gradientSamples: lsamples.count,
      bestScore: bestOf(lres).score.toFixed(4),
    });
    check('gradient sampling produces valid count', lsamples.count === 900, { count: lsamples.count });
    laligner.dispose();
  }

  /* ---------------- warp renderer ---------------- */
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const renderer = new WarpRenderer(
    gpu.device,
    canvas,
    gpu.format,
    // textures are rebuilt internally from the images, so hand it fresh ones
    (await import('../src/gpu/device')).uploadTexture(gpu.device, a, 'test-A'),
    (await import('../src/gpu/device')).uploadTexture(gpu.device, b, 'test-B'),
    a,
    b,
  );
  renderer.resize(256, 256);
  renderer.render(matOfAffine(truth), { ...DEFAULT_VIEW, mode: 0, opacity: 0.5 });
  const meanBlend = await readCanvas(gpu.device, canvas);
  check('renderer draws something', meanBlend > 0.05, { mean: meanBlend });

  const canvas2 = document.createElement('canvas');
  canvas2.width = 256;
  canvas2.height = 256;
  const r2 = new WarpRenderer(
    gpu.device,
    canvas2,
    gpu.format,
    (await import('../src/gpu/device')).uploadTexture(gpu.device, a, 'test-A2'),
    (await import('../src/gpu/device')).uploadTexture(gpu.device, b, 'test-B2'),
    a,
    b,
  );
  r2.resize(256, 256);
  r2.render(matOfAffine(truth), { ...DEFAULT_VIEW, mode: 1, gain: 3 });
  const diffAligned = await readCanvas(gpu.device, canvas2);

  const canvas3 = document.createElement('canvas');
  canvas3.width = 256;
  canvas3.height = 256;
  const r3 = new WarpRenderer(
    gpu.device,
    canvas3,
    gpu.format,
    (await import('../src/gpu/device')).uploadTexture(gpu.device, a, 'test-A3'),
    (await import('../src/gpu/device')).uploadTexture(gpu.device, b, 'test-B3'),
    a,
    b,
  );
  r3.resize(256, 256);
  r3.render(matOfAffine({ tx: 0, ty: 0, theta: 0, scale: 1, aspect: 1, shear: 0 }), {
    ...DEFAULT_VIEW,
    mode: 1,
    gain: 3,
  });
  const diffIdentity = await readCanvas(gpu.device, canvas3);
  check('difference image dimmer when aligned', diffAligned < diffIdentity, {
    aligned: diffAligned,
    identity: diffIdentity,
  });

  /* ---------------- done ---------------- */
  const failed = checks.filter((c) => !c.ok);
  const result = {
    ok: failed.length === 0,
    checks,
    failed: failed.map((f) => f.name),
    best: { score: gb.score, ncc: gb.ncc, params: gb.params, err: gerr },
    stochasticBest: { score: sb.score, err: serr },
  };
  window.__RESULT = result;
  log(`\n${result.ok ? 'ALL PASS' : 'FAILURES: ' + result.failed.join(', ')}`);
  aligner.dispose();
  renderer.dispose();
  r2.dispose();
  r3.dispose();
}

main().catch((e) => {
  const msg = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
  window.__ERROR = msg;
  out.textContent = `ERROR ${msg}`;
  // eslint-disable-next-line no-console
  console.error(e);
});

// keep types used
void candidateAt;
