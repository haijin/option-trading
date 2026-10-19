/**
 * Mock of the Ask chat (docs/designs/trade-skills-integration.md, stage T2):
 *
 *   POST /api/ask                       start one question (202 AskItemView)
 *   GET  /api/ask?kind=idea&market=&symbol= | ?kind=position&positionId=   the thread, oldest first
 *   GET  /api/ask/:id                   one question, polled while it runs
 *
 * There is no model: after MOCK_AI_DELAY_MS (default 4000) the question gets a canned answer that cites a few rule ids and
 * the pitfalls the real situation map would attach (the map itself is imported, so the numbers match the real server). A
 * question containing "fail" fails, to show that state. MOCK_AI_UNAVAILABLE=1 answers 503 ai_unavailable.
 */
import { randomUUID } from 'node:crypto';
import type { AskItemView, AskTarget, AskThreadView, Market } from '../../src/server/api-types';
import { matchPitfalls } from '../../src/server/research/knowledge';
import { findRow, store } from './state';
import { directoryName, parseSymbol } from './symbols';
import { HttpError, invalid, isRecord, notFound, nowIso } from './util';

const PER_RUN_USD = 0.25;
const DAILY_USD = 2;
const MODEL = 'claude-sonnet-5-5';

const delayMs = (): number => {
  const n = Number(process.env.MOCK_AI_DELAY_MS ?? 4000);
  return Number.isFinite(n) && n >= 0 ? n : 4000;
};

interface Rec {
  item: AskItemView;
  startedAtMs: number;
}

const runs: Rec[] = [];

const sameTarget = (a: AskTarget, b: AskTarget): boolean =>
  a.kind === 'idea'
    ? b.kind === 'idea' && a.market === b.market && a.symbol === b.symbol
    : b.kind === 'position' && a.positionId === b.positionId;

const hasCjk = (s: string): boolean => /[㐀-鿿]/.test(s);

function resolveTarget(raw: unknown): { target: AskTarget; symbol: string; market: Market; name: string | null } {
  if (!isRecord(raw)) throw invalid('Field "target" is required and must be an object.');
  if (raw.kind === 'position') {
    const id = Number(raw.positionId);
    if (!Number.isInteger(id) || id <= 0) throw invalid('Field "target.positionId" must be a positive whole number.');
    const p = store.positions.find((x) => x.id === id);
    if (!p) throw notFound(`There is no position ${id}.`);
    const row = findRow(p.market, p.symbol);
    return {
      target: { kind: 'position', positionId: id },
      symbol: p.symbol,
      market: p.market,
      name: row?.name ?? directoryName(p.market, p.symbol),
    };
  }
  if (raw.kind !== 'idea') throw invalid('Field "target.kind" must be "idea" or "position".');
  const market = raw.market === 'HK' ? 'HK' : raw.market === 'US' ? 'US' : null;
  if (!market) throw invalid('Field "target.market" must be US or HK.');
  const parsed = parseSymbol(String(raw.symbol ?? ''), market);
  if (!parsed.ok) throw invalid(parsed.error);
  const row = findRow(parsed.market, parsed.symbol);
  if (!row) throw new HttpError(400, 'unknown_stock', `${parsed.market}:${parsed.symbol} is not in the database.`);
  return {
    target: { kind: 'idea', market: parsed.market, symbol: parsed.symbol },
    symbol: parsed.symbol,
    market: parsed.market,
    name: row.name,
  };
}

function cannedAnswer(item: AskItemView): string {
  const sym = item.symbol;
  const cites = item.pitfalls.map((p) => `pitfall ${p}`).join(', ');
  if (item.target.kind === 'position') {
    if (hasCjk(item.question))
      return [
        `**一句话：** 这张 ${sym} 的 put 目前每个前提都还成立，按 50% 权利金的纪律处理即可。`,
        '',
        '- 标记显示已收回大约一半权利金，`profit50` 提醒会在到达时触发（pitfall 13）。',
        '- 事件窗口没有变化：`events.earningsBeforeExpiry` 没有触发，所以不是失效（pitfall 4）。',
        '- 基准：持有到 50% 后平仓；多头：股价继续走高，权利金更快归零；空头：跌破支撑位时 `stop2x` 先于到期触发。',
        '',
        `引用：${cites}。你来决定；应用只展示数字。`,
      ].join('\n');
    return [
      `**Short answer:** every precondition of this ${sym} put still holds; the 50% rule decides the exit, not the mark.`,
      '',
      '- The latest mark has captured about half of the credit, so the `profit50` alert is the line to watch (pitfall 13).',
      '- Nothing in the event window moved: `events.earningsBeforeExpiry` is quiet, so this is not an invalidation (pitfall 4).',
      '- Base: close at 50% of credit and re-enter at a fresh cushion. Bull: the put decays faster and the same rule fires earlier. Bear: a break of support trips `stop2x` before expiry.',
      '',
      `Cited: ${cites}. Your call; the app only shows the numbers.`,
    ].join('\n');
  }
  if (hasCjk(item.question))
    return [
      `**一句话：** ${sym} 这张 put 的数字支持卖出，但波动率优势还没被证明。`,
      '',
      '- `vol.vrpForward` 显示为 unmeasured：少于十个对齐窗口，所以 pitfall 36 的结论是"优势未证明"，不是"没有优势"。',
      '- `vol.ivRank` 只决定 vega 方向（pitfall 19）；能收多少看 `option.annRoc`。',
      '- 两个亏损概率 `option.lossProbIv` 与 `option.lossProbRv` 的差距，就是这笔交易里隐含的波动率赌注。',
      '',
      '基准：缓冲在，权利金按时间衰减。多头：股价上行，提前到 50%。空头：跌到支撑位附近，`events.earningsWindow` 之外没有催化剂时按 `stop2x` 处理。',
      '',
      `引用：${cites}。你来决定；应用只展示数字。`,
    ].join('\n');
  return [
    `**Short answer:** the app's numbers support selling this ${sym} put; the vol edge is unproven, not absent.`,
    '',
    '- `vol.vrpForward` is unmeasured (fewer than ten aligned windows), so pitfall 36 says the edge is unproven, not that it is missing.',
    '- `vol.ivRank` only picks the vega side (pitfall 19); what you collect is `option.annRoc`.',
    '- The gap between `option.lossProbIv` and `option.lossProbRv` is the size of the vol bet inside the trade.',
    '',
    'Base: the cushion holds and the credit decays with time. Bull: the stock drifts up and the 50% rule arrives early. Bear: a move to support with no dated catalyst inside `events.earningsWindow` is where `stop2x` applies.',
    '',
    `Cited: ${cites}. Your call; the app only shows the numbers.`,
  ].join('\n');
}

