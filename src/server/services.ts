import { AuthService } from './auth/service';
import type { ServerDeps } from './deps';
import { ResearchManager } from './research/manager';
import { AskService } from './services/ask-service';
import { BacktestService } from './services/backtest-service';
import { DataService } from './services/data-service';
import { JournalAiService } from './services/journal-ai';
import { JournalAssetService } from './services/journal-assets';
import { JournalService } from './services/journal-service';
import { JournalSnapshotService } from './services/journal-snapshot';
import { LeadersService } from './services/leaders-service';
import { NewsService } from './services/news-service';
import { OverviewService } from './services/overview-service';
import { PositionService } from './services/positions-service';
import { RemindersService } from './services/reminders-service';
import { ScanService } from './services/scan-service';
import { SettingsService } from './services/settings-service';
import { AppState } from './services/state';
import { StockService } from './services/stock-service';
import { ValueService } from './services/value-service';
import { WatchBoardService } from './services/watch-board-service';
import { WatchService } from './services/watch-service';

/** The server's object graph, wired once per process (tests build their own with fakes). */
export interface Services {
  deps: ServerDeps;
  state: AppState;
  scan: ScanService;
  stocks: StockService;
  values: ValueService;
  watch: WatchService;
  /** The watchlist board: watched names with price, KPIs, highlights and the scan's verdict. */
  board: WatchBoardService;
  positions: PositionService;
  data: DataService;
  settings: SettingsService;
  overview: OverviewService;
  research: ResearchManager;
  /** The Ask chat on an idea or a position: questions answered from the app's numbers and the sell-put pitfalls. */
  ask: AskService;
  backtests: BacktestService;
  /** The daily journal (the user's own notes; never read by a skill, the scanner or a backtest). */
  journal: JournalService;
  /** The journal's images (upload, serve, delete). */
  journalImages: JournalAssetService;
  /** Frozen copies of positions and scan picks for the journal, and the optional context of an AI rewrite. */
  journalSnapshots: JournalSnapshotService;
  /** The AI rewrite: a suggestion with a diff that changes nothing until the author accepts. */
  journalAi: JournalAiService;
  news: NewsService;
  /** The Leaders page: the daily pullback-buy shortlist (display only; never read by a skill or the scan). */
  leaders: LeadersService;
  /** Reminders: results dates, expiries, position alerts, ex-dividends and blocking news. */
  reminders: RemindersService;
  /** Null when the login requirement is off. */
  auth: AuthService | null;
}

export function createServices(deps: ServerDeps): Services {
  const state = new AppState();
  const stocks = new StockService(deps, state);
  const values = new ValueService(deps, state, (inst) => stocks.fundamentalPayload(inst));
  const scan = new ScanService(deps, state, () => values);
  const watch = new WatchService(deps, state, scan);
  const board = new WatchBoardService(deps, state, watch, scan, stocks, values);
  const positions = new PositionService(deps, state, scan);
  const data = new DataService(deps, state, scan, watch, () => values);
  const settings = new SettingsService(deps, state);
  const overview = new OverviewService(deps, scan, data);
  const research = new ResearchManager(deps, state, () => values);
  const ask = new AskService(deps, scan, positions);
  const backtests = new BacktestService(deps, state);
  const news = new NewsService(deps, state);
  const leaders = new LeadersService(deps, state, watch);
  const reminders = new RemindersService(deps);
  const auth = deps.auth ? new AuthService(deps, deps.auth) : null;
  const journal = new JournalService(deps, auth);
  const journalImages = new JournalAssetService(deps);
  const journalSnapshots = new JournalSnapshotService(deps, positions, scan);
  const journalAi = new JournalAiService(deps, journal, journalSnapshots);
  return {
    deps,
    state,
    scan,
    stocks,
    values,
    watch,
    board,
    positions,
    data,
    settings,
    overview,
    research,
    ask,
    backtests,
    journal,
    journalImages,
    journalSnapshots,
    journalAi,
    news,
    leaders,
    reminders,
    auth,
  };
}
