/**
 * Mock of the journal's AI rewrite endpoints (docs/designs/daily-journal.md, "AI rewrite pipeline"):
 *
 *   POST /api/journal/entries/:date/ai       start a run (202 {runId})
 *   GET  /api/journal/entries/:date/ai       the newest run of the day, or null
 *   GET  /api/journal/ai/:runId              the run, with progress lines while it works and `result` when done
 *   POST /api/journal/ai/:runId/cancel | accept | reject
 *
 * There is no model: after a fake delay (MOCK_AI_DELAY_MS, default 4000) the mock rewrites the entry with canned rules per
 * mode (fix spelling, keep the first sentence, bullets under headings, an appended section, a few words in Chinese). Images,
 * tables, snapshots and checklists are cut out before and put back after, like the real pipeline, so the Suggestion and Changes
 * tabs behave as they will with the real model. A custom instruction that contains "fail" makes the run fail, to show that
 * stage. MOCK_AI_UNAVAILABLE=1 answers 503 ai_unavailable.
 */
import { randomUUID } from 'node:crypto';
import {
  deriveFromDoc,
  isAssetId,
  type JournalDocJson,
  type JournalNodeJson,
  renderMarkdown,
  validateJournalDoc,
} from '../../src/journal';
import type {
  JournalAiAcceptView,
  JournalAiMode,
  JournalAiRunView,
  JournalAiStartView,
} from '../../src/server/api-types';
import { applyAiAccepted, entryForAi } from './diary';
import { HttpError, isRecord } from './util';

const MODES: JournalAiMode[] = ['polish', 'tighten', 'structure', 'lessons', 'translate_zh', 'translate_en', 'custom'];
const LABEL: Record<JournalAiMode, string> = {
  polish: 'Polish',
  tighten: 'Tighten',
  structure: 'Structure',
  lessons: 'Lessons & actions',
  translate_zh: '中文',
  translate_en: 'English',
  custom: 'Custom',
};
const DAILY_RUNS = 20;
const MODEL = 'claude-haiku-5-5';

const delayMs = (): number => {
  const n = Number(process.env.MOCK_AI_DELAY_MS ?? 4000);
  return Number.isFinite(n) && n >= 0 ? n : 4000;
};

interface Locked {
  id: string;
  node: JournalNodeJson;
}

interface Run {
  id: string;
  date: string;
  mode: JournalAiMode;
  instruction: string | null;
  withContext: boolean;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  accepted: boolean | null;
  startedAt: number;
  createdAt: string;
  finishedAt: string | null;
  inputDoc: JournalDocJson;
  progress: string[];
  error: string | null;
  result: JournalAiRunView['result'];
  costUsd: number | null;
  durationMs: number | null;
  model: string | null;
  /** The text the author sees as the Suggestion tab: the new document. */
  outputDoc: JournalDocJson | null;
}

const runs = new Map<string, Run>();

// ------------------------------------------------------------------------------------------------ locked blocks
const KIND: Record<string, string> = { figure: 'FIG', table: 'TBL', snapshot: 'SNAP', taskList: 'TODO' };
const KIND_WORD: Record<string, string> = { FIG: 'image', TBL: 'table', SNAP: 'snapshot', TODO: 'checklist' };
const marker = (id: string): string => `@@${id}@@`;

function cut(doc: JournalDocJson): { stripped: JournalDocJson; locked: Locked[] } {
  const counts: Record<string, number> = {};
  const locked: Locked[] = [];
  const stripped: JournalDocJson = {
    ...doc,
    content: (doc.content ?? []).map((n) => {
      const kind = KIND[n.type];
      if (!kind) return n;
      counts[kind] = (counts[kind] ?? 0) + 1;
      const id = `${kind}:${counts[kind]}`;
      locked.push({ id, node: n });
      return { type: 'paragraph', content: [{ type: 'text', text: marker(id) }] };
    }),
  };
  return { stripped, locked };
}

function restore(doc: JournalDocJson, locked: Locked[]): JournalDocJson {
  const byMarker = new Map(locked.map((l) => [marker(l.id), l.node]));
  return {
    ...doc,
    content: (doc.content ?? []).map((n) => {
      const only = n.type === 'paragraph' && n.content?.length === 1 ? n.content[0] : undefined;
      return (only?.text !== undefined && byMarker.get(only.text)) || n;
    }),
  };
}

/** Markdown the way the model sees it: locked blocks are `[[FIG:1]]` lines. */
const toModelMarkdown = (stripped: JournalDocJson): string =>
  renderMarkdown(stripped).replace(/@@((?:FIG|TBL|SNAP|TODO):\d+)@@/g, '[[$1]]');

const isMarker = (n: JournalNodeJson): boolean => n.type === 'paragraph' && /^@@/.test(n.content?.[0]?.text ?? '');

