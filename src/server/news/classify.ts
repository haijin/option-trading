/**
 * Judges news stories against each name's standing, one light model call per story (docs/designs/latest-news.md, stage N2).
 * The model's answer is data: parsed, validated, stored on the story row and rendered as text. A story whose answer fails
 * validation stays unclassified (no badge, never Neutral). Nothing here is read by a skill or changes the scan.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { hkDayOf, hkDayStart, NEWS_IMPACTS, NEWS_RULE_KEYS, type NewsRule, type NewsStanding } from '../../core/news';
import type { Db } from '../../db/client';
import {
  aiSpendSince,
  type ClassifyCandidate,
  countUnclassified,
  latestSkillVerdicts,
  listUnclassified,
  markRejected,
  nextEvents,
  setClassification,
} from '../../db/news';
import type { SkillExecutor } from '../research/executor';
import type { NewsConfig } from './config';
import { type NameState, resolveNames } from './standing';

// ------------------------------------------------------------------------------------------------------ the answer
export const classificationSchema = z
  .object({
    impact: z.enum(NEWS_IMPACTS),
    summary: z.string().trim().min(1).max(240),
    rules: z.array(z.object({ key: z.enum(NEWS_RULE_KEYS), text: z.string().trim().min(1).max(200) }).strict()).max(4),
    confidence: z.number().int().min(0).max(100),
  })
  .strict();

export type Classification = z.infer<typeof classificationSchema>;

export type ParseResult = { ok: true; value: Classification } | { ok: false; reason: string };

/** Numbers as printed, normalised so '1,234.50' and '1234.5' are the same token. */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    let t = m[0].replace(/,/g, '');
    if (t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, '');
    out.add(t);
  }
  return out;
}

/** The first number in `output` that is not in `input`, or null. */
export function introducedNumber(output: string, input: string): string | null {
  const known = numbersIn(input);
  for (const n of numbersIn(output)) if (!known.has(n)) return n;
  return null;
}

/**
 * Reads the model's answer: exactly one fenced `json` block, an object that fits the schema, no link in any string, and no
 * number that is not in `input`. Anything else is a reason to reject; the story then stays unclassified.
 */
export function parseClassification(text: string, input: string): ParseResult {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (blocks.length === 0) return { ok: false, reason: 'no json block in the answer' };
  if (blocks.length > 1) return { ok: false, reason: 'more than one json block in the answer' };
  let raw: unknown;
  try {
    raw = JSON.parse((blocks[0] as RegExpMatchArray)[1] as string);
  } catch {
    return { ok: false, reason: 'the json block does not parse' };
  }
  const parsed = classificationSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false, reason: `schema: ${i?.path.join('.') || 'answer'}: ${i?.message ?? 'invalid'}` };
  }
  const v = parsed.data;
  const strings = [v.summary, ...v.rules.map((r) => r.text)];
  if (strings.some((s) => /https?:\/\/|www\./i.test(s))) return { ok: false, reason: 'a link in the text' };
  const extra = introducedNumber(strings.join(' '), input);
  if (extra !== null) return { ok: false, reason: `introduces the number ${extra}, which is not in the input` };
  return { ok: true, value: v };
}

// ------------------------------------------------------------------------------------------------------ the prompt
const TEMPLATE = readFileSync(new URL('../research/prompts/news-classify.md', import.meta.url), 'utf8');

/** Untrusted text goes in as plain data: angle brackets are escaped so it cannot close the story block. */
const defang = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s+/g, ' ').trim();

export interface ClassifyContext {
  standing: NewsStanding;
  name: string;
  nextEvent: { type: string; date: string; confirmed: boolean } | null;
  gate: { verdict: string; score: number | null; asOf: string } | null;
  timing: { verdict: string; score: number | null; asOf: string } | null;
}

const verdictLine = (v: ClassifyContext['gate']): string =>
  v ? `${v.verdict}${v.score === null ? '' : ` (score ${Math.round(v.score)})`}, as of ${v.asOf}` : 'not available';

