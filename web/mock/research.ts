import type {
  Market,
  ResearchRunDetailView,
  ResearchRunView,
  SkillCatalogView,
  SkillId,
} from '../../src/server/api-types';
import { hasNoProviderData } from './ingest';
import { qualityScreen } from './kpi';
import { isLeaderName } from './leaders';
import type { RunPlanLine, RunRec } from './model';
import { reportMarkdown, screenMarkdown } from './reports';
import { PRESETS, SKILL_CATALOG, SKILLS_ROOT } from './seed-ref';
import { findRow, requireRow, store } from './state';
import { parseSymbol } from './symbols';
import { conflict, hash, invalid, isoAt, notFound, round } from './util';
import { Body } from './validate';

const SKILL_IDS = SKILL_CATALOG.map((s) => s.id);
const MODEL = 'claude-sonnet-4-5';
const COST_USD = { local: 0, light: 0.18, medium: 0.55, heavy: 1.4 } as const;
const UNAVAILABLE: Partial<Record<SkillId, string>> = {
  'investment-research': 'Needs a second source for exact-decimal checks',
};

const info = (id: SkillId) => {
  const found = SKILL_CATALOG.find((s) => s.id === id);
  if (!found) throw new Error(`unknown skill ${id}`);
  return found;
};

export function skillCatalog(): SkillCatalogView {
  return {
    skills: SKILL_CATALOG.map((s) => {
      const reason = store.skillUnavailable ? (UNAVAILABLE[s.id] ?? null) : null;
      return { ...s, available: reason === null, unavailableReason: reason };
    }),
    presets: PRESETS,
    executor: 'fake',
    root: SKILLS_ROOT,
    notes: [
      'The executor is a fake in this build: AI runs write illustrative reports and never call a model.',
      'quality-screen is computed from stored numbers and needs no AI.',
      'AI runs execute one at a time; the rest wait in the queue.',
    ],
  };
}

// ------------------------------------------------------------------------------------------------ plans
const TOOL_LINES = [
  'read stored/fundamentals.json (4 annual, 8 quarterly periods)',
  'web_search "{sym} latest results key figures"',
  'fetch primary filing index (200 OK, 184 KB)',
  'python exact_decimal.py --check roe,gross_margin (ok, max diff 0.3%)',
  'cross-check revenue against a second source: diff 0.4% (ok)',
  'read skills/{skill}/SKILL.md',
  'drafting section ({n} tokens)',
  'compare with the previous 8 periods (ok)',
];

function buildPlan(skillId: SkillId, symbol: string, steps: string[], stepMs: number, local: boolean): RunPlanLine[] {
  const lines: RunPlanLine[] = [];
  steps.forEach((step, i) => {
    const t = i * stepMs;
    lines.push({ t, text: `[${i + 1}/${steps.length}] ${step}` });
    if (local) return;
    for (const [k, offset] of [
      [0, 0.3],
      [1, 0.65],
    ] as const) {
      const pick = TOOL_LINES[hash(`${skillId}${symbol}${i}${k}`) % TOOL_LINES.length];
      lines.push({
        t: Math.round(t + stepMs * offset),
        text: `  ${pick
          .replace('{sym}', symbol)
          .replace('{skill}', skillId)
          .replace('{n}', String(800 + (hash(step) % 900)))}`,
      });
    }
  });
  const end = steps.length * stepMs;
  lines.push({
    t: end,
    text: local ? 'done: 7 filters checked' : `done: report written to reports/${symbol}/${skillId}.md`,
  });
  return lines;
}

const durationOf = (r: RunRec): number => {
  const steps = info(r.skillId).steps.length;
  return r.failAt === null ? steps * r.stepMs : Math.round((r.failAt + 0.5) * r.stepMs);
};

// ------------------------------------------------------------------------------------------------ lifecycle
function finish(rec: RunRec, endMs: number): void {
  rec.finishedAtMs = endMs;
  const row = findRow(rec.market, rec.symbol);
  const profile = row?.profile ?? null;
  if (rec.failAt !== null) {
    rec.status = 'failed';
    rec.stepIndex = rec.failAt;
    rec.error = `Executor exited with code 1: could not fetch primary filings for ${rec.market}:${rec.symbol}.`;
    return;
  }
  rec.status = 'done';
  rec.stepIndex = info(rec.skillId).steps.length - 1;
  const date = isoAt(endMs).slice(0, 10);
  if (!profile) {
    if (!row)
      rec.report = {
        format: 'markdown',
        markdown: `# ${rec.symbol} (${rec.skillId})

Illustrative report from the mock server, ${date}. This name is not on the watchlist, so there were no stored statements: the real server fetches them first.
`,
      };
    return;
  }
  rec.report =
    rec.skillId === 'quality-screen'
      ? { format: 'screen', screen: qualityScreen(profile) }
      : { format: 'markdown', markdown: reportMarkdown(profile, rec.skillId, date) };
}

