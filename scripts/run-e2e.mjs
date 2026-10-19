// Runs every tests/e2e/*.test.ts file in its own vitest process.
//
// On this Windows host a vitest worker occasionally dies with a native abort (exit code 0xC0000409, "Worker exited
// unexpectedly") even though the same file passes on rerun and no test assertion is involved (about 1 in 8 full runs,
// seen in files of any size, never deterministic; see DECISIONS.md). A file is retried ONLY when that exact worker-crash
// signature appears and no assertion failed; an assertion failure or any other error fails the run immediately.
// Every retry is printed.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join('tests', 'e2e');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort();
const vitest = join('node_modules', 'vitest', 'vitest.mjs');
const MAX_ATTEMPTS = 3;
let failed = 0;

for (const f of files) {
  const path = `tests/e2e/${f}`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.e2e.config.ts', path], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    process.stdout.write(r.stdout ?? '');
    process.stderr.write(r.stderr ?? '');
    if (r.status === 0) break;
    const text = `${r.stdout}${r.stderr}`;
    const crashed =
      text.includes('Worker exited unexpectedly') &&
      !/AssertionError|\bFAIL\b/.test(text.replace(/Unhandled Error/g, ''));
    if (crashed && attempt < MAX_ATTEMPTS) {
      console.error(
        `\n[run-e2e] ${path}: the worker process was killed by the OS (not a test failure); retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})\n`,
      );
      continue;
    }
    failed++;
    break;
  }
}
console.log(
  failed === 0 ? `\n[run-e2e] all ${files.length} e2e files passed` : `\n[run-e2e] ${failed} e2e file(s) failed`,
);
process.exit(failed === 0 ? 0 : 1);
