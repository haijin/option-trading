import { spawn } from 'node:child_process';

export interface ExecInput {
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  /** One line of progress (a tool call or a sentence the model wrote). */
  onProgress(line: string): void;
  maxBudgetUsd: number;
  model: string | null;
  /** Built-in tools made available, and the permission rules that need no prompt. Everything else is denied. */
  tools: string[];
  allowedTools: string[];
  /**
   * Ignore every MCP server configured on this machine (`--strict-mcp-config`) and every skill. For runs that must see
   * nothing but the prompt (the journal's AI rewrite): the user's own MCP servers would otherwise start with each run.
   */
  isolated?: boolean;
}

export interface ExecResult {
  markdown: string;
  costUsd: number | null;
  model: string | null;
}

/** Runs one prompt to a finished report. The real one shells out to `claude -p`; tests use FakeExecutor. */
export interface SkillExecutor {
  readonly kind: 'claude-cli' | 'fake';
  run(input: ExecInput): Promise<ExecResult>;
}

// ------------------------------------------------------------------------------------------------ stream parsing
export interface StreamEvent {
  progress: string[];
  model: string | null;
  result: { text: string; costUsd: number | null; isError: boolean; detail: string } | null;
}

const clip = (s: string, n = 180): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, ' ').trim();

/** Parses one line of `claude -p --output-format stream-json --verbose`. Unknown or malformed lines yield an empty event. */
export function parseStreamLine(line: string): StreamEvent {
  const out: StreamEvent = { progress: [], model: null, result: null };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return out;
  }
  if (j.type === 'system' && typeof j.model === 'string') out.model = j.model;
  if (j.type === 'assistant') {
    const msg = j.message as { model?: string; content?: unknown[] } | undefined;
    if (msg?.model) out.model = msg.model;
    for (const b of msg?.content ?? []) {
      const blk = b as { type?: string; text?: string; name?: string; input?: Record<string, unknown> };
      if (blk.type === 'text' && blk.text?.trim()) out.progress.push(clip(blk.text));
      else if (blk.type === 'tool_use') {
        const arg = blk.input
          ? (blk.input.query ?? blk.input.url ?? blk.input.command ?? blk.input.file_path ?? blk.input.prompt ?? '')
          : '';
        out.progress.push(`tool ${blk.name ?? '?'}${arg ? `: ${clip(String(arg), 120)}` : ''}`);
      }
    }
  }
  if (j.type === 'result') {
    out.result = {
      text: typeof j.result === 'string' ? j.result : '',
      costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
      isError: j.is_error === true || (typeof j.subtype === 'string' && j.subtype !== 'success'),
      detail: [j.subtype, j.terminal_reason, j.api_error_status]
        .filter((x) => typeof x === 'string' || typeof x === 'number')
        .join(' / '),
    };
  }
  return out;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32')
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

