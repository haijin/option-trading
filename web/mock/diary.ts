/**
 * In-memory mock of the daily journal API (docs/designs/daily-journal.md, "API"; the endpoint index at the bottom of
 * src/server/api-types.ts). It behaves like the real server where the UI depends on it: one entry per day, a `revisionNo`
 * concurrency token that every write bumps (409 `revision_conflict` when the client's is stale), derived Markdown, word
 * count and mentions, a revision list with restore, soft delete with undelete, close and reopen, the calendar, lessons and
 * search by words, `symbol` and `tag`. Seeded with the prototype's sample entries (13, 12, 10, 9, 8 and 7 Oct 2026).
 * Named diary.ts because journal.ts is the trade-CSV import.
 */
import {
  deriveFromDoc,
  excerptOf,
  extractLessons,
  type JournalDerived,
  type JournalDocJson,
  type JournalMentionRef,
  type JournalNodeJson,
  mentionLabel,
  parseMention,
  templateById,
  validateJournalDoc,
} from '../../src/journal';
import type {
  ISODate,
  JournalCalendarView,
  JournalCardView,
  JournalEntryView,
  JournalLessonsView,
  JournalListView,
  JournalMarketView,
  JournalMentionView,
  JournalRevisionSource,
  JournalRevisionView,
  JournalStatus,
  JournalSummaryLineView,
  JournalTemplateId,
} from '../../src/server/api-types';
import { SEED_ASSET_CHART, SEED_ASSET_CHART_DOWN } from './diaryAssets';
import { findRow } from './state';
import { HttpError, isIsoDate, isRecord } from './util';

// ------------------------------------------------------------------------------------------------ store
interface Rev {
  no: number;
  at: string;
  source: JournalRevisionSource;
  label: string;
  wordCount: number;
  doc: JournalDocJson;
}

interface Rec {
  id: string;
  date: ISODate;
  title: string | null;
  template: JournalTemplateId | null;
  marketView: JournalMarketView;
  tags: string[];
  status: JournalStatus;
  doc: JournalDocJson;
  derived: JournalDerived;
  revisionNo: number;
  createdAt: string;
  updatedAt: string;
  revisions: Rev[];
  deleted: boolean;
  aiPolished: boolean;
  /** The newest accepted AI suggestion. */
  lastAi: { mode: string | null; at: string } | null;
}

const diary = new Map<ISODate, Rec>();
let nextId = 1;
const PAGE_SIZE = 20;
/** A plain autosave only makes a new History row when the newest one is older than this. */
const REVISION_GAP_MS = 10 * 60_000;

// ------------------------------------------------------------------------------------------------ seed documents
const text = (t: string, marks?: JournalNodeJson['marks']): JournalNodeJson =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
const stock = (symbolLabel: string): JournalNodeJson => {
  const ref = parseMention(symbolLabel) as JournalMentionRef;
  return text(mentionLabel(ref), [{ type: 'stockMention', attrs: { market: ref.market, symbol: ref.symbol } }]);
};
/** `p('HK open weak, ', stock('0700.HK'), ' holds')`: strings become text, nodes stay. */
const p = (...parts: (string | JournalNodeJson)[]): JournalNodeJson => ({
  type: 'paragraph',
  content: parts.map((x) => (typeof x === 'string' ? text(x) : x)),
});
const figure = (assetId: string, caption: string): JournalNodeJson => ({ type: 'figure', attrs: { assetId, caption } });
const h2 = (t: string): JournalNodeJson => ({ type: 'heading', attrs: { level: 2 }, content: [text(t)] });
const quote = (...parts: (string | JournalNodeJson)[]): JournalNodeJson => ({
  type: 'blockquote',
  content: [p(...parts)],
});
const bullets = (...items: string[]): JournalNodeJson => ({
  type: 'bulletList',
  content: items.map((t) => ({ type: 'listItem', content: [p(t)] })),
});
const todos = (...items: [string, boolean][]): JournalNodeJson => ({
  type: 'taskList',
  content: items.map(([t, checked]) => ({ type: 'taskItem', attrs: { checked }, content: [p(t)] })),
});
const doc = (...content: JournalNodeJson[]): JournalDocJson => ({ type: 'doc', content });