function settle(now = Date.now()): void {
  for (const r of runs) {
    const i = r.item;
    if (i.status !== 'queued' && i.status !== 'running') continue;
    const elapsed = now - r.startedAtMs;
    const total = delayMs();
    if (elapsed < total) {
      i.status = 'running';
      i.progress = [
        `grounding: idea from the scan as of ${store.lastScan.asOf}, 31 reasons, IV row ${store.lastScan.asOf}, no open puts, no thesis note, news brief`,
        `pitfalls: ${i.pitfalls.join(', ')}${i.market === 'HK' ? ' + HK notes' : ''}`,
        `claude -p · no tools · cap $${PER_RUN_USD.toFixed(2)} · model ${MODEL}`,
        'thinking…',
      ].slice(0, 1 + Math.min(3, Math.floor((elapsed / Math.max(total, 1)) * 4)));
      continue;
    }
    i.finishedAt = new Date(r.startedAtMs + total).toISOString();
    i.model = MODEL;
    i.grounding = [
      `idea from the scan as of ${store.lastScan.asOf}`,
      '31 reasons',
      `IV row ${store.lastScan.asOf}`,
      'news brief',
    ];
    if (/fail/i.test(i.question)) {
      i.status = 'failed';
      i.error = 'No answer was kept: the model returned a fragment, not an answer. Ask again.';
      i.costUsd = 0.02;
    } else {
      i.status = 'done';
      i.answer = cannedAnswer(i);
      i.costUsd = 0.04 + (i.question.length % 7) / 100;
    }
  }
}

function spentToday(): { usd: number; runs: number } {
  const today = nowIso().slice(0, 10);
  const todays = runs.filter((r) => r.item.createdAt.slice(0, 10) === today);
  return { usd: todays.reduce((s, r) => s + (r.item.costUsd ?? 0), 0), runs: todays.length };
}

export function askStart(body: unknown): AskItemView {
  if (process.env.MOCK_AI_UNAVAILABLE === '1')
    throw new HttpError(503, 'ai_unavailable', 'Ask needs the claude CLI and it was not found.');
  if (!isRecord(body)) throw invalid('The request body must be a JSON object.');
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) throw new HttpError(400, 'question_required', 'Type a question first.');
  if (question.length > 600) throw new HttpError(400, 'question_too_long', 'A question is at most 600 characters.');
  const { target, symbol, market } = resolveTarget(body.target);
  settle();
  const active = runs.find(
    (r) => sameTarget(r.item.target, target) && (r.item.status === 'queued' || r.item.status === 'running'),
  );
  if (active)
    throw new HttpError(409, 'ask_in_progress', 'An answer is still being written here. Wait for it, then ask again.');
  const spent = spentToday();
  if (spent.usd + PER_RUN_USD > DAILY_USD)
    throw new HttpError(429, 'daily_budget', `Today's Ask budget of US$${DAILY_USD.toFixed(2)} is used up.`);
  const item: AskItemView = {
    id: randomUUID(),
    target,
    symbol,
    market,
    question,
    answer: null,
    status: 'queued',
    error: null,
    pitfalls: matchPitfalls(question, target.kind),
    grounding: [],
    progress: [],
    model: null,
    costUsd: null,
    createdAt: nowIso(),
    finishedAt: null,
  };
  runs.push({ item, startedAtMs: Date.now() });
  return item;
}

export function askThread(query: URLSearchParams): AskThreadView {
  const kind = query.get('kind');
  const raw =
    kind === 'position'
      ? { kind, positionId: Number(query.get('positionId')) }
      : { kind, market: query.get('market'), symbol: query.get('symbol') };
  const { target, symbol, market, name } = resolveTarget(raw);
  settle();
  const spent = spentToday();
  return {
    target,
    symbol,
    market,
    name,
    items: runs.filter((r) => sameTarget(r.item.target, target)).map((r) => r.item),
    executor: 'fake',
    limits: { perRunUsd: PER_RUN_USD, dailyUsd: DAILY_USD, spentTodayUsd: spent.usd, runsToday: spent.runs },
  };
}

export function askGet(id: string): AskItemView {
  settle();
  const r = runs.find((x) => x.item.id === id);
  if (!r) throw notFound(`There is no question ${id}.`);
  return r.item;
}
