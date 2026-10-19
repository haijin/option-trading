import { type FormEvent, useState } from 'react';
import { api } from '../api/endpoints';
import type { ChainImportView, Market } from '../api/types';
import { useMutation } from '../hooks/useMutation';
import { parseNumber, todayIso, volText } from '../lib/format';
import { useDataVersion } from '../state/dataVersion';
import { useToast } from '../state/toast';
import { Callout } from './Callout';
import { Field } from './Field';
import { Modal } from './Modal';

const PLACEHOLDER = 'expiry,strike,right,bid,ask,last,volume,oi\n2026-10-29,395,P,3.55,3.90,3.70,120,840';

/** Paste an option chain copied from the broker (POST /api/chains/import); line-numbered errors are shown verbatim. */
export function PasteChainModal({
  symbol: initialSymbol,
  market,
  spot,
  date,
  onClose,
}: {
  symbol: string;
  market: Market;
  spot?: number;
  date?: string;
  onClose: () => void;
}) {
  const mutation = useMutation();
  const toast = useToast();
  const { bump } = useDataVersion();
  const [symbol, setSymbol] = useState(initialSymbol);
  const [spotText, setSpotText] = useState(spot !== undefined ? String(spot) : '');
  const [dateText, setDateText] = useState(date ?? todayIso());
  const [csv, setCsv] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<ChainImportView | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const spotValue = parseNumber(spotText);
    if (symbol.trim() === '') return setFormError('Enter a symbol.');
    if (spotValue === null || spotValue <= 0) return setFormError('Spot price must be above 0.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return setFormError('Date as YYYY-MM-DD.');
    if (csv.trim() === '') return setFormError('Paste the chain rows first.');
    setFormError(null);
    const view = await mutation.run(
      () => api.importChain({ symbol: symbol.trim().toUpperCase(), market, csv, spot: spotValue, date: dateText }),
      { inlineError: true, bump: false },
    );
    if (!view) return;
    setResult(view);
    if (view.ok) {
      // Only a stored chain changes what the scan shows, so only then refresh the data.
      toast.push(`Chain stored for ${symbol.trim().toUpperCase()}: ${view.stored} rows.`);
      bump();
    }
  };

  return (
    <Modal
      title={`Paste an option chain (${initialSymbol})`}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="submit" form="chain-form" className="btn primary" disabled={mutation.busy}>
            {mutation.busy ? 'Importing...' : 'Import'}
          </button>
        </>
      }
    >
      <form id="chain-form" className="stack" onSubmit={submit} noValidate>
        <div className="grid3">
          <Field label="Symbol">
            <input value={symbol} onChange={(e) => setSymbol(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Spot price">
            <input inputMode="decimal" value={spotText} onChange={(e) => setSpotText(e.target.value)} />
          </Field>
          <Field label="Date">
            <input type="date" value={dateText} onChange={(e) => setDateText(e.target.value)} />
          </Field>
        </div>
        <Field label="Paste rows from your broker (CSV: expiry, strike, right, bid, ask, last, volume, oi, optional iv and delta)">
          <textarea
            rows={8}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={PLACEHOLDER}
            spellCheck={false}
          />
        </Field>
        {formError ? (
          <Callout kind="fail" role="alert">
            {formError}
          </Callout>
        ) : null}
        {mutation.error ? (
          <Callout kind="fail" role="alert">
            {mutation.error.message}
          </Callout>
        ) : null}
        {result ? <ChainResult result={result} /> : null}
      </form>
    </Modal>
  );
}

function ChainResult({ result }: { result: ChainImportView }) {
  return (
    <div className="stack" aria-live="polite">
      {result.ok ? (
        <Callout kind="ok">
          Stored {result.stored} rows across {result.expiries.length}{' '}
          {result.expiries.length === 1 ? 'expiry' : 'expiries'}
          {result.iv30 !== null ? `, 30-day IV ${volText(result.iv30)}` : ''}. The price switches from synthetic to this
          chain at the next scan.
        </Callout>
      ) : (
        <Callout kind="fail" role="alert">
          <b>Nothing was stored.</b> Fix these lines and import again.
        </Callout>
      )}
      {result.errors.length > 0 ? (
        <ul className="mono" style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
          {result.errors.map((line) => (
            <li key={line} className="neg">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      {result.warnings.length > 0 ? (
        <ul className="mono" style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
          {result.warnings.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
