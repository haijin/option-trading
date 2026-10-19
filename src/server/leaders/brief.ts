/**
 * The Leaders brief (docs/designs/leaders-pullback.md, stage L4): one no-tools model call per run that writes a two-sentence lead
 * and a one-line text per listed name from the skill's own payloads. The text is decoration: it is validated like the news
 * brief (one fenced json block, the schema, ids that are in the input, no link, no number that is not in the input), and a
 * rejected brief is dropped, so the page shows the skill's reason lines only. The answer is parsed, validated and stored as text;
 * it is never executed and never fed back as an instruction. Nothing here is read by a skill or changes the scan.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { hkDayOf, hkDayStart } from '../../core/news';
import type { Db } from '../../db/client';
import {
  briefSpendSince,
  type CandidateRow,
  getRun,
  listCandidates,
  type RunRow,
  setBriefLines,
  setRunBrief,
} from '../../db/leaders';
import { introducedNumber } from '../news/classify';
import type { SkillExecutor } from '../research/executor';
import type { LeadersConfig } from './config';

export const leadersBriefSchema = z
  .object({
    lead: z.string().trim().min(1).max(300),
    lines: z.record(z.string().regex(/^\d{1,12}$/, 'a line key is a name id'), z.string().trim().min(1).max(160)),
  })
  .strict();

export type LeadersBriefParse = { ok: true; lead: string; lines: Map<number, string> } | { ok: false; reason: string };

/**
 * Reads the answer: exactly one fenced json block that fits the schema, line keys that are names in the input, no link, and no
 * number that is not in `input`.
 */
export function parseLeadersBrief(text: string, input: string, ids: ReadonlySet<number>): LeadersBriefParse {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (blocks.length === 0) return { ok: false, reason: 'no json block in the answer' };
  if (blocks.length > 1) return { ok: false, reason: 'more than one json block in the answer' };
  let raw: unknown;
  try {
    raw = JSON.parse((blocks[0] as RegExpMatchArray)[1] as string);
  } catch {
    return { ok: false, reason: 'the json block does not parse' };
  }
  const parsed = leadersBriefSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false, reason: `schema: ${i?.path.join('.') || 'answer'}: ${i?.message ?? 'invalid'}` };
  }
  const v = parsed.data;
  const unknown = Object.keys(v.lines).find((k) => !ids.has(Number(k)));
  if (unknown !== undefined) return { ok: false, reason: `a line for ${unknown}, which is not a name in the input` };
  const strings = [v.lead, ...Object.values(v.lines)];
  if (strings.some((s) => /https?:\/\/|www\./i.test(s))) return { ok: false, reason: 'a link in the text' };
  const extra = introducedNumber(strings.join(' '), input);
  if (extra !== null) return { ok: false, reason: `introduces the number ${extra}, which is not in the input` };
  return { ok: true, lead: v.lead, lines: new Map(Object.entries(v.lines).map(([k, t]) => [Number(k), t])) };
}

// ------------------------------------------------------------------------------------------------------ the prompt
const TEMPLATE = readFileSync(new URL('../research/prompts/leaders-brief.md', import.meta.url), 'utf8');

/** Names come from the database as plain data: angle brackets are escaped so they cannot close the input block. */
const defang = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s+/g, ' ').trim();

const num = (x: number | null, d = 1): string =>
  x === null || !Number.isFinite(x) ? 'n/a' : String(Number(x.toFixed(d)));
const signed = (x: number | null, d = 0): string =>
  x === null || !Number.isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(d)}%`;

/** One name as the model sees it: the screen's own numbers, its three reason lines and its flags. */
function nameBlock(r: CandidateRow): string {
  const p = r.payload;
  const bits = [
    `${r.market === 'HK' ? `${r.symbol}.HK` : r.symbol}`,
    r.state === 'setup' ? 'Setup' : 'Watch',
    `score ${num(r.score, 0)}`,
    `close ${num(p.close, 2)}`,
    `day ${signed(p.changePct === null ? null : p.changePct * 100, 1)}`,
    `3m ${signed(p.ret3m === null ? null : p.ret3m * 100)}`,
    `6m ${signed(p.ret6m === null ? null : p.ret6m * 100)}`,
  ];
  if (p.base) bits.push(`base ${num(p.base.depth * 100, 0)}% deep over ${p.base.len} days`);
  if (p.plan) bits.push(`stop ${num(p.plan.stopPct * 100, 1)}%`, `3R ${num(p.plan.r3, 2)}`);
  else if (p.stopPct !== null) bits.push(`last turn-up bar needed a ${num(p.stopPct * 100, 1)}% stop`);
  const lines = [`[${r.instrumentId}] ${defang(r.name ?? r.symbol)} · ${bits.join(' · ')}`];
  for (const w of p.why) lines.push(`  - ${defang(w.text)}`);
  if (p.flags.length > 0) lines.push(`  flags: ${p.flags.map((f) => defang(f.text)).join('; ')}`);
  return lines.join('\n');
}

export function buildLeadersBriefInput(o: { run: RunRow; rows: readonly CandidateRow[]; today: string }): string {
  const { run } = o;
  const d = run.detail as {
    funnel?: {
      screened: number;
      leaders: number;
      consolidating: number;
      shortlisted: number;
      setup: number;
      watch: number;
    };
    regimeInfo?: {
      regime?: string | null;
      volIndex?: number | null;
      volIndexSymbol?: string | null;
      indexSymbol?: string | null;
      indexVsSma200Pct?: number | null;
    };
  };
  const f = d.funnel;
  const ri = d.regimeInfo;
  const regimeBits = [
    `regime ${run.regime ?? 'unknown'}`,
    run.posture === 'watch_only' ? 'watch only: pullback entries are off' : 'entries allowed',
  ];
  if (ri?.volIndex !== null && ri?.volIndex !== undefined)
    regimeBits.push(`${ri.volIndexSymbol ?? 'vol index'} ${num(ri.volIndex, 1)}`);
  if (ri?.indexVsSma200Pct !== null && ri?.indexVsSma200Pct !== undefined)
    regimeBits.push(`${ri.indexSymbol ?? 'index'} ${ri.indexVsSma200Pct >= 0 ? 'above' : 'below'} its 200-day average`);
  return [
    `Today: ${o.today}. Market: ${run.market === 'HK' ? 'Hong Kong' : 'US'}. Session of ${run.asOf}.`,
    `Regime (from the app's own data): ${regimeBits.join(', ')}.`,
    f
      ? `Funnel: ${f.screened} screened, ${f.leaders} leaders, ${f.consolidating} in a valid base, ${f.shortlisted} on the list (${f.setup} Setup, ${f.watch} Watch).`
      : 'Funnel: not recorded.',
    `Names on the list, best first (${o.rows.length}):`,
    ...o.rows.map(nameBlock),
  ].join('\n');
}

