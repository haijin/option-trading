/**
 * The market brief (docs/designs/latest-news.md, stage N3): one model call over the last 24 hours of market-wide stories, the
 * stored market regime and the app's own dates. The tape numbers are copied from our tables and are not part of the answer.
 * The answer is validated like a story judgement, plus: every bullet cites at least one story we fetched (by id, so a made-up
 * source cannot get in) and the answer may not carry a key we did not ask for. A rejected brief is retried once with the
 * reason, then dropped.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { hkMonthlyExpiry, type Market, usMonthlyExpiry } from '../../core/calendar';
import { addDays, type ISODate, monthOf, startOfNextMonth, yearOf } from '../../core/dates';
import { hkDayOf, hkDayStart, type NewsCitation, type NewsSession, type NewsTapeItem } from '../../core/news';
import type { Db } from '../../db/client';
import {
  aiSpendSince,
  briefExists,
  lastBriefAt,
  latestRegimes,
  listMarketItems,
  type RegimeRow,
  saveBrief,
  upcomingEvents,
} from '../../db/news';
import { listWatchlist } from '../../db/repos';
import type { SkillExecutor } from '../research/executor';
import { introducedNumber } from './classify';
import type { NewsConfig } from './config';
import { buildTape, tapeLines } from './tape';

export const BRIEF_TAGS = ['US', 'HK·CN', 'Macro', 'Dates'] as const;
const storyId = z.string().regex(/^S\d{1,3}$/);

export const briefSchema = z
  .object({
    lead: z.string().trim().min(1).max(300),
    bullets: z
      .array(
        z
          .object({
            tag: z.enum(BRIEF_TAGS),
            text: z.string().trim().min(1).max(320),
            cites: z.array(storyId).min(1).max(4),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    for_puts: z.string().trim().min(1).max(300),
    cites: z.array(storyId).max(6).optional(),
  })
  .strict();

export type ParsedBrief = z.infer<typeof briefSchema>;

export interface BriefStory {
  id: string;
  url: string;
  source: string;
  title: string;
  snippet: string | null;
  publishedAt: Date;
}

export type BriefParse = { ok: true; value: ParsedBrief; cited: BriefStory[] } | { ok: false; reason: string };

/**
 * Reads the answer: exactly one fenced json block that fits the schema, distinct bullet tags, only ids from the story list, no
 * link, and no number that is not in `input`.
 */
export function parseBrief(text: string, input: string, stories: readonly BriefStory[]): BriefParse {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (blocks.length === 0) return { ok: false, reason: 'no json block in the answer' };
  if (blocks.length > 1) return { ok: false, reason: 'more than one json block in the answer' };
  let raw: unknown;
  try {
    raw = JSON.parse((blocks[0] as RegExpMatchArray)[1] as string);
  } catch {
    return { ok: false, reason: 'the json block does not parse' };
  }
  const parsed = briefSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false, reason: `schema: ${i?.path.join('.') || 'answer'}: ${i?.message ?? 'invalid'}` };
  }
  const v = parsed.data;
  const tags = v.bullets.map((b) => b.tag);
  if (new Set(tags).size !== tags.length) return { ok: false, reason: 'two bullets carry the same tag' };
  const byId = new Map(stories.map((s) => [s.id, s]));
  const ids = [...new Set([...v.bullets.flatMap((b) => b.cites), ...(v.cites ?? [])])];
  const unknown = ids.find((id) => !byId.has(id));
  if (unknown) return { ok: false, reason: `cites ${unknown}, which is not a story we fetched` };
  const strings = [v.lead, v.for_puts, ...v.bullets.map((b) => b.text)];
  if (strings.some((s) => /https?:\/\/|www\./i.test(s))) return { ok: false, reason: 'a link in the text' };
  const extra = introducedNumber(strings.join(' '), input);
  if (extra !== null) return { ok: false, reason: `introduces the number ${extra}, which is not in the input` };
  const cited = ids
    .map((id) => byId.get(id) as BriefStory)
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  return { ok: true, value: v, cited };
}

// ------------------------------------------------------------------------------------------------------ the prompt
const TEMPLATE = readFileSync(new URL('../research/prompts/news-brief.md', import.meta.url), 'utf8');

