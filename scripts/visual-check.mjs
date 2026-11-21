// Pixel-level visual sanity check: captures the page and analyses regions in-page.
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

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1660, height: 1150, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL });

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
console.log('ready:', ready);

// move the mouse onto the heatmap so the hover preview + readout are exercised
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
const readoutBefore = await evalJs('document.querySelector(".readout")?.textContent?.slice(0, 90)');

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));

const analysis = await evalJs(`(async () => {
  const READOUT = ${JSON.stringify(readoutBefore)};
  const png = ${JSON.stringify(shot.result.data)};
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
    const d = g.getImageData(Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)).data;
    let sum = 0, sum2 = 0, n = 0; const colors = new Set(); let warm = 0, green = 0;
    for (let i = 0; i < d.length; i += 4 * 3) {
      const l = (d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114) / 255;
      sum += l; sum2 += l*l; n++;
      colors.add(((d[i]>>4)<<8) | ((d[i+1]>>4)<<4) | (d[i+2]>>4));
      if (d[i] > 200 && d[i+1] > 195 && d[i+2] < 150) warm++;
      if (d[i+1] > d[i] + 25 && d[i+1] > d[i+2] + 20) green++;
    }
    const mean = sum / n;
    return { mean: +mean.toFixed(3), std: +Math.sqrt(sum2/n - mean*mean).toFixed(3), colors: colors.size, warmPx: warm, greenPx: green, w: Math.round(b.w), h: Math.round(b.h) };
  };
  return JSON.stringify({
    page: { w: img.width, h: img.height },
    overlay: stats(box('.canvasWrap')),
    heatmap: stats(box('.heatCanvas')),
    leftCol: stats(box('.col.left')),
    rightCol: stats(box('.col.right')),
    readout: READOUT,
    score: document.querySelector('.scoreValue')?.textContent,
    optima: document.querySelectorAll('.optimum').length,
  });
})()`);

console.log(analysis);
const a = JSON.parse(analysis);
const checks = [
  ['overlay shows an image', a.overlay && a.overlay.std > 0.05 && a.overlay.mean > 0.05 && a.overlay.mean < 0.95],
  ['heatmap has many colours', a.heatmap && a.heatmap.colors > 12],
  ['heatmap shows bright peaks', a.heatmap && a.heatmap.warmPx > 2],
  ['heatmap shows green mid-tones', a.heatmap && a.heatmap.greenPx > 20],
  ['left column is not blank', a.leftCol && a.leftCol.std > 0.02],
  ['right column is not blank', a.rightCol && a.rightCol.std > 0.05],
  ['readout populated', !!a.readout && a.readout.includes('tx')],
  ['score shown', !!a.score],
];
let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`);
}
console.log(bad ? `\n${bad} visual checks failed` : `\nall ${checks.length} visual checks passed`);
if (bad) process.exitCode = 1;
child.kill('SIGKILL');