// ------------------------------------------------------------------------------------------------ canned rewrites
const txt = (t: string, marks?: JournalNodeJson['marks']): JournalNodeJson =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
const para = (...c: JournalNodeJson[]): JournalNodeJson => ({ type: 'paragraph', content: c });
const h2 = (t: string): JournalNodeJson => ({ type: 'heading', attrs: { level: 2 }, content: [txt(t)] });

/** Changes the words of every text node that is not a stock name. */
function mapText(node: JournalNodeJson, fn: (text: string) => string): JournalNodeJson {
  if (node.type === 'text') {
    if (node.marks?.some((m) => m.type === 'stockMention')) return node;
    return { ...node, text: fn(node.text ?? '') };
  }
  return node.content ? { ...node, content: node.content.map((c) => mapText(c, fn)) } : node;
}

const polishText = (s: string): string =>
  s
    .replace(/\bdidnt\b/gi, 'did not')
    .replace(/\bdont\b/gi, 'do not')
    .replace(/\bcant\b/gi, 'cannot')
    .replace(/\bi\b/g, 'I')
    .replace(/\s{2,}/g, ' ')
    .replace(/(^|[.!?]\s+)([a-z])/g, (_m, a: string, b: string) => `${a}${b.toUpperCase()}`);

/** The first and last text node of a block, to capitalise and to close the sentence. */
function polishBlock(block: JournalNodeJson): JournalNodeJson {
  if (isMarker(block) || block.type === 'heading') return block;
  const mapped = mapText(block, polishText);
  if (block.type !== 'paragraph' || !mapped.content?.length) {
    return block.content ? { ...mapped, content: mapped.content?.map(polishBlock) } : mapped;
  }
  const kids = [...mapped.content];
  const last = kids[kids.length - 1] as JournalNodeJson;
  if (last.type === 'text' && !last.marks?.length && !/[.!?:)"”]$/.test(last.text ?? ''))
    kids[kids.length - 1] = { ...last, text: `${last.text}.` };
  return { ...mapped, content: kids };
}

const tightenText = (s: string): string => polishText(s.replace(/\b(really|just|very|basically|I think)\b,?\s*/gi, ''));

function tightenBlock(block: JournalNodeJson): JournalNodeJson {
  if (isMarker(block) || block.type === 'heading') return block;
  if (block.type === 'paragraph') {
    const kids = (block.content ?? []).map((c) => (c.type === 'text' ? mapText(c, tightenText) : c));
    // keep the first sentence of a long paragraph
    const first = kids.findIndex((c) => c.type === 'text' && /[.!?]\s/.test(c.text ?? ''));
    if (first >= 0 && kids.length > first) {
      const node = kids[first] as JournalNodeJson;
      const m = /^(.*?[.!?])\s/.exec(node.text ?? '');
      if (m?.[1]) return { ...block, content: [...kids.slice(0, first), { ...node, text: m[1] }] };
    }
    return { ...block, content: kids };
  }
  return block.content ? { ...block, content: block.content.map(tightenBlock) } : block;
}

const ZH: [RegExp, string][] = [
  [/\bMarket\b/g, '市场'],
  [/\bScan\b/g, '扫描'],
  [/\bTomorrow\b/g, '明天'],
  [/\bOvernight\b/g, '隔夜'],
  [/\bLesson:/g, '教训：'],
  [/\bput\b/gi, '认沽'],
  [/\bresults\b/gi, '业绩'],
  [/\bsold\b/gi, '已卖出'],
  [/\bsell\b/gi, '卖出'],
  [/\broll\b/gi, '展期'],
  [/\bpremium\b/gi, '权利金'],
  [/\brule\b/gi, '规则'],
  [/\btoday\b/gi, '今天'],
  [/\band\b/gi, '和'],
  [/\bthe\b/gi, ''],
];

function zhBlock(block: JournalNodeJson): JournalNodeJson {
  if (isMarker(block)) return block;
  return mapText(block, (s) => ZH.reduce((acc, [re, to]) => acc.replace(re, to), s).replace(/\s{2,}/g, ' '));
}

function structure(blocks: JournalNodeJson[]): JournalNodeJson[] {
  const out: JournalNodeJson[] = [];
  if (!blocks.some((b) => b.type === 'heading')) out.push(h2('Notes'));
  let list: JournalNodeJson | null = null;
  for (const b of blocks) {
    if (b.type === 'paragraph' && !isMarker(b)) {
      const item = { type: 'listItem', content: [b] };
      if (list) (list.content as JournalNodeJson[]).push(item);
      else {
        list = { type: 'bulletList', content: [item] };
        out.push(list);
      }
    } else {
      list = null;
      out.push(b);
    }
  }
  return out;
}

function lessonsSection(): JournalNodeJson[] {
  const li = (t: string): JournalNodeJson => ({ type: 'listItem', content: [para(txt(t))] });
  return [
    h2('Lessons & actions (AI draft)'),
    {
      type: 'bulletList',
      content: [
        li('Rules beat feelings: a written rule decided the day, and it felt right afterwards.'),
        li('Watching the tape adds nothing when the plan already names the trigger.'),
      ],
    },
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { checked: false },
          content: [para(txt('Set a price alert instead of checking by hand'))],
        },
        { type: 'taskItem', attrs: { checked: false }, content: [para(txt('Write the premium floor into the notes'))] },
      ],
    },
  ];
}