const POSITIONS_SNAPSHOT: JournalNodeJson = {
  type: 'snapshot',
  attrs: {
    kind: 'positions',
    asOf: '2026-10-13T16:05:00Z',
    title: 'Open positions · from the app',
    columns: ['Name', 'Put', 'Exp', 'DTE', 'Delta', 'P&L'],
    align: ['l', 'r', 'l', 'r', 'r', 'r'],
    rows: [
      ['NKE', '65', '17 Oct', '4', '0.18', '+$210'],
      ['KO', '60', '21 Nov', '39', '0.22', '+$95'],
      ['0700.HK', '560', '29 Oct', '16', '0.15', '+HK$1,120'],
    ],
  },
};

interface Seed {
  date: ISODate;
  at: [number, number];
  title: string;
  template: JournalTemplateId;
  marketView: JournalMarketView;
  tags: string[];
  status: JournalStatus;
  aiPolished: boolean;
  doc: JournalDocJson;
}

const SEEDS: Seed[] = [
  {
    date: '2026-10-07',
    at: [8, 20],
    title: 'Pre-market: MSFT 480 assignment risk',
    template: 'morning',
    marketView: 'bearish',
    tags: ['assignment', 'breach'],
    status: 'closed',
    aiPolished: true,
    doc: doc(
      h2('Overnight'),
      p(
        stock('MSFT'),
        ' closed 483 with the 480 put at 0.44 delta. Rule says roll at strike + 5% breach, which was yesterday.',
      ),
      figure(SEED_ASSET_CHART_DOWN, 'MSFT at 483 before the open.'),
      h2('Orders I intend to place'),
      bullets('Roll the 480 to the Nov 465 for a small credit', 'No new puts until MSFT is resolved'),
      quote('Lesson: a roll one day late cost more than the roll itself. The rule has a date, not just a price.'),
    ),
  },
  {
    date: '2026-10-08',
    at: [19, 4],
    title: 'Quiet day, nothing done',
    template: 'evening',
    marketView: 'neutral',
    tags: [],
    status: 'closed',
    aiPolished: false,
    doc: doc(
      h2('What happened'),
      p(
        'No scan picks. Watched ',
        stock('0700.HK'),
        ' drift. Read the Q2 ',
        stock('3690.HK'),
        ' call again: subsidies are the whole story.',
      ),
    ),
  },
  {
    date: '2026-10-09',
    at: [22, 30],
    title: 'Sold NKE Nov 65 put, 0.21 delta',
    template: 'trade',
    marketView: 'bullish',
    tags: ['trade'],
    status: 'closed',
    aiPolished: false,
    doc: doc(
      h2('Thesis'),
      p(
        'Filled at 1.48 against a 1.52 mid. Thesis: inventory clean-up done, guidance already cut, 65 is below the August low.',
      ),
      h2('Exit plan'),
      bullets('Take profit at 50% of the credit', 'Roll at strike + 5%', 'Stop at 2x the credit'),
      h2('What the scan said'),
      p(
        stock('NKE'),
        ' passed every rule. S1 warns about results on 15 Oct but the expiry is after, so I sized it small.',
      ),
    ),
  },
  {
    date: '2026-10-10',
    at: [10, 12],
    title: 'Week 41: +$640, one rule breach',
    template: 'weekly',
    marketView: 'bullish',
    tags: ['weekly', 'breach'],
    status: 'closed',
    aiPolished: true,
    doc: doc(
      h2('P&L by name'),
      p('Four expiries, all worthless. ', stock('KO'), ' +$220, ', stock('NKE'), ' +$180, ', stock('MSFT'), ' +$240.'),
      h2('Rule breaches'),
      bullets('Sold the KO 60 one day after a WARN because the premium was good. Not again.'),
      quote('Lesson: never sell into a WARN because the premium is good. The premium is good because of the WARN.'),
      h2('Next week'),
      todos(['Re-read the roll rule before Monday', true], ['Check NKE results date', false]),
    ),
  },
  {
    date: '2026-10-12',
    at: [8, 51],
    title: 'Two HK names on the list, taking neither',
    template: 'morning',
    marketView: 'bearish',
    tags: ['hk', 'earnings'],
    status: 'closed',
    aiPolished: true,
    doc: doc(
      h2('Overnight'),
      p(
        'Scan after the weekend: ',
        stock('3690.HK'),
        ' and ',
        stock('9988.HK'),
        ' ready. 9988 Nov 150 looks fine on delta but the 20 Nov results sit inside the window.',
      ),
      h2('What would make me stop'),
      p('Any HSI close below the 200 day average ends new HK puts for the week.'),
      quote('Lesson: if results sit inside the expiry window, the trade is a results bet, whatever the delta says.'),
    ),
  },
  {
    date: '2026-10-13',
    at: [16, 42],
    title: 'Evening review: weak HK open, NKE into results',
    template: 'evening',
    marketView: 'neutral',
    tags: ['roll-rule', 'hk'],
    status: 'draft',
    aiPolished: false,
    doc: doc(
      h2('Market'),
      p(
        'HK open weak again, HSI -1.2% at open then recover by close. ',
        stock('0700.HK'),
        ' still holding 600 area, I think the 560 put nov is ok but IV lower than last week so premium not great. didnt sell.',
      ),
      p(
        'US: ',
        stock('NKE'),
        ' results after close, I have the 65 put open exp 17 Oct, 4 days left, delta now 0.18. if it drops below 68 tomorrow I will roll to Nov 62.5 rather than take assignment, because earnings risk not what I signed up for.',
      ),
      figure(SEED_ASSET_CHART, 'Tencent held 600 into the close. Screenshot 16:05.'),
      POSITIONS_SNAPSHOT,
      h2('Scan'),
      p(
        'Scan said 2 names ready: ',
        stock('KO'),
        ' 62.5 Nov, ',
        stock('3690.HK'),
        ' 100 Nov. Skipped 3690, results before expiry (S1 warn) and i dont want meituan at 100 anyway. KO i already have the 60, so no.',
      ),
      quote('Lesson: stop checking price every 10 min. the roll rule is below strike + 5%, not "feels heavy".'),
      quote('Lesson: write the premium floor down (1.2% of strike, 20 to 45 days) so "not great" has a number.'),
      h2('Tomorrow'),
      todos(
        ['NKE pre-market: roll to Nov 62.5 if under 68', false],
        ['Re-check 0700 IV; sell the Nov 560 only if premium > 1.2%', false],
        ['Update KO note on Research', true],
      ),
    ),
  },
];

