import { type FormEvent, useState } from 'react';
import { api } from '../../api/endpoints';
import type { LotSellInput, LotView } from '../../api/types';
import { Callout } from '../../components/Callout';
import { Field } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { useMutation } from '../../hooks/useMutation';
import { parseNumber, signedMoney, todayIso } from '../../lib/format';

/** Records the sale of shares received from an assigned put (POST /api/lots/:id/sell). The app never sells anything. */
export function SellLotModal({ lot, onClose }: { lot: LotView; onClose: () => void }) {
  const mutation = useMutation();
  const [price, setPrice] = useState(lot.spot !== null ? String(lot.spot) : '');
  const [date, setDate] = useState(todayIso());
  const [fees, setFees] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = parseNumber(price);
    if (value === null || value <= 0) return setError('Enter the sale price per share.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError('Date as YYYY-MM-DD.');
    const input: LotSellInput = { price: value, date };
    if (fees.trim() !== '') {
      const feesValue = parseNumber(fees);
      if (feesValue === null || feesValue < 0) return setError('Fees must be 0 or more.');
      input.fees = feesValue;
    }
    setError(null);
    const sold = await mutation.run(() => api.sellLot(lot.id, input), {
      inlineError: true,
      success: (view) =>
        `${lot.symbol} shares sold${view.realizedPnl === null ? '' : `, realised ${signedMoney(view.realizedPnl, view.currency)}`}.`,
    });
    if (sold) onClose();
  };

  return (
    <Modal
      title={`Sell ${lot.shares} ${lot.symbol} shares`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="sell-lot-form" className="btn primary" disabled={mutation.busy}>
            {mutation.busy ? 'Saving...' : 'Record sale'}
          </button>
        </>
      }
    >
      <form id="sell-lot-form" className="stack" onSubmit={submit} noValidate>
        {mutation.error ? (
          <Callout kind="fail" role="alert">
            {mutation.error.message}
          </Callout>
        ) : null}
        <p className="muted">
          Record a sale you made in your broker. Profit is measured from the assignment close ({lot.costBasis}), because
          the put's own result already includes the move to that price.
        </p>
        <div className="grid2">
          <Field label="Sale price per share">
            <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
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
