import type {
  Currency,
  FairValueView,
  IngestItemView,
  ISODate,
  Market,
  RejectStatus,
  ReportingFrequency,
  ResearchRunDetailView,
  SkillId,
  SolvencyModel,
  StockKey,
  ValuationOverrides,
} from '../../src/server/api-types';

/** Sample fundamentals per share / in percent, the inputs of the KPI table and of the intrinsic-value maths. */
export interface Fund {
  /** Bank or insurer: no FCF DCF, no interest cover. */
  fin: boolean;
  eps: number;
  bvps: number;
  fcfps: number;
  dps: number;
  roe5: number;
  roe10: number;
  roic: number | null;
  gm: number | null;
  om: number | null;
  nm: number;
  /** Operating cash flow / net income. */
  ocf: number;
  capex: number;
  cov: number | null;
  dni: number | null;
  rc5: number;
  ec5: number;
  dil: number;
  pay: number;
  bb: number;
  /** EPS growth per year, percent, [bull, base, bear]. */
  g: [number, number, number];
  pe: [number, number, number];
  /** [own 5y median P/E, current percentile]. */
  hpe: [number, number];
  /** FCF growth used by the DCF; defaults to the base EPS growth. */
  dg?: number;
  comp: number;
  mg: number;
  /** Years listed. */
  listed: number;
  info: 'A' | 'B';
}

export interface Quality {
  f: number;
  z: number | null;
  /** FCF yield, percent. */
  fcf: number;
  /** Net debt / EBITDA; null = net cash. */
  nd: number | null;
  cagr: number;
  eps: number;
}

export interface Technical {
  rsi: number;
  macd: number;
  support: number;
  supportKind: string;
  touch: boolean;
}

export interface Volatility {
  /** Percent. */
  iv: number;
  rv: number;
  ivr: number;
  mode: 'chain' | 'rvOnly';
}

export interface EarningsSeed {
  date: ISODate;
  source: string;
  confirmed: boolean;
}

export interface ContractSeed {
  strike: number;
  prem: number;
  mult: number;
  dte: number;
  expiry: ISODate;
  delta: number;
}

export interface StaticBinding {
  status: RejectStatus;
  group: string;
  rule: string;
  value: string;
  want: string;
  detail: string;
  skillId: string;
}

/** Everything the "market data" of one stock consists of: seeded for the sample names, synthesised after a first ingest. */
export interface Profile {
  symbol: string;
  market: Market;
  name: string;
  zhName: string;
  sector: string;
  spot: number;
  lastBar: ISODate;
  /** Price ratio 380 sessions ago, shapes the chart. */
  pathA: number;
  score: number;
  sk?: { s1?: number; s2?: number; s3?: number };
  q: Quality;
  tech: Technical;
  vol: Volatility;
  er: EarningsSeed | null;
  contract: ContractSeed | null;
  binding: StaticBinding | null;
  /** Demo flag: the badge of this idea has no net-cost ratio. */
  noCostRatio?: boolean;
  fund: Fund;
}

export interface WatchRow {
  symbol: string;
  market: Market;
  name: string | null;
  sector: string | null;
  boardLot: number;
  solvencyModel: SolvencyModel;
  solvencyInferred: boolean;
  reportingFrequency: ReportingFrequency;
  conviction: number | null;
  notes: string | null;
  maxCollateralPct: number | null;
  active: boolean;
  addedAt: string;
  /** pending = never ingested, loaded = has data, no_data = the provider has nothing for it. */
  ingest: 'pending' | 'loaded' | 'no_data';
  profile: Profile | null;
}

export interface PositionRec {
  id: number;
  symbol: string;
  market: Market;
  strike: number;
  expiry: ISODate;
  quantity: number;
  multiplier: number;
  openDate: ISODate;
  openPrice: number;
  openFees: number;
  status: 'open' | 'closed' | 'expired' | 'assigned' | 'rolled';
  closeDate: ISODate | null;
  closePrice: number | null;
  closeFees: number;
  realizedPnl: number | null;
  source: 'manual' | 'journal_import';
  /** Spot supplied when the put was logged, used when the symbol has no stored bars. */
  spotHint: number | null;
}

export interface UserEvent {
  type: string;
  date: ISODate;
  confirmed: boolean;
  source: string;
}

export interface ChainRec {
  source: 'csv';
  date: ISODate;
  spot: number;
  stored: number;
  expiries: ISODate[];
  iv30: number | null;
}

export interface IngestPlanStep {
  /** Offset from the job start, ms. */
  t: number;
  log?: string;
  item?: IngestItemView;
}

export interface IngestRec {
  id: string;
  startedAtMs: number;
  durationMs: number;
  scope: 'all' | StockKey[];
  pausedSkipped: string[];
  plan: IngestPlanStep[];
  /** Keys (`US:KO`) of the rows this job loads data for. */
  fetched: string[];
  summary: { ok: number; failed: number; skipped: number; rows: number };
  /** Set when every name failed: the job then ends as `failed` instead of `done`. */
  error: string | null;
  settled: boolean;
}

export interface RunPlanLine {
  t: number;
  text: string;
}

export interface RunRec {
  id: string;
  symbol: string;
  market: Market;
  skillId: SkillId;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  stepMs: number;
  local: boolean;
  /** Step index at which a failing run stops, or null. */
  failAt: number | null;
  finalCostUsd: number | null;
  model: string | null;
  plan: RunPlanLine[];
  error: string | null;
  stepIndex: number;
  report: ResearchRunDetailView['report'];
}

export interface Store {
  equity: number | null;
  baseCurrency: Currency;
  watch: Map<string, WatchRow>;
  positions: PositionRec[];
  nextPositionId: number;
  /** Trades and results that predate the positions listed above (the journal summary adds them in). */
  journalBase: { trades: number; wins: number; realised: Partial<Record<Currency, number>> };
  events: Map<string, UserEvent[]>;
  chains: Map<string, ChainRec>;
  overrides: Map<string, ValuationOverrides>;
  fairValues: Map<string, FairValueView>;
  ingestJobs: IngestRec[];
  nextIngestId: number;
  runs: RunRec[];
  nextRunId: number;
  /** When the single AI slot last became free (ms). */
  aiFreeAtMs: number;
  lastScan: { id: string; at: string; asOf: ISODate; ideas: number } | null;
  scanSigs: Map<string, string>;
  nextScanId: number;
  skillUnavailable: boolean;
}

export const keyOf = (market: Market, symbol: string): string => `${market}:${symbol}`;
