import { API_BASE, request } from './client';
import type {
  AskItemView,
  AskStartInput,
  AskTarget,
  AskThreadView,
  AuthSessionView,
  AuthUserView,
  BacktestDetailView,
  BacktestRequestInput,
  BacktestSummaryView,
  BacktestTradeView,
  ChainImportInput,
  ChainImportView,
  ChartView,
  DataStatusView,
  EmailLinkRequestInput,
  EmailLinkRequestView,
  EmailLinkVerifyInput,
  EventAddInput,
  ExplainView,
  FairValueImportInput,
  FairValueImportView,
  HealthView,
  IngestJobView,
  IngestStartInput,
  JournalAiAcceptView,
  JournalAiRunView,
  JournalAiStartInput,
  JournalAiStartView,
  JournalAssetView,
  JournalCalendarView,
  JournalEntryInput,
  JournalEntryView,
  JournalImportInput,
  JournalImportView,
  JournalLessonsView,
  JournalListView,
  JournalRevisionView,
  LeaderMuteInput,
  LeaderMuteView,
  LeaderRecordView,
  LeaderStage,
  LeadersDaysView,
  LeadersRefreshView,
  LeadersView,
  LeaderWatchView,
  LoginInput,
  LotSellInput,
  LotView,
  Market,
  MarkRunView,
  NewsBriefDayView,
  NewsDaysView,
  NewsRefreshView,
  NewsScope,
  NewsSearchView,
  NewsView,
  OverviewView,
  PositionAddInput,
  PositionCloseInput,
  PositionsView,
  PositionView,
  RegisterInput,
  RemindersView,
  ResearchRunDetailView,
  ResearchRunView,
  ResearchStartInput,
  ScanView,
  SettingsPatch,
  SettingsView,
  SkillCatalogView,
  ValuationOverrides,
  ValueView,
  WatchAddInput,
  WatchBoardView,
  WatchBulkInput,
  WatchEntryView,
  WatchPasteView,
  WatchPatch,
  WatchPreviewView,
} from './types';
import { type UploadOptions, uploadJournalImage } from './upload';

type Signal = AbortSignal | undefined;

/** Filters of the journal list (all optional). `today` is the client's local date: the streak counts back from it. */
export interface JournalListQuery {
  from?: string;
  to?: string;
  q?: string;
  /** Canonical symbol with the market spelled the way the search box does: `NKE`, `0700.HK`. */
  symbol?: string;
  /** A tag without the leading #. */
  tag?: string;
  page?: number;
  today?: string;
}

/** Query of GET /api/leaders. Market and state filters are applied in the page, over the candidates returned. */
export interface LeadersQuery {
  date?: string;
  stage?: LeaderStage;
  market?: Market;
  state?: 'setup' | 'watch' | 'all';
}

const leaderPath = (id: number) => `/leaders/candidates/${id}`;

const journalPath = (date: string) => `/journal/entries/${encodeURIComponent(date)}`;

const stockPath = (market: Market, symbol: string) => `/stocks/${market}/${encodeURIComponent(symbol)}`;