const countWords = (d: JournalDocJson): number => deriveFromDoc(d).wordCount;

function revLabel(source: JournalRevisionSource, words: number): string {
  if (source === 'template') return 'Applied a template';
  return `Typed ${words} ${words === 1 ? 'word' : 'words'}`;
}

function seed(): void {
  for (const s of SEEDS) {
    const at = new Date(
      Number(s.date.slice(0, 4)),
      Number(s.date.slice(5, 7)) - 1,
      Number(s.date.slice(8, 10)),
      s.at[0],
      s.at[1],
    );
    const derived = deriveFromDoc(s.doc);
    const earlier = new Date(at.getTime() - 3 * 3_600_000).toISOString();
    const partial: JournalDocJson = {
      type: 'doc',
      content: (s.doc.content ?? []).slice(0, Math.max(1, Math.ceil((s.doc.content ?? []).length * 0.6))),
    };
    const partialWords = countWords(partial);
    const templateDoc = templateById(s.template)?.doc ?? s.doc;
    diary.set(s.date, {
      id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
      date: s.date,
      title: s.title,
      template: s.template,
      marketView: s.marketView,
      tags: s.tags,
      status: s.status,
      doc: s.doc,
      derived,
      revisionNo: 3,
      createdAt: earlier,
      updatedAt: at.toISOString(),
      deleted: false,
      aiPolished: s.aiPolished,
      lastAi: s.aiPolished ? { mode: 'polish', at: at.toISOString() } : null,
      // newest first, like the real list: the full text, an earlier partial draft, the template it started from
      revisions: [
        {
          no: 3,
          at: at.toISOString(),
          source: 'user',
          label: revLabel('user', derived.wordCount),
          wordCount: derived.wordCount,
          doc: s.doc,
        },
        {
          no: 2,
          at: new Date(at.getTime() - 3_600_000).toISOString(),
          source: 'user',
          label: revLabel('user', partialWords),
          wordCount: partialWords,
          doc: partial,
        },
        { no: 1, at: earlier, source: 'template', label: 'Started from the template', wordCount: 0, doc: templateDoc },
      ],
    });
  }
}
seed();

