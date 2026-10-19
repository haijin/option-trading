import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectClaude, detectPython, findOnPath, investAgentRoot } from '../../src/server/research/env';
import { FakeExecutor, parseStreamLine } from '../../src/server/research/executor';
import { ResearchManager } from '../../src/server/research/manager';
import { buildPrompt } from '../../src/server/research/prompt';
import { PRESETS, SKILL_IDS, SKILLS } from '../../src/server/research/skills';

describe('prompt builder', () => {
  const base = {
    skillMarkdown:
      '# Skill\nAnalyse $ARGUMENTS now.\nRun `python3 ~/ai-berkshire/tools/financial_rigor.py cross-validate` and `python3 ~/ai-berkshire/tools/report_audit.py extract`.\nAgain: $ARGUMENTS',
    target: 'Coca-Cola (KO, US)',
    root: 'D:\\ai-berkshire',
    python: 'C:\\Users\\me\\Python\\python.exe',
    today: '2026-10-11',
  };

  it('substitutes every placeholder and rewrites the tool root and interpreter', () => {
    const p = buildPrompt(base);
    expect(p).not.toContain('$ARGUMENTS');
    expect(p).not.toContain('~/ai-berkshire');
    expect(p).not.toMatch(/\bpython3\b/);
    expect(p).toContain('Analyse Coca-Cola (KO, US) now.');
    expect(p).toContain('"C:/Users/me/Python/python.exe" D:/ai-berkshire/tools/financial_rigor.py cross-validate');
    expect(p).toContain('Again: Coca-Cola (KO, US)');
  });

  it('forbids file writes and puts the skill after a clear marker', () => {
    const p = buildPrompt(base);
    expect(p).toMatch(/Do not create, edit or save any file/);
    expect(p).toMatch(/not investment advice/);
    expect(p.indexOf('=== SKILL ===')).toBeGreaterThan(p.indexOf('Do not create'));
    expect(p).toContain('Today is 2026-10-11');
  });

  it('without Python it says so instead of pointing at a tool that cannot run', () => {
    const p = buildPrompt({ ...base, python: null });
    expect(p).toMatch(/not available on this machine/);
    expect(p).toContain('python3');
  });

  it('adds database facts as flagged context only when given', () => {
    expect(buildPrompt(base)).not.toMatch(/Facts from the user's own database/);
    const p = buildPrompt({ ...base, context: ['last close 68.2 USD'] });
    expect(p).toMatch(/Facts from the user's own database \(may be stale/);
    expect(p).toContain('- last close 68.2 USD');
  });
});

describe('claude stream-json parsing', () => {
  it('turns assistant text and tool calls into progress lines', () => {
    const text = parseStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: { model: 'm1', content: [{ type: 'text', text: 'Gate 1:   looks fine\nand more' }] },
      }),
    );
    expect(text.progress).toEqual(['Gate 1: looks fine and more']);
    expect(text.model).toBe('m1');
    const tool = parseStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'KO free cash flow 2025' } }] },
      }),
    );
    expect(tool.progress).toEqual(['tool WebSearch: KO free cash flow 2025']);
  });

  it('reads the final result, its cost and error flag', () => {
    const ok = parseStreamLine(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '# Report', total_cost_usd: 0.42 }),
    );
    expect(ok.result).toEqual({ text: '# Report', costUsd: 0.42, isError: false, detail: 'success' });
    const err = parseStreamLine(
      JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, result: '' }),
    );
    expect(err.result?.isError).toBe(true);
    expect(parseStreamLine(JSON.stringify({ type: 'system', model: 'sonnet' })).model).toBe('sonnet');
  });

  it('ignores blank, malformed and unknown lines', () => {
    for (const l of ['', '   ', 'not json', '{"type":"mystery"}', '[1,2]']) {
      const e = parseStreamLine(l);
      expect(e.progress).toEqual([]);
      expect(e.result).toBeNull();
    }
  });

  it('clips very long lines', () => {
    const e = parseStreamLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } }),
    );
    expect((e.progress[0] as string).length).toBeLessThanOrEqual(180);
  });
});

