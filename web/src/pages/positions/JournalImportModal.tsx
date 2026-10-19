import { type FormEvent, useState } from 'react';
import { api } from '../../api/endpoints';
import type { JournalImportView } from '../../api/types';
import { Callout } from '../../components/Callout';
import { CsvInput } from '../../components/CsvInput';
import { Modal } from '../../components/Modal';
import { useMutation } from '../../hooks/useMutation';
import { useDataVersion } from '../../state/dataVersion';
import { useToast } from '../../state/toast';

const HEADER =
  'open_date,symbol,market,expiry,strike,multiplier,contracts,credit,open_fees,close_date,close_price,close_fees,outcome,rolled_to_row';

/** Imports a trade journal CSV (POST /api/journal/import). A file with any rule violation stores nothing and lists the lines. */
export function JournalImportModal({ onClose }: { onClose: () => void }) {
  const mutation = useMutation();
  const toast = useToast();
  const { bump } = useDataVersion();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<JournalImportView | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (csv.trim() === '') return setFormError('Choose a file or paste the CSV first.');
    setFormError(null);
    const view = await mutation.run(() => api.importJournal({ csv }), { inlineError: true, bump: false });
    if (!view) return;
    setResult(view);
    if (view.ok) {
      toast.push(`Journal imported: ${view.imported} new, ${view.skippedExisting} already there.`);
      bump();
    }
  };

  return (
    <Modal
      title="Import journal CSV"
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="submit" form="journal-form" className="btn primary" disabled={mutation.busy}>
            {mutation.busy ? 'Importing...' : 'Import'}
          </button>
        </>
      }
    >
      <form id="journal-form" className="stack" onSubmit={submit} noValidate>
        <p className="muted">
          Your past trades become ground truth for calibration. A file with any rule violation is rejected with line
          numbers and nothing is stored. Importing the same file twice is safe.
        </p>
        <CsvInput label="Journal CSV" value={csv} onChange={setCsv} placeholder={HEADER} />
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
        {result ? <JournalResult result={result} /> : null}
      </form>
    </Modal>
  );
}

function JournalResult({ result }: { result: JournalImportView }) {
  return (
    <div className="stack" aria-live="polite">
      {result.ok ? (
        <Callout kind="ok">
          Imported {result.imported} {result.imported === 1 ? 'trade' : 'trades'}; {result.skippedExisting} already
          stored; {result.quotesWritten} spot quotes written.
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
      {result.totals.length > 0 ? (
        <div>
          <h4>Totals (compare with your broker statement)</h4>
          <ul className="mono" style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>
            {result.totals.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.warnings.length > 0 ? (
        <div>
          <h4>Warnings</h4>
          <ul className="mono" style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>
            {result.warnings.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