/** The input block of one story: everything the model may reason from, and so everything a number in its answer may come from. */
export function buildClassifyInput(item: ClassifyCandidate, ctx: ClassifyContext, symbolLabel: string): string {
  const s = ctx.standing;
  const lines = [
    `Name: ${defang(ctx.name)} (${symbolLabel})`,
    `Standing today: ${s.label}${s.detail ? ` · ${s.detail}` : ''}`,
  ];
  if (s.strike !== null && s.expiry !== null)
    lines.push(
      `Put: strike ${s.strike}, expires ${s.expiry}${s.dte === null ? '' : `, ${s.dte} days to expiry`}${s.otmPct === null ? '' : `, ${s.otmPct}% out of the money`}`,
    );
  lines.push(
    `Next known event: ${ctx.nextEvent ? `${ctx.nextEvent.type} on ${ctx.nextEvent.date} (${ctx.nextEvent.confirmed ? 'confirmed' : 'estimate'})` : 'none known'}`,
    `Quality gate (F): ${verdictLine(ctx.gate)}`,
    `Technical timing (T): ${verdictLine(ctx.timing)}`,
    `Source: ${defang(item.source)}`,
    `Published: ${item.publishedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '<story>',
    `Headline: ${defang(item.title)}`,
  );
  if (item.snippet) lines.push(`Snippet: ${defang(item.snippet).slice(0, 600)}`);
  lines.push('</story>');
  return lines.join('\n');
}

export function buildClassifyPrompt(input: string): string {
  // A function replacement: the input is free text and may contain "$&" and friends.
  return TEMPLATE.replace('{{INPUT}}', () => input);
}

// -------------------------------------------------------------------------------------------------------- the run
export interface ClassifyDeps {
  db: Db;
  executor: SkillExecutor;
  config: NewsConfig;
  now(): Date;
  log(line: string): void;
  /** Spend that is not on any row (a rejected brief), so the day's budget still counts it. */
  extraSpentUsd?: () => number;
}

export interface ClassifyReport {
  judged: number;
  rejected: number;
  /** Calls that failed outright (no answer): the story is left for the next run. */
  failed: number;
  /** The run stopped because the day's budget cannot cover another call. */
  budgetStopped: boolean;
  /** Stories still waiting afterwards. */
  left: number;
  costUsd: number;
  /** The run gave up after repeated failures of the executor itself. */
  aborted: boolean;
}

const MAX_CONSECUTIVE_FAILURES = 3;

function cwd(): string {
  const dir = join(tmpdir(), 'option-trading-news');
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function contexts(db: Db, names: readonly NameState[], now: Date): Promise<Map<number, ClassifyContext>> {
  const ids = names.map((n) => n.instrumentId);
  const today = hkDayOf(now);
  const [events, gates, timings] = await Promise.all([
    nextEvents(db, ids, today),
    latestSkillVerdicts(db, ids, 'fundamental.gate'),
    latestSkillVerdicts(db, ids, 'technical.timing'),
  ]);
  return new Map(
    names.map((n) => [
      n.instrumentId,
      {
        standing: n.standing,
        name: n.name ?? n.symbol,
        nextEvent: events.get(n.instrumentId) ?? null,
        gate: gates.get(n.instrumentId) ?? null,
        timing: timings.get(n.instrumentId) ?? null,
      },
    ]),
  );
}

/**
 * Judges the stories nothing has judged yet: names on the shortlist or with an open put first, then the rest, newest first,
 * one call each with no tools, capped per call and per day. The standing the model is shown is stored on the row.
 */
export async function classifyPending(deps: ClassifyDeps): Promise<ClassifyReport> {
  const { db, config } = deps;
  const now = deps.now();
  const report: ClassifyReport = {
    judged: 0,
    rejected: 0,
    failed: 0,
    budgetStopped: false,
    left: 0,
    costUsd: 0,
    aborted: false,
  };
  const since = new Date(now.getTime() - config.lookbackDays * 86_400_000);
  const names = await resolveNames(db, now);
  const byId = new Map(names.map((n) => [n.instrumentId, n]));
  const priority = names.filter((n) => n.inShortlist || n.inPositions).map((n) => n.instrumentId);
  const todo = (await listUnclassified(db, { priorityIds: priority, since, limit: config.maxPerRun })).filter((c) =>
    byId.has(c.instrumentId),
  );
  const ctx = await contexts(db, names, now);
  let spent = (await aiSpendSince(db, hkDayStart(hkDayOf(now)))) + (deps.extraSpentUsd?.() ?? 0);
  let failures = 0;

  for (const item of todo) {
    if (config.dailyBudgetUsd - spent < config.perCallCapUsd) {
      report.budgetStopped = true;
      break;
    }
    const name = byId.get(item.instrumentId) as NameState;
    const context = ctx.get(item.instrumentId) as ClassifyContext;
    const input = buildClassifyInput(item, context, `${name.symbol}, ${name.market}`);
    let answer: Awaited<ReturnType<SkillExecutor['run']>>;
    try {
      answer = await deps.executor.run({
        prompt: buildClassifyPrompt(input),
        cwd: cwd(),
        signal: AbortSignal.timeout(config.timeoutMs),
        onProgress: () => {},
        maxBudgetUsd: config.perCallCapUsd,
        model: config.model,
        tools: [],
        allowedTools: [],
      });
    } catch (err) {
      report.failed++;
      failures++;
      deps.log(`news classify: call failed for story ${item.id}: ${(err as Error).message}`);
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        report.aborted = true;
        break;
      }
      continue;
    }
    failures = 0;
    // The CLI reports a cost with every answer; when it does not, the cap is the safe stand-in for the budget.
    const cost = answer.costUsd ?? config.perCallCapUsd;
    spent += cost;
    report.costUsd += cost;
    const knownAt = deps.now();
    const model = answer.model ?? config.model;
    const parsed = parseClassification(answer.markdown, input);
    if (parsed.ok) {
      const v = parsed.value;
      await setClassification(db, item.id, {
        impact: v.impact,
        summary: v.summary,
        rules: v.rules as NewsRule[],
        standing: context.standing,
        confidence: v.confidence,
        knownAt,
        model,
        costUsd: cost,
      });
      report.judged++;
    } else {
      await markRejected(db, item.id, { knownAt, model, costUsd: cost });
      report.rejected++;
      deps.log(`news classify: story ${item.id} rejected: ${parsed.reason}`);
    }
  }
  report.left = await countUnclassified(db, since);
  return report;
}

export function classifyDetail(r: ClassifyReport, config: NewsConfig): string {
  const parts = [`${r.judged} judged`];
  if (r.rejected > 0) parts.push(`${r.rejected} rejected by the validators`);
  if (r.failed > 0) parts.push(`${r.failed} calls failed`);
  parts.push(`US$${r.costUsd.toFixed(2)} spent`);
  if (r.left > 0) parts.push(`${r.left} waiting`);
  if (r.budgetStopped) parts.push(`daily budget US$${config.dailyBudgetUsd.toFixed(2)} used up`);
  if (r.aborted) parts.push('stopped after repeated failures');
  return parts.join(', ');
}