export function buildLeadersBriefPrompt(input: string, rejected?: string): string {
  const base = TEMPLATE.replace('{{INPUT}}', () => input);
  return rejected
    ? `${base}\nYour previous answer was rejected: ${rejected}. Answer again with one corrected json block.\n`
    : base;
}

// -------------------------------------------------------------------------------------------------------- the run
export interface LeadersBriefDeps {
  db: Db;
  executor: SkillExecutor;
  config: LeadersConfig;
  now(): Date;
  log(line: string): void;
  /** Spend that is on no row (a rejected brief), so the day's budget still counts it. */
  extraSpentUsd?: () => number;
  /** Called with the cost of a rejected brief. */
  onRejectedCost?: (usd: number) => void;
}

export interface LeadersBriefOutcome {
  written: boolean;
  /** The brief was asked for and could not be produced (a rejected answer, a failed call). */
  failed: boolean;
  costUsd: number;
  detail: string;
}

/**
 * Writes the brief of one run. Skips, without a call, when the run has nothing listed, already has its brief, or when the day's
 * budget cannot cover a call.
 */
export async function writeLeadersBrief(deps: LeadersBriefDeps, runId: number): Promise<LeadersBriefOutcome> {
  const { db, config } = deps;
  const skip = (detail: string): LeadersBriefOutcome => ({ written: false, failed: false, costUsd: 0, detail });
  const run = await getRun(db, runId);
  if (!run) return skip(`no run ${runId}`);
  if (run.status === 'failed' || run.status === 'running') return skip(`run ${runId} is ${run.status}`);
  if (run.briefLead) return skip(`the ${run.market} ${run.asOf} brief is already written`);
  const rows = (await listCandidates(db, [runId]))
    .filter((r) => r.rank !== null && (r.state === 'setup' || r.state === 'watch'))
    .sort((a, b) => (a.rank as number) - (b.rank as number));
  if (rows.length === 0) return skip(`the ${run.market} ${run.asOf} run lists no names`);
  const now = deps.now();
  const input = buildLeadersBriefInput({ run, rows, today: hkDayOf(now) });
  const ids = new Set(rows.map((r) => r.instrumentId));
  const byInstrument = new Map(rows.map((r) => [r.instrumentId, r.id]));

  let spent = (await briefSpendSince(db, hkDayStart(hkDayOf(now)))) + (deps.extraSpentUsd?.() ?? 0);
  let cost = 0;
  let reason: string | undefined;
  const fail = (detail: string): LeadersBriefOutcome => {
    if (cost > 0) deps.onRejectedCost?.(cost);
    return { written: false, failed: true, costUsd: cost, detail };
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (config.dailyBudgetUsd - spent < config.briefCapUsd)
      return reason
        ? fail(`rejected (${reason}); no budget left to retry`)
        : skip(`the daily budget US$${config.dailyBudgetUsd.toFixed(2)} cannot cover a brief`);
    let answer: Awaited<ReturnType<SkillExecutor['run']>>;
    try {
      const dir = join(tmpdir(), 'option-trading-leaders');
      mkdirSync(dir, { recursive: true });
      answer = await deps.executor.run({
        prompt: buildLeadersBriefPrompt(input, reason),
        cwd: dir,
        signal: AbortSignal.timeout(config.timeoutMs),
        onProgress: () => {},
        maxBudgetUsd: config.briefCapUsd,
        model: config.model,
        tools: [],
        allowedTools: [],
        isolated: true,
      });
    } catch (err) {
      return fail(`the model call failed: ${(err as Error).message}`);
    }
    const spend = answer.costUsd ?? config.briefCapUsd;
    spent += spend;
    cost += spend;
    const parsed = parseLeadersBrief(answer.markdown, input, ids);
    if (parsed.ok) {
      await setRunBrief(db, runId, { lead: parsed.lead, model: answer.model ?? config.model, costUsd: cost });
      await setBriefLines(
        db,
        new Map(
          [...parsed.lines].flatMap(([instrumentId, text]) =>
            byInstrument.has(instrumentId) ? [[byInstrument.get(instrumentId) as number, text] as const] : [],
          ),
        ),
      );
      return {
        written: true,
        failed: false,
        costUsd: cost,
        detail: `${run.market} ${run.asOf} brief written: a lead and ${parsed.lines.size} line${parsed.lines.size === 1 ? '' : 's'}, US$${cost.toFixed(2)}`,
      };
    }
    reason = parsed.reason;
    deps.log(`leaders brief: attempt ${attempt + 1} rejected: ${reason}`);
  }
  return fail(`rejected by the validators: ${reason}`);
}
