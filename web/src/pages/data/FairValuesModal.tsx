import { type FormEvent, useState } from 'react';
import { api } from '../../api/endpoints';
import type { FairValueImportView } from '../../api/types';
import { Callout } from '../../components/Callout';
import { CsvInput } from '../../components/CsvInput';
import { Field } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { useMutation } from '../../hooks/useMutation';

/** Imports Morningstar fair values from the Invest-agent CSV (POST /api/fair-values/import). */
export function FairValuesModal({ onClose }: { onClose: () => void }) {
  const mutation = useMutation();
  const [csv, setCsv] = useState('');
  const [asOf, setAsOf] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FairValueImportView | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (csv.trim() === '') return setError('Choose a file or paste the CSV first.');
    if (asOf !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(asOf))
      return setError('As-of date as YYYY-MM-DD, or leave it blank.');
    setError(null);
    const view = await mutation.run(() => api.importFairValues(asOf ? { csv, asOf } : { csv }), {
      inlineError: true,
      success: (v) => `Fair values imported: ${v.matched} matched, ${v.unmatched.length} not on your watchlist.`,
    });
    if (view) setResult(view);
  };

  return (
    <Modal
      title="Import fair values CSV"
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="submit" form="fair-form" className="btn primary" disabled={mutation.busy}>
            {mutation.busy ? 'Importing...' : 'Import'}
          </button>
        </>
      }
    >
      <form id="fair-form" className="stack" onSubmit={submit} noValidate>
        <p className="muted">
          Morningstar fair values come from a CSV made by the Invest-agent tool (this app does not scrape Morningstar).
          They add one more method to the intrinsic value of US names.
        </p>
        <CsvInput
          label="Fair values CSV"
          value={csv}
          onChange={setCsv}
          placeholder="symbol,market,fair_value,moat,uncertainty"
        />
        <Field label="As of (optional, defaults to the file's date)" style={{ maxWidth: 220 }}>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
        {error ? (
          <Callout kind="fail" role="alert">
            {error}
          </Callout>
        ) : null}
        {mutation.error ? (
          <Callout kind="fail" role="alert">
            {mutation.error.message}
          </Callout>
        ) : null}
        {result ? (
          <div className="stack" aria-live="polite">
            <Callout kind="ok">
              Matched <b>{result.matched}</b> {result.matched === 1 ? 'stock' : 'stocks'} (as of {result.asOf}).
            </Callout>
            {result.unmatched.length > 0 ? (
              <Callout>
                Not matched to a watched stock ({result.unmatched.length}):{' '}
                <span className="mono">{result.unmatched.join(', ')}</span>
              </Callout>
            ) : null}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
