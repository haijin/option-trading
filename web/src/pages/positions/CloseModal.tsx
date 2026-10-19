import { type FormEvent, useState } from 'react';
import { api } from '../../api/endpoints';
import type { PositionCloseInput, PositionView } from '../../api/types';
import { Callout } from '../../components/Callout';
import { Field } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { useMutation } from '../../hooks/useMutation';
import { contractLabel, parseNumber, signedMoney, todayIso } from '../../lib/format';

type Kind = PositionCloseInput['kind'];

const KINDS: { id: Kind; label: string; help: string }[] = [
  { id: 'bought_back', label: 'Bought back', help: 'You bought the put back before expiry.' },
  { id: 'expired', label: 'Expired', help: 'It expired worthless: you keep the whole credit.' },
  {
    id: 'assigned',
    label: 'Assigned',
    help: 'You were assigned the shares: the loss is booked from the underlying close.',
  },
];

/** Closes an open put: bought back, expired, or assigned (POST /api/positions/:id/close). */
export function CloseModal({ position, onClose }: { position: PositionView; onClose: () => void }) {
  const mutation = useMutation();
  const [kind, setKind] = useState<Kind>('bought_back');
  const [price, setPrice] = useState('');
  const [underlying, setUnderlying] = useState(position.spot !== null ? String(position.spot) : '');
  const [date, setDate] = useState(todayIso());
  const [fees, setFees] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const input: PositionCloseInput = { kind, date };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError('Date as YYYY-MM-DD.');
    if (kind === 'bought_back') {
      const value = parseNumber(price);
      if (value === null || value < 0) return setError('Enter the buy-back premium per share (0 or more).');
      input.price = value;
    }
    if (kind === 'assigned') {
      const value = parseNumber(underlying);
      if (value === null || value <= 0) return setError('Enter the underlying close on assignment day.');
      input.underlyingClose = value;
    }
    const feesValue = parseNumber(fees);
    if (fees.trim() !== '') {
      if (feesValue === null || feesValue < 0) return setError('Fees must be 0 or more.');
      input.fees = feesValue;
    }
    setError(null);
    const closed = await mutation.run(() => api.closePosition(position.id, input), {
      inlineError: true,
      success: (view) =>
        `${position.symbol} closed${view.realizedPnl === null ? '' : `, realised ${signedMoney(view.realizedPnl, view.currency)}`}.`,
    });
    if (closed) onClose();
  };

  const help = KINDS.find((item) => item.id === kind)?.help;

  return (
    <Modal
      title={`Close ${position.symbol} ${contractLabel(position.expiry, position.strike)}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="close-form" className="btn primary" disabled={mutation.busy}>
            {mutation.busy ? 'Saving...' : 'Close position'}
          </button>
        </>
      }
    >
      <form id="close-form" className="stack" onSubmit={submit} noValidate>
        {mutation.error ? (
          <Callout kind="fail" role="alert">
            {mutation.error.message}
          </Callout>
        ) : null}
        <Field label="How did it end?" hint={help}>
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {KINDS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid2">
          {kind === 'bought_back' ? (
            <Field label="Buy-back premium per share">
              <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
            </Field>
          ) : null}
          {kind === 'assigned' ? (
            <Field label="Underlying close on assignment day">
              <input inputMode="decimal" value={underlying} onChange={(e) => setUnderlying(e.target.value)} />
            </Field>
          ) : null}
          <Field label="Date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Fees (total, optional)">
            <input inputMode="decimal" value={fees} onChange={(e) => setFees(e.target.value)} />
          </Field>
        </div>
        {error ? (
          <Callout kind="fail" role="alert">
            {error}
          </Callout>
        ) : null}
      </form>
    </Modal>
  );
}
