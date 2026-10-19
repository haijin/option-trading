import type { ReactNode } from 'react';
import type { DataTier, Market, ValueBadge, Verdict, WatchStatus } from '../api/types';
import { priceOfIvText, ratioPct } from '../lib/format';

export type ChipKind = 'ok' | 'warn' | 'fail' | 'blue' | '';

export function Chip({ kind = '', title, children }: { kind?: ChipKind; title?: string; children: ReactNode }) {
  return (
    <span className={`chip ${kind}`.trim()} title={title}>
      {children}
    </span>
  );
}

export function MarketChip({ market }: { market: Market }) {
  return <Chip>{market}</Chip>;
}

const TIER_KIND: Record<DataTier, ChipKind> = { real: 'ok', proxy: 'blue', synthetic: 'warn' };

export function TierChip({ tier }: { tier: DataTier }) {
  return (
    <Chip
      kind={TIER_KIND[tier]}
      title="data tier: real = quoted data, proxy = substitute inputs, synthetic = modelled price"
    >
      {tier}
    </Chip>
  );
}

const VERDICT_KIND: Record<Verdict, ChipKind> = { PASS: 'ok', FAIL: 'fail', WARN: 'warn', NA: '' };

export function VerdictChip({ verdict }: { verdict: Verdict }) {
  return <Chip kind={VERDICT_KIND[verdict]}>{verdict}</Chip>;
}

/** Where the option price came from: a real quote, a pasted chain, or the model. */
export function PriceSourceChip({ source }: { source: string }) {
  if (source === 'synthetic') {
    return (
      <Chip kind="warn" title="no fresh chain: priced by the model">
        synthetic price
      </Chip>
    );
  }
  const labels: Record<string, string> = {
    csv: 'pasted chain',
    yahoo: 'yahoo chain',
    futu: 'futu chain',
    ibkr: 'ibkr chain',
    journal: 'journal fill',
  };
  return <Chip kind="ok">{labels[source] ?? `${source} chain`}</Chip>;
}

function ratioKind(ratio: number): ChipKind {
  if (ratio <= 0.85) return 'ok';
  if (ratio <= 1.0) return 'blue';
  return 'warn';
}

/** "cost 90% of IV" when a put is proposed, otherwise "price 83% of IV". */
export function ValueChip({ value }: { value: ValueBadge | null }) {
  if (!value) return null;
  const hasCost = value.costRatio !== null;
  const ratio = value.costRatio ?? value.priceRatio;
  const text = hasCost ? `cost ${ratioPct(ratio)} of IV` : priceOfIvText(ratio);
  return (
    <Chip kind={ratioKind(ratio)} title={`intrinsic value ${value.base.toFixed(2)} (base case)`}>
      {text}
    </Chip>
  );
}

/** Price-vs-IV badge for lists that are not about a proposed put (Research, Data). */
export function PriceVsIvChip({ badge }: { badge: ValueBadge | null }) {
  if (!badge) return <Chip>no numbers yet</Chip>;
  return (
    <Chip kind={ratioKind(badge.priceRatio)} title={`intrinsic value ${badge.base.toFixed(2)} (base case)`}>
      {priceOfIvText(badge.priceRatio)}
    </Chip>
  );
}

const STATUS_KIND: Record<WatchStatus['kind'], ChipKind> = {
  idea: 'ok',
  rejected: 'warn',
  open_put: 'blue',
  stale: 'fail',
  paused: '',
  pending_first_ingest: 'blue',
  no_data: 'warn',
  unscored: '',
};

export function StatusChip({ status }: { status: WatchStatus }) {
  return (
    <Chip kind={STATUS_KIND[status.kind]} title={status.detail ?? undefined}>
      {status.label}
    </Chip>
  );
}