function rewrite(mode: JournalAiMode, instruction: string | null, stripped: JournalDocJson): JournalDocJson {
  const blocks = stripped.content ?? [];
  switch (mode) {
    case 'polish':
      return { ...stripped, content: blocks.map(polishBlock) };
    case 'tighten':
      return { ...stripped, content: blocks.map(tightenBlock) };
    case 'structure':
      return { ...stripped, content: structure(blocks.map(polishBlock)) };
    case 'lessons':
      return { ...stripped, content: [...blocks, ...lessonsSection()] };
    case 'translate_zh':
    case 'translate_en':
      return { ...stripped, content: blocks.map(zhBlock) };
    default: {
      const polished = blocks.map(polishBlock);
      const first = polished[0];
      const note = instruction ? `Custom (“${instruction.slice(0, 40)}”): ` : '';
      if (first?.type === 'paragraph' && !isMarker(first) && note)
        polished[0] = { ...first, content: [txt(note), ...(first.content ?? [])] };
      return { ...stripped, content: polished };
    }
  }
}

// ------------------------------------------------------------------------------------------------ the run over time
const proseWords = (stripped: JournalDocJson): number =>
  deriveFromDoc({ ...stripped, content: (stripped.content ?? []).filter((b) => !isMarker(b)) }).wordCount;

function progressLines(run: Run): string[] {
  const { stripped, locked } = cut(run.inputDoc);
  const kinds = [...new Set(locked.map((l) => KIND_WORD[l.id.split(':')[0] as string]))];
  return [
    `prose: ${proseWords(stripped)} words, ${locked.length} locked block${locked.length === 1 ? '' : 's'}${kinds.length ? ` (${kinds.join(', ')})` : ''}`,
    `mode: ${LABEL[run.mode]}${run.instruction ? ` · "${run.instruction.slice(0, 60)}"` : ''}`,
    `context: ${run.withContext ? "today's open positions and scan picks" : 'none'}`,
    `claude -p · no tools · cap $0.10 · model ${MODEL}`,
    'writing…',
  ];
}

function finish(run: Run): void {
  const now = new Date();
  run.finishedAt = now.toISOString();
  run.durationMs = delayMs();
  run.model = MODEL;
  if (run.instruction && /\bfail\b/i.test(run.instruction)) {
    run.status = 'failed';
    run.error = 'The suggestion was refused and nothing was changed. The model changed a number: 62.5 became 65.';
    return;
  }
  const { stripped, locked } = cut(run.inputDoc);
  const written = rewrite(run.mode, run.instruction, stripped);
  const doc = restore(written, locked);
  const checked = validateJournalDoc(doc);
  if (!checked.ok) {
    run.status = 'failed';
    run.error = `The suggestion was refused and nothing was changed. ${checked.issues[0]?.message ?? ''}`.trim();
    return;
  }
  run.status = 'done';
  run.costUsd = 0.03;
  run.outputDoc = checked.doc;
  run.result = {
    doc: checked.doc,
    inputMarkdown: toModelMarkdown(stripped),
    outputMarkdown: toModelMarkdown(written),
    lockedKept: locked.length,
    lockedTotal: locked.length,
  };
}

/** Progress is time-based: a line every 300 ms, the answer after the delay. */
function advance(run: Run): void {
  if (run.status !== 'queued' && run.status !== 'running') return;
  const elapsed = Date.now() - run.startedAt;
  const total = delayMs();
  const lines = progressLines(run);
  if (elapsed >= total) {
    run.progress = lines;
    finish(run);
    return;
  }
  run.status = elapsed < 250 ? 'queued' : 'running';
  const step = Math.max(1, (total - 250) / lines.length);
  const shown = elapsed < 250 ? 0 : Math.min(lines.length, 1 + Math.floor((elapsed - 250) / step));
  run.progress = lines.slice(0, shown);
}