describe('fake executor', () => {
  const input = (signal: AbortSignal, onProgress: (l: string) => void = () => {}) => ({
    prompt: 'p\n=== SKILL ===\nthe skill',
    cwd: '.',
    signal,
    onProgress,
    maxBudgetUsd: 1,
    model: null,
    tools: [],
    allowedTools: [],
  });

  it('reports progress, records the prompt and returns a markdown report', async () => {
    const ex = new FakeExecutor({ steps: 4 });
    const lines: string[] = [];
    const out = await ex.run(input(new AbortController().signal, (l) => lines.push(l)));
    expect(lines).toHaveLength(4);
    expect(out.markdown).toMatch(/^# Fake report/);
    expect(ex.prompts).toHaveLength(1);
  });

  it('stops when aborted', async () => {
    const ex = new FakeExecutor({ steps: 50, delayMs: 20 });
    const c = new AbortController();
    const run = ex.run(input(c.signal));
    setTimeout(() => c.abort(), 30);
    await expect(run).rejects.toThrow(/cancelled/);
  });
});

describe('environment detection', () => {
  it('finds files on PATH and skips the Microsoft Store stub folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ot-env-'));
    try {
      const real = join(dir, 'bin');
      const stub = join(dir, 'WindowsApps');
      mkdirSync(real);
      mkdirSync(stub);
      writeFileSync(join(real, 'tool.exe'), '');
      writeFileSync(join(stub, 'python.exe'), '');
      const sep = process.platform === 'win32' ? ';' : ':';
      expect(findOnPath(['tool.exe'], { PATH: `${stub}${sep}${real}` })).toBe(join(real, 'tool.exe'));
      expect(findOnPath(['python.exe'], { PATH: stub })).toBeNull();
      expect(findOnPath(['missing.exe'], { PATH: real })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours explicit overrides and refuses ones that do not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ot-env-'));
    try {
      const f = join(dir, 'claude.exe');
      writeFileSync(f, '');
      expect(detectClaude({ OT_CLAUDE_CLI: f })).toBe(f);
      expect(detectClaude({ OT_CLAUDE_CLI: join(dir, 'nope.exe') })).toBeNull();
      expect(detectPython({ OT_PYTHON: f })).toBe(f);
      expect(detectPython({ OT_PYTHON: join(dir, 'nope.exe') })).toBeNull();
      expect(investAgentRoot({ INVEST_AGENT_ROOT: ' D:\\x ' })).toBe('D:\\x');
      expect(investAgentRoot({})).toBe('');
      expect(investAgentRoot({ INVEST_AGENT_ROOT: '   ' })).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('skill catalog', () => {
  it('has the seven chosen skills, only the quality screen is local, presets only reference real skills', () => {
    expect(SKILL_IDS).toHaveLength(7);
    expect(SKILLS.filter((s) => s.local).map((s) => s.id)).toEqual(['quality-screen']);
    for (const s of SKILLS) {
      expect(s.steps.length).toBeGreaterThanOrEqual(2);
      expect(s.local ? s.file === null : s.file === `${s.id}.md`).toBe(true);
    }
    for (const p of PRESETS) for (const id of p.skillIds) expect(SKILL_IDS).toContain(id);
  });

  it('every AI skill points at a file that exists in the Invest-agent repository (when it is on this machine)', () => {
    const root = investAgentRoot();
    if (!root || !existsSync(join(root, 'skills'))) return;
    for (const s of SKILLS) if (s.file) expect(existsSync(join(root, 'skills', s.file)), s.file).toBe(true);
  });

  it('with no INVEST_AGENT_ROOT the prompt-driven skills say to set it, and the local quality screen stays available', async () => {
    const deps = { research: { root: '', executorKind: 'fake', python: null }, fileExists: async () => true };
    const cat = await ResearchManager.prototype.catalog.call({ deps } as unknown as ResearchManager);
    for (const s of cat.skills.filter((x) => x.id !== 'quality-screen')) {
      expect(s.available, s.id).toBe(false);
      expect(s.unavailableReason, s.id).toMatch(/INVEST_AGENT_ROOT is not set/);
    }
    expect(cat.skills.find((x) => x.id === 'quality-screen')).toMatchObject({ available: true });
    expect(cat.root).toBe('');
  });

  it('with the root set and the file present nothing changes: only the executor can make a skill unavailable', async () => {
    const deps = {
      research: { root: 'D:\\ai-berkshire', executorKind: 'none', python: null },
      fileExists: async () => true,
    };
    const cat = await ResearchManager.prototype.catalog.call({ deps } as unknown as ResearchManager);
    const ai = cat.skills.find((x) => x.id === 'investment-research');
    expect(ai?.unavailableReason).toMatch(/no AI executor/);
    const ok = await ResearchManager.prototype.catalog.call({
      deps: { ...deps, research: { ...deps.research, executorKind: 'fake' } },
    } as unknown as ResearchManager);
    expect(ok.skills.every((s) => s.available)).toBe(true);
  });
});
