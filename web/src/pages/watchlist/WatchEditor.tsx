import { useState } from 'react';
import { api } from '../../api/endpoints';
import type { ReportingFrequency, SolvencyModel, WatchEntryView, WatchPatch } from '../../api/types';
import { AddEventModal } from '../../components/AddEventModal';
import { Callout } from '../../components/Callout';
import { Chip, MarketChip, StatusChip } from '../../components/Chip';
import { Field } from '../../components/Field';
import { Switch } from '../../components/Switch';
import { useMutation } from '../../hooks/useMutation';
import { useResource } from '../../hooks/useResource';
import { money, n0, num, parseNumber } from '../../lib/format';
import { toHash } from '../../lib/route';
import { useOverview } from '../../state/overview';
import { FREQUENCY_OPTIONS, SOLVENCY_OPTIONS } from './options';

/** Edits one stock (PATCH /api/watchlist/:market/:symbol). Only changed fields are sent. The page puts it in a dialog. */
export function WatchEditor({
  entry,
  onClose,
  onToggle,
}: {
  entry: WatchEntryView;
  onClose: () => void;
  onToggle: (next: boolean) => void;
}) {
  const mutation = useMutation();
  const overview = useOverview();
  const settings = useResource((signal) => api.settings(signal), []);
  const hk = entry.market === 'HK';
  const [lot, setLot] = useState(String(entry.boardLot));
  const [solvency, setSolvency] = useState<SolvencyModel>(entry.solvencyModel);
  const [frequency, setFrequency] = useState<ReportingFrequency>(entry.reportingFrequency);
  const [conviction, setConviction] = useState(entry.conviction === null ? '' : String(entry.conviction));
  const [maxPct, setMaxPct] = useState(entry.maxCollateralPct === null ? '' : String(entry.maxCollateralPct));
  const [notes, setNotes] = useState(entry.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [eventModal, setEventModal] = useState(false);

  const equity = overview.data?.equity ?? null;
  const base = overview.data?.baseCurrency ?? 'HKD';
  const defaultPct = settings.data?.perNameCapPct;
  const maxValue = parseNumber(maxPct);
  const maxHint =
    maxValue !== null && equity !== null
      ? `${money((equity * maxValue) / 100, base)} of notional`
      : equity !== null && defaultPct !== undefined
        ? `default ${num(defaultPct, 0, 1)}% = ${money((equity * defaultPct) / 100, base)}`
        : 'blank = the default cap';

  const save = async () => {
    const patch: WatchPatch = {};
    if (hk) {
      const lotValue = parseNumber(lot);
      if (lotValue === null || !Number.isInteger(lotValue) || lotValue <= 0)
        return setError('Board lot must be a whole number above 0.');
      if (lotValue !== entry.boardLot) patch.boardLot = lotValue;
    }
    if (maxPct.trim() !== '' && (maxValue === null || maxValue <= 0 || maxValue > 100)) {
      return setError('Max collateral must be a percentage between 0 and 100 (blank = default).');
    }
    const newMax = maxPct.trim() === '' ? null : maxValue;
    if (newMax !== entry.maxCollateralPct) patch.maxCollateralPct = newMax;
    if (solvency !== entry.solvencyModel) patch.solvencyModel = solvency;
    if (frequency !== entry.reportingFrequency) patch.reportingFrequency = frequency;
    const newConviction = conviction === '' ? null : Number(conviction);
    if (newConviction !== entry.conviction) patch.conviction = newConviction;
    const newNotes = notes.trim() === '' ? null : notes.trim();
    if (newNotes !== (entry.notes ?? null)) patch.notes = newNotes;
    setError(null);
    if (Object.keys(patch).length === 0) return;
    await mutation.run(() => api.watchlistPatch(entry.market, entry.symbol, patch), {
      success: `${entry.symbol} saved.${newMax !== null && newMax > 10 ? ' Note: above 10% of equity on one name is concentrated.' : ''}`,
    });
  };

  return (
    <>
      <div className="stack">
        <div className="row" style={{ gap: 6 }}>
          <MarketChip market={entry.market} />
          <StatusChip status={entry.status} />
        </div>
        <div className="row">
          <Switch checked={entry.active} onChange={onToggle} label={`Watching ${entry.symbol}`} />
          <b>{entry.active ? 'Watching' : 'Not watching'}</b>
          <small>
            {entry.active
              ? 'fetched at ingest, ranked at scan, offered in Research'
              : 'skipped by everything; history is kept, resume any time'}
          </small>
        </div>
        {entry.hasOpenPut ? (
          <Callout kind="blue">
            <b>Open put on {entry.symbol}.</b> No new idea is made while it is open
            {entry.active ? '' : '; it is still tracked on Positions even though you stopped watching it'}.{' '}
            <a href={toHash({ page: 'positions' })}>Positions</a>
          </Callout>
        ) : null}
        <div className="grid2">
          <Field
            label="Board lot / multiplier"
            hint={hk ? 'from data/hk-board-lots.csv; edit to override' : 'US contracts are 100 shares'}
          >
            <input inputMode="numeric" value={lot} onChange={(e) => setLot(e.target.value)} disabled={!hk} />
          </Field>
          <Field
            label="Solvency model"
            hint={entry.solvencyInferred ? 'inferred from the sector at first ingest unless you set it' : 'set by you'}
          >
            <select value={solvency} onChange={(e) => setSolvency(e.target.value as SolvencyModel)}>
              {SOLVENCY_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reporting frequency">
            <select value={frequency} onChange={(e) => setFrequency(e.target.value as ReportingFrequency)}>
              {FREQUENCY_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Conviction (1-5)" hint="your own prior; a small weight in the ranking">
            <select value={conviction} onChange={(e) => setConviction(e.target.value)}>
              <option value="">not set</option>
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Max collateral for this stock (% of equity)" hint={maxHint}>
            <input
              inputMode="decimal"
              value={maxPct}
              onChange={(e) => setMaxPct(e.target.value)}
              placeholder="default"
            />
          </Field>
          <div className="stack" style={{ gap: 4 }}>
            <small>Next results date</small>
            <div className="row" style={{ gap: 8 }}>
              {entry.nextEarnings ? (
                <span>
                  {entry.nextEarnings.date}{' '}
                  <small>
                    ({entry.nextEarnings.confirmed ? 'confirmed' : 'estimated'}, {entry.nextEarnings.source})
                  </small>
                </span>
              ) : (
                <Chip kind="warn">none on file</Chip>
              )}
              <button type="button" className="btn sm" onClick={() => setEventModal(true)}>
                {entry.nextEarnings ? 'Change date' : 'Add date'}
              </button>
            </div>
          </div>
        </div>
        <Field label="Why do I want to own it?">
          <textarea className="prose" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {error ? (
          <Callout kind="fail" role="alert">
            {error}
          </Callout>
        ) : null}
        <div className="row">
          <button type="button" className="btn primary" onClick={save} disabled={mutation.busy}>
            {mutation.busy ? 'Saving...' : 'Save'}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <div className="sp" />
          <small>
            {entry.symbol} &middot; added {entry.addedAt.slice(0, 10)} &middot; {n0(entry.boardLot)} per contract
          </small>
        </div>
      </div>
      {eventModal ? (
        <AddEventModal symbol={entry.symbol} market={entry.market} onClose={() => setEventModal(false)} />
      ) : null}
    </>
  );
}