function view(run: Run): JournalAiRunView {
  advance(run);
  return {
    id: run.id,
    date: run.date as JournalAiRunView['date'],
    mode: run.mode,
    instruction: run.instruction,
    withContext: run.withContext,
    status: run.status,
    accepted: run.accepted,
    progress: run.progress,
    error: run.error,
    model: run.model,
    costUsd: run.costUsd,
    durationMs: run.durationMs,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    result: run.result,
  };
}

// ------------------------------------------------------------------------------------------------ endpoints
function runOf(id: string): Run {
  const run = isAssetId(id) ? runs.get(id.toLowerCase()) : undefined;
  if (!run) throw new HttpError(404, 'run_not_found', 'There is no such rewrite.');
  return run;
}

export function startAi(date: string, body: unknown): JournalAiStartView {
  if (!isRecord(body)) throw new HttpError(400, 'invalid_body', 'The body must be a JSON object.');
  const mode = body.mode as JournalAiMode;
  if (!MODES.includes(mode)) throw new HttpError(400, 'invalid_body', 'mode: pick one of the listed modes.');
  const instruction =
    typeof body.instruction === 'string' && body.instruction.trim() !== '' ? body.instruction.trim() : null;
  if (instruction && instruction.length > 500)
    throw new HttpError(400, 'invalid_instruction', 'The instruction is at most 500 characters.');
  if (mode === 'custom' && !instruction)
    throw new HttpError(400, 'instruction_required', 'Tell the AI what to do in the box, or pick another mode.');
  if (process.env.MOCK_AI_UNAVAILABLE === '1')
    throw new HttpError(
      503,
      'ai_unavailable',
      'The AI rewrite needs the claude CLI and it was not found. Set OT_CLAUDE_CLI to its path and restart the app.',
    );
  const { doc } = entryForAi(date);
  const today = new Date().toISOString().slice(0, 10);
  const todays = [...runs.values()].filter((r) => r.createdAt.startsWith(today)).length;
  if (todays >= DAILY_RUNS)
    throw new HttpError(
      429,
      'daily_limit',
      `You have used today's ${DAILY_RUNS} rewrites. The count restarts at midnight UTC.`,
    );
  for (const r of runs.values()) advance(r);
  const running = [...runs.values()].find((r) => r.date === date && (r.status === 'queued' || r.status === 'running'));
  if (running)
    throw new HttpError(409, 'run_in_progress', 'A rewrite is already running for this entry.', { runId: running.id });
  const { stripped } = cut(doc);
  if (proseWords(stripped) === 0)
    throw new HttpError(400, 'nothing_to_rewrite', 'There is no text to rewrite yet. Write something first.');
  const run: Run = {
    id: randomUUID(),
    date,
    mode,
    instruction,
    withContext: body.withContext === true,
    status: 'queued',
    accepted: null,
    startedAt: Date.now(),
    createdAt: new Date().toISOString(),
    finishedAt: null,
    inputDoc: structuredClone(doc),
    progress: [],
    error: null,
    result: null,
    costUsd: null,
    durationMs: null,
    model: null,
    outputDoc: null,
  };
  runs.set(run.id, run);
  return { runId: run.id };
}

export function latestAi(date: string): JournalAiRunView | null {
  entryForAi(date); // 404 entry_not_found when the day has no entry, like the real server
  const mine = [...runs.values()].filter((r) => r.date === date).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return mine[0] ? view(mine[0]) : null;
}

export const getAi = (id: string): JournalAiRunView => view(runOf(id));

export function cancelAi(id: string): JournalAiRunView {
  const run = runOf(id);
  advance(run);
  if (run.status === 'queued' || run.status === 'running') {
    run.status = 'cancelled';
    run.finishedAt = new Date().toISOString();
  }
  return view(run);
}

export function acceptAi(id: string): JournalAiAcceptView {
  const run = runOf(id);
  advance(run);
  if (run.status !== 'done' || !run.outputDoc)
    throw new HttpError(409, 'run_not_ready', 'This rewrite has no suggestion to use.');
  if (run.accepted !== null)
    throw new HttpError(
      409,
      'already_decided',
      run.accepted ? 'This suggestion was already used.' : 'You already kept your version.',
    );
  const { doc } = entryForAi(run.date);
  if (JSON.stringify(doc) !== JSON.stringify(run.inputDoc))
    throw new HttpError(
      409,
      'entry_changed',
      'You edited this entry after the suggestion was made. Ask again to get one for what you have now.',
    );
  const out = applyAiAccepted(run.date, run.outputDoc, run.mode, LABEL[run.mode]);
  run.accepted = true;
  return out;
}

export function rejectAi(id: string): JournalAiRunView {
  const run = runOf(id);
  advance(run);
  if (run.status !== 'done') throw new HttpError(409, 'run_not_ready', 'This rewrite has no suggestion to decline.');
  if (run.accepted === null) run.accepted = false;
  return view(run);
}
