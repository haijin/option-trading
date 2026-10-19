// `pnpm demo`: the web UI against the sample-data mock API; no database, no sign-in, nothing is saved.
//   pnpm demo                    mock API on http://127.0.0.1:4318, UI on http://127.0.0.1:5173
//   pnpm demo --port 5199        extra arguments go to Vite
//   MOCK_PORT=4400 pnpm demo     another port for the mock API (the UI's /api proxy follows it)
// Ctrl+C stops both. Every number on screen is sample data.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mockPort = Number(process.env.MOCK_PORT ?? 4318) || 4318;
const apiTarget = `http://127.0.0.1:${mockPort}`;

const vitePkg = createRequire(import.meta.url).resolve('vite/package.json');
const viteBin = join(dirname(vitePkg), JSON.parse(readFileSync(vitePkg, 'utf8')).bin.vite);

const mock = spawn(process.execPath, ['--import', 'tsx', 'web/mock/server.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, MOCK_PORT: String(mockPort) },
});
const ui = spawn(process.execPath, [viteBin, '--config', 'web/vite.config.ts', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, API_TARGET: apiTarget },
});

console.log(`Demo: sample-data API at ${apiTarget}; the UI address is the Vite "Local" line below. Ctrl+C stops both.`);

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code ?? 0;
  mock.kill();
  ui.kill();
}
mock.on('exit', (code) => stop(code ?? 1));
ui.on('exit', (code) => stop(code ?? 1));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(0));
