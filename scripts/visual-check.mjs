// Pixel-level visual check: captures the landing page and the studio, then
// analyses regions in-page (so we can assert things without eyeballing pngs).
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const URL = process.env.APP_URL || process.argv[2] || 'http://127.0.0.1:5199/';
const OUT = process.argv[3] || '/tmp/mi-align-visual.png';
const PORT = 9340;
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
    '--user-data-dir=/tmp/mi-align-visual-profile',
    '--window-size=1660,1150',
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
sock.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
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
  return r.result?.result?.value;
};

const analyse = async (png, regions, extra) =>
  JSON.parse(
    await evalJs(`(async () => {
  const png = ${JSON.stringify(png)};
  const img = new Image();
  img.src = 'data:image/png;base64,' + png;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height}; };
  const stats = (b) => {
    if (!b) return null;
    const d = g.getImageData(Math.round(b.x), Math.round(b.y), Math.max(1, Math.round(b.w)), Math.max(1, Math.round(b.h))).data;
    let sum = 0, sum2 = 0, n = 0, black = 0;
    const colors = new Set(); let warm = 0, green = 0;
    for (let i = 0; i < d.length; i += 4 * 3) {
      const l = (d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114) / 255;
      sum += l; sum2 += l*l; n++;
      if (d[i] < 8 && d[i+1] < 8 && d[i+2] < 8) black++;
      colors.add(((d[i]>>4)<<8) | ((d[i+1]>>4)<<4) | (d[i+2]>>4));
      if (d[i] > 200 && d[i+1] > 195 && d[i+2] < 150) warm++;
      if (d[i+1] > d[i] + 25 && d[i+1] > d[i+2] + 20) green++;
    }
    const mean = sum / n;
    return { mean: +mean.toFixed(3), std: +Math.sqrt(sum2/n - mean*mean).toFixed(3), colors: colors.size,
             blackPct: +((black / n) * 100).toFixed(1), warmPx: warm, greenPx: green, w: Math.round(b.w), h: Math.round(b.h) };
  };
  const out = { page: { w: img.width, h: img.height }, __extra: ${JSON.stringify(extra ?? null)} };
  for (const [name, sel] of Object.entries(${JSON.stringify(regions)})) out[name] = stats(box(sel));
  return JSON.stringify(out);
})()`),
  );

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1660, height: 1150, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL });

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
};

/* ---------------- landing ---------------- */
await sleep(5200);
const shot0 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
const landing = await analyse(shot0.result.data, { hero: '.landing-hero', cards: '.ex-grid', card: '.ex-card' });
check('landing hero has text', landing.hero && landing.hero.std > 0.05, landing.hero);
check('example cards render art', landing.cards && landing.cards.std > 0.06 && landing.cards.colors > 24, landing.cards);

/* ---------------- studio ---------------- */
await evalJs(
  `(() => { const card = [...document.querySelectorAll('.ex-card')].find(c => c.querySelector('h3')?.textContent.includes('Detail')); card?.querySelector('.ghost')?.click(); })()`,
);
let ready = false;
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  const idle = await evalJs('document.querySelector(".progressText")?.textContent');
  const hasScore = await evalJs('!!document.querySelector(".scoreValue")');
  if (idle === 'idle' && hasScore) {
    ready = true;
    break;
  }
}
check('studio ready', ready);

// hover a heatmap cell so the preview + readout are exercised in the screenshot
const r = JSON.parse(
  await evalJs('JSON.stringify((({x,y,width,height})=>({x,y,width,height}))(document.querySelector(".heatCanvas").getBoundingClientRect()))'),
);
await send('Input.dispatchMouseEvent', {
  type: 'mouseMoved',
  x: Math.round(r.x + r.width * 0.62),
  y: Math.round(r.y + r.height * 0.4),
  button: 'none',
});
await sleep(700);
const readoutBefore = await evalJs('document.querySelector(".readout")?.textContent?.slice(0, 110)');

const shot1 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
writeFileSync(OUT, Buffer.from(shot1.result.data, 'base64'));
const studio = await analyse(
  shot1.result.data,
  {
    overlay: '.canvasWrap',
    heatmap: '.heatCanvas',
    miHist: '.miHist canvas',
    leftCol: '.col.left',
    rightCol: '.col.right',
    statsRow: '.paramGrid',
  },
  { readout: readoutBefore },
);

check('overlay shows the warped image', studio.overlay && studio.overlay.std > 0.05 && studio.overlay.mean > 0.02, studio.overlay);
check('heatmap has many colours', studio.heatmap && studio.heatmap.colors > 12, studio.heatmap);
check('heatmap shows a bright optimum', studio.heatmap && studio.heatmap.warmPx > 2, studio.heatmap);
check('joint histogram is drawn', studio.miHist && studio.miHist.std > 0.08, studio.miHist);
check('left column is not blank', studio.leftCol && studio.leftCol.std > 0.02, studio.leftCol);
check('right column is not blank', studio.rightCol && studio.rightCol.std > 0.05, studio.rightCol);
check('transform grid is rendered', studio.statsRow && studio.statsRow.std > 0.03, studio.statsRow);
check('readout populated on hover', !!studio.__extra.readout && /tx/.test(studio.__extra.readout), studio.__extra.readout);

/* ---------------- stochastic run leaves unexplored cells black ---------------- */
await evalJs(`[...document.querySelectorAll(".segmented button")].find(b=>b.textContent.includes("Stochastic"))?.click()`);
await sleep(400);
await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.fieldRow')];
  const row = rows.find(r => r.textContent.includes('random samples'));
  const input = row.querySelector('input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '120');
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(300);
await evalJs(`[...document.querySelectorAll(".runBar button")].find(b=>/Run|Re-run/.test(b.textContent)).click()`);
let doneStoch = false;
for (let i = 0; i < 60; i++) {
  await sleep(900);
  const idle = await evalJs('document.querySelector(".progressText")?.textContent');
  const strat = await evalJs('[...document.querySelectorAll(".statList .v")].map(e=>e.textContent).join("|")');
  if (idle === 'idle' && /stochastic/.test(strat)) {
    doneStoch = true;
    break;
  }
}
check('stochastic scan completed', doneStoch);
const emptyCells = await evalJs(
  `(() => { const t = document.querySelector(".legendRow")?.textContent ?? ""; return t; })()`,
);
const shot2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
const sliced = await analyse(shot2.result.data, { heatmap: '.heatCanvas' });
check('unexplored cells are black', sliced.heatmap && sliced.heatmap.blackPct > 25, { ...sliced.heatmap, legend: emptyCells });
check('sampled cells still coloured', sliced.heatmap && sliced.heatmap.colors > 10, sliced.heatmap);

const bad = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - bad.length}/${checks.length} visual checks passed`);
child.kill('SIGKILL');
try {
  sock.close();
} catch {}
process.exit(bad.length ? 1 : 0);