// ------------------------------------------------------------------------------------------------ claude -p
export function createClaudeCliExecutor(command: string): SkillExecutor {
  return {
    kind: 'claude-cli',
    run(i) {
      return new Promise<ExecResult>((resolve, reject) => {
        if (i.signal.aborted) return reject(new Error('cancelled'));
        const args = [
          '-p',
          '--output-format',
          'stream-json',
          '--verbose',
          '--no-session-persistence',
          '--permission-mode',
          'dontAsk',
          // The user's own hooks and plugins (global settings) must not run inside a research run.
          '--setting-sources',
          'project,local',
          '--tools',
          i.tools.join(','),
          '--allowedTools',
          i.allowedTools.join(','),
          '--max-budget-usd',
          String(i.maxBudgetUsd),
          ...(i.model ? ['--model', i.model] : []),
          ...(i.isolated ? ['--strict-mcp-config', '--disable-slash-commands'] : []),
        ];
        // UTF-8 for the Python helpers: the Windows code page cannot print the tool's own help text.
        const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
        const child = spawn(command, args, { cwd: i.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let model: string | null = null;
        let final: StreamEvent['result'] = null;
        let buf = '';
        let err = '';
        const onAbort = (): void => killTree(child.pid);
        i.signal.addEventListener('abort', onAbort, { once: true });
        const eat = (line: string): void => {
          if (!line.trim()) return;
          const ev = parseStreamLine(line);
          if (ev.model) model = ev.model;
          for (const p of ev.progress) i.onProgress(p);
          if (ev.result) final = ev.result;
        };
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d: string) => {
          buf += d;
          let nl = buf.indexOf('\n');
          while (nl >= 0) {
            eat(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
            nl = buf.indexOf('\n');
          }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (d: string) => {
          err = (err + d).slice(-2000);
        });
        child.on('error', (e) => {
          i.signal.removeEventListener('abort', onAbort);
          reject(new Error(`could not start the claude CLI (${command}): ${e.message}`));
        });
        child.on('close', (code) => {
          i.signal.removeEventListener('abort', onAbort);
          eat(buf);
          if (i.signal.aborted) return reject(new Error('cancelled'));
          const r = final as StreamEvent['result'];
          if (r && !r.isError && r.text.trim()) return resolve({ markdown: r.text, costUsd: r.costUsd, model });
          reject(
            new Error(
              r?.isError
                ? `the run ended with an error (${r.detail || 'no detail'}): ${clip(r.text || err, 400)}`
                : `claude exited with code ${code}: ${clip(err, 400) || 'no output'}`,
            ),
          );
        });
        child.stdin.on('error', () => {});
        child.stdin.end(i.prompt);
      });
    },
  };
}

// ------------------------------------------------------------------------------------------------ fake (tests, demos)
type FakeReply = string | { markdown: string; costUsd?: number | null; model?: string | null };

export class FakeExecutor implements SkillExecutor {
  readonly kind = 'fake' as const;
  readonly prompts: string[] = [];
  readonly inputs: ExecInput[] = [];
  /** True when this fake answers with scripted text (`reply`): the news jobs only use a fake that can write a JSON answer. */
  readonly scripted: boolean;
  constructor(
    private readonly opts: {
      delayMs?: number;
      steps?: number;
      failWhen?: (prompt: string) => boolean;
      /** Replaces the canned report: the text the model "wrote" for this prompt (a string, or an object with an optional cost and model); sync or async. */
      reply?: (prompt: string) => FakeReply | Promise<FakeReply>;
    } = {},
  ) {
    this.scripted = opts.reply !== undefined;
  }

  async run(i: ExecInput): Promise<ExecResult> {
    this.prompts.push(i.prompt);
    this.inputs.push(i);
    const steps = this.opts.steps ?? 3;
    for (let s = 1; s <= steps; s++) {
      if (i.signal.aborted) throw new Error('cancelled');
      i.onProgress(`tool WebSearch: step ${s} of ${steps}`);
      if (this.opts.delayMs) await sleep(this.opts.delayMs, i.signal);
    }
    if (i.signal.aborted) throw new Error('cancelled');
    if (this.opts.failWhen?.(i.prompt)) throw new Error('the fake executor was told to fail');
    if (this.opts.reply) {
      const r = await this.opts.reply(i.prompt);
      return typeof r === 'string'
        ? { markdown: r, costUsd: 0.01, model: 'fake-model' }
        : {
            markdown: r.markdown,
            costUsd: r.costUsd === undefined ? 0.01 : r.costUsd,
            model: r.model === undefined ? 'fake-model' : r.model,
          };
    }
    const title = /^=== SKILL ===\n(.*)$/m.exec(i.prompt)?.[1] ?? 'skill';
    return {
      markdown: `# Fake report\n\n${title}\n\n| Gate | Stars |\n|---|---|\n| Business | 4 |\n\n- prompt characters: ${i.prompt.length}\n`,
      costUsd: 0.01,
      model: 'fake-model',
    };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
