import { type FormEvent, useState } from 'react';
import { api } from '../api/endpoints';
import type { EventAddInput, Market } from '../api/types';
import { useMutation } from '../hooks/useMutation';
import { Callout } from './Callout';
import { Field } from './Field';
import { Modal } from './Modal';

const TYPES: { id: EventAddInput['type']; label: string }[] = [
  { id: 'earnings', label: 'Results (earnings)' },
  { id: 'ex_dividend', label: 'Ex-dividend' },
  { id: 'agm', label: 'Shareholder meeting (AGM)' },
  { id: 'rights_issue', label: 'Rights issue' },
  { id: 'spin_off', label: 'Spin-off' },
  { id: 'split', label: 'Split' },
  { id: 'index_rebalance', label: 'Index rebalance' },
  { id: 'other', label: 'Other' },
];

/** Adds a dated event for a stock (POST /api/events); the results date is what the earnings rule needs. */
export function AddEventModal({
  symbol,
  market,
  type = 'earnings',
  onClose,
}: {
  symbol: string;
  market: Market;
  type?: EventAddInput['type'];
  onClose: () => void;
}) {
  const mutation = useMutation();
  const [eventType, setEventType] = useState<EventAddInput['type']>(type);
  const [date, setDate] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError('Date as YYYY-MM-DD.');
    setError(null);
    const result = await mutation.run(() => api.addEvent({ symbol, market, type: eventType, date, confirmed }), {
      success: `${symbol}: ${eventType === 'earnings' ? 'results date' : 'event'} saved for ${date}.`,
      inlineError: true,
    });
    if (result) onClose();
  };

  return (
    <Modal
      title={`Add a date for ${symbol}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="event-form" className="btn primary" disabled={mutation.busy}>
            {mutation.busy ? 'Saving...' : 'Save date'}
          </button>
        </>
      }
    >
      <form id="event-form" className="stack" onSubmit={submit} noValidate>
        <p className="muted">
          HK results dates are often missing from free data. Without one, the earnings rule cannot protect the contract,
          so the scan shows a warning.
        </p>
        {mutation.error ? (
          <Callout kind="fail" role="alert">
            {mutation.error.message}
          </Callout>
        ) : null}
        <div className="grid2">
          <Field label="What">
            <select value={eventType} onChange={(e) => setEventType(e.target.value as EventAddInput['type'])}>
              {TYPES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date" error={error}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>The company has confirmed this date</span>
        </label>
      </form>
    </Modal>
  );
}
