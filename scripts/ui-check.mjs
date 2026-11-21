// UI integration test: landing → studio, manual edits, MI, heatmap zoom, dive, locks.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const URL = process.env.APP_URL || process.argv[2] || 'http://127.0.0.1:5199/';
const PORT = 9338;
const bin = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find((p) => existsSync(p));
const child = spawn(
  bin,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--use-angle=swiftshader',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/mi-align-ui-profile',
    '--window-size=1660,1100',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl;
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    wsUrl = l.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch {}
  if (!wsUrl) await sleep(250);
}
const sock = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const errors = [];
sock.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});
await new Promise((r) => sock.addEventListener('open', r));
const send = (method, params = {}) =>
  new Promise((r) => {
    const mid = ++id;
    pending.set(mid, r);
    sock.send(JSON.stringify({ id: mid, method, params }));
  });
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails));
  return r.result?.result?.value;
};
const clickText = (sel, text) =>
  evalJs(
    `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.includes(${JSON.stringify(
      text,
    )})); if (!el) return false; el.click(); return true; })()`,
  );
const rectOf = async (sel) =>
  JSON.parse(
    await evalJs(
      `JSON.stringify((({x,y,width,height}) => ({x,y,width,height}))(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect()))`,
    ),
  );

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
};

async function waitIdle(timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(900);
    const txt = await evalJs('document.querySelector(".progressText")?.textContent ?? ""');
    if (txt === 'idle') return true;
  }
  return false;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1660, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL });
await sleep(2500);

/* ---------------- landing ---------------- */
check('landing page shown', await evalJs('!!document.querySelector(".landing")'));
check('hero rendered', (await evalJs('document.querySelector(".landing-hero h1")?.textContent ?? ""')).includes('transform'));
const cards = await evalJs('document.querySelectorAll(".ex-card").length');
check('all examples listed', cards === 5, { cards });
await sleep(2500);
const thumbs = await evalJs('document.querySelectorAll(".pairSlot img").length');
check('example previews render', thumbs >= 10, { thumbs });
const pairSizes = await evalJs(
  `[...document.querySelectorAll(".ex-card")].map(c => [...c.querySelectorAll(".pairSlot")].map(s => Math.round(s.getBoundingClientRect().width) + "x" + Math.round(s.getBoundingClientRect().height)).join("|")).join(" ; ")`,
);
const differing = pairSizes
  .split(' ; ')
  .filter((p) => {
    const [a, b] = p.split('|');
    return a !== b;
  });
check('preview pairs show differing A/B shapes', differing.length >= 2, { differing, pairSizes });

/* ---------------- open the different-size example ---------------- */
await evalJs(
  `(() => { const card = [...document.querySelectorAll('.ex-card')].find(c => c.querySelector('h3')?.textContent.includes('Detail')); if (!card) return false; card.querySelector('.ghost').click(); return true; })()`,
);
await sleep(1800);
check('studio opened', await evalJs('!!document.querySelector(".layout")'));
const header = await evalJs('document.querySelector(".tagline")?.textContent ?? ""');
check('header shows both image sizes', /A \d+×\d+ → B \d+×\d+/.test(header), header);

let idle = await waitIdle();
check('auto-run finished', idle);
const score = await evalJs('document.querySelector(".scoreValue")?.textContent ?? null');
check('search produced a score', !!score, { score });
const err = await evalJs('document.querySelector(".errRow")?.textContent ?? ""');
check('recovers the different-size truth', /pos/.test(err) && parseFloat(err.replace(/.*vs truth/, '')) < 3, err);

const scaleRange = await evalJs(
  `(() => { const row = [...document.querySelectorAll(".dofRow")][3]; const i = [...row.querySelectorAll("input")].slice(1).map(e=>e.value); return i.join(","); })()`,
);
check('example suggested a scale range', scaleRange.startsWith('0.54'), { scaleRange });
const space0 = await evalJs('[...document.querySelectorAll(".spaceChip")].map(e=>e.textContent).join(" ")');
check('search space chips shown', /s 0\.540×…0\.760×/.test(space0), space0);

/* ---------------- MI panel ---------------- */
const mi = await evalJs('document.querySelector(".miValue")?.textContent');
check('MI displayed', !!mi && parseFloat(mi) > 0.5, { mi });
const miRows = await evalJs('[...document.querySelectorAll(".miRows .v")].map(e=>e.textContent).join(" ")');
check('MI stats populated', /NCC|0\./.test(miRows), miRows);

/* ---------------- manual transform editing ---------------- */
const readParams = () => evalJs('[...document.querySelectorAll(".paramCell .paramVal")].map(e=>e.textContent).join("|")');
const before = await readParams();
const cv = await rectOf('.warpCanvas');
const cx = Math.round(cv.x + cv.width * 0.5);
const cy = Math.round(cv.y + cv.height * 0.5);
const drag = async (dx, dy, modifiers = 0) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none', buttons: 0, modifiers });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, modifiers, buttons: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + dx, y: cy + dy, button: 'left', buttons: 1, modifiers });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + dx, y: cy + dy, button: 'left', buttons: 0, clickCount: 1, modifiers });
  await sleep(400);
};
await drag(60, 30);
const afterMove = await readParams();
check('drag translates the moving image', afterMove !== before, { before, afterMove });
const txOf = async () => parseFloat((await readParams()).split('|')[0]);
const tx1 = await txOf();
check('translation follows the cursor', tx1 > parseFloat(before.split('|')[0]) + 0.02, { before: before.split('|')[0], tx1 });
check('overlay reports a manual transform', /manual/.test(await evalJs('document.querySelector(".viewerHead .dim")?.textContent ?? ""')));

