import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { Market } from '../../core/calendar';
import type { Instrument } from '../../core/types';
import {
  createResearchRun,
  failOrphanedRuns,
  getResearchRun,
  hasStatements,
  listResearchRuns,
  type ResearchRunRow,
  updateResearchRun,
} from '../../db/app-repos';
import { findInstrument, getInstrument } from '../../db/repos';
import { runIngest } from '../../providers/ingest';
import { YahooClient } from '../../providers/yahoo/client';
import type {
  ResearchRunDetailView,
  ResearchRunView,
  ResearchStartInput,
  ScreenView,
  SkillCatalogView,
  SkillId,
} from '../api-types';
import type { ServerDeps } from '../deps';
import { badRequest, notFound, unavailable } from '../errors';
import type { AppState } from '../services/state';
import type { ValueService } from '../services/value-service';
import { parseMarketSymbol } from '../services/watch-service';
import { buildPrompt } from './prompt';
import { PRESETS, SKILL_IDS, SKILLS, type SkillDef, skillDef } from './skills';

const PROGRESS_KEEP = 60;
const RUN_TIMEOUT_MS = 40 * 60_000;
const CONCURRENCY = 2;

export class ResearchManager {
  private readonly controllers = new Map<string, AbortController>();
  private readonly queue: string[] = [];
  private active = 0;
  private ready: Promise<void>;

  constructor(
    private readonly deps: ServerDeps,
    private readonly state: AppState,
    private readonly values: () => ValueService,
  ) {
    // A run left "running" by a process that died would be polled forever.
    this.ready = failOrphanedRuns(deps.db, 'the server restarted while this run was in progress').then(() => undefined);
  }

  // ------------------------------------------------------------------------------------------ catalog
  async catalog(): Promise<SkillCatalogView> {
    const r = this.deps.research;
    const skills = await Promise.all(
      SKILLS.map(async (s) => {
        let reason: string | null = null;
        if (!s.local) {
          if (!r.root)
            reason = 'INVEST_AGENT_ROOT is not set: clone the ai-berkshire prompts and point INVEST_AGENT_ROOT at them';
          else if (r.executorKind === 'none')
            reason = 'no AI executor: the claude CLI was not found (set OT_CLAUDE_CLI)';
          else if (s.file && !(await this.deps.fileExists(join(r.root, 'skills', s.file))))
            reason = `skill file not found: ${join(r.root, 'skills', s.file)}`;
        }
        const { file: _file, ...rest } = s;
        return { ...rest, available: reason === null, unavailableReason: reason };
      }),
    );
    const notes = [
      'AI skills run in the background through the claude CLI with read-only tools (web search, web fetch, read) and a spending cap; the report is saved when the run finishes.',
      'The prompts are your own files in the Invest-agent repository; the app only fills in the stock and fixes the tool paths.',
    ];
    if (!r.python)
      notes.push(
        'No Python interpreter was found: exact-decimal checks inside the skills are skipped and the model is told so.',
      );
    return { skills, presets: PRESETS, executor: r.executorKind, root: r.root, notes };
  }

  // ------------------------------------------------------------------------------------------ start / list / get
  async start(input: ResearchStartInput): Promise<ResearchRunView[]> {
    await this.ready;
    const { market, symbol } = parseMarketSymbol(input.symbol, input.market);
    const inst = await findInstrument(this.deps.db, market, symbol);
    if (!inst)
      throw badRequest('unknown_stock', `${market}:${symbol} is not in the database: add it to the watchlist first`);
    if (!Array.isArray(input.skillIds) || input.skillIds.length === 0)
      throw badRequest('no_skills', 'pick at least one skill');
    const ids = [...new Set(input.skillIds)];
    for (const id of ids) if (!SKILL_IDS.includes(id)) throw badRequest('unknown_skill', `unknown skill "${id}"`);
    const cat = await this.catalog();
    for (const id of ids) {
      const s = cat.skills.find((x) => x.id === id);
      if (s && !s.available) throw unavailable('skill_unavailable', s.unavailableReason ?? `${id} is not available`);
    }
    // The quality screen is local and reads stored statements: a name that came from the Leaders universe has none yet.
    if (ids.includes('quality-screen') && !(await hasStatements(this.deps.db, inst.id)))
      await this.fetchStatements(inst);
    const rows: ResearchRunRow[] = [];
    for (const id of ids) rows.push(await createResearchRun(this.deps.db, inst.id, id));
    for (const r of rows) {
      this.queue.push(r.id);
    }
    this.pump();
    return rows.map((r) => toView(r, market, symbol));
  }

