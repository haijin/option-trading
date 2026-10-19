/**
 * The Ask chat (docs/designs/trade-skills-integration.md stage T2; docs/designs/ai-analysis.md item 7). One question about
 * the current idea for a name or about one open put, answered by the model from the app's own numbers and the matching
 * sell-put pitfalls, with no tools and a small dollar cap. Every question is a research_runs row of kind 'ask' whose
 * `result` holds the question, the answer and what the prompt was grounded on; nothing downstream reads the answer (no
 * verdict row in this stage). The pure parts are in src/server/research/knowledge and ask-prompt.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { hkDayOf } from '../../core/news';
import type { Instrument } from '../../core/types';
import {
  createResearchRun,
  getPositionRow,
  getResearchRun,
  type IvDailyRow,
  latestIvDaily,
  latestRecommendationFor,
  listPositionsDetailed,
  listResearchRunsBySkill,
  type PositionRow,
  type ResearchRunRow,
  type StoredRecommendation,
  skillSpendSince,
  updateResearchRun,
} from '../../db/app-repos';
import { latestMarks } from '../../db/marks';
import { listBriefsForDay } from '../../db/news';
import { findInstrument, getInstrument } from '../../db/repos';
import type { AskItemView, AskStartInput, AskTarget, AskThreadView, IdeaView, PositionView } from '../api-types';
import type { ServerDeps } from '../deps';
import { ApiError, badRequest, conflict, notFound, unavailable } from '../errors';
import { type AskConfig, askConfig } from '../research/ask-config';
import { type AskGroundingSection, type AskTurn, buildAskPrompt, validateAnswer } from '../research/ask-prompt';
import { hkNotes, matchPitfalls, pitfallDoc, rulesText } from '../research/knowledge';
import { reasonViews } from '../views';
import type { PositionService } from './positions-service';
import type { ScanService } from './scan-service';
import { parseMarketSymbol } from './watch-service';

/** The `skill_id` of an Ask row in research_runs. */
export const ASK_SKILL_ID = 'ask';
export const QUESTION_MAX_CHARS = 600;
const CONCURRENCY = 2;
/** Earlier answered turns of the same thread shown to the model, so pushback can be judged. */
const THREAD_TURNS = 4;
const THESIS_CHARS = 1500;
const PROGRESS_KEEP = 40;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, ' ').trim();
const fmt = (v: number | null | undefined, dp = 4): string =>
  v === null || v === undefined ? 'n/a' : String(+v.toFixed(dp));
const pctOf = (fraction: number | null): string => (fraction === null ? 'n/a' : `${(fraction * 100).toFixed(0)}%`);

/** What an Ask row keeps in research_runs.result. */
export interface AskResult {
  kind: 'ask';
  target: AskTarget;
  question: string;
  answer: string | null;
  pitfalls: number[];
  grounding: string[];
}

export const sameTarget = (a: AskTarget, b: AskTarget): boolean =>
  a.kind === 'idea'
    ? b.kind === 'idea' && a.market === b.market && a.symbol === b.symbol
    : b.kind === 'position' && a.positionId === b.positionId;

function resultOf(r: ResearchRunRow): AskResult | null {
  const x = r.result as Partial<AskResult> | null;
  return x && x.kind === 'ask' && x.target && typeof x.question === 'string' ? (x as AskResult) : null;
}

const hkDayStart = (now: Date): Date => new Date(`${hkDayOf(now)}T00:00:00+08:00`);

interface Grounding {
  targetLine: string;
  sections: AskGroundingSection[];
  /** One phrase per source, kept on the row and shown under the answer. */
  summary: string[];
}