await drag(90, 0, 8);
const afterRot = await readParams();
const rotDeg = (v) => parseFloat(v.split('|')[2]);
const dropped = Math.abs(rotDeg(afterRot) - rotDeg(afterMove));
check('shift+drag rotates by a sane amount', dropped > 0.5 && dropped < 60, { delta: dropped, afterRot });

await drag(0, -90, 2);
const afterScale = await readParams();
const scaleFactor = parseFloat(afterScale.split('|')[3]) / parseFloat(afterRot.split('|')[3]);
check('ctrl+drag scales sanely', scaleFactor !== 1 && scaleFactor < 4, { scaleFactor, afterScale });

// ctrl+wheel zooms out (smaller scale)
const scaleOf = async () =>
  parseFloat((await evalJs('[...document.querySelectorAll(".paramCell .paramVal")][3]?.textContent ?? "1"')).replace('×', ''));
const scaleBefore = await scaleOf();
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 120, modifiers: 2 });
await sleep(350);
const scaleAfter = await scaleOf();
check('ctrl+wheel zooms out', scaleAfter < scaleBefore, { scaleBefore, scaleAfter });

const miAfter = await evalJs('document.querySelector(".miValue")?.textContent');
check('MI tracks the manual transform', miAfter !== null && miAfter !== mi, { mi, miAfter });

/* ---------------- heatmap: select, zoom, dive ---------------- */
const hcanvas = await rectOf('.heatCanvas');
const hx = Math.round(hcanvas.x + hcanvas.width * 0.56);
const hy = Math.round(hcanvas.y + hcanvas.height * 0.44);
const zoom0 = await evalJs('document.querySelector(".heatCanvas").dataset.zoom');
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx, y: hy, button: 'none' });
await sleep(250);
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: hx, y: hy, deltaX: 0, deltaY: -420, modifiers: 0 });
await sleep(350);
const zoom1 = await evalJs('document.querySelector(".heatCanvas").dataset.zoom');
check('heatmap wheel zoom', parseFloat(zoom1) > parseFloat(zoom0), { zoom0, zoom1 });

// pan while zoomed
const cam0 = (await evalJs('document.querySelector(".heatCanvas").dataset.cam')).split(',').map(Number);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hx, y: hy, button: 'left', clickCount: 1, buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx - 40, y: hy + 30, button: 'left', buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hx - 40, y: hy + 30, button: 'left', clickCount: 1 });
await sleep(300);
const cam1 = (await evalJs('document.querySelector(".heatCanvas").dataset.cam')).split(',').map(Number);
// dragging left/up must move the map with the pointer: cam.cx grows when drag dx<0, cy grows when dy>0
check('heatmap pan follows the pointer', cam1[0] > cam0[0] && cam1[1] > cam0[1], { cam0, cam1 });

// zoom back out below the fit scale
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: hx, y: hy, deltaX: 0, deltaY: 900, modifiers: 0 });
await sleep(350);
const zoomOut = await evalJs('document.querySelector(".heatCanvas").dataset.zoom');
check('heatmap can zoom out past the fit', parseFloat(zoomOut) < 1, { zoomOut });
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: hx, y: hy, deltaX: 0, deltaY: -260, modifiers: 0 });
await sleep(300);

// click a cell -> selection + dive button
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx, y: hy, button: 'none', buttons: 0 });
await sleep(150);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hx, y: hy, button: 'left', clickCount: 1, buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hx, y: hy, button: 'left', buttons: 0, clickCount: 1 });
await sleep(450);
const readout = await evalJs('document.querySelector(".readout")?.textContent ?? ""');
check('cell click selects and offers a dive', /selected/.test(readout) && /dive inside this cell/.test(readout), readout.slice(0, 90));

const crumbs0 = await evalJs('document.querySelectorAll(".crumb").length');
await clickText('.readoutActions button', 'dive inside');
await sleep(600);
const crumbs1 = await evalJs('document.querySelectorAll(".crumb").length');
check('diving adds a breadcrumb', crumbs1 === crumbs0 + 1, { crumbs0, crumbs1 });
const space1 = await evalJs('[...document.querySelectorAll(".spaceChip")].map(e=>e.textContent).join(" ")');
check('dive narrows the search space to the cell', space1 !== space0, { space0, space1 });
idle = await waitIdle();
check('dive search finished', idle);
const scoreDive = await evalJs('document.querySelector(".scoreValue")?.textContent ?? null');
check('dive produces a finer result', !!scoreDive, { score: score, scoreDive });
check('explored cell marked', (await evalJs('document.querySelector(".crumb.last")?.textContent ?? ""')).length > 0);

