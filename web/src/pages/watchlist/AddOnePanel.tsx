import { useEffect, useState } from 'react';
import { api } from '../../api/endpoints';
import type { Market, SolvencyModel, WatchEntryView, WatchPreviewView } from '../../api/types';
import { Callout, ErrorBanner } from '../../components/Callout';
import { Chip } from '../../components/Chip';
import { Field } from '../../components/Field';
import { useDebounced } from '../../hooks/useDebounced';
import { useMutation } from '../../hooks/useMutation';
import { useResource } from '../../hooks/useResource';
import { parseNumber } from '../../lib/format';
import { toHash } from '../../lib/route';
import { SOLVENCY_OPTIONS } from './options';

export const PREVIEW_DEBOUNCE_MS = 250;

/** The card under the symbol box: canonical symbol, Yahoo symbol, name, and what happens if you add it. */
function PreviewCard({
  preview,
  lot,
  onLot,
  onResume,
  resuming,
}: {
  preview: WatchPreviewView;
  lot: string;
  onLot: (value: string) => void;
  onResume: () => void;
  resuming: boolean;
}) {
  if (!preview.ok) {
    return (
      <Callout kind="fail" role="alert">
        {preview.error ?? 'That symbol is not valid.'}
      </Callout>
    );
  }
  const hk = preview.market === 'HK';
  return (
    <div className="stack" data-testid="preview-card">
      <div className="row" style={{ gap: 8 }}>
        <b>{preview.symbol}</b>
        <span>{preview.name ? preview.name : <i className="muted">name filled at first ingest</i>}</span>
        {preview.market ? <Chip>{preview.market}</Chip> : null}
        <small>Yahoo symbol {preview.yahooSymbol}</small>
      </div>
      {preview.duplicate === 'watching' ? <Callout kind="blue">Already on your list and being watched.</Callout> : null}
      {preview.duplicate === 'paused' ? (
        <Callout
          action={
            <button type="button" className="btn sm" onClick={onResume} disabled={resuming}>
              Resume watching
            </button>
          }
        >
          Already on your list but paused (history kept).
        </Callout>
      ) : null}
      {hk && preview.lotSource === 'missing' ? (
        <Callout>
          <b>Not in data/hk-board-lots.csv.</b> Enter the board lot below: it is the multiplier behind every HK number.
        </Callout>
      ) : null}
      {hk ? (
        <div className="row">
          <Field label="Board lot (multiplier)" style={{ width: 190 }}>
            <input
              inputMode="numeric"
              value={lot}
              onChange={(e) => onLot(e.target.value)}
              placeholder="e.g. 500"
              required={preview.lotSource === 'missing'}
            />
          </Field>
          {preview.lotSource === 'seed_file' ? (
            <small>{preview.boardLot} from your data/hk-board-lots.csv</small>
          ) : null}
          {preview.lotSource === 'existing' ? <small>{preview.boardLot} already stored</small> : null}
        </div>
      ) : null}
    </div>
  );
}