  /**
   * The one-name fundamentals fetch (profile and statements, about 30 s) for a name that is not on the watchlist. A failure does
   * not stop the run: the quality screen then reports that it has no statements, which is the truth.
   */
  private async fetchStatements(inst: Instrument): Promise<void> {
    try {
      const out = await runIngest(
        {
          db: this.deps.db,
          client: new YahooClient({ fetch: this.deps.fetch }),
          fetch: this.deps.fetch,
          now: this.deps.now(),
          dataDir: this.deps.dataDir,
          readFile: this.deps.readFile,
          fileExists: this.deps.fileExists,
          log: this.deps.log,
        },
        { steps: ['profile', 'fundamentals'], names: [inst] },
      );
      if (out.failed > 0)
        this.deps.log(
          `statements for ${inst.market}:${inst.symbol}: ${out.items
            .filter((i) => i.status === 'failed')
            .map((i) => i.detail)
            .join(' | ')}`,
        );
      this.state.bump();
    } catch (err) {
      this.deps.log(`statements for ${inst.market}:${inst.symbol} failed: ${(err as Error).message}`);
    }
  }

  async list(market?: Market, symbol?: string): Promise<ResearchRunView[]> {
    await this.ready;
    let instrumentId: number | undefined;
    let key: { market: Market; symbol: string } | null = null;
    if (symbol) {
      const p = parseMarketSymbol(symbol, market);
      const inst = await findInstrument(this.deps.db, p.market, p.symbol);
      if (!inst) return [];
      instrumentId = inst.id;
      key = p;
    }
    // Ask questions share the table (skill_id 'ask') but have their own endpoint and no report: the Research page never lists them.
    const rows = (await listResearchRuns(this.deps.db, instrumentId)).filter((r) => Boolean(skillDef(r.skillId)));
    return Promise.all(rows.map((r) => this.viewOf(r, key)));
  }

  private async viewOf(r: ResearchRunRow, key: { market: Market; symbol: string } | null): Promise<ResearchRunView> {
    if (key) return toView(r, key.market, key.symbol);
    const inst = await getInstrument(this.deps.db, r.instrumentId);
    return toView(r, inst?.market ?? 'US', inst?.symbol ?? '?');
  }

  async get(id: string): Promise<ResearchRunDetailView> {
    await this.ready;
    const r = await getResearchRun(this.deps.db, id);
    if (!r) throw notFound(`no research run ${id}`);
    const view = await this.viewOf(r, null);
    let report: ResearchRunDetailView['report'] = null;
    const res = r.result as { screen?: ScreenView } | null;
    if (res?.screen) report = { format: 'screen', screen: res.screen };
    else if (r.reportPath) report = { format: 'markdown', markdown: await this.readReport(r.reportPath) };
    return { ...view, report };
  }

  async reportMarkdown(id: string): Promise<string> {
    await this.ready;
    const r = await getResearchRun(this.deps.db, id);
    if (!r) throw notFound(`no research run ${id}`);
    if (r.reportPath) return this.readReport(r.reportPath);
    const res = r.result as { screen?: ScreenView; markdown?: string } | null;
    if (res?.markdown) return res.markdown;
    throw notFound('this run has no report yet');
  }

  private async readReport(rel: string): Promise<string> {
    const full = resolve(this.deps.reportsDir, rel);
    if (!full.startsWith(resolve(this.deps.reportsDir) + sep)) throw badRequest('bad_path', 'invalid report path');
    try {
      return await readFile(full, 'utf8');
    } catch {
      throw notFound('the report file is missing on disk');
    }
  }

  async cancel(id: string): Promise<ResearchRunView> {
    await this.ready;
    const r = await getResearchRun(this.deps.db, id);
    if (!r) throw notFound(`no research run ${id}`);
    if (r.status === 'queued') {
      const i = this.queue.indexOf(id);
      if (i >= 0) this.queue.splice(i, 1);
      await updateResearchRun(this.deps.db, id, { status: 'cancelled', finishedAt: this.deps.now() });
    } else if (r.status === 'running') {
      this.controllers.get(id)?.abort();
    }
    return this.viewOf((await getResearchRun(this.deps.db, id)) as ResearchRunRow, null);
  }

