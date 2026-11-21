// UI integration test: drives the real app in headless Chrome.
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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1660, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL });

// wait for the auto-run to finish
let score = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  score = await evalJs('document.querySelector(".scoreValue")?.textContent ?? null');
  const txt = await evalJs('document.querySelector(".progressText")?.textContent ?? ""');
  if (score && txt === 'idle') break;
}
check('auto-run produced a score', !!score, { score });
check('heatmap rendered', (await evalJs('document.querySelectorAll(".optimum").length')) >= 1, {
  optima: await evalJs('document.querySelectorAll(".optimum").length'),
});
check('warp canvas has size', (await evalJs('document.querySelector(".canvasWrap").getBoundingClientRect().width')) > 300);
check('samples reported', (await evalJs('document.querySelector(".foot .hint").textContent')).includes('samples'));

// ---- hover the heatmap
const rect = await evalJs(
  'JSON.stringify((({x,y,width,height}) => ({x,y,width,height}))(document.querySelector(".heatCanvas").getBoundingClientRect()))',
);
const r = JSON.parse(rect);
const hx = Math.round(r.x + r.width * 0.55);
const hy = Math.round(r.y + r.height * 0.45);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx, y: hy, button: 'none', clickCount: 0 });
await sleep(400);
const hoverText = await evalJs('document.querySelector(".readout").textContent');
check('hover shows full 6-DOF readout', /tx/.test(hoverText) && /θ|θ/.test(hoverText), hoverText.slice(0, 90));
const head1 = await evalJs('document.querySelector(".viewerHead .dim").textContent');
check('hover previews in the overlay', /previewing/.test(head1), head1);

// ---- click a cell
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hx, y: hy, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hx, y: hy, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none', clickCount: 0 });
await sleep(300);
const head2 = await evalJs('document.querySelector(".viewerHead .dim").textContent');
check('clicking a cell pins that transform', /picked/.test(head2), head2);

// ---- view modes
await evalJs('[...document.querySelectorAll(".viewBar .segmented button")].find(b=>b.textContent==="Difference").click()');
await sleep(250);
const sliders = await evalJs('[...document.querySelectorAll(".viewBar .slider span")].map(e=>e.textContent).join(",")');
check('difference mode exposes gain', sliders.includes('gain'), sliders);
await evalJs('[...document.querySelectorAll(".viewBar .segmented button")].find(b=>b.textContent==="Checker").click()');
await sleep(200);
check(
  'checker mode exposes checker size',
  (await evalJs('[...document.querySelectorAll(".viewBar .slider span")].map(e=>e.textContent).join(",")')).includes('checker'),
);

// ---- heatmap axis switch
const before = await evalJs('document.querySelector(".heatCanvas").width');
await evalJs('const s=document.querySelectorAll(".axisRow select")[1]; s.value="theta"; s.dispatchEvent(new Event("change",{bubbles:true}))');
await sleep(500);
const afterAxis = await evalJs('document.querySelectorAll(".axisRow select")[1].value');
const ticks = await evalJs('document.querySelector(".axisRow").textContent');
check('y axis switchable', afterAxis === 'theta', { afterAxis, before, ticks });

// ---- stochastic mode
await evalJs('[...document.querySelectorAll(".segmented button")].find(b=>b.textContent.includes("Stochastic")).click()');
await sleep(300);
const hasSeeds = await evalJs('document.body.textContent.includes("starting points")');
check('stochastic controls appear', hasSeeds);
// run it once to make sure the stochastic path renders results + paths
await evalJs('[...document.querySelectorAll(".runBar button")].find(b=>/Run|Re-run/.test(b.textContent)).click()');
let stoScore = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const idle = await evalJs('document.querySelector(".progressText")?.textContent');
  stoScore = await evalJs('document.querySelector(".scoreValue")?.textContent ?? null');
  if (idle === 'idle' && stoScore) break;
}
check('stochastic run produces a result', !!stoScore, { stoScore });
check(
  'stochastic strategy reported',
  (await evalJs('[...document.querySelectorAll(".statList .v")].map(e=>e.textContent).join("|")')).includes('stochastic'),
);
await evalJs('[...document.querySelectorAll(".segmented button")].find(b=>b.textContent.includes("Exhaustive")).click()');
await sleep(200);

// ---- example switch -> landmarks (multi-modal)
await evalJs('[...document.querySelectorAll(".example")].find(b=>b.textContent.includes("Landmarks")).click()');
let optCount = 0;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const idle = await evalJs('document.querySelector(".progressText")?.textContent');
  optCount = await evalJs('document.querySelectorAll(".optimum").length');
  if (idle === 'idle' && optCount > 0) break;
}
check('landmarks example finds multiple optima', optCount >= 3, { optCount });
const truthLine = await evalJs('document.querySelector(".truth")?.textContent ?? ""');
check('ground truth shown for example', truthLine.includes('ground truth'), truthLine.slice(0, 60));
const errLine = await evalJs('document.querySelector(".errRow")?.textContent ?? ""');
check('error-vs-truth displayed', /pos/.test(errLine), errLine);

// ---- polish button
await evalJs('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Polish")).click()');
await sleep(2500);
check('polish does not crash', (await evalJs('document.querySelector(".scoreValue")?.textContent')) !== null);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} UI checks passed`);
if (errors.length) console.log('page errors:\n' + errors.slice(0, 8).join('\n'));
if (failed.length) process.exitCode = 1;
child.kill('SIGKILL');
