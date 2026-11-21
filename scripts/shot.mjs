// Screenshot helper: load a page in headless Chrome (SwiftShader WebGPU) and capture it.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const URL = process.argv[2] || 'http://127.0.0.1:5199/';
const OUT = process.argv[3] || '/tmp/mi-align.png';
const WAIT = Number(process.argv[4] || 25000);
const PORT = 9336;

const bin = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`].find((p) =>
  existsSync(p),
);
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
    '--user-data-dir=/tmp/mi-align-shot-profile',
    '--window-size=1660,1100',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
child.stderr.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
for (let i = 0; i < 80 && !ws; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    ws = l.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch {}
  if (!ws) await sleep(250);
}
const sock = new WebSocket(ws);
let id = 0;
const pending = new Map();
const logs = [];
sock.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  } else if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXC ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
  }
});
await new Promise((r) => sock.addEventListener('open', r));
const send = (method, params = {}) =>
  new Promise((r) => {
    const mid = ++id;
    pending.set(mid, r);
    sock.send(JSON.stringify({ id: mid, method, params }));
  });

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1660, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL });
await sleep(WAIT);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
const info = await send('Runtime.evaluate', {
  expression: 'JSON.stringify({chips: [...document.querySelectorAll(".chip")].map(e=>e.textContent), score: document.querySelector(".scoreValue")?.textContent, opts: document.querySelectorAll(".optimum").length, progs: document.querySelector(".progressText")?.textContent})',
  returnByValue: true,
});
console.log('page:', info.result?.result?.value);
if (logs.length) console.log('console errors:\n' + logs.slice(0, 10).join('\n'));
console.log('wrote', OUT);
child.kill('SIGKILL');