// ------------------------------------------------------------------------------------------------ views
function mentionViews(refs: JournalMentionRef[]): JournalMentionView[] {
  return refs.map((m) => ({
    market: m.market,
    symbol: m.symbol,
    label: mentionLabel(m),
    known: findRow(m.market, m.symbol) !== undefined,
  }));
}

function cardOf(r: Rec): JournalCardView {
  return {
    date: r.date,
    title: r.title,
    template: r.template,
    marketView: r.marketView,
    tags: r.tags,
    status: r.status,
    wordCount: r.derived.wordCount,
    excerpt: excerptOf(r.derived.markdown),
    mentions: mentionViews(r.derived.mentions),
    thumbnailAssetId: r.derived.assetIds[0] ?? null,
    aiPolished: r.aiPolished,
    updatedAt: r.updatedAt,
  };
}

function entryOf(r: Rec): JournalEntryView {
  return {
    ...cardOf(r),
    id: r.id,
    doc: r.doc,
    markdown: r.derived.markdown,
    revisionNo: r.revisionNo,
    createdAt: r.createdAt,
    revisionCount: r.revisions.length,
    lastAi: r.lastAi,
  };
}

const live = (): Rec[] => [...diary.values()].filter((r) => !r.deleted).sort((a, b) => (a.date < b.date ? 1 : -1));

function requireDate(date: string): ISODate {
  if (!isIsoDate(date)) throw new HttpError(400, 'invalid_date', `"${date}" is not a date: use YYYY-MM-DD.`);
  return date;
}

function requireEntry(date: string): Rec {
  const rec = diary.get(requireDate(date));
  if (!rec || rec.deleted) throw new HttpError(404, 'entry_not_found', `There is no journal entry for ${date}.`);
  return rec;
}

