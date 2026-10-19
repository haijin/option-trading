import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Finds the first existing file named `names[i]` in PATH. Windows Store stubs under WindowsApps are skipped (they open the store, not Python). */
export function findOnPath(names: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (/windowsapps/i.test(dir)) continue;
    for (const n of names) {
      const p = join(dir, n);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** The `claude` executable: OT_CLAUDE_CLI, else PATH. `.cmd` shims are ignored (they cannot be spawned without a shell). */
export function detectClaude(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.OT_CLAUDE_CLI) return existsSync(env.OT_CLAUDE_CLI) ? env.OT_CLAUDE_CLI : null;
  return findOnPath(process.platform === 'win32' ? ['claude.exe'] : ['claude'], env);
}

/** A real Python interpreter: OT_PYTHON, then common install folders, then PATH (minus the Microsoft Store stub). */
export function detectPython(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.OT_PYTHON) return existsSync(env.OT_PYTHON) ? env.OT_PYTHON : null;
  const local = env.LOCALAPPDATA;
  if (local) {
    const c = join(local, 'Python', 'bin', 'python.exe');
    if (existsSync(c)) return c;
  }
  return findOnPath(process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'], env);
}

/** No default: the prompt repository is not bundled, so the six prompt-driven skills stay unavailable until INVEST_AGENT_ROOT is set. */
export const DEFAULT_INVEST_AGENT_ROOT = '';

export function investAgentRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.INVEST_AGENT_ROOT?.trim() || DEFAULT_INVEST_AGENT_ROOT;
}