/** Runs advance with wall time: local runs finish on their own, AI runs take the single executor slot one after another. */
export function advanceRuns(now = Date.now()): void {
  for (const r of store.runs) {
    if (r.local && r.status === 'running' && r.startedAtMs !== null && now - r.startedAtMs >= durationOf(r))
      finish(r, r.startedAtMs + durationOf(r));
  }
  for (;;) {
    const running = store.runs.find((r) => !r.local && r.status === 'running');
    if (running && running.startedAtMs !== null) {
      const end = running.startedAtMs + durationOf(running);
      if (now < end) return;
      finish(running, end);
      store.aiFreeAtMs = end;
      continue;
    }
    const next = store.runs
      .filter((r) => !r.local && r.status === 'queued')
      .sort((a, b) => a.createdAtMs - b.createdAtMs)[0];
    if (!next) return;
    next.status = 'running';
    next.startedAtMs = Math.max(next.createdAtMs, store.aiFreeAtMs);
  }
}

function toView(rec: RunRec, now: number): ResearchRunView {
  const steps = info(rec.skillId).steps;
  const elapsed = rec.startedAtMs === null ? 0 : (rec.finishedAtMs ?? now) - rec.startedAtMs;
  const settled = rec.status === 'done';
  const frac = rec.status === 'queued' ? 0 : settled ? 1 : Math.min(1, elapsed / (steps.length * rec.stepMs));
  const progress =
    rec.startedAtMs === null
      ? rec.status === 'queued'
        ? ['waiting for the executor: one AI run at a time']
        : []
      : rec.plan.filter((l) => settled || l.t <= elapsed).map((l) => l.text);
  if (rec.status === 'failed' && rec.error) progress.push(`ERROR ${rec.error}`);
  if (rec.status === 'cancelled') progress.push('cancelled by you');
  return {
    id: rec.id,
    symbol: rec.symbol,
    market: rec.market,
    skillId: rec.skillId,
    status: rec.status,
    createdAt: isoAt(rec.createdAtMs),
    startedAt: rec.startedAtMs === null ? null : isoAt(rec.startedAtMs),
    finishedAt: rec.finishedAtMs === null ? null : isoAt(rec.finishedAtMs),
    steps,
    stepIndex:
      rec.status === 'queued'
        ? 0
        : settled
          ? steps.length - 1
          : rec.status === 'running'
            ? Math.min(steps.length - 1, Math.floor(elapsed / rec.stepMs))
            : rec.stepIndex,
    progress: progress.slice(-8),
    costUsd: rec.finalCostUsd === null || rec.status === 'queued' ? null : round(rec.finalCostUsd * frac, 3),
    model: rec.model,
    error: rec.error,
    hasReport: settled && rec.report !== null,
    verdict: (() => {
      const s = settled && rec.report?.format === 'screen' ? rec.report.screen : null;
      if (!s) return null;
      const pass = s.rows.filter((r) => r.status === 'pass' || r.status === 'exempt').length;
      const total = s.rows.filter((r) => r.status !== 'na').length;
      return `${s.verdict === 'PASS' || s.verdict === 'EXEMPT-PASS' ? 'pass' : 'fail'} ${pass} of ${total}`;
    })(),
  };
}

function makeRun(
  symbol: string,
  market: Market,
  skillId: SkillId,
  createdAtMs: number,
  startAtMs: number | null,
): RunRec {
  const meta = info(skillId);
  const local = meta.local;
  const stepMs = local ? 500 : 1500;
  const noData = hasNoProviderData(symbol);
  return {
    id: `run-${String(store.nextRunId++).padStart(4, '0')}`,
    symbol,
    market,
    skillId,
    status: local ? 'running' : 'queued',
    createdAtMs,
    startedAtMs: local ? (startAtMs ?? createdAtMs) : null,
    finishedAtMs: null,
    stepMs,
    local,
    failAt: noData && !local ? 2 : null,
    finalCostUsd: local ? null : COST_USD[meta.effort],
    model: local ? null : MODEL,
    plan: buildPlan(skillId, symbol, meta.steps, stepMs, local),
    error: null,
    stepIndex: 0,
    report: null,
  };
}