/** Typed wrappers for every endpoint in the contract (src/server/api-types.ts, endpoint index at the bottom). */
export const api = {
  health: (signal?: Signal) => request<HealthView>('/health', { signal }),
  overview: (signal?: Signal) => request<OverviewView>('/overview', { signal }),

  scan: (signal?: Signal) => request<ScanView>('/scan', { signal }),
  runScan: () => request<ScanView>('/scan/run', { method: 'POST' }),
  explain: (market: Market, symbol: string, signal?: Signal) =>
    request<ExplainView>(`${stockPath(market, symbol)}/explain`, { signal }),
  chart: (market: Market, symbol: string, bars = 180, signal?: Signal) =>
    request<ChartView>(`${stockPath(market, symbol)}/chart`, { query: { bars }, signal }),
  value: (market: Market, symbol: string, rate?: number, signal?: Signal) =>
    request<ValueView>(`${stockPath(market, symbol)}/value`, { query: { rate }, signal }),
  putValuation: (market: Market, symbol: string, overrides: ValuationOverrides | null) =>
    request<ValueView>(`${stockPath(market, symbol)}/valuation`, { method: 'PUT', body: overrides }),

  watchlist: (signal?: Signal) => request<WatchEntryView[]>('/watchlist', { signal }),
  watchlistBoard: (signal?: Signal) => request<WatchBoardView>('/watchlist/board', { signal }),
  watchlistPreview: (raw: string, market?: Market, signal?: Signal) =>
    request<WatchPreviewView>('/watchlist/preview', { query: { raw, market }, signal }),
  watchlistAdd: (input: WatchAddInput) => request<WatchEntryView>('/watchlist', { method: 'POST', body: input }),
  watchlistPatch: (market: Market, symbol: string, patch: WatchPatch) =>
    request<WatchEntryView>(`/watchlist/${market}/${encodeURIComponent(symbol)}`, { method: 'PATCH', body: patch }),
  watchlistBulk: (input: WatchBulkInput) =>
    request<WatchEntryView[]>('/watchlist/bulk', { method: 'POST', body: input }),
  watchlistPaste: (text: string, apply: boolean, signal?: Signal) =>
    request<WatchPasteView>('/watchlist/paste', { method: 'POST', body: { text, apply }, signal }),

  positions: (signal?: Signal) => request<PositionsView>('/positions', { signal }),
  addPosition: (input: PositionAddInput) => request<PositionView>('/positions', { method: 'POST', body: input }),
  closePosition: (id: number, input: PositionCloseInput) =>
    request<PositionView>(`/positions/${id}/close`, { method: 'POST', body: input }),
  backtests: (signal?: Signal) => request<BacktestSummaryView[]>('/backtests', { signal }),
  backtest: (id: string, signal?: Signal) =>
    request<BacktestDetailView>(`/backtests/${encodeURIComponent(id)}`, { signal }),
  backtestTrades: (id: string, signal?: Signal) =>
    request<BacktestTradeView[]>(`/backtests/${encodeURIComponent(id)}/trades`, { signal }),
  startBacktest: (input: BacktestRequestInput) =>
    request<BacktestSummaryView>('/backtests', { method: 'POST', body: input }),
  cancelBacktest: (id: string) =>
    request<BacktestSummaryView>(`/backtests/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
  runMarks: (asOf?: string) =>
    request<MarkRunView>('/positions/marks/run', { method: 'POST', body: asOf ? { asOf } : {} }),
  sellLot: (id: number, input: LotSellInput) => request<LotView>(`/lots/${id}/sell`, { method: 'POST', body: input }),
  importJournal: (input: JournalImportInput) =>
    request<JournalImportView>('/journal/import', { method: 'POST', body: input }),

  journalEntries: (query: JournalListQuery = {}, signal?: Signal) =>
    request<JournalListView>('/journal/entries', { query: { ...query }, signal }),
  journalEntry: (date: string, signal?: Signal) => request<JournalEntryView>(journalPath(date), { signal }),
  /** Creates or updates the day's entry. `keepalive` lets the save on page hide finish after the page is gone. */
  putJournalEntry: (date: string, input: JournalEntryInput, options: { keepalive?: boolean; signal?: Signal } = {}) =>
    request<JournalEntryView>(journalPath(date), {
      method: 'PUT',
      body: input,
      keepalive: options.keepalive,
      signal: options.signal,
    }),
  closeJournalEntry: (date: string, reopen = false) =>
    request<JournalEntryView>(`${journalPath(date)}/close`, {
      method: 'POST',
      query: reopen ? { reopen: 1 } : undefined,
    }),
  deleteJournalEntry: (date: string) => request<{ ok: true }>(journalPath(date), { method: 'DELETE' }),
  undeleteJournalEntry: (date: string) =>
    request<JournalEntryView>(`${journalPath(date)}/undelete`, { method: 'POST' }),
  journalRevisions: (date: string, signal?: Signal) =>
    request<JournalRevisionView[]>(`${journalPath(date)}/revisions`, { signal }),
  restoreJournalRevision: (date: string, no: number) =>
    request<JournalEntryView>(`${journalPath(date)}/revisions/${no}/restore`, { method: 'POST' }),
  journalCalendar: (month: string, signal?: Signal) =>
    request<JournalCalendarView>('/journal/calendar', { query: { month }, signal }),
  journalLessons: (limit?: number, signal?: Signal) =>
    request<JournalLessonsView>('/journal/lessons', { query: { limit }, signal }),

  /** One image as multipart form data; resolves with the stored image's id. Progress is reported as 0 to 1. */
  uploadJournalImage: (file: Blob, options?: UploadOptions): Promise<JournalAssetView> =>
    uploadJournalImage(file, options),

  /** The newest AI rewrite of the day (null when there was none), so a suggestion that waited can be found again. */
  journalAiLatest: (date: string, signal?: Signal) =>
    request<JournalAiRunView | null>(`${journalPath(date)}/ai`, { signal }),
  startJournalAi: (date: string, input: JournalAiStartInput) =>
    request<JournalAiStartView>(`${journalPath(date)}/ai`, { method: 'POST', body: input }),
  journalAiRun: (runId: string, signal?: Signal) =>
    request<JournalAiRunView>(`/journal/ai/${encodeURIComponent(runId)}`, { signal }),
  cancelJournalAi: (runId: string) =>
    request<JournalAiRunView>(`/journal/ai/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),
  acceptJournalAi: (runId: string) =>
    request<JournalAiAcceptView>(`/journal/ai/${encodeURIComponent(runId)}/accept`, { method: 'POST' }),
  rejectJournalAi: (runId: string) =>
    request<JournalAiRunView>(`/journal/ai/${encodeURIComponent(runId)}/reject`, { method: 'POST' }),

  settings: (signal?: Signal) => request<SettingsView>('/settings', { signal }),
  putSettings: (patch: SettingsPatch) => request<SettingsView>('/settings', { method: 'PUT', body: patch }),

  dataStatus: (signal?: Signal) => request<DataStatusView>('/data/status', { signal }),
  startIngest: (input: IngestStartInput = {}) => request<IngestJobView>('/ingest', { method: 'POST', body: input }),
  ingest: (id: string, signal?: Signal) => request<IngestJobView>(`/ingest/${encodeURIComponent(id)}`, { signal }),
  importChain: (input: ChainImportInput) => request<ChainImportView>('/chains/import', { method: 'POST', body: input }),
  addEvent: (input: EventAddInput) => request<{ ok: true }>('/events', { method: 'POST', body: input }),
  importFairValues: (input: FairValueImportInput) =>
    request<FairValueImportView>('/fair-values/import', { method: 'POST', body: input }),

  news: (q: { scope: NewsScope; days: number; date?: string; neutral: boolean }, signal?: Signal) =>
    request<NewsView>('/news', {
      query: { scope: q.scope, days: q.days, date: q.date, neutral: q.neutral ? 1 : 0 },
      signal,
    }),
  newsDays: (month: string, scope: NewsScope, neutral: boolean, signal?: Signal) =>
    request<NewsDaysView>('/news/days', { query: { month, scope, neutral: neutral ? 1 : 0 }, signal }),
  newsSearch: (q: string, scope: NewsScope, signal?: Signal) =>
    request<NewsSearchView>('/news/search', { query: { q, scope }, signal }),
  newsBrief: (date: string, signal?: Signal) => request<NewsBriefDayView>('/news/brief', { query: { date }, signal }),
  refreshNews: () => request<NewsRefreshView>('/news/refresh', { method: 'POST' }),

  leaders: (q: LeadersQuery = {}, signal?: Signal) => request<LeadersView>('/leaders', { query: { ...q }, signal }),
  leadersDays: (month: string, signal?: Signal) =>
    request<LeadersDaysView>('/leaders/days', { query: { month }, signal }),
  leadersRecord: (window: '60' | 'all', signal?: Signal) =>
    request<LeaderRecordView>('/leaders/record', { query: { window }, signal }),
  refreshLeaders: () => request<LeadersRefreshView>('/leaders/refresh', { method: 'POST' }),
  muteLeader: (id: number, input: LeaderMuteInput = {}) =>
    request<LeaderMuteView>(`${leaderPath(id)}/mute`, { method: 'POST', body: input }),
  unmuteLeader: (id: number) => request<{ ok: true }>(`${leaderPath(id)}/mute`, { method: 'DELETE' }),
  watchLeader: (id: number) => request<LeaderWatchView>(`${leaderPath(id)}/watch`, { method: 'POST' }),

  reminders: (days = 30, signal?: Signal) => request<RemindersView>('/reminders', { query: { days }, signal }),

  skills: (signal?: Signal) => request<SkillCatalogView>('/skills', { signal }),
  startResearch: (input: ResearchStartInput) =>
    request<ResearchRunView[]>('/research/runs', { method: 'POST', body: input }),
  /** Every run, newest first, for the Home panel. */
  researchRunsAll: (signal?: Signal) => request<ResearchRunView[]>('/research/runs', { signal }),
  researchRuns: (market: Market, symbol: string, signal?: Signal) =>
    request<ResearchRunView[]>('/research/runs', { query: { market, symbol }, signal }),
  researchRun: (id: string, signal?: Signal) =>
    request<ResearchRunDetailView>(`/research/runs/${encodeURIComponent(id)}`, { signal }),
  cancelResearch: (id: string) =>
    request<ResearchRunView>(`/research/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  // ---- ask
  askThread: (target: AskTarget, signal?: Signal) =>
    request<AskThreadView>('/ask', {
      query:
        target.kind === 'idea'
          ? { kind: 'idea', market: target.market, symbol: target.symbol }
          : { kind: 'position', positionId: target.positionId },
      signal,
    }),
  ask: (input: AskStartInput) => request<AskItemView>('/ask', { method: 'POST', body: input }),
  askRun: (id: string, signal?: Signal) => request<AskItemView>(`/ask/${encodeURIComponent(id)}`, { signal }),
};

/** Sign-in endpoints. Google is not here: it is two browser navigations (`links.googleStart`), not a fetch. */
export const authApi = {
  session: (signal?: Signal) => request<AuthSessionView>('/auth/session', { signal }),
  login: (input: LoginInput) => request<AuthUserView>('/auth/login', { method: 'POST', body: input }),
  register: (input: RegisterInput) => request<AuthUserView>('/auth/register', { method: 'POST', body: input }),
  requestEmailLink: (email: string) =>
    request<EmailLinkRequestView>('/auth/email/request', {
      method: 'POST',
      body: { email } satisfies EmailLinkRequestInput,
    }),
  verifyEmailLink: (token: string) =>
    request<AuthUserView>('/auth/email/verify', { method: 'POST', body: { token } satisfies EmailLinkVerifyInput }),
  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),
};

/** Download links (plain anchors, no fetch). */
export const links = {
  googleStart: `${API_BASE}/auth/google/start`,
  watchlistCsv: `${API_BASE}/watchlist/export.csv`,
  /** An image of an entry (`thumb` is the 320 px WebP the list cards use). Same origin, signed-in owner only. */
  journalAssetUrl: (id: string, thumb = false) =>
    `${API_BASE}/journal/assets/${encodeURIComponent(id)}${thumb ? '?thumb=1' : ''}`,
  /** The entry as a Markdown download (the browser saves it; it is not fetched as JSON). */
  journalExportUrl: (date: string) => `${API_BASE}${journalPath(date)}/export.md`,
  reportMd: (id: string) => `${API_BASE}/research/runs/${encodeURIComponent(id)}/report.md`,
};
