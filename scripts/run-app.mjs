// `pnpm app`: builds the web UI when it is missing, starts the local server and opens it in the browser.
//   pnpm app               build if needed, start, open http://127.0.0.1:3004
//   pnpm app --no-open     same, without opening a browser
//   pnpm app --rebuild     rebuild the UI first
// If a server is already answering on the port, this just opens it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const port = Number(process.env.OT_PORT ?? 3004) || 3004;
const url = `http://127.0.0.1:${port}`;
const args = new Set(process.argv.slice(2));

async function healthy() {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function open(target) {
  if (args.has('--no-open')) return;
  if (process.platform === 'win32')
    spawn('cmd', ['/c', 'start', '', target], { stdio: 'ignore', detached: true }).unref();
  else if (process.platform === 'darwin') spawn('open', [target], { stdio: 'ignore', detached: true }).unref();
  else spawn('xdg-open', [target], { stdio: 'ignore', detached: true }).unref();
}

if (await healthy()) {
  console.log(`Option Trading is already running at ${url}`);
  open(url);
  process.exit(0);
}

if (args.has('--rebuild') || !existsSync('web/dist/index.html')) {
  console.log('Building the web UI...');
  const b = spawnSync('pnpm', ['web:build'], { stdio: 'inherit', shell: true });
  if (b.status !== 0) {
    console.error('The web UI build failed; the API will still start.');
  }
}

const server = spawn('pnpm', ['app:server'], { stdio: 'inherit', shell: true });
server.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill());

for (let i = 0; i < 60; i++) {
  if (await healthy()) {
    console.log(`Ready: ${url}  (Ctrl+C stops it)`);
    open(url);
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
