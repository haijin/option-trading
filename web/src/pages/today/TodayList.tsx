import type { IdeaView, LeadersCardView, Market, RejectStatus, RejectView, ScanView } from '../../api/types';
import { Chip, PriceSourceChip, TierChip, ValueChip } from '../../components/Chip';
import { ScoreBar } from '../../components/Stars';
import { contractLabel, currencyPrefix, n0, pct } from '../../lib/format';
import { toHash } from '../../lib/route';
import { stockKey } from '../../lib/symbols';
import { LeadersTodayCard } from '../leaders/LeadersTodayCard';

export type Selectable = { kind: 'idea'; idea: IdeaView } | { kind: 'reject'; reject: RejectView };

export function selectableKey(item: Selectable): string {
  return item.kind === 'idea'
    ? stockKey(item.idea.market, item.idea.symbol)
    : stockKey(item.reject.market, item.reject.symbol);
}

/** Ranked within each market and never merged across markets; rejects follow. This is also the keyboard order. */
export function orderedSelectables(scan: ScanView): Selectable[] {
  const byMarket = (market: Market) =>
    scan.ideas
      .filter((idea) => idea.market === market)
      .sort((a, b) => a.rank - b.rank)
      .map((idea): Selectable => ({ kind: 'idea', idea }));
  return [
    ...byMarket('US'),
    ...byMarket('HK'),
    ...scan.rejected.map((reject): Selectable => ({ kind: 'reject', reject })),
  ];
}

const REJECT_LABEL: Record<RejectStatus, string> = {
  dropped_stale: 'stale',
  failed: 'FAIL',
  excluded: 'excluded',
  cut: 'cut',
  no_contract: 'no contract',
};

function IdeaRow({ idea, selected, onSelect }: { idea: IdeaView; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={`lrow${selected ? ' sel' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <span className="s">
        {idea.symbol}
        <small>{idea.name ?? ''}</small>
      </span>
      <span className="mono">{contractLabel(idea.contract.expiry, idea.contract.strike)}</span>
      <span className="num">
        <b>{pct(idea.contract.annRocPct)}</b>
      </span>
      <span className="sub">
        {n0(idea.composite)} score <ScoreBar score={idea.composite} />
        <TierChip tier={idea.tier} />
        <PriceSourceChip source={idea.contract.priceSource} />
        {idea.ruleWarns.length > 0 ? (
          <Chip kind="warn" title={idea.ruleWarns.join(', ')}>
            WARN:{idea.ruleWarns.length}
          </Chip>
        ) : null}
        {idea.staleTagged ? <Chip kind="fail">STALE</Chip> : null}
        <ValueChip value={idea.value} />
      </span>
    </button>
  );
}

function RejectRow({ reject, selected, onSelect }: { reject: RejectView; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={`lrow${selected ? ' sel' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <span className="s">
        {reject.symbol}
        <small>{reject.name ?? ''}</small>
      </span>
      <span />
      <span>
        <Chip kind="fail">{REJECT_LABEL[reject.status]}</Chip>
      </span>
      <span className="sub mono">{reject.bindingRule}</span>
    </button>
  );
}

/** Left pane: US shortlist, HK shortlist, Not recommended, Excluded (open put), and what is still waiting for data. */
export function TodayList({
  scan,
  selectedKey,
  onSelect,
  refreshing,
  leaders,
}: {
  scan: ScanView;
  selectedKey: string | null;
  onSelect: (item: Selectable) => void;
  refreshing: boolean;
  /** The Leaders card from the overview; null (or absent) until a leaders scan has run. */
  leaders?: LeadersCardView | null;
}) {
  const items = orderedSelectables(scan);
  const ideas = (market: Market) =>
    items.filter(
      (item): item is Extract<Selectable, { kind: 'idea' }> => item.kind === 'idea' && item.idea.market === market,
    );
  const rejects = items.filter((item): item is Extract<Selectable, { kind: 'reject' }> => item.kind === 'reject');

  return (
    <section className="list" aria-label="Today's shortlist">
      <LeadersTodayCard card={leaders} />
      <div className="gh">
        <span>
          Scan as of {scan.asOf}
          {refreshing ? <span className="refreshing"> &middot; refreshing...</span> : null}
        </span>
        <span title={`${scan.stats.computed} computed, ${scan.stats.cacheHits} cached`}>{scan.paramsLabel}</span>
      </div>

      {scan.waitingForData.length > 0 ? (
        <div className="callout blue" style={{ margin: 10 }}>
          <span>
            <b>Waiting for data:</b> {scan.waitingForData.map((w) => w.symbol).join(', ')}. Run an ingest to fetch them
            first.
          </span>
          <a className="btn sm" href={toHash({ page: 'data' })}>
            Run ingest
          </a>
        </div>
      ) : null}

      {(['US', 'HK'] as const).map((market) => {
        const rows = ideas(market);
        return (
          <section key={market} aria-label={`${market} shortlist`}>
            <div className="gh">
              <span>
                {market} shortlist &middot; {rows.length}
              </span>
              <span>{currencyPrefix(market === 'US' ? 'USD' : 'HKD')} per contract</span>
            </div>
            {rows.length === 0 ? <div className="list-empty">no recommendations in this market today</div> : null}
            {rows.map((item) => (
              <IdeaRow
                key={selectableKey(item)}
                idea={item.idea}
                selected={selectableKey(item) === selectedKey}
                onSelect={() => onSelect(item)}
              />
            ))}
          </section>
        );
      })}

      <section aria-label="Not recommended">
        <div className="gh">
          <span>Not recommended &middot; {rejects.length}</span>
          <span>binding rule</span>
        </div>
        {rejects.length === 0 ? <div className="list-empty">nothing was rejected</div> : null}
        {rejects.map((item) => (
          <RejectRow
            key={selectableKey(item)}
            reject={item.reject}
            selected={selectableKey(item) === selectedKey}
            onSelect={() => onSelect(item)}
          />
        ))}
      </section>

      {scan.openNames.length > 0 ? (
        <section aria-label="Excluded: open put">
          <div className="gh">
            <span>Excluded: open put &middot; {scan.openNames.length}</span>
            <span>blocked from new ideas</span>
          </div>
          {scan.openNames.map((name) => (
            <div className="lrow static" key={stockKey(name.market, name.symbol)}>
              <span className="s">
                {name.symbol}
                <small>{name.name ?? ''}</small>
              </span>
              <span />
              <span className="muted">
                {name.contracts} {name.contracts === 1 ? 'contract' : 'contracts'}
              </span>
            </div>
          ))}
        </section>
      ) : null}

      {scan.pasteChainsFor.length > 0 ? (
        <p className="note" style={{ padding: '10px 12px 24px' }}>
          Paste a broker chain for {scan.pasteChainsFor.map((p) => p.symbol).join(', ')} to replace modelled prices with
          real quotes.
        </p>
      ) : null}
    </section>
  );
}