  /** Waits for every queued and running run to finish (tests). */
  async idle(): Promise<void> {
    while (this.active > 0 || this.queue.length > 0) await new Promise((r) => setTimeout(r, 20));
  }

  // ------------------------------------------------------------------------------------------ worker
  private pump(): void {
    while (this.active < CONCURRENCY && this.queue.length > 0) {
      const id = this.queue.shift() as string;
      this.active++;
      void this.runOne(id).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async runOne(id: string): Promise<void> {
    const db = this.deps.db;
    const row = await getResearchRun(db, id);
    if (row?.status !== 'queued') return;
    const inst = await getInstrument(db, row.instrumentId);
    const def = skillDef(row.skillId);
    if (!inst || !def) {
      await updateResearchRun(db, id, {
        status: 'failed',
        error: 'stock or skill no longer exists',
        finishedAt: this.deps.now(),
      });
      return;
    }
    const ctrl = new AbortController();
    this.controllers.set(id, ctrl);
    await updateResearchRun(db, id, { status: 'running', startedAt: this.deps.now() });
    try {
      if (def.local) await this.runLocal(id, inst.market, inst.symbol, def);
      else await this.runAi(id, inst.market, inst.symbol, inst.name, def, ctrl);
    } catch (err) {
      const cancelled = ctrl.signal.aborted;
      await updateResearchRun(db, id, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? 'cancelled' : (err as Error).message,
        finishedAt: this.deps.now(),
      });
    } finally {
      this.controllers.delete(id);
      this.state.bump();
    }
  }

  private async runLocal(id: string, market: Market, symbol: string, def: SkillDef): Promise<void> {
    const v = await this.values().view(market, symbol);
    if (!v.hasFundamentals) throw new Error('no stored financial statements yet for this stock: run an ingest first');
    const markdown = screenMarkdown(symbol, market, v.screen);
    const path = await this.saveReport(market, symbol, def.id, markdown, null);
    await updateResearchRun(this.deps.db, id, {
      status: 'done',
      finishedAt: this.deps.now(),
      stepIndex: def.steps.length,
      reportPath: path,
      result: { screen: v.screen },
    });
  }

  private async runAi(
    id: string,
    market: Market,
    symbol: string,
    name: string | null,
    def: SkillDef,
    ctrl: AbortController,
  ): Promise<void> {
    const r = this.deps.research;
    const skillMarkdown = await this.deps.readFile(join(r.root, 'skills', def.file as string));
    const today = this.deps.now().toISOString().slice(0, 10);
    const target = `${name ?? symbol} (${market === 'HK' ? `${symbol}.HK, HKEX` : `${symbol}, US`})`;
    const ctx = await this.contextFacts(market, symbol);
    const prompt = buildPrompt({ skillMarkdown, target, root: r.root, python: r.python, today, context: ctx });
    const progress: string[] = [];
    let calls = 0;
    let lastSave = 0;
    const timer = setTimeout(() => ctrl.abort(), RUN_TIMEOUT_MS);
    const tools = ['WebSearch', 'WebFetch', 'Read'];
    const allowed = ['WebSearch', 'WebFetch', 'Read'];
    if (r.python) {
      tools.push('Bash');
      // Only the exact-decimal helper scripts may run. The model sometimes prefixes environment variables or uses a
      // relative path, hence the wildcards around the interpreter name.
      const py = basename(r.python.replace(/\\/g, '/'));
      allowed.push(`Bash(*${py}*financial_rigor.py*)`, `Bash(*${py}*report_audit.py*)`);
    }
    try {
      const out = await r.executor.run({
        prompt,
        cwd: r.root,
        signal: ctrl.signal,
        maxBudgetUsd: r.maxBudgetUsd,
        model: r.model,
        tools,
        allowedTools: allowed,
        onProgress: (line) => {
          if (line.startsWith('tool ')) calls++;
          progress.push(line);
          if (progress.length > PROGRESS_KEEP) progress.splice(0, progress.length - PROGRESS_KEEP);
          const now = Date.now();
          if (now - lastSave > 1500) {
            lastSave = now;
            const stepIndex = Math.min(def.steps.length - 1, Math.floor(calls / 4));
            void updateResearchRun(this.deps.db, id, { progress: [...progress], stepIndex });
          }
        },
      });
      const path = await this.saveReport(market, symbol, def.id, out.markdown, {
        model: out.model,
        costUsd: out.costUsd,
        target,
      });
      await updateResearchRun(this.deps.db, id, {
        status: 'done',
        finishedAt: this.deps.now(),
        progress: [...progress],
        stepIndex: def.steps.length,
        reportPath: path,
        costUsd: out.costUsd,
        model: out.model,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async contextFacts(market: Market, symbol: string): Promise<string[]> {
    try {
      const v = await this.values().view(market, symbol);
      const out: string[] = [`${market}:${symbol}, trading currency ${v.currency}.`];
      if (v.intrinsic)
        out.push(
          `last close ${v.intrinsic.price} ${v.currency} (${v.asOf}); the app's rough intrinsic value is ${v.intrinsic.base?.toFixed(2) ?? 'n/a'} at a ${v.intrinsic.requiredReturnPct}% required return (an assumption-driven estimate, not a fact).`,
        );
      out.push(
        `quality screen on stored data: ${v.screen.verdict} (${v.fundamentals.annual} annual statements stored).`,
      );
      return out;
    } catch {
      return [];
    }
  }

  private async saveReport(
    market: Market,
    symbol: string,
    skillId: SkillId,
    markdown: string,
    meta: { model: string | null; costUsd: number | null; target: string } | null,
  ): Promise<string> {
    const stamp = this.deps
      .now()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z')
      .replace('T', '-');
    const rel = join(`${market}-${symbol}`, `${skillId}-${stamp}.md`);
    const full = join(this.deps.reportsDir, rel);
    await mkdir(dirname(full), { recursive: true });
    const head = [
      `<!-- ${skillId} for ${market}:${symbol}, generated ${this.deps.now().toISOString()}${meta?.model ? `, model ${meta.model}` : ''}${meta?.costUsd != null ? `, cost US$${meta.costUsd.toFixed(2)}` : ''} -->`,
      '',
    ].join('\n');
    await writeFile(
      full,
      `${head}${markdown.trimEnd()}\n\n---\n*Decision support only: statistics and analysis about rules you configured, not investment advice. The app never places orders.*\n`,
      'utf8',
    );
    return rel.split(sep).join('/');
  }
}

function screenVerdictText(s: ScreenView): string {
  const pass = s.rows.filter((r) => r.status === 'pass' || r.status === 'exempt').length;
  const total = s.rows.filter((r) => r.status !== 'na').length;
  const word = s.verdict === 'PASS' || s.verdict === 'EXEMPT-PASS' ? 'pass' : 'fail';
  return `${word} ${pass} of ${total}`;
}

function toView(r: ResearchRunRow, market: Market, symbol: string): ResearchRunView {
  const def = skillDef(r.skillId);
  const screen = (r.result as { screen?: ScreenView } | null)?.screen;
  return {
    id: r.id,
    symbol,
    market,
    skillId: r.skillId as SkillId,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    steps: def?.steps ?? [],
    stepIndex: r.stepIndex,
    progress: r.progress,
    costUsd: r.costUsd,
    model: r.model,
    error: r.error,
    hasReport: r.reportPath !== null || screen !== undefined,
    verdict: screen ? screenVerdictText(screen) : null,
  };
}

export function screenMarkdown(symbol: string, market: Market, s: ScreenView): string {
  const rows = s.rows.map(
    (r) =>
      `| ${r.n} | ${r.label} | ${r.valueText} | ${r.rule} | ${r.status.toUpperCase()} | ${r.note.replace(/\|/g, '/')} |`,
  );
  return [
    `# Quality screen (去劣筛选): ${market}:${symbol}`,
    '',
    `**Verdict: ${s.verdict}** (${s.borderline} borderline, ${s.windowYears} annual statements available)`,
    '',
    '| # | Filter | Value | Rule | Result | Note |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    'The screen removes companies that are clearly not first-rate. Passing does not mean good: business model, management and price still need judgement.',
  ].join('\n');
}
