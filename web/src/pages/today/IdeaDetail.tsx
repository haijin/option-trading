import { useState } from 'react';
import type { IdeaView } from '../../api/types';
import { AddEventModal } from '../../components/AddEventModal';
import { AskSheet } from '../../components/AskSheet';
import { Callout } from '../../components/Callout';
import { Chip, MarketChip, TierChip } from '../../components/Chip';
import { LogFillModal } from '../../components/LogFillModal';
import { KvGrid } from '../../components/Panel';
import { PasteChainModal } from '../../components/PasteChainModal';
import { Tabs } from '../../components/Tabs';
import { money, n2, pct, ratioPct, volText } from '../../lib/format';
import { toHash } from '../../lib/route';
import { prefillContracts } from '../../lib/ticket';
import { ChartTab, DETAIL_TABS, type DetailTab, ReasonsTab, SkillsTab, ValueTab } from './DetailTabs';
import { TicketBar } from './TicketBar';

type ModalKind = 'fill' | 'chain' | 'event' | 'ask' | null;

/** Chips in the Ask sheet of an idea: the questions a put seller asks before a fill. */
export const IDEA_QUESTIONS = [
  'Why this put?',
  'Is the IV worth selling?',
  'What would make the app drop it?',
  'Results risk?',
];

/** Full view of one recommendation: ticket, stat grid, data callouts and the four tabs. */
export function IdeaDetail({
  idea,
  asOf,
  tab,
  onTab,
}: {
  idea: IdeaView;
  asOf: string;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
}) {
  const [modal, setModal] = useState<ModalKind>(null);
  const { contract, sizing } = idea;
  const cur = idea.currency;
  const close = () => setModal(null);
  const quote = [
    contract.bid !== null && contract.ask !== null ? `bid ${n2(contract.bid)} / ask ${n2(contract.ask)}` : null,
    contract.iv !== null ? `IV ${volText(contract.iv)}` : null,
    contract.probItm !== null ? `P(ITM) ${ratioPct(contract.probItm)}` : null,
    contract.expectedValue !== null ? `expected value ${money(contract.expectedValue, cur)}` : null,
  ].filter((part): part is string => part !== null);

  return (
    <>
      <div className="dh">
        <h2>{idea.symbol}</h2>
        <span className="muted">{idea.name ?? ''}</span>
        <MarketChip market={idea.market} />
        {idea.sector ? <Chip>{idea.sector}</Chip> : null}
        <TierChip tier={idea.tier} />
        <div className="sp" />
        <span className="muted">composite</span> <b style={{ fontSize: 18 }}>{idea.composite.toFixed(1)}</b>
        <button type="button" className="btn sm" onClick={() => setModal('ask')}>
          Ask
        </button>
        <a className="btn sm" href={toHash({ page: 'research', market: idea.market, symbol: idea.symbol })}>
          Research &amp; run skills &rarr;
        </a>
      </div>

      <TicketBar idea={idea} onLogFill={() => setModal('fill')} />

      <KvGrid
        items={[
          { label: 'Credit', value: money(contract.credit, cur) },
          { label: 'Collateral', value: money(contract.collateral, cur) },
          { label: 'Ann. return', value: pct(contract.annRocPct) },
          { label: 'Cushion', value: pct(contract.cushionPct) },
          { label: 'Delta', value: n2(Math.abs(contract.delta)) },
          { label: 'DTE', value: contract.dte },
          { label: 'Breakeven', value: n2(contract.breakeven) },
          {
            label: 'Size',
            value: sizing ? (
              <>
                {sizing.contracts} <small>({pct(sizing.pctOfEquity)} eq.)</small>
              </>
            ) : (
              <small>not sized</small>
            ),
          },
        ]}
      />
      {quote.length > 0 || (sizing && sizing.capsHit.length > 0) ? (
        <p className="note" style={{ margin: 0 }}>
          {quote.join(' · ')}
          {sizing && sizing.capsHit.length > 0
            ? `${quote.length > 0 ? ' · ' : ''}size limited by ${sizing.capsHit.join(', ')}`
            : ''}
        </p>
      ) : null}

      {idea.staleTagged ? (
        <Callout kind="fail">
          <b>STALE.</b> This idea is ranked on data that is behind the last session. Run an ingest before relying on it.
        </Callout>
      ) : null}
      {contract.priceSource === 'synthetic' ? (
        <Callout
          action={
            <button type="button" className="btn sm" onClick={() => setModal('chain')}>
              Paste chain...
            </button>
          }
        >
          <b>Prices are synthetic.</b> No fresh option chain, so the credit is a model price with haircuts. Paste your
          broker's chain to get a real quote.
        </Callout>
      ) : null}
      {idea.nextEarnings === null ? (
        <Callout
          action={
            <button type="button" className="btn sm" onClick={() => setModal('event')}>
              Add date
            </button>
          }
        >
          <b>No results date known</b> for {idea.symbol}. HK dates are often missing from free data.
        </Callout>
      ) : null}

      <Tabs tabs={DETAIL_TABS} value={tab} onChange={onTab} label="Idea sections" />
      {tab === 'reasons' ? <ReasonsTab narrative={idea.narrative} reasons={idea.reasons} skills={idea.skills} /> : null}
      {tab === 'chart' ? <ChartTab market={idea.market} symbol={idea.symbol} /> : null}
      {tab === 'value' ? <ValueTab market={idea.market} symbol={idea.symbol} /> : null}
      {tab === 'skills' ? <SkillsTab skills={idea.skills} /> : null}
      <p className="note">As of {asOf}. Backtest results for the whole watchlist are on the Backtests page.</p>

      {modal === 'fill' ? (
        <LogFillModal
          onClose={close}
          prefill={{
            symbol: idea.symbol,
            market: idea.market,
            expiry: contract.expiry,
            strike: contract.strike,
            contracts: prefillContracts(idea),
            price: contract.premium,
            spot: idea.spot,
          }}
        />
      ) : null}
      {modal === 'chain' ? (
        <PasteChainModal symbol={idea.symbol} market={idea.market} spot={idea.spot} onClose={close} />
      ) : null}
      {modal === 'event' ? <AddEventModal symbol={idea.symbol} market={idea.market} onClose={close} /> : null}
      {modal === 'ask' ? (
        <AskSheet
          target={{ kind: 'idea', market: idea.market, symbol: idea.symbol }}
          title={`Ask about ${idea.symbol}`}
          suggestions={IDEA_QUESTIONS}
          onClose={close}
        />
      ) : null}
    </>
  );
}
