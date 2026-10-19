import { useState } from 'react';
import { api } from '../../api/endpoints';
import type { WatchPasteRow } from '../../api/types';
import { Callout, ErrorBanner } from '../../components/Callout';
import { Chip, type ChipKind } from '../../components/Chip';
import { Field } from '../../components/Field';
import { useDebounced } from '../../hooks/useDebounced';
import { useMutation } from '../../hooks/useMutation';
import { useResource } from '../../hooks/useResource';
import { tokenizeSymbols } from '../../lib/symbols';

const RESULT: Record<WatchPasteRow['result'], { text: string; kind: ChipKind }> = {
  new: { text: 'new', kind: 'ok' },
  resume: { text: 'paused: will resume', kind: 'blue' },
  already_watching: { text: 'already watching', kind: '' },
  invalid: { text: 'invalid', kind: 'fail' },
  lot_unknown: { text: 'lot unknown: set it after', kind: 'warn' },
};

/** "Paste a list" tab: preview every symbol (no changes), then add the valid ones. */
export function AddPastePanel() {
  const mutation = useMutation();
  const [text, setText] = useState('');
  const debounced = useDebounced(text, 300);
  const hasSymbols = tokenizeSymbols(debounced).length > 0;
  const preview = useResource((signal) => api.watchlistPaste(debounced, false, signal), [debounced], {
    enabled: hasSymbols,
  });
  const rows = hasSymbols && debounced === text ? preview.data?.rows : undefined;
  const validCount = rows?.filter((row) => row.ok).length ?? 0;

  const apply = async () => {
    const view = await mutation.run(() => api.watchlistPaste(text, true), {
      success: (v) => `${v.added} added, ${v.resumed} resumed, ${v.skipped} already watching, ${v.invalid} invalid.`,
    });
    if (view) setText('');
  };

  return (
    <div className="stack">
      <Field label="One per line, or separated by commas or spaces. Optional prefix: HK:0005, US:MSFT">
        <textarea
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'AAPL, MSFT\n0005\n3690.HK'}
          spellCheck={false}
        />
      </Field>
      <div aria-live="polite" className="stack">
        {!hasSymbols ? <small className="muted">Paste symbols to preview them.</small> : null}
        {preview.error && hasSymbols ? (
          <ErrorBanner error={preview.error} onRetry={preview.refresh} title="Could not preview the list." />
        ) : null}
        {rows ? (
          <div style={{ overflow: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Entered</th>
                  <th>Symbol</th>
                  <th>Mkt</th>
                  <th>Name</th>
                  <th className="num">Lot</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.raw}>
                    <td className="mono">{row.raw}</td>
                    <td>{row.ok && row.symbol ? <b>{row.symbol}</b> : null}</td>
                    <td>{row.market ?? ''}</td>
                    <td>
                      {row.ok ? (
                        row.name || <span className="faint">filled at first ingest</span>
                      ) : (
                        <span className="neg">{row.error}</span>
                      )}
                    </td>
                    <td className="num">
                      {row.ok && row.boardLot !== null ? row.boardLot : row.ok && row.market === 'HK' ? '?' : ''}
                    </td>
                    <td>
                      <Chip kind={RESULT[row.result].kind}>{RESULT[row.result].text}</Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : hasSymbols ? (
          <small className="muted">Checking...</small>
        ) : null}
      </div>
      {rows?.some((row) => row.result === 'lot_unknown') ? (
        <Callout>
          HK names marked "lot unknown" are not in your board-lot file: set the real board lot in the editor after
          adding them.
        </Callout>
      ) : null}
      <div className="row">
        <button type="button" className="btn primary" onClick={apply} disabled={validCount === 0 || mutation.busy}>
          {mutation.busy ? 'Adding...' : 'Add valid symbols'}
        </button>
        <small>Names already on the list are skipped; paused ones are resumed.</small>
      </div>
    </div>
  );
}