const defang = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s+/g, ' ').trim();

const hkTime = (d: Date): string => new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');

function regimeLine(r: RegimeRow): string {
  const parts = [`${r.market}: ${r.regime}`, `deploy cap ${r.deployCapPct}%`, `delta cap ${r.deltaCap}`];
  if (r.volIndex !== null) parts.push(`vol index ${r.volIndex}`);
  if (r.indexClose !== null && r.indexSma200 !== null)
    parts.push(`index ${Math.round(r.indexClose)} against its 200-day average ${Math.round(r.indexSma200)}`);
  return `- ${parts.join(', ')} (as of ${r.day})`;
}

/** The dates the brief may use, from the app's own calendar and stored events: monthly expiries and watched names' earnings. */
export async function knownDates(db: Db, today: ISODate): Promise<string[]> {
  const lines: string[] = [];
  const nextMonthly = (market: Market): ISODate | null => {
    try {
      const f = market === 'HK' ? hkMonthlyExpiry : usMonthlyExpiry;
      const here = f(yearOf(today), monthOf(today));
      if (here >= today) return here;
      const n = startOfNextMonth(today);
      return f(yearOf(n), monthOf(n));
    } catch {
      return null; // outside the calendar tables
    }
  };
  const hk = nextMonthly('HK');
  const us = nextMonthly('US');
  if (hk) lines.push(`- HK monthly option expiry: ${hk}`);
  if (us) lines.push(`- US monthly option expiry: ${us}`);
  const watch = await listWatchlist(db, { activeOnly: true });
  const names = new Map(watch.map((w) => [w.id, w.market === 'HK' ? `${w.symbol}.HK` : w.symbol]));
  for (const e of await upcomingEvents(db, { from: today, to: addDays(today, 21), instrumentIds: [...names.keys()] }))
    lines.push(
      `- ${names.get(e.instrumentId)} ${e.type === 'ex_dividend' ? 'ex-dividend' : e.type} on ${e.date}${e.confirmed ? '' : ' (estimate)'}`,
    );
  return lines;
}

export function buildBriefInput(o: {
  now: Date;
  session: NewsSession;
  regimes: readonly RegimeRow[];
  tape: readonly NewsTapeItem[];
  dates: readonly string[];
  stories: readonly BriefStory[];
}): string {
  const label =
    o.session === 'hk_open'
      ? 'HK open (07:30 Hong Kong time)'
      : o.session === 'us_open'
        ? 'US open (21:00 Hong Kong time)'
        : 'on demand';
  return [
    `Today: ${hkDayOf(o.now)} (Hong Kong). Brief for the ${label}.`,
    "Regime (from the app's own data):",
    ...(o.regimes.length > 0 ? o.regimes.map(regimeLine) : ['- none stored']),
    "Market tape (from the app's own tables):",
    ...(o.tape.length > 0 ? tapeLines(o.tape) : ['- none stored']),
    "Known dates (from the app's calendar and stored events):",
    ...(o.dates.length > 0 ? o.dates : ['- none']),
    `Stories from the last 24 hours (${o.stories.length}), newest first:`,
    ...o.stories.map(
      (s) =>
        `[${s.id}] ${hkTime(s.publishedAt)} HKT · ${defang(s.source)} · ${defang(s.title)}${s.snippet ? ` — ${defang(s.snippet).slice(0, 240)}` : ''}`,
    ),
  ].join('\n');
}

export function buildBriefPrompt(input: string, rejected?: string): string {
  const base = TEMPLATE.replace('{{INPUT}}', () => input);
  return rejected
    ? `${base}\nYour previous answer was rejected: ${rejected}. Answer again with one corrected json block.\n`
    : base;
}

// -------------------------------------------------------------------------------------------------------- the run
export interface BriefDeps {
  db: Db;
  executor: SkillExecutor;
  config: NewsConfig;
  now(): Date;
  log(line: string): void;
  /** Spend that is not on any row (a rejected brief), so the day's budget still counts it. */
  extraSpentUsd?: () => number;
  /** Called with the cost of a rejected brief. */
  onRejectedCost?: (usd: number) => void;
}

