/**
 * A frozen copy of app data for the journal: open positions, or today's scan picks, as rows of display strings. The rows
 * come from the same services as the Positions and Today pages, so what the journal shows is what those pages showed. The
 * entry keeps the copy; it never re-reads live tables, because the entry says what the author saw that day.
 * The same data, written as short lines, is the optional context an AI rewrite may be given.
 */
import type { Currency, JournalSnapshotView, PositionView, ScanView } from '../api-types';
import type { ServerDeps } from '../deps';
import type { PositionService } from './positions-service';
import type { ScanService } from './scan-service';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PREFIX: Record<Currency, string> = { USD: '$', HKD: 'HK$', SGD: 'S$' };

/** `2026-10-17` -> `17 Oct`. */
export function shortDay(iso: string): string {
  const [, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1] ?? ''}`.trim();
}

/** `1234.5` -> `$1,235`; with `signed`, `+$210` / `-HK$1,120`. Whole units: the diary is not a ledger. */
export function money(value: number, currency: Currency, signed = false): string {
  const body = `${PREFIX[currency]}${Math.round(Math.abs(value)).toLocaleString('en-US')}`;
  if (value < 0) return `-${body}`;
  return signed && value > 0 ? `+${body}` : body;
}

const price = (n: number): string => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))));

export interface SnapshotContext {
  /** Reference lines for the model. */
  text: string;
  /** "today's 3 positions, scan 16:32": for the progress line. */
  summary: string;
}

export class JournalSnapshotService {
  constructor(
    private readonly deps: ServerDeps,
    private readonly positions: PositionService,
    private readonly scan: ScanService,
  ) {}

  private asOf(): string {
    return this.deps.now().toISOString().slice(0, 16);
  }

  /** Open puts: name, strike, expiry, days left, quantity, credit received and the P&L at the latest mark. */
  async positionsSnapshot(): Promise<JournalSnapshotView> {
    const view = await this.positions.list();
    return {
      kind: 'positions',
      asOf: this.asOf(),
      title: 'Open positions',
      columns: ['Name', 'Put', 'Exp', 'DTE', 'Qty', 'Credit', 'P&L'],
      align: ['l', 'r', 'l', 'r', 'r', 'r', 'r'],
      rows: view.open.map((p: PositionView) => [
        p.market === 'HK' ? `${p.symbol}.HK` : p.symbol,
        price(p.strike),
        shortDay(p.expiry),
        String(p.dte),
        String(p.quantity),
        money(p.credit, p.currency),
        p.mark ? money(p.mark.unrealizedPnl, p.currency, true) : '-',
      ]),
    };
  }

  /** Today's recommended puts: name, strike, expiry, days left, delta, credit and the annualised return on collateral. */
  async scanSnapshot(): Promise<JournalSnapshotView> {
    const view = await this.scan.get({});
    return {
      kind: 'scan',
      asOf: this.asOf(),
      title: `Scan picks · ${view.asOf}`,
      columns: ['Name', 'Put', 'Exp', 'DTE', 'Delta', 'Credit', 'Ann. ROC'],
      align: ['l', 'r', 'l', 'r', 'r', 'r', 'r'],
      rows: view.ideas.map((i) => [
        i.market === 'HK' ? `${i.symbol}.HK` : i.symbol,
        price(i.contract.strike),
        shortDay(i.contract.expiry),
        String(i.contract.dte),
        i.contract.delta.toFixed(2),
        money(i.contract.credit, i.currency),
        `${i.contract.annRocPct.toFixed(1)}%`,
      ]),
    };
  }

  /** Positions and scan as short lines for the model. A part that cannot be read is left out and said so. */
  async contextBlock(): Promise<SnapshotContext> {
    const lines: string[] = [];
    const parts: string[] = [];
    try {
      const open = (await this.positions.list()).open;
      lines.push(`Open positions (from the app, ${this.asOf()}):`);
      if (open.length === 0) lines.push('- none');
      for (const p of open)
        lines.push(
          `- ${p.market === 'HK' ? `${p.symbol}.HK` : p.symbol} put ${price(p.strike)} exp ${p.expiry} x${p.quantity}, ${p.dte} DTE` +
            (p.mark ? `, P&L ${money(p.mark.unrealizedPnl, p.currency, true)}` : ''),
        );
      parts.push(`${open.length} position${open.length === 1 ? '' : 's'}`);
    } catch {
      lines.push('Open positions: not available.');
    }
    try {
      const scan: ScanView = await this.scan.get({});
      lines.push(`Today's scan (${scan.asOf}):`);
      for (const i of scan.ideas)
        lines.push(
          `- ${i.market === 'HK' ? `${i.symbol}.HK` : i.symbol} put ${price(i.contract.strike)} exp ${i.contract.expiry}, delta ${i.contract.delta.toFixed(2)}: recommended`,
        );
      for (const r of scan.rejected.slice(0, 12))
        lines.push(`- ${r.market === 'HK' ? `${r.symbol}.HK` : r.symbol}: not recommended (${r.bindingRule})`);
      parts.push(`scan ${scan.asOf}`);
    } catch {
      lines.push("Today's scan: not available.");
    }
    return { text: lines.join('\n'), summary: parts.length > 0 ? `today's ${parts.join(', ')}` : 'none available' };
  }
}
