import '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hkDayOf } from '../core/news';
import { canonicalSymbol } from '../core/symbols';
import { ASSET_LIMITS, isAssetId } from '../journal';
import type { JournalDocJson } from '../journal/types';
import type { Market } from './api-types';
import { ApiError, badRequest, notFound } from './errors';
import type { Services } from './services';

const market = z.enum(['US', 'HK']);
const solvency = z.enum(['altman', 'property', 'financial', 'reit']);
const reporting = z.enum(['quarterly', 'semiannual']);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dates are YYYY-MM-DD');
const nullableInt = z.number().int().nullable();

const watchAdd = z.object({
  symbol: z.string().min(1).max(20),
  market: market.optional(),
  boardLot: z.number().int().positive().optional(),
  solvencyModel: solvency.optional(),
  reportingFrequency: reporting.optional(),
  conviction: nullableInt.optional(),
  notes: z.string().max(2000).nullable().optional(),
  maxCollateralPct: z.number().nullable().optional(),
});
const watchPatch = z.object({
  active: z.boolean().optional(),
  boardLot: z.number().int().positive().optional(),
  solvencyModel: solvency.optional(),
  reportingFrequency: reporting.optional(),
  conviction: nullableInt.optional(),
  notes: z.string().max(2000).nullable().optional(),
  maxCollateralPct: z.number().nullable().optional(),
  name: z.string().max(200).nullable().optional(),
});
const stockKey = z.object({ market, symbol: z.string().min(1).max(20) });
const bulk = z.object({ op: z.enum(['stop', 'resume']), keys: z.array(stockKey).min(1).max(200) });
const paste = z.object({ text: z.string().max(20_000), apply: z.boolean() });
const positionAdd = z.object({
  symbol: z.string().min(1).max(20),
  market: market.optional(),
  strike: z.number().positive(),
  expiry: isoDate,
  contracts: z.number().int().positive(),
  price: z.number().positive(),
  date: isoDate.optional(),
  fees: z.number().min(0).optional(),
  spot: z.number().positive().optional(),
});
const positionClose = z.object({
  kind: z.enum(['bought_back', 'expired', 'assigned']),
  price: z.number().min(0).optional(),
  date: isoDate.optional(),
  fees: z.number().min(0).optional(),
  underlyingClose: z.number().positive().optional(),
});
const marksRun = z.object({ asOf: isoDate.optional() });
const lotSell = z.object({
  price: z.number().positive(),
  date: isoDate.optional(),
  fees: z.number().min(0).optional(),
});
const backtestStart = z
  .object({
    name: z.string().max(100).optional(),
    symbols: z.array(stockKey).max(200).optional(),
    from: isoDate,
    to: isoDate,
    tierPolicy: z.enum(['real_only', 'real_then_synthetic', 'synthetic_only']),
    initialCapital: z.number().positive().optional(),
    observeRejected: z.boolean().optional(),
    scanEveryDays: z.number().int().min(1).max(60).optional(),
    benchmarks: z.boolean().optional(),
    sensitivity: z.boolean().optional(),
    walkForward: z
      .object({ trainMonths: z.number().int().min(6).max(120), testMonths: z.number().int().min(3).max(60) })
      .nullable()
      .optional(),
    paramsOverride: z
      .record(z.string(), z.unknown())
      .refine((o) => JSON.stringify(o).length <= 10_000, 'paramsOverride is too large')
      .optional(),
  })
  .strict();