export interface BriefOutcome {
  written: boolean;
  /** The brief was asked for and could not be produced (a rejected answer, a failed call). */
  failed: boolean;
  costUsd: number;
  detail: string;
}

const MAX_STORIES = 40;

/**
 * Writes the brief for one session. Skips, without a call, when there is nothing to write from, when the day's budget cannot
 * cover a call, when a scheduled session already has its brief, or when a manual one was written a moment ago.
 */
export async function writeBrief(deps: BriefDeps, session: NewsSession): Promise<BriefOutcome> {
  const { db, config } = deps;
  const now = deps.now();
  const day = hkDayOf(now);
  const skip = (detail: string): BriefOutcome => ({ written: false, failed: false, costUsd: 0, detail });
  if (session !== 'manual' && (await briefExists(db, day, session)))
    return skip(`the ${session} brief for ${day} is already written`);
  if (session === 'manual') {
    const last = await lastBriefAt(db);
    if (last && now.getTime() - last.getTime() < config.minBriefGapMs)
      return skip(`a brief was written ${Math.round((now.getTime() - last.getTime()) / 60_000)} minutes ago`);
  }
  const rows = await listMarketItems(db, {
    from: new Date(now.getTime() - 86_400_000),
    to: new Date(now.getTime() + 1),
    limit: MAX_STORIES,
  });
  if (rows.length === 0) return skip('no market-wide stories in the last 24 hours');
  const stories: BriefStory[] = rows.map((r, i) => ({ id: `S${i + 1}`, ...r }));
  const [regimes, tape, dates] = await Promise.all([latestRegimes(db), buildTape(db, now), knownDates(db, day)]);
  const input = buildBriefInput({ now, session, regimes, tape, dates, stories });

  let spent = (await aiSpendSince(db, hkDayStart(day))) + (deps.extraSpentUsd?.() ?? 0);
  let cost = 0;
  let reason: string | undefined;
  // A brief that is never written has no row to carry its cost: report it so the day's budget still counts it.
  const fail = (detail: string): BriefOutcome => {
    if (cost > 0) deps.onRejectedCost?.(cost);
    return { written: false, failed: true, costUsd: cost, detail };
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (config.dailyBudgetUsd - spent < config.briefCapUsd)
      return reason
        ? fail(`rejected (${reason}); no budget left to retry`)
        : skip(`the daily budget US${config.dailyBudgetUsd.toFixed(2)} cannot cover a brief`);
    let answer: Awaited<ReturnType<SkillExecutor['run']>>;
    try {
      const dir = join(tmpdir(), 'option-trading-news');
      mkdirSync(dir, { recursive: true });
      answer = await deps.executor.run({
        prompt: buildBriefPrompt(input, reason),
        cwd: dir,
        signal: AbortSignal.timeout(config.timeoutMs * 2),
        onProgress: () => {},
        maxBudgetUsd: config.briefCapUsd,
        model: config.model,
        tools: [],
        allowedTools: [],
      });
    } catch (err) {
      return fail(`the model call failed: ${(err as Error).message}`);
    }
    const spend = answer.costUsd ?? config.briefCapUsd;
    spent += spend;
    cost += spend;
    const parsed = parseBrief(answer.markdown, input, stories);
    if (parsed.ok) {
      const v = parsed.value;
      const citations: NewsCitation[] = parsed.cited.map((s) => ({
        url: s.url,
        source: s.source,
        title: s.title,
        publishedAt: s.publishedAt.toISOString(),
      }));
      await saveBrief(db, {
        day,
        asOf: now,
        session,
        lead: v.lead,
        bullets: v.bullets.map((b) => ({ tag: b.tag, text: b.text })),
        forPuts: v.for_puts,
        tape: [...tape],
        citations,
        model: answer.model ?? config.model,
        costUsd: cost,
      });
      return {
        written: true,
        failed: false,
        costUsd: cost,
        detail: `${session} brief written from ${stories.length} stories, ${citations.length} cited, US$${cost.toFixed(2)}`,
      };
    }
    reason = parsed.reason;
    deps.log(`news brief: attempt ${attempt + 1} rejected: ${reason}`);
  }
  return fail(`rejected by the validators: ${reason}`);
}