// ------------------------------------------------------------------------------------------------ list, calendar, lessons
const todayLocal = (): ISODate => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function shiftDay(day: ISODate, n: number): ISODate {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function summaryFor(today: ISODate): JournalSummaryLineView {
  const month = today.slice(0, 7);
  const inMonth = live().filter((r) => r.date.startsWith(month));
  const names = new Set<string>();
  let lessons = 0;
  for (const r of inMonth) {
    lessons += extractLessons(r.derived.markdown).length;
    for (const m of r.derived.mentions) names.add(`${m.market}:${m.symbol}`);
  }
  const days = new Set(live().map((r) => r.date));
  let cursor = days.has(today) ? today : shiftDay(today, -1);
  let streak = 0;
  while (days.has(cursor)) {
    streak++;
    cursor = shiftDay(cursor, -1);
  }
  return { month, entries: inMonth.length, lessons, names: names.size, streak };
}

export function listDiary(q: URLSearchParams): JournalListView {
  const from = q.get('from');
  const to = q.get('to');
  for (const [k, v] of [
    ['from', from],
    ['to', to],
  ] as const)
    if (v && !isIsoDate(v)) throw new HttpError(400, 'invalid_date', `Query parameter "${k}" must be YYYY-MM-DD.`);
  const words = (q.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const symbolRaw = q.get('symbol');
  const symbol = symbolRaw ? parseMention(symbolRaw) : null;
  if (symbolRaw && !symbol) throw new HttpError(400, 'invalid_symbol', `"${symbolRaw}" is not a stock name.`);
  const tag = (q.get('tag') ?? '').replace(/^#/, '').toLowerCase();
  const pageParam = Number(q.get('page') ?? 1);
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  const todayParam = q.get('today');
  const today = todayParam && isIsoDate(todayParam) ? todayParam : todayLocal();

  const all = live().filter((r) => {
    if (from && r.date < from) return false;
    if (to && r.date > to) return false;
    if (symbol && !r.derived.mentions.some((m) => m.market === symbol.market && m.symbol === symbol.symbol))
      return false;
    if (tag && !r.tags.includes(tag)) return false;
    if (words.length > 0) {
      const hay = `${r.title ?? ''} ${r.derived.plain}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const start = (page - 1) * PAGE_SIZE;
  return {
    entries: all.slice(start, start + PAGE_SIZE).map(cardOf),
    total: all.length,
    page,
    pageSize: PAGE_SIZE,
    summary: summaryFor(today),
  };
}

export function diaryCalendar(month: string | null): JournalCalendarView {
  if (!month || !/^\d{4}-\d{2}$/.test(month) || !isIsoDate(`${month}-01`))
    throw new HttpError(400, 'invalid_month', 'Query parameter "month" must be YYYY-MM.');
  const days = live()
    .filter((r) => r.date.startsWith(month))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((r) => ({ date: r.date, marketView: r.marketView, wordCount: r.derived.wordCount, status: r.status }));
  return {
    month,
    days,
    entries: days.length,
    bullish: days.filter((d) => d.marketView === 'bullish').length,
    bearish: days.filter((d) => d.marketView === 'bearish').length,
  };
}

export function diaryLessons(limitParam: string | null): JournalLessonsView {
  const n = Number(limitParam);
  const limit = Number.isInteger(n) && n >= 1 ? Math.min(n, 200) : 50;
  const out: JournalLessonsView['lessons'] = [];
  for (const r of live()) {
    for (const lesson of extractLessons(r.derived.markdown)) {
      const refs: JournalMentionRef[] = [];
      for (const m of lesson.matchAll(/\$(\d{4,5}\.HK|[A-Z][A-Z0-9.]{0,9})/g)) {
        const ref = parseMention(m[1] as string);
        if (ref && !refs.some((x) => x.market === ref.market && x.symbol === ref.symbol)) refs.push(ref);
      }
      out.push({
        date: r.date,
        text: lesson.replace(/\$(?=[A-Z0-9])/g, ''),
        mentions: mentionViews(refs),
        source: 'entry',
      });
    }
  }
  return { lessons: out.slice(0, limit) };
}

// ------------------------------------------------------------------------------------------------ writes
const VIEWS: JournalMarketView[] = ['bullish', 'neutral', 'bearish'];
const TEMPLATES: JournalTemplateId[] = ['morning', 'evening', 'trade', 'weekly', 'free'];

interface Parsed {
  title: string | null;
  template: JournalTemplateId | null;
  marketView: JournalMarketView;
  tags: string[];
  doc: JournalDocJson;
  revisionNo: number | null;
  source: 'user' | 'template';
}

function parseInput(body: unknown): Parsed {
  if (!isRecord(body)) throw new HttpError(400, 'invalid_body', 'The body must be a JSON object.');
  const bad = (m: string) => new HttpError(400, 'invalid_body', m);
  const title = body.title;
  if (title !== null && (typeof title !== 'string' || title.length > 200))
    throw bad('"title" must be a string of at most 200 characters, or null.');
  const template = body.template ?? null;
  if (template !== null && !TEMPLATES.includes(template as JournalTemplateId))
    throw bad('"template" is not a known template.');
  if (!VIEWS.includes(body.marketView as JournalMarketView))
    throw bad('"marketView" must be bullish, neutral or bearish.');
  const tags = body.tags;
  if (
    !Array.isArray(tags) ||
    tags.length > 20 ||
    !tags.every((t) => typeof t === 'string' && t.length > 0 && t.length <= 40)
  )
    throw bad('"tags" must be a list of up to 20 non-empty strings of at most 40 characters.');
  const revisionNo = body.revisionNo;
  if (revisionNo !== null && !(Number.isInteger(revisionNo) && (revisionNo as number) >= 1))
    throw bad('"revisionNo" must be a whole number or null.');
  const source = body.source ?? 'user';
  if (source !== 'user' && source !== 'template') throw bad('"source" must be user or template.');
  const checked = validateJournalDoc(body.doc);
  if (!checked.ok)
    throw new HttpError(
      400,
      'invalid_document',
      `The document is not valid: ${checked.issues[0]?.path} ${checked.issues[0]?.message}`,
      {
        issues: checked.issues.slice(0, 10),
      },
    );
  return {
    title: typeof title === 'string' && title.trim() !== '' ? title.trim() : null,
    template: template as JournalTemplateId | null,
    marketView: body.marketView as JournalMarketView,
    tags: tags as string[],
    doc: checked.doc,
    revisionNo: revisionNo as number | null,
    source,
  };
}

export function putDiaryEntry(date: string, body: unknown): JournalEntryView {
  requireDate(date);
  const input = parseInput(body);
  const existing = diary.get(date as ISODate);
  const current = existing && !existing.deleted ? existing : undefined;
  if ((current?.revisionNo ?? null) !== input.revisionNo) {
    throw new HttpError(409, 'revision_conflict', 'This entry changed on another device.', {
      currentRevisionNo: current?.revisionNo ?? null,
    });
  }
  const now = new Date();
  const derived = deriveFromDoc(input.doc);
  if (!current) {
    const rec: Rec = {
      id: existing?.id ?? `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
      date: date as ISODate,
      title: input.title,
      template: input.template,
      marketView: input.marketView,
      tags: input.tags,
      status: 'draft',
      doc: input.doc,
      derived,
      revisionNo: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      deleted: false,
      aiPolished: false,
      lastAi: null,
      revisions: [
        {
          no: 1,
          at: now.toISOString(),
          source: input.source,
          label: revLabel(input.source, derived.wordCount),
          wordCount: derived.wordCount,
          doc: input.doc,
        },
      ],
    };
    diary.set(rec.date, rec);
    return entryOf(rec);
  }

  const newest = current.revisions[0] as Rev;
  if (input.source === 'template') {
    // the state before the template stays in History as its own row, then the template makes the next one
    if (JSON.stringify(newest.doc) !== JSON.stringify(current.doc)) {
      current.revisions.unshift({
        no: newest.no + 1,
        at: current.updatedAt,
        source: 'user',
        label: revLabel('user', current.derived.wordCount),
        wordCount: current.derived.wordCount,
        doc: current.doc,
      });
    }
    current.revisions.unshift({
      no: (current.revisions[0] as Rev).no + 1,
      at: now.toISOString(),
      source: 'template',
      label: revLabel('template', derived.wordCount),
      wordCount: derived.wordCount,
      doc: input.doc,
    });
  } else if (now.getTime() - Date.parse(newest.at) > REVISION_GAP_MS) {
    current.revisions.unshift({
      no: newest.no + 1,
      at: now.toISOString(),
      source: 'user',
      label: revLabel('user', derived.wordCount),
      wordCount: derived.wordCount,
      doc: input.doc,
    });
  } else {
    newest.doc = input.doc;
    newest.wordCount = derived.wordCount;
    newest.label = revLabel(newest.source === 'template' ? 'template' : 'user', derived.wordCount);
  }
  current.title = input.title;
  current.template = input.template;
  current.marketView = input.marketView;
  current.tags = input.tags;
  current.doc = input.doc;
  current.derived = derived;
  current.revisionNo += 1;
  current.updatedAt = now.toISOString();
  return entryOf(current);
}

export function getDiaryEntry(date: string): JournalEntryView {
  return entryOf(requireEntry(date));
}

export function closeDiaryEntry(date: string, reopen: boolean): JournalEntryView {
  const rec = requireEntry(date);
  rec.status = reopen ? 'draft' : 'closed';
  rec.revisionNo += 1;
  rec.updatedAt = new Date().toISOString();
  return entryOf(rec);
}

export function deleteDiaryEntry(date: string): { ok: true } {
  requireEntry(date).deleted = true;
  return { ok: true };
}

export function undeleteDiaryEntry(date: string): JournalEntryView {
  const rec = diary.get(requireDate(date));
  if (!rec?.deleted) throw new HttpError(404, 'entry_not_found', `There is no deleted entry for ${date}.`);
  rec.deleted = false;
  return entryOf(rec);
}

export function diaryRevisions(date: string): JournalRevisionView[] {
  const rec = requireEntry(date);
  return rec.revisions.map((r, i) => ({
    no: r.no,
    at: r.at,
    source: r.source,
    label: r.label,
    wordCount: r.wordCount,
    current: i === 0,
  }));
}

export function restoreDiaryRevision(date: string, noText: string): JournalEntryView {
  const rec = requireEntry(date);
  const no = Number(noText);
  const rev = rec.revisions.find((r) => r.no === no);
  if (!rev) throw new HttpError(404, 'revision_not_found', `Entry ${date} has no revision ${noText}.`);
  const derived = deriveFromDoc(rev.doc);
  const now = new Date().toISOString();
  rec.revisions.unshift({
    no: (rec.revisions[0] as Rev).no + 1,
    at: now,
    source: 'restore',
    label: `Restored revision ${no}`,
    wordCount: derived.wordCount,
    doc: rev.doc,
  });
  rec.doc = rev.doc;
  rec.derived = derived;
  rec.revisionNo += 1;
  rec.updatedAt = now;
  return entryOf(rec);
}

export function diaryExport(date: string): { filename: string; markdown: string } {
  const rec = requireEntry(date);
  const head = `# ${rec.title ?? `Journal ${rec.date}`}\n\n${rec.date} · ${rec.marketView}${rec.tags.length ? ` · ${rec.tags.map((t) => `#${t}`).join(' ')}` : ''}\n\n`;
  return { filename: `journal-${rec.date}.md`, markdown: `${head}${rec.derived.markdown}\n` };
}

// ------------------------------------------------------------------------------------------------ for the AI mock
/** The entry's current document and concurrency token, for starting a rewrite. */
export function entryForAi(date: string): { doc: JournalDocJson; revisionNo: number } {
  const rec = requireEntry(date);
  return { doc: rec.doc, revisionNo: rec.revisionNo };
}

/**
 * Use suggestion: the suggested document becomes the entry, as a new History row (`AI · Polish (accepted)`). The row before it
 * holds the author's own version, and its number is what Undo restores.
 */
export function applyAiAccepted(
  date: string,
  doc: JournalDocJson,
  mode: string,
  modeLabel: string,
): { entry: JournalEntryView; undoRevisionNo: number } {
  const rec = requireEntry(date);
  const now = new Date().toISOString();
  let before = rec.revisions[0] as Rev;
  if (JSON.stringify(before.doc) !== JSON.stringify(rec.doc)) {
    rec.revisions.unshift({
      no: before.no + 1,
      at: rec.updatedAt,
      source: 'user',
      label: revLabel('user', rec.derived.wordCount),
      wordCount: rec.derived.wordCount,
      doc: rec.doc,
    });
    before = rec.revisions[0] as Rev;
  }
  const derived = deriveFromDoc(doc);
  rec.revisions.unshift({
    no: before.no + 1,
    at: now,
    source: 'ai_accepted',
    label: `AI · ${modeLabel} (accepted)`,
    wordCount: derived.wordCount,
    doc,
  });
  rec.doc = doc;
  rec.derived = derived;
  rec.revisionNo += 1;
  rec.updatedAt = now;
  rec.aiPolished = true;
  rec.lastAi = { mode, at: now };
  return { entry: entryOf(rec), undoRevisionNo: before.no };
}