const journalImport = z.object({ csv: z.string().min(1).max(2_000_000) });
const settingsPatch = z.object({
  equity: z.number().positive().optional(),
  baseCurrency: z.enum(['HKD', 'USD']).optional(),
  governor: z
    .object({
      dailyLossLimit: z.number().positive().nullable().optional(),
      consecutiveLossHalt: z.number().int().positive().nullable().optional(),
      degearTiers: z
        .array(z.object({ drawdownPct: z.number().positive().max(100), multiplier: z.number().min(0).max(1) }))
        .max(10)
        .optional(),
    })
    .strict()
    .optional(),
});
const ingestStart = z.object({ only: z.array(stockKey).optional() });
const chainImport = z.object({
  symbol: z.string().min(1).max(20),
  market: market.optional(),
  csv: z.string().min(1).max(2_000_000),
  spot: z.number().positive(),
  date: isoDate,
});
const eventAdd = z.object({
  symbol: z.string().min(1).max(20),
  market: market.optional(),
  type: z.enum(['earnings', 'ex_dividend', 'agm', 'rights_issue', 'spin_off', 'split', 'index_rebalance', 'other']),
  date: isoDate,
  confirmed: z.boolean().optional(),
});
const fairValueImport = z.object({ csv: z.string().min(1).max(5_000_000), asOf: isoDate.optional() });
const researchStart = z.object({
  symbol: z.string().min(1).max(20),
  market: market.optional(),
  skillIds: z
    .array(
      z.enum([
        'quality-screen',
        'investment-checklist',
        'investment-research',
        'earnings-review',
        'management-deep-dive',
        'news-pulse',
        'thesis-tracker',
      ]),
    )
    .min(1)
    .max(7),
});
const askTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idea'), market, symbol: z.string().min(1).max(20) }),
  z.object({ kind: z.literal('position'), positionId: z.number().int().positive() }),
]);
const askStart = z.object({ target: askTarget, question: z.string().min(1).max(600) });
const overrides = z
  .object({
    growthPct: z.tuple([z.number(), z.number(), z.number()]).optional(),
    targetPe: z.tuple([z.number(), z.number(), z.number()]).optional(),
    dcfGrowthPct: z.number().optional(),
    requiredReturnPct: z.number().optional(),
  })
  .nullable();

const journalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dates are YYYY-MM-DD');
const journalEntryBody = z
  .object({
    title: z.string().max(400).nullable(),
    template: z.enum(['morning', 'evening', 'trade', 'weekly', 'free']).nullable(),
    marketView: z.enum(['bullish', 'neutral', 'bearish']),
    tags: z.array(z.string().max(80)).max(40),
    doc: z.custom<JournalDocJson>(
      (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
      'doc must be an object',
    ),
    revisionNo: z.number().int().min(1).nullable(),
    source: z.enum(['user', 'template']).optional(),
  })
  .strict();
const journalAiStart = z
  .object({
    mode: z.enum(['polish', 'tighten', 'structure', 'lessons', 'translate_zh', 'translate_en', 'custom']),
    instruction: z.string().max(2000).nullable().optional(),
    withContext: z.boolean().optional(),
  })
  .strict();
const newsScope = z.enum(['shortlist', 'positions', 'all']);
const newsQuery = z.object({
  scope: newsScope.default('shortlist'),
  date: isoDate.optional(),
  days: z.enum(['1', '3', '7', '30']).default('3').transform(Number),
  neutral: z
    .enum(['0', '1'])
    .default('1')
    .transform((v) => v === '1'),
});
const newsDaysQuery = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month is YYYY-MM'),
  scope: newsScope.default('shortlist'),
  neutral: z
    .enum(['0', '1'])
    .default('1')
    .transform((v) => v === '1'),
});
const newsSearchQuery = z.object({ q: z.string().trim().min(1).max(100), scope: newsScope.default('shortlist') });
const newsBriefQuery = z.object({ date: isoDate.optional() });
const leadersQuery = z.object({
  date: isoDate.optional(),
  stage: z.enum(['screened', 'leaders', 'consolidating', 'shortlist']).default('shortlist'),
  market: market.optional(),
  state: z.enum(['setup', 'watch', 'all']).default('all'),
});
const leadersDaysQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month is YYYY-MM') });
const leadersRecordQuery = z.object({ window: z.enum(['60', 'all']).default('60') });
const leadersMute = z
  .object({ days: z.number().int().min(1).max(60).optional(), reason: z.string().max(200).optional() })
  .strict();
const candidateId = (v: unknown): number => {
  const n = Number((v as { id?: string }).id);
  if (!Number.isInteger(n) || n < 1) throw badRequest('invalid_id', 'the candidate id must be a whole number');
  return n;
};

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw badRequest('validation', msg, r.error.issues);
  }
  return r.data;
}

const marketParam = (v: string): Market => {
  const m = v.toUpperCase();
  if (m !== 'US' && m !== 'HK') throw badRequest('invalid_market', 'market must be US or HK');
  return m;
};
const symbolParam = (m: Market, v: string): string => {
  try {
    return canonicalSymbol(m, decodeURIComponent(v));
  } catch (err) {
    throw badRequest('invalid_symbol', (err as Error).message);
  }
};
const numQuery = (v: unknown, name: string): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest('invalid_query', `${name} must be a number`);
  return n;
};

/**
 * Liveness, and the one data route that is public (the launcher polls it before anyone can sign in). With the login on,
 * a request without a session gets only `{ ok: true }`: no version, database name or clock.
 */