/** "One symbol" tab: validated preview as you type (250 ms debounce), then add. */
export function AddOnePanel({ onAdded }: { onAdded: (entry: WatchEntryView) => void }) {
  const mutation = useMutation();
  const resume = useMutation();
  const ingest = useMutation();
  const [raw, setRaw] = useState('');
  const [marketChoice, setMarketChoice] = useState<'auto' | Market>('auto');
  const [lot, setLot] = useState('');
  const [conviction, setConviction] = useState('');
  const [maxPct, setMaxPct] = useState('');
  const [solvency, setSolvency] = useState<'' | SolvencyModel>('');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [added, setAdded] = useState<WatchEntryView | null>(null);

  const debounced = useDebounced(raw.trim(), PREVIEW_DEBOUNCE_MS);
  const marketParam = marketChoice === 'auto' ? undefined : marketChoice;
  const preview = useResource(
    (signal) => api.watchlistPreview(debounced, marketParam, signal),
    [debounced, marketParam],
    {
      enabled: debounced !== '',
    },
  );
  const view = debounced !== '' && raw.trim() === debounced ? preview.data : undefined;

  // A new previewed symbol brings its own board lot.
  const previewKey = preview.data ? `${preview.data.market}:${preview.data.symbol}` : '';
  const previewLot = preview.data?.boardLot ?? null;
  useEffect(() => {
    setLot(previewKey && previewLot !== null ? String(previewLot) : '');
  }, [previewKey, previewLot]);

  const reset = () => {
    setRaw('');
    setLot('');
    setConviction('');
    setMaxPct('');
    setSolvency('');
    setNotes('');
    setFormError(null);
  };

  const submit = async () => {
    if (!view?.ok || !view.symbol || !view.market) return;
    const input: Parameters<typeof api.watchlistAdd>[0] = { symbol: view.symbol, market: view.market };
    if (view.market === 'HK') {
      const lotValue = parseNumber(lot);
      if (lotValue === null || !Number.isInteger(lotValue) || lotValue <= 0) {
        return setFormError(`Enter the board lot for ${view.symbol}: a whole number above 0.`);
      }
      if (view.lotSource === 'missing' || lotValue !== view.boardLot) input.boardLot = lotValue;
    }
    const maxValue = parseNumber(maxPct);
    if (maxPct.trim() !== '') {
      if (maxValue === null || maxValue <= 0 || maxValue > 100)
        return setFormError('Max collateral must be a percentage between 0 and 100 (blank = default).');
      input.maxCollateralPct = maxValue;
    }
    if (conviction !== '') input.conviction = Number(conviction);
    if (solvency !== '') input.solvencyModel = solvency;
    if (notes.trim() !== '') input.notes = notes.trim();
    setFormError(null);
    const entry = await mutation.run(() => api.watchlistAdd(input), {
      success: `${view.symbol} added. It is fetched at the next ingest and scored at the next scan.`,
    });
    if (entry) {
      setAdded(entry);
      onAdded(entry);
      reset();
    }
  };

  const resumeNow = async () => {
    if (!view?.symbol || !view.market) return;
    const { market, symbol } = view;
    await resume.run(() => api.watchlistPatch(market, symbol, { active: true }), {
      success: `${symbol}: watching again. It is fetched and scanned from now on.`,
    });
  };

  const fetchNow = async () => {
    if (!added) return;
    const only = [{ market: added.market, symbol: added.symbol }];
    const job = await ingest.run(() => api.startIngest({ only }), {
      success: `Fetching ${added.symbol} now. Follow it on the Data page.`,
    });
    if (job) setAdded(null);
  };

  const canAdd = !!view && view.ok && view.duplicate === null && !mutation.busy;

  return (
    <div className="stack">
      {added ? (
        <Callout
          kind="ok"
          action={
            <span className="row" style={{ gap: 6 }}>
              <button type="button" className="btn sm primary" onClick={fetchNow} disabled={ingest.busy}>
                Fetch data now
              </button>
              <a className="btn sm" href={toHash({ page: 'data' })}>
                Data page
              </a>
            </span>
          }
        >
          <b>{added.symbol} added.</b> It has no prices yet: fetch it now, or it is picked up by the next ingest.
        </Callout>
      ) : null}
      <div className="row">
        <Field label="Symbol" style={{ flex: 1, minWidth: 180 }}>
          <input
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="AAPL, BRK.B, 700, 0700.HK"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Market" style={{ width: 120 }}>
          <select value={marketChoice} onChange={(e) => setMarketChoice(e.target.value as 'auto' | Market)}>
            <option value="auto">Auto</option>
            <option value="US">US</option>
            <option value="HK">HK</option>
          </select>
        </Field>
      </div>

      <div aria-live="polite" style={{ display: 'grid', gap: 8 }}>
        {raw.trim() === '' ? (
          <small className="muted">Letters for US (AAPL, BRK.B), digits for HK (700 or 0700.HK).</small>
        ) : preview.error ? (
          <ErrorBanner error={preview.error} onRetry={preview.refresh} title="Could not check that symbol." />
        ) : view ? (
          <PreviewCard preview={view} lot={lot} onLot={setLot} onResume={resumeNow} resuming={resume.busy} />
        ) : (
          <small className="muted">Checking...</small>
        )}
      </div>

      <div className="grid3">
        <Field label="Conviction (1-5)">
          <select value={conviction} onChange={(e) => setConviction(e.target.value)}>
            <option value="">not set</option>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Max collateral (% of equity)">
          <input inputMode="decimal" value={maxPct} onChange={(e) => setMaxPct(e.target.value)} placeholder="default" />
        </Field>
        <Field label="Solvency model">
          <select value={solvency} onChange={(e) => setSolvency(e.target.value as '' | SolvencyModel)}>
            <option value="">infer at first ingest</option>
            {SOLVENCY_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Why do you want to own it? (optional)">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="one line" />
      </Field>
      {formError ? (
        <Callout kind="fail" role="alert">
          {formError}
        </Callout>
      ) : null}
      <div className="row">
        <button type="button" className="btn primary" onClick={submit} disabled={!canAdd}>
          {mutation.busy ? 'Adding...' : 'Add to watchlist'}
        </button>
        <small>Fetched at the next ingest, scored at the next scan.</small>
      </div>
    </div>
  );
}