export function startRuns(raw: unknown): ResearchRunView[] {
  advanceRuns();
  const b = Body.from(raw);
  const parsed = parseSymbol(b.string('symbol'), b.optOneOf('market', ['US', 'HK'] as const) ?? 'auto');
  if (!parsed.ok) throw invalid(parsed.error);
  // A name from the Leaders list may not be on the watchlist: the real server fetches its statements first, the mock just runs.
  const known = findRow(parsed.market, parsed.symbol);
  if (!known && !isLeaderName(parsed.market, parsed.symbol)) requireRow(parsed.market, parsed.symbol);
  if (known && !known.active)
    throw conflict(
      'not_watching',
      `${parsed.market}:${parsed.symbol} is not being watched: resume it before spending a run on it.`,
    );
  const ids: SkillId[] = [];
  for (const v of b.array('skillIds')) {
    if (typeof v !== 'string' || !(SKILL_IDS as string[]).includes(v))
      throw invalid(`Field "skillIds" has an unknown skill: ${String(v)}. Known: ${SKILL_IDS.join(', ')}.`);
    if (!ids.includes(v as SkillId)) ids.push(v as SkillId);
  }
  if (ids.length === 0) throw invalid('Field "skillIds" must list at least one skill.');
  for (const id of ids) {
    const reason = store.skillUnavailable ? UNAVAILABLE[id] : undefined;
    if (reason) throw conflict('skill_unavailable', `${id} is not available: ${reason}.`);
    if (info(id).local && known && !known.profile)
      throw conflict(
        'no_fundamentals',
        `${id} needs stored numbers, and ${parsed.market}:${parsed.symbol} has none yet: run an ingest first.`,
      );
  }
  const now = Date.now();
  const created = ids.map((id) => makeRun(parsed.symbol, parsed.market, id, now, null));
  store.runs.push(...created);
  advanceRuns(now);
  return created.map((r) => toView(r, now));
}

export function listRuns(marketParam: string | null, symbolParam: string | null): ResearchRunView[] {
  advanceRuns();
  if (marketParam !== null && marketParam !== '' && marketParam !== 'US' && marketParam !== 'HK')
    throw invalid('Query parameter "market" must be US or HK.');
  const market = marketParam === 'US' || marketParam === 'HK' ? marketParam : null;
  let symbol: string | null = null;
  if (symbolParam !== null && symbolParam !== '') {
    const parsed = parseSymbol(symbolParam, market ?? 'auto');
    if (!parsed.ok) throw invalid(parsed.error);
    symbol = parsed.symbol;
  }
  const now = Date.now();
  return store.runs
    .filter((r) => (market === null || r.market === market) && (symbol === null || r.symbol === symbol))
    .sort((a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id))
    .map((r) => toView(r, now));
}

const findRun = (id: string): RunRec => {
  const rec = store.runs.find((r) => r.id === id);
  if (!rec) throw notFound(`No research run "${id}".`);
  return rec;
};

export function getRun(id: string): ResearchRunDetailView {
  advanceRuns();
  const rec = findRun(id);
  return { ...toView(rec, Date.now()), report: rec.status === 'done' ? rec.report : null };
}

export function cancelRun(id: string): ResearchRunView {
  advanceRuns();
  const rec = findRun(id);
  if (rec.status !== 'queued' && rec.status !== 'running')
    throw conflict('run_not_cancellable', `Run ${id} is already ${rec.status}.`);
  const now = Date.now();
  if (rec.status === 'running' && !rec.local) store.aiFreeAtMs = now;
  rec.status = 'cancelled';
  rec.finishedAtMs = now;
  rec.stepIndex =
    rec.startedAtMs === null
      ? 0
      : Math.min(info(rec.skillId).steps.length - 1, Math.floor((now - rec.startedAtMs) / rec.stepMs));
  advanceRuns(now);
  return toView(rec, now);
}

export function runReportMd(id: string): { filename: string; markdown: string } {
  advanceRuns();
  const rec = findRun(id);
  if (rec.status !== 'done' || !rec.report) throw notFound(`Run ${id} has no report yet (status: ${rec.status}).`);
  const profile = findRow(rec.market, rec.symbol)?.profile ?? null;
  const date = isoAt(rec.finishedAtMs ?? Date.now()).slice(0, 10);
  const markdown =
    rec.report.format === 'markdown'
      ? rec.report.markdown
      : profile
        ? screenMarkdown(profile, rec.report.screen, date)
        : '# Quality screen\n';
  return { filename: `${rec.symbol}-${rec.skillId}-${date}.md`, markdown };
}

// ------------------------------------------------------------------------------------------------ seed
/** Three finished runs from September so the Reports tab of 0700 and KO is not empty. */
export function seedRuns(): void {
  const seed: [string, Market, SkillId, string, number][] = [
    ['0700', 'HK', 'investment-research', '2026-09-14T09:12:00.000Z', 1.42],
    ['0700', 'HK', 'thesis-tracker', '2026-09-14T09:31:00.000Z', 0.21],
    ['KO', 'US', 'quality-screen', '2026-08-30T14:05:00.000Z', 0],
  ];
  for (const [symbol, market, skillId, at, cost] of seed) {
    const start = Date.parse(at);
    const rec = makeRun(symbol, market, skillId, start - 2000, start);
    rec.status = 'running';
    rec.startedAtMs = start;
    rec.stepMs = rec.local ? 500 : 45_000;
    rec.finalCostUsd = rec.local ? null : cost;
    finish(rec, start + durationOf(rec));
    store.runs.push(rec);
  }
}