export class AskService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly queue: string[] = [];
  private active = 0;
  readonly cfg: AskConfig;

  // Rows left queued or running by a dead process are failed by ResearchManager at start-up (same table).
  constructor(
    private readonly deps: ServerDeps,
    private readonly scan: ScanService,
    private readonly positions: PositionService,
  ) {
    this.cfg = askConfig(process.env, deps.ask);
  }

  // ------------------------------------------------------------------------------------------ targets
  private normalise(target: AskTarget): AskTarget {
    if (target.kind === 'position') {
      if (!Number.isInteger(target.positionId) || target.positionId <= 0)
        throw badRequest('invalid_position', 'positionId must be a positive whole number');
      return { kind: 'position', positionId: target.positionId };
    }
    const p = parseMarketSymbol(target.symbol, target.market);
    return { kind: 'idea', market: p.market, symbol: p.symbol };
  }

  private async resolve(target: AskTarget): Promise<{ inst: Instrument; position: PositionRow | null }> {
    if (target.kind === 'position') {
      const row = await getPositionRow(this.deps.db, target.positionId);
      if (!row) throw notFound(`there is no position ${target.positionId}`, 'position_not_found');
      return { inst: row.instrument, position: row };
    }
    const inst = await findInstrument(this.deps.db, target.market, target.symbol);
    if (!inst) throw badRequest('unknown_stock', `${target.market}:${target.symbol} is not in the database`);
    return { inst, position: null };
  }

  private async limits(): Promise<AskThreadView['limits']> {
    const spent = await skillSpendSince(this.deps.db, ASK_SKILL_ID, hkDayStart(this.deps.now()));
    return {
      perRunUsd: this.cfg.maxBudgetUsd,
      dailyUsd: this.cfg.dailyBudgetUsd,
      spentTodayUsd: spent.costUsd,
      runsToday: spent.runs,
    };
  }

  private item(r: ResearchRunRow, inst: Instrument): AskItemView {
    const x = resultOf(r);
    return {
      id: r.id,
      target: x?.target ?? { kind: 'idea', market: inst.market, symbol: inst.symbol },
      symbol: inst.symbol,
      market: inst.market,
      question: x?.question ?? '',
      answer: r.status === 'done' ? (x?.answer ?? null) : null,
      status: r.status,
      error: r.error,
      pitfalls: x?.pitfalls ?? [],
      grounding: x?.grounding ?? [],
      progress: r.progress,
      model: r.model,
      costUsd: r.costUsd,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  }

  // ------------------------------------------------------------------------------------------ start / read
  async start(input: AskStartInput): Promise<AskItemView> {
    const question = (input.question ?? '').trim();
    if (!question) throw badRequest('question_required', 'Type a question first.');
    if (question.length > QUESTION_MAX_CHARS)
      throw badRequest('question_too_long', `A question is at most ${QUESTION_MAX_CHARS} characters.`);
    if (this.deps.research.executorKind === 'none')
      throw unavailable(
        'ai_unavailable',
        'Ask needs the claude CLI and it was not found. Set OT_CLAUDE_CLI to its path and restart the app.',
      );
    const target = this.normalise(input.target);
    const { inst } = await this.resolve(target);
    const db = this.deps.db;
    const rows = await listResearchRunsBySkill(db, inst.id, ASK_SKILL_ID, 20);
    const active = rows.find((r) => {
      const x = resultOf(r);
      return x !== null && (r.status === 'queued' || r.status === 'running') && sameTarget(x.target, target);
    });
    if (active)
      throw conflict('ask_in_progress', 'An answer is still being written here. Wait for it, then ask again.', {
        runId: active.id,
      });
    const limits = await this.limits();
    if (limits.spentTodayUsd + this.cfg.maxBudgetUsd > this.cfg.dailyBudgetUsd)
      throw new ApiError(
        429,
        'daily_budget',
        `Today's Ask budget of US$${this.cfg.dailyBudgetUsd.toFixed(2)} is used up (US$${limits.spentTodayUsd.toFixed(2)} spent). It resets at midnight Hong Kong time.`,
      );
    const row = await createResearchRun(db, inst.id, ASK_SKILL_ID);
    const result: AskResult = { kind: 'ask', target, question, answer: null, pitfalls: [], grounding: [] };
    await updateResearchRun(db, row.id, { result });
    this.queue.push(row.id);
    this.pump();
    return this.item({ ...row, result }, inst);
  }

  async thread(rawTarget: AskTarget): Promise<AskThreadView> {
    const target = this.normalise(rawTarget);
    const { inst } = await this.resolve(target);
    const rows = await listResearchRunsBySkill(this.deps.db, inst.id, ASK_SKILL_ID, 60);
    const items = rows
      .filter((r) => {
        const x = resultOf(r);
        return x !== null && sameTarget(x.target, target);
      })
      .reverse()
      .map((r) => this.item(r, inst));
    return {
      target,
      symbol: inst.symbol,
      market: inst.market,
      name: inst.name,
      items,
      executor: this.deps.research.executorKind,
      limits: await this.limits(),
    };
  }

  async get(id: string): Promise<AskItemView> {
    const r = await getResearchRun(this.deps.db, id);
    if (!r || r.skillId !== ASK_SKILL_ID) throw notFound(`there is no question ${id}`, 'ask_not_found');
    const inst = await getInstrument(this.deps.db, r.instrumentId);
    if (!inst) throw notFound('the stock of this question no longer exists', 'ask_not_found');
    return this.item(r, inst);
  }

  // ------------------------------------------------------------------------------------------ worker
  private pump(): void {
    while (this.active < CONCURRENCY && this.queue.length > 0) {
      const id = this.queue.shift() as string;
      this.active++;
      void this.runOne(id)
        .catch((err) => this.deps.log(`ask run ${id} crashed: ${(err as Error).stack ?? String(err)}`))
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  /** Waits for every queued and running question to finish (tests). */
  async idle(): Promise<void> {
    while (this.active > 0 || this.queue.length > 0) await new Promise((r) => setTimeout(r, 20));
  }

  private async runOne(id: string): Promise<void> {
    const db = this.deps.db;
    const row = await getResearchRun(db, id);
    const x = row ? resultOf(row) : null;
    if (row?.status !== 'queued' || !x) return;
    const ctrl = new AbortController();
    this.controllers.set(id, ctrl);
    await updateResearchRun(db, id, { status: 'running', startedAt: this.deps.now() });
    const lines: string[] = [];
    let chain: Promise<void> = Promise.resolve();
    const say = (line: string): void => {
      lines.push(line);
      if (lines.length > PROGRESS_KEEP) lines.splice(0, lines.length - PROGRESS_KEEP);
      const snapshot = [...lines];
      chain = chain.then(() => updateResearchRun(db, id, { progress: snapshot })).catch(() => undefined);
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, this.cfg.timeoutMs);
    let workDir: string | null = null;
    try {
      const { inst, position } = await this.resolve(x.target);
      const g = await this.grounding(x.target, inst, position);
      const pitfalls = matchPitfalls(x.question, x.target.kind);
      const notes = inst.market === 'HK' ? hkNotes() : [];
      const thread = await this.earlierTurns(inst.id, x.target, id);
      say(`grounding: ${g.summary.join(', ')}`);
      say(
        `pitfalls: ${pitfalls.join(', ')}${notes.length > 0 ? ' + HK notes' : ''}${
          thread.length > 0 ? ` · ${thread.length} earlier turn${thread.length === 1 ? '' : 's'}` : ''
        }`,
      );
      say(`claude -p · no tools · cap $${this.cfg.maxBudgetUsd.toFixed(2)} · model ${this.cfg.model}`);
      say('thinking…');
      const stored: AskResult = { ...x, pitfalls, grounding: g.summary };
      await updateResearchRun(db, id, { result: stored });
      workDir = await mkdtemp(join(tmpdir(), 'ot-ask-'));
      const prompt = buildAskPrompt({
        rules: rulesText(),
        today: this.deps.now().toISOString().slice(0, 10),
        target: g.targetLine,
        pitfalls: pitfalls.map(pitfallDoc),
        notes,
        grounding: g.sections,
        thread,
        question: x.question,
      });
      const res = await this.deps.research.executor.run({
        prompt,
        cwd: workDir,
        signal: ctrl.signal,
        onProgress: (l) => say(clip(l, 160)),
        maxBudgetUsd: this.cfg.maxBudgetUsd,
        model: this.cfg.model,
        tools: [],
        allowedTools: [],
        isolated: true,
      });
      clearTimeout(timer);
      const checked = validateAnswer(res.markdown);
      await chain;
      const common = {
        model: res.model ?? this.cfg.model,
        costUsd: res.costUsd,
        finishedAt: this.deps.now(),
        progress: [...lines],
      };
      if (checked.ok)
        await updateResearchRun(db, id, {
          ...common,
          status: 'done',
          result: { ...stored, answer: checked.markdown },
        });
      else
        await updateResearchRun(db, id, {
          ...common,
          status: 'failed',
          error: `No answer was kept: ${checked.problem}. Ask again.`,
        });
    } catch (err) {
      await chain;
      const base = { finishedAt: this.deps.now(), progress: [...lines] };
      if (timedOut)
        await updateResearchRun(db, id, {
          ...base,
          status: 'failed',
          error: `The model did not answer within ${Math.max(1, Math.round(this.cfg.timeoutMs / 1000))} seconds.`,
        });
      else if (ctrl.signal.aborted) await updateResearchRun(db, id, { ...base, status: 'cancelled' });
      else
        await updateResearchRun(db, id, {
          ...base,
          status: 'failed',
          error: clip((err as Error).message, 300),
        });
    } finally {
      clearTimeout(timer);
      this.controllers.delete(id);
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The newest answered questions of the same thread, oldest first, without the one being answered. */
  private async earlierTurns(instrumentId: number, target: AskTarget, currentId: string): Promise<AskTurn[]> {
    const rows = await listResearchRunsBySkill(this.deps.db, instrumentId, ASK_SKILL_ID, 40);
    const turns: AskTurn[] = [];
    for (const r of rows) {
      if (r.id === currentId || r.status !== 'done') continue;
      const x = resultOf(r);
      if (!x?.answer || !sameTarget(x.target, target)) continue;
      turns.push({ question: x.question, answer: x.answer });
      if (turns.length >= THREAD_TURNS) break;
    }
    return turns.reverse();
  }

  // ------------------------------------------------------------------------------------------ grounding
  private async grounding(target: AskTarget, inst: Instrument, position: PositionRow | null): Promise<Grounding> {
    const db = this.deps.db;
    const sections: AskGroundingSection[] = [];
    const summary: string[] = [];
    const label = `${inst.symbol} (${inst.market}${inst.name ? `, ${inst.name}` : ''})`;
    // The cached scan only: Ask never runs the pipeline (a scan can take a minute and the Today page has just loaded it).
    const view = this.scan.peek(false) ?? this.scan.peek(true);
    const idea = view?.ideas.find((i) => i.market === inst.market && i.symbol === inst.symbol) ?? null;
    let targetLine: string;

    if (target.kind === 'idea') {
      if (idea && view) {
        targetLine = `Idea: ${label}, the ${idea.contract.expiry} ${idea.contract.strike} put recommended by the scan as of ${view.asOf}`;
        sections.push({ heading: `The idea (scan as of ${view.asOf})`, body: ideaLines(idea).join('\n') });
        sections.push({
          heading:
            'Reasons JSON (every rule the scanner evaluated for this name; S3 volatility rows start with "vol.")',
          body: idea.reasons.map((r) => JSON.stringify(r)).join('\n'),
        });
        summary.push(`idea from the scan as of ${view.asOf}, ${idea.reasons.length} reasons`);
      } else {
        const rec = await latestRecommendationFor(db, inst.id);
        if (!rec) throw notFound(`There is no idea for ${label} yet: run the scan first.`, 'no_idea');
        targetLine = `Idea: ${label}, the ${rec.expiry} ${rec.strike} put recommended by the stored scan of ${rec.asOf}`;
        sections.push({
          heading: `The idea (stored scan of ${rec.asOf}; the live scan is not cached right now)`,
          body: recLines(rec).join('\n'),
        });
        sections.push({
          heading:
            'Reasons JSON (every rule the scanner evaluated for this name; S3 volatility rows start with "vol.")',
          body: rec.reasons.map((r) => JSON.stringify(r)).join('\n') || 'none stored',
        });
        summary.push(`stored idea of ${rec.asOf}, ${rec.reasons.length} reasons`);
      }
    } else {
      const [pv] = await this.positions.toViews([position as PositionRow]);
      if (!pv) throw notFound('the position could not be read', 'position_not_found');
      targetLine = `Open put: ${label}, ${pv.quantity} x the ${pv.expiry} ${pv.strike} put sold on ${pv.openDate}${
        pv.status === 'open' ? '' : ` (now ${pv.status})`
      }`;
      sections.push({ heading: 'The position', body: positionLines(pv).join('\n') });
      summary.push(`position ${pv.id} (${pv.status})`);
      const report = this.scan.report(false) ?? this.scan.report(true);
      const n = report?.names.find((r) => r.instrument.id === inst.id);
      if (n) {
        const rs = reasonViews(n.results);
        sections.push({
          heading: `Scanner Reasons for this name (cached scan${view ? ` as of ${view.asOf}` : ''}; S3 volatility rows start with "vol.")`,
          body: rs.map((r) => JSON.stringify(r)).join('\n') || 'none',
        });
        summary.push(`${rs.length} scanner reasons`);
      } else {
        const rec = await latestRecommendationFor(db, inst.id);
        if (rec) {
          sections.push({
            heading: `Reasons JSON from the stored scan of ${rec.asOf} (the live scan is not cached right now)`,
            body: rec.reasons.map((r) => JSON.stringify(r)).join('\n') || 'none stored',
          });
          summary.push(`stored reasons of ${rec.asOf}`);
        } else summary.push('no scanner reasons available');
      }
    }

    const iv = await latestIvDaily(db, inst.id);
    if (iv) {
      sections.push({
        heading: `Latest IV row (iv_daily ${iv.day}, tier ${iv.tier}; vols are fractions, 0.45 = 45%)`,
        body: ivLines(iv),
      });
      summary.push(`IV row ${iv.day}`);
    } else {
      sections.push({ heading: 'Latest IV row', body: 'none stored for this name' });
      summary.push('no IV row');
    }

    const open = (await listPositionsDetailed(db)).filter((p) => p.status === 'open' && p.instrument.id === inst.id);
    if (open.length > 0) {
      const marks = await latestMarks(
        db,
        open.map((p) => p.id),
      );
      sections.push({
        heading: 'Open puts on this name (with the latest marks)',
        body: open
          .map((p) => {
            const m = marks.get(p.id);
            const markText = m
              ? `mark ${m.mark} per share on ${m.day} (${m.tier}), unrealised ${fmt(m.unrealizedPnl, 2)}, ${pctOf(m.pctCaptured)} of credit captured, alerts ${m.alertCodes.join(', ') || 'none'}`
              : 'no mark yet';
            return `- #${p.id}: ${p.quantity} x ${p.expiry} ${p.strike} put, sold ${p.openDate} at ${p.openPrice} per share (multiplier ${p.multiplier}); ${markText}`;
          })
          .join('\n'),
      });
      summary.push(`${open.length} open put${open.length === 1 ? '' : 's'}`);
    } else sections.push({ heading: 'Open puts on this name', body: 'none' });

    const thesis = await this.latestThesis(inst.id);
    if (thesis) {
      sections.push({
        heading: `Latest thesis note (AI research run thesis-tracker of ${thesis.date}; a dated judgement, not a fact)`,
        body: thesis.text,
      });
      summary.push(`thesis note of ${thesis.date}`);
    } else summary.push('no thesis note');

    const briefs = await listBriefsForDay(db, hkDayOf(this.deps.now()));
    const brief = [...briefs].sort((a, b) => b.asOf.getTime() - a.asOf.getTime())[0];
    if (brief) {
      sections.push({
        heading: `Today's news brief (${brief.session}, ${brief.asOf.toISOString()})`,
        body: [brief.lead, ...brief.bullets.map((b) => `- ${b.tag}: ${b.text}`), `For puts: ${brief.forPuts}`].join(
          '\n',
        ),
      });
      summary.push('news brief');
    } else summary.push('no news brief today');

    return { targetLine, sections, summary };
  }

  private async latestThesis(instrumentId: number): Promise<{ date: string; text: string } | null> {
    const rows = await listResearchRunsBySkill(this.deps.db, instrumentId, 'thesis-tracker', 5);
    const run = rows.find((r) => r.status === 'done' && r.reportPath);
    if (!run?.reportPath) return null;
    const full = resolve(this.deps.reportsDir, run.reportPath);
    if (!full.startsWith(resolve(this.deps.reportsDir) + sep)) return null;
    try {
      const text = await readFile(full, 'utf8');
      const body = text.replace(/^<!--[\s\S]*?-->\s*/, '').trim();
      return {
        date: (run.finishedAt ?? run.createdAt).toISOString().slice(0, 10),
        text: body.length > THESIS_CHARS ? `${body.slice(0, THESIS_CHARS)}\n(truncated)` : body,
      };
    } catch {
      return null;
    }
  }
}

// ------------------------------------------------------------------------------------------------ grounding text
function ideaLines(i: IdeaView): string[] {
  const c = i.contract;
  return [
    `- spot ${i.spot} ${i.currency}; support ${i.support ?? 'n/a'}${i.supportSource ? ` (${i.supportSource})` : ''}; trend ${i.trend ?? 'n/a'}`,
    `- recommended put: strike ${c.strike}, expiry ${c.expiry} (${c.dte} DTE), premium ${c.premium} per share, credit ${c.credit} per contract (multiplier ${c.multiplier}), collateral (full notional) ${c.collateral}`,
    `- annualised return ${c.annRocPct}%, cushion ${c.cushionPct}%, breakeven ${c.breakeven}, delta ${c.delta}, P(ITM) ${fmt(c.probItm)}, expected value ${fmt(c.expectedValue, 2)}, IV ${fmt(c.iv)}, bid/ask ${fmt(c.bid, 2)}/${fmt(c.ask, 2)}, price source ${c.priceSource}, data tier ${i.tier}${i.staleTagged ? ', STALE data' : ''}`,
    `- composite ${i.composite} (rank ${i.rank}, confidence ${fmt(i.confidence, 2)}); rule WARNs: ${i.ruleWarns.join(', ') || 'none'}`,
    `- sizing by S6: ${
      i.sizing
        ? `${i.sizing.contracts} contracts, ${i.sizing.pctOfEquity}% of equity${i.sizing.capsHit.length > 0 ? `, limited by ${i.sizing.capsHit.join(', ')}` : ''}`
        : 'not sized'
    }`,
    `- next results date: ${
      i.nextEarnings
        ? `${i.nextEarnings.date} (${i.nextEarnings.confirmed ? 'confirmed' : 'unconfirmed'}, ${i.nextEarnings.source})`
        : 'unknown to the app'
    }`,
    ...(i.narrative
      ? [`- the app's narrative: ${i.narrative.headline}`, ...i.narrative.lines.map((l) => `  - ${l}`)]
      : []),
  ];
}

function recLines(r: StoredRecommendation): string[] {
  return [
    `- underlying ${r.underlyingPrice}; recommended put: strike ${r.strike}, expiry ${r.expiry} (${r.dte} DTE at the time), rank ${r.rank}`,
    `- credit ${r.creditPerContract} per contract, collateral (full notional) ${r.collateralPerContract}, annualised return ${(r.annualizedRoc * 100).toFixed(1)}%, cushion ${(r.cushionPct * 100).toFixed(1)}%, breakeven ${r.breakeven}, P(ITM) ${fmt(r.probItm)}`,
    `- composite ${r.composite}; suggested contracts ${r.suggestedContracts ?? 'not sized'}`,
  ];
}

function positionLines(p: PositionView): string[] {
  return [
    `- ${p.quantity} x ${p.expiry} ${p.strike} put (${p.dte} DTE), multiplier ${p.multiplier}, status ${p.status}`,
    `- sold ${p.openDate} at ${p.openPrice} per share: credit ${p.credit} ${p.currency}, collateral (full notional) ${p.collateral}`,
    `- spot ${p.spot ?? 'n/a'}; distance from spot to strike ${p.distancePct === null ? 'n/a' : `${p.distancePct.toFixed(1)}%`}`,
    p.mark
      ? `- latest mark ${p.mark.price} per share on ${p.mark.day} (${p.mark.tier}): unrealised ${fmt(p.mark.unrealizedPnl, 2)}, ${pctOf(p.mark.pctCaptured)} of credit captured, delta ${fmt(p.mark.delta, 2)}`
      : '- no mark yet (the mark job has not priced this put)',
    `- alerts: ${p.alerts.map((a) => `${a.code} (${a.level}): ${a.text}`).join('; ') || 'none'}`,
    `- still on the watchlist: ${p.watching ? 'yes' : 'no'}`,
  ];
}

function ivLines(iv: IvDailyRow): string {
  return [
    `IV30 ${fmt(iv.iv30)}, IV60 ${fmt(iv.iv60)}, IV rank ${fmt(iv.ivRank, 1)}, IV percentile ${fmt(iv.ivPercentile, 1)}`,
    `RV20 ${fmt(iv.rv20)}, RV60 ${fmt(iv.rv60)}, 25-delta skew ${fmt(iv.skew25d)}, term ratio ${fmt(iv.termRatio)}`,
  ].join('\n');
}
