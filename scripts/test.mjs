// Starts a dev server, runs the requested browser checks, then shuts everything down.
// usage: node scripts/test.mjs [smoke] [ui-check] [visual-check]
import { spawn } from 'node:child_process';

const suites = process.argv.slice(2);
const wanted = suites.length ? suites : ['smoke'];
const PORT = 5199;
const URL = `http://127.0.0.1:${PORT}/`;

const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(URL);
      if (res.ok) return;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  throw new Error('vite did not start on ' + URL);
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

let exitCode = 0;
try {
  await waitForServer();
  for (const suite of wanted) {
    const file = {
      smoke: 'scripts/smoke.mjs',
      'ui-check': 'scripts/ui-check.mjs',
      'visual-check': 'scripts/visual-check.mjs',
    }[suite];
    if (!file) {
      console.error(`unknown suite: ${suite}`);
      exitCode = 2;
      continue;
    }
    console.log(`\n=== ${suite} ===`);
    const code = await run('node', [file], { SMOKE_URL: `${URL}test/smoke.html`, APP_URL: URL });
    if (code !== 0) exitCode = code;
  }
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  server.kill('SIGKILL');
}
process.exit(exitCode);
