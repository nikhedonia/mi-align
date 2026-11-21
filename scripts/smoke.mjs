// Drives headless Chrome over CDP and waits for the in-page smoke test result.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:5173/test/smoke.html';
const PORT = 9333;

const candidates = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
].filter(Boolean);

const chrome = candidates.find((p) => existsSync(p));
if (!chrome) {
  console.error('no chrome binary found');
  process.exit(2);
}

const args = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=swiftshader',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/mi-align-smoke-profile',
  '--window-size=1280,900',
  'about:blank',
];

const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', (d) => {
  stderr += d.toString();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('devtools endpoint never came up');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: r } = pending.get(msg.id);
        pending.delete(msg.id);
        r(msg);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      resolve({
        send: (method, params = {}) =>
          new Promise((r) => {
            const mid = ++id;
            pending.set(mid, { resolve: r });
            ws.send(JSON.stringify({ id: mid, method, params }));
          }),
        close: () => ws.close(),
      });
    });
  });
}

const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 180000);

try {
  const cdp = await connect(await getWsUrl());
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: URL });

  const started = Date.now();
  let result = null;
  let error = null;
  while (Date.now() - started < timeoutMs) {
    await sleep(700);
    const r = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ r: window.__RESULT ?? null, e: window.__ERROR ?? null })',
      returnByValue: true,
    });
    const raw = r.result?.result?.value;
    if (!raw) continue;
    const parsed = JSON.parse(raw);
    if (parsed.e) {
      error = parsed.e;
      break;
    }
    if (parsed.r) {
      result = parsed.r;
      break;
    }
  }

  if (error) {
    console.error('SMOKE ERROR\n' + error);
    process.exitCode = 1;
  } else if (!result) {
    console.error('TIMEOUT waiting for smoke result');
    const txt = await cdp.send('Runtime.evaluate', {
      expression: 'document.getElementById("out")?.textContent ?? ""',
      returnByValue: true,
    });
    console.error(txt.result?.result?.value ?? '');
    process.exitCode = 1;
  } else {
    for (const c of result.checks) {
      console.log(`${c.ok ? '  ok  ' : ' FAIL '} ${c.name}${c.detail ? '  ' + JSON.stringify(c.detail) : ''}`);
    }
    console.log(
      `\n${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks passed in ${(
        (Date.now() - started) / 1000
      ).toFixed(1)}s`,
    );
    if (!result.ok) {
      console.error('FAILED: ' + result.failed.join(', '));
      process.exitCode = 1;
    }
    console.log('best:', JSON.stringify(result.best));
    console.log('stochastic:', JSON.stringify(result.stochasticBest));
  }
  cdp.close();
} catch (e) {
  console.error('driver error:', e);
  process.exitCode = 1;
} finally {
  child.kill('SIGKILL');
  if (process.exitCode) {
    const interesting = stderr
      .split('\n')
      .filter((l) => /error|fail/i.test(l) && !/Fontconfig|dbus|gpu_init|GLES|EGL/i.test(l))
      .slice(0, 12)
      .join('\n');
    if (interesting) console.error('--- chrome stderr ---\n' + interesting);
  }
}