export function registerHealth(app: FastifyInstance, s: Services): void {
  app.get('/api/health', async (req) => {
    if (s.auth && !(await s.auth.userForCookie(req.headers.cookie))) return { ok: true };
    return {
      ok: true,
      version: s.deps.version,
      database: { connected: true, name: s.deps.database.name },
      now: s.deps.now().toISOString(),
    };
  });
}

/** Every data route. Registered inside a plugin that carries the login gate (app.ts), never at the top level. */
export function registerRoutes(app: FastifyInstance, s: Services): void {
  const q = (req: { query: unknown }): Record<string, string | undefined> =>
    (req.query ?? {}) as Record<string, string | undefined>;

  app.get('/api/overview', async () => s.overview.view());

  // ---- today
  const asOfQuery = (req: { query: unknown }): string | undefined => {
    const v = q(req).asOf;
    if (v === undefined || v === '') return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest('invalid_query', 'asOf must be YYYY-MM-DD');
    return v;
  };
  app.get('/api/scan', async (req) => {
    const asOf = asOfQuery(req);
    return s.scan.get({ allowStale: q(req).allowStale === '1', ...(asOf ? { asOf } : {}) });
  });
  app.post('/api/scan/run', async (req) => {
    const asOf = asOfQuery(req);
    return s.scan.get({ allowStale: q(req).allowStale === '1', save: true, ...(asOf ? { asOf } : {}) });
  });

  // ---- one stock
  app.get('/api/stocks/:market/:symbol/explain', async (req) => {
    const p = req.params as { market: string; symbol: string };
    const m = marketParam(p.market);
    return s.stocks.explain(m, symbolParam(m, p.symbol));
  });
  app.get('/api/stocks/:market/:symbol/chart', async (req) => {
    const p = req.params as { market: string; symbol: string };
    const m = marketParam(p.market);
    return s.stocks.chart(m, symbolParam(m, p.symbol), numQuery(q(req).bars, 'bars') ?? 180);
  });
  app.get('/api/stocks/:market/:symbol/value', async (req) => {
    const p = req.params as { market: string; symbol: string };
    const m = marketParam(p.market);
    const sym = symbolParam(m, p.symbol);
    // A proposed put (from today's scan) makes the "if assigned" block meaningful.
    const idea = s.scan.peek()?.ideas.find((i) => i.market === m && i.symbol === sym);
    return s.values.view(
      m,
      sym,
      numQuery(q(req).rate, 'rate'),
      idea ? { strike: idea.contract.strike, premium: idea.contract.premium } : null,
    );
  });
  app.put('/api/stocks/:market/:symbol/valuation', async (req) => {
    const p = req.params as { market: string; symbol: string };
    const m = marketParam(p.market);
    return s.values.setOverrides(
      m,
      symbolParam(m, p.symbol),
      parse(overrides, req.body === undefined ? null : req.body),
      numQuery(q(req).rate, 'rate'),
    );
  });

  // ---- watchlist
  app.get('/api/watchlist', async () => s.watch.list());
  app.get('/api/watchlist/board', async () => s.board.board());
  app.get('/api/watchlist/preview', async (req) => {
    const x = q(req);
    const m = x.market && x.market !== 'auto' ? marketParam(x.market) : undefined;
    return s.watch.preview(x.raw ?? '', m);
  });
  app.get('/api/watchlist/export.csv', async (_req, reply) => {
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="watchlist.csv"');
    return s.watch.exportCsv();
  });
  app.post('/api/watchlist', async (req, reply) => {
    reply.code(201);
    return s.watch.add(parse(watchAdd, req.body));
  });
  app.post('/api/watchlist/bulk', async (req) => s.watch.bulk(parse(bulk, req.body)));
  app.post('/api/watchlist/paste', async (req) => {
    const b = parse(paste, req.body);
    return s.watch.paste(b.text, b.apply);
  });
  app.patch('/api/watchlist/:market/:symbol', async (req) => {
    const p = req.params as { market: string; symbol: string };
    const m = marketParam(p.market);
    return s.watch.patch(m, symbolParam(m, p.symbol), parse(watchPatch, req.body));
  });

  // ---- positions and journal
  app.get('/api/positions', async () => s.positions.list());
  app.post('/api/positions', async (req, reply) => {
    reply.code(201);
    return s.positions.add(parse(positionAdd, req.body));
  });
  app.post('/api/positions/:id/close', async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) throw notFound('no such position');
    return s.positions.close(id, parse(positionClose, req.body));
  });
  app.post('/api/positions/marks/run', async (req) => s.positions.runMarks(parse(marksRun, req.body).asOf));
  app.get('/api/lots', async (req) => {
    const st = (req.query as { status?: string }).status;
    if (st !== undefined && st !== 'open' && st !== 'sold')
      throw badRequest('invalid_query', 'status must be open or sold');
    return s.positions.lots(st);
  });
  app.post('/api/lots/:id/sell', async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('invalid_id', 'lot id must be a positive integer');
    return s.positions.sellLot(id, parse(lotSell, req.body));
  });
  app.post('/api/journal/import', async (req) => s.positions.importJournalCsv(parse(journalImport, req.body).csv));

  // ---- daily journal: every route resolves the signed-in user first and passes the id down, so a query can never see another user's rows
  const me = (req: { headers: { cookie?: string | undefined } }): Promise<string> =>
    s.journal.userId(req.headers.cookie);
  const dateParam = (req: { params: unknown }): string => parse(journalDate, (req.params as { date: string }).date);
  app.get('/api/journal/entries', async (req) => {
    const x = q(req);
    return s.journal.list(await me(req), {
      ...(x.from ? { from: x.from } : {}),
      ...(x.to ? { to: x.to } : {}),
      ...(x.q ? { q: x.q } : {}),
      ...(x.symbol ? { symbol: x.symbol } : {}),
      ...(x.tag ? { tag: x.tag } : {}),
      ...(x.today ? { today: x.today } : {}),
      page: numQuery(x.page, 'page') ?? 1,
      pageSize: numQuery(x.pageSize, 'pageSize') ?? 30,
    });
  });
  app.get('/api/journal/entries/:date', async (req) => s.journal.get(await me(req), dateParam(req)));
  app.put('/api/journal/entries/:date', async (req) =>
    s.journal.put(await me(req), dateParam(req), parse(journalEntryBody, req.body)),
  );
  app.post('/api/journal/entries/:date/close', async (req) =>
    s.journal.setStatus(await me(req), dateParam(req), q(req).reopen === '1' ? 'draft' : 'closed'),
  );
  app.delete('/api/journal/entries/:date', async (req) => s.journal.remove(await me(req), dateParam(req)));
  app.post('/api/journal/entries/:date/undelete', async (req) => s.journal.undelete(await me(req), dateParam(req)));
  app.get('/api/journal/entries/:date/revisions', async (req) => s.journal.revisions(await me(req), dateParam(req)));
  app.post('/api/journal/entries/:date/revisions/:no/restore', async (req) => {
    const no = Number((req.params as { no: string }).no);
    if (!Number.isInteger(no) || no <= 0 || no > 2_000_000_000)
      throw badRequest('invalid_id', 'revision number must be a positive integer');
    return s.journal.restore(await me(req), dateParam(req), no);
  });
  /** The address the browser used, so exported image links open the same way (the public address when that is the one in use). */
  const originOf = (req: { headers: { host?: string | undefined } }): string => {
    const host = req.headers.host ?? '127.0.0.1';
    const pub = s.deps.auth?.publicOrigin;
    return pub && new URL(pub).host.toLowerCase() === host.toLowerCase() ? pub : `http://${host}`;
  };
  app.get('/api/journal/entries/:date/export.md', async (req, reply) => {
    const out = await s.journal.exportMarkdown(await me(req), dateParam(req), originOf(req));
    reply
      .header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${out.filename}"`);
    return out.markdown;
  });
  app.get('/api/journal/calendar', async (req) => s.journal.calendar(await me(req), q(req).month ?? ''));
  app.get('/api/journal/lessons', async (req) =>
    s.journal.lessons(await me(req), numQuery(q(req).limit, 'limit') ?? 50),
  );

  // ---- journal AI rewrite: a suggestion that changes nothing until it is accepted
  const runId = (req: { params: unknown }): string => {
    const id = (req.params as { runId: string }).runId;
    if (!isAssetId(id)) throw notFound('there is no such rewrite', 'run_not_found');
    return id.toLowerCase();
  };
  app.post('/api/journal/entries/:date/ai', async (req, reply) => {
    const body = parse(journalAiStart, req.body);
    const out = await s.journalAi.start(await me(req), dateParam(req), {
      mode: body.mode,
      instruction: body.instruction ?? null,
      withContext: body.withContext === true,
    });
    reply.code(202);
    return out;
  });
  app.get('/api/journal/entries/:date/ai', async (req) => s.journalAi.latestForEntry(await me(req), dateParam(req)));
  app.get('/api/journal/ai/:runId', async (req) => s.journalAi.get(await me(req), runId(req)));
  app.post('/api/journal/ai/:runId/cancel', async (req) => s.journalAi.cancel(await me(req), runId(req)));
  app.post('/api/journal/ai/:runId/accept', async (req) => s.journalAi.accept(await me(req), runId(req)));
  app.post('/api/journal/ai/:runId/reject', async (req) => s.journalAi.reject(await me(req), runId(req)));

  // ---- "Your notes" on Research: presentation only, the scanner never sees it
  app.get('/api/stocks/:market/:symbol/journal', async (req) => {
    const p = req.params as { market: string; symbol: string };
    const m = marketParam(p.market);
    return s.journal.notesFor(await me(req), m, symbolParam(m, p.symbol));
  });

  // ---- journal snapshot: a frozen table of positions or today's scan picks, for the editor to insert
  app.get('/api/journal/snapshot', async (req) => {
    await me(req);
    const kind = q(req).kind;
    if (kind === 'positions') return s.journalSnapshots.positionsSnapshot();
    if (kind === 'scan') return s.journalSnapshots.scanSnapshot();
    throw badRequest('invalid_query', 'kind must be positions or scan');
  });

  // ---- journal images: multipart in, bytes out; the file name the client sends is never used
  const assetId = (req: { params: unknown }): string => {
    const id = (req.params as { id: string }).id;
    if (!isAssetId(id)) throw notFound('there is no such image', 'asset_not_found');
    return id.toLowerCase();
  };
  app.post('/api/journal/assets', async (req, reply) => {
    const userId = await me(req);
    if (!req.isMultipart()) throw badRequest('multipart_required', 'Send the image as multipart/form-data.');
    let bytes: Buffer;
    try {
      const part = await req.file();
      if (!part) throw badRequest('no_file', 'There is no image in the upload.');
      bytes = await part.toBuffer();
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE')
        throw new ApiError(413, 'file_too_large', `Images are limited to ${ASSET_LIMITS.maxBytes / 1024 / 1024} MB.`);
      throw err;
    }
    reply.code(201);
    return s.journalImages.upload(userId, bytes);
  });
  app.get('/api/journal/assets/:id', async (req, reply) => {
    const file = await s.journalImages.read(await me(req), assetId(req), q(req).thumb === '1');
    reply
      .header('Content-Type', file.mime)
      .header('Content-Disposition', 'inline')
      .header('Cache-Control', 'private, max-age=86400')
      .header('ETag', file.etag);
    if (req.headers['if-none-match'] === file.etag) return reply.code(304).send();
    return reply.send(file.data);
  });
  app.delete('/api/journal/assets/:id', async (req) => s.journalImages.remove(await me(req), assetId(req)));

  // ---- settings
  app.get('/api/settings', async () => s.settings.view());
  app.put('/api/settings', async (req) => s.settings.patch(parse(settingsPatch, req.body)));

  // ---- data
  app.get('/api/data/status', async () => s.data.status());
  app.post('/api/ingest', async (req, reply) => {
    const body = parse(ingestStart, req.body);
    reply.code(202);
    return s.data.startIngest(body);
  });
  app.get('/api/ingest/:id', async (req) => s.data.getJob((req.params as { id: string }).id));
  app.post('/api/chains/import', async (req) => s.data.importChainCsv(parse(chainImport, req.body)));
  app.post('/api/events', async (req) => {
    await s.data.addEvent(parse(eventAdd, req.body));
    return { ok: true };
  });
  app.post('/api/fair-values/import', async (req) => s.data.importFairValues(parse(fairValueImport, req.body)));

  // ---- research
  app.get('/api/skills', async () => s.research.catalog());
  app.post('/api/research/runs', async (req, reply) => {
    reply.code(202);
    return s.research.start(parse(researchStart, req.body));
  });
  app.get('/api/research/runs', async (req) => {
    const x = q(req);
    return s.research.list(x.market ? marketParam(x.market) : undefined, x.symbol);
  });
  app.get('/api/research/runs/:id', async (req) => s.research.get((req.params as { id: string }).id));
  app.post('/api/research/runs/:id/cancel', async (req) => s.research.cancel((req.params as { id: string }).id));
  app.get('/api/research/runs/:id/report.md', async (req, reply) => {
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    return s.research.reportMarkdown((req.params as { id: string }).id);
  });
  // ---- ask (docs/designs/trade-skills-integration.md, stage T2)
  app.post('/api/ask', async (req, reply) => {
    reply.code(202);
    return s.ask.start(parse(askStart, req.body));
  });
  app.get('/api/ask', async (req) => {
    const x = q(req);
    if (x.kind === 'position') return s.ask.thread({ kind: 'position', positionId: Number(x.positionId) });
    if (x.kind !== 'idea') throw badRequest('invalid_kind', 'kind must be idea or position');
    return s.ask.thread({ kind: 'idea', market: marketParam(x.market ?? ''), symbol: x.symbol ?? '' });
  });
  app.get('/api/ask/:id', async (req) => s.ask.get((req.params as { id: string }).id));
  // ---- reminders (docs/designs/app-dashboard.md)
  app.get('/api/reminders', async (req) => {
    const daysRaw = q(req).days;
    const days = daysRaw ? Math.min(90, Math.max(1, Number.parseInt(daysRaw, 10))) : 30;
    const today = hkDayOf(s.deps.now());
    return s.reminders.view(today, days);
  });

  // ---- news (docs/designs/latest-news.md)
  app.get('/api/news', async (req) => {
    const x = parse(newsQuery, req.query);
    return s.news.view({ scope: x.scope, days: x.days, hideNeutral: !x.neutral, ...(x.date ? { date: x.date } : {}) });
  });
  app.get('/api/news/days', async (req) => {
    const x = parse(newsDaysQuery, req.query);
    return s.news.days({ month: x.month, scope: x.scope, hideNeutral: !x.neutral });
  });
  app.get('/api/news/search', async (req) => s.news.search(parse(newsSearchQuery, req.query)));
  app.get('/api/news/brief', async (req) => {
    const x = parse(newsBriefQuery, req.query);
    return s.news.briefs(x.date ?? hkDayOf(s.deps.now()));
  });
  app.post('/api/news/refresh', async (_req, reply) => {
    reply.code(202);
    return s.news.refresh();
  });
  // ---- leaders (docs/designs/leaders-pullback.md)
  app.get('/api/leaders', async (req) => {
    const x = parse(leadersQuery, req.query);
    return s.leaders.view({
      stage: x.stage,
      ...(x.date ? { date: x.date } : {}),
      ...(x.market ? { market: x.market } : {}),
      state: x.state,
    });
  });
  app.get('/api/leaders/days', async (req) => s.leaders.days(parse(leadersDaysQuery, req.query).month));
  app.get('/api/leaders/record', async (req) => s.leaders.record(parse(leadersRecordQuery, req.query).window));
  app.post('/api/leaders/refresh', async (_req, reply) => {
    reply.code(202);
    return s.leaders.refresh();
  });
  app.post('/api/leaders/candidates/:id/mute', async (req) =>
    s.leaders.mute(candidateId(req.params), parse(leadersMute, req.body)),
  );
  app.delete('/api/leaders/candidates/:id/mute', async (req) => s.leaders.unmute(candidateId(req.params)));
  app.post('/api/leaders/candidates/:id/watch', async (req) => s.leaders.addToWatchlist(candidateId(req.params)));
  // ---- backtests (Phase 4)
  app.post('/api/backtests', async (req, reply) => {
    reply.code(202);
    return s.backtests.start(parse(backtestStart, req.body));
  });
  app.get('/api/backtests', async () => s.backtests.list());
  app.get('/api/backtests/:id', async (req) => s.backtests.get((req.params as { id: string }).id));
  app.get('/api/backtests/:id/trades', async (req) =>
    s.backtests.trades((req.params as { id: string }).id, q(req).shadow === '1'),
  );
  app.get('/api/backtests/:id/trades.csv', async (req, reply) => {
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="backtest-trades.csv"');
    return s.backtests.csv((req.params as { id: string }).id);
  });
  app.post('/api/backtests/:id/cancel', async (req) => s.backtests.cancel((req.params as { id: string }).id));
  app.get('/api/stocks/:market/:symbol/studies', async (req) => {
    const { market: mk, symbol: sym } = req.params as { market: string; symbol: string };
    const m = marketParam(mk);
    return s.backtests.studies(m, symbolParam(m, sym));
  });
}