await clickText('.hmHead button', 'up');
await sleep(500);
const crumbs2 = await evalJs('document.querySelectorAll(".crumb").length');
check('back returns to the parent map', crumbs2 === crumbs0, { crumbs2 });

// ---- zoom-driven subdivision: continuous zoom, finer grid underneath
const chipsA = await evalJs('[...document.querySelectorAll(".spaceChip")].map(e=>e.textContent).join(" ")');
const zoomA = parseFloat(await evalJs('document.querySelector(".heatCanvas").dataset.zoom'));
for (let i = 0; i < 2; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: hx, y: hy, deltaX: 0, deltaY: -800, modifiers: 0 });
  await sleep(500);
}
const zoomMid = parseFloat(await evalJs('document.querySelector(".heatCanvas").dataset.zoom'));
await waitIdle();
const crumbsAuto = await evalJs('document.querySelectorAll(".crumb").length');
const layersAuto = await evalJs('document.querySelector(".heatCanvas").dataset.layers');
const zoomAfter = parseFloat(await evalJs('document.querySelector(".heatCanvas").dataset.zoom'));
const chipsB = await evalJs('[...document.querySelectorAll(".spaceChip")].map(e=>e.textContent).join(" ")');
check('zooming deep subdivides the visible region', crumbsAuto > crumbs0, { crumbs0, crumbsAuto, layersAuto });
check('zoom keeps moving (never reset)', zoomMid > zoomA && zoomAfter >= zoomMid - 0.01, { zoomA, zoomMid, zoomAfter });
check('subdivision narrows the searched range', chipsA !== chipsB, { chipsA, chipsB });
check('the coarser level is kept as context', parseInt(layersAuto, 10) >= 2, { layersAuto });

// ---- zooming back out unwinds the pyramid, neighbours visible, no black
const blackPct = () =>
  evalJs(`(() => { const c = document.querySelector('.heatCanvas'); const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let black = 0, n = 0; for (let i = 0; i < d.length; i += 4) { if (d[i+3] < 10) continue; n++; if (d[i] < 10 && d[i+1] < 10 && d[i+2] < 10) black++; }
    return +((black / Math.max(1, n)) * 100).toFixed(1); })()`);
let crumbsOut = crumbsAuto;
for (let i = 0; i < 10; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: hx, y: hy, deltaX: 0, deltaY: 800, modifiers: 0 });
  await sleep(220);
  crumbsOut = await evalJs('document.querySelectorAll(".crumb").length');
}
await waitIdle();
const crumbsFinal = await evalJs('document.querySelectorAll(".crumb").length');
const blackOut = await blackPct();
check('zooming out climbs back down the pyramid', crumbsFinal < crumbsAuto, { crumbsAuto, crumbsFinal });
check('no black holes when zooming back out', blackOut < 4, { blackOut });
const chipsPop = await evalJs('[...document.querySelectorAll(".spaceChip")].map(e=>e.textContent).join(" ")');
check('a coarser search space is active again', chipsPop !== chipsB, { chipsPop });

/* ---------------- locking an axis ---------------- */
await clickText('.viewerHead button', 'reset to best');
await sleep(400);
const countBefore = await evalJs('document.querySelector(".summary .bigNum")?.textContent');
const lockBtns = await evalJs('document.querySelectorAll(".lockBtn").length');
check('lock buttons present', lockBtns === 6, { lockBtns });
await evalJs('[...document.querySelectorAll(".dofRow")][2].querySelector(".lockBtn").click()');
await sleep(300);
const countAfter = await evalJs('document.querySelector(".summary .bigNum")?.textContent');
const lockedRows = await evalJs('document.querySelectorAll(".dofRow.locked").length');
check('locking removes an axis from the search', countAfter !== countBefore, { countBefore, countAfter, lockedRows });
const thetaLocked = await evalJs(
  '[...document.querySelectorAll(".dofRow.locked")].map(r => r.querySelector(".dofName").textContent).join(",")',
);
check('rotation is the locked axis', thetaLocked.includes('Rotation'), { thetaLocked });

await clickText('.runBar button', 'Run');
idle = await waitIdle();
const err2 = await evalJs('document.querySelector(".errRow")?.textContent ?? ""');
check('still aligned with a locked axis', /pos/.test(err2) && parseFloat(err2.replace(/.*vs truth/, '')) < 3, err2);

/* ---------------- back to landing ---------------- */
await evalJs('document.querySelector(".backBtn").click()');
await sleep(600);
check('back button returns to the landing', await evalJs('!!document.querySelector(".landing")'));
check('session is resumable', await evalJs('document.body.textContent.includes("Continue session")'));
await clickText('.start-tile', 'Continue session');
await sleep(600);
check('resume returns to the studio with state', await evalJs('!!document.querySelector(".scoreValue")'));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} UI checks passed`);
if (errors.length) console.log('page errors:\n' + errors.slice(0, 10).join('\n'));
child.kill('SIGKILL');
try {
  sock.close();
} catch {}
process.exit(failed.length ? 1 : 0);
