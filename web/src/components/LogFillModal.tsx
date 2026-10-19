import { type FormEvent, useState } from 'react';
import { api } from '../api/endpoints';
import type { Market, PositionAddInput } from '../api/types';
import { useMutation } from '../hooks/useMutation';
import { parseNumber, todayIso } from '../lib/format';
import { Callout } from './Callout';
import { Field } from './Field';
import { Modal } from './Modal';

export interface FillPrefill {
  symbol?: string;
  market?: Market;
  expiry?: string;
  strike?: number;
  contracts?: number;
  price?: number;
  spot?: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Errors = Partial<
  Record<'symbol' | 'expiry' | 'strike' | 'contracts' | 'price' | 'date' | 'fees' | 'spot', string>
>;

/** Records a put sold in the broker (POST /api/positions). The app never places orders. */
export function LogFillModal({ prefill = {}, onClose }: { prefill?: FillPrefill; onClose: () => void }) {
  const mutation = useMutation();
  const [symbol, setSymbol] = useState(prefill.symbol ?? '');
  const [market, setMarket] = useState<'' | Market>(prefill.market ?? '');
  const [expiry, setExpiry] = useState(prefill.expiry ?? '');
  const [strike, setStrike] = useState(prefill.strike !== undefined ? String(prefill.strike) : '');
  const [contracts, setContracts] = useState(prefill.contracts !== undefined ? String(prefill.contracts) : '1');
  const [price, setPrice] = useState(prefill.price !== undefined ? prefill.price.toFixed(2) : '');
  const [date, setDate] = useState(todayIso());
  const [fees, setFees] = useState('');
  const [spot, setSpot] = useState(prefill.spot !== undefined ? String(prefill.spot) : '');
  const [errors, setErrors] = useState<Errors>({});

  const validate = (): PositionAddInput | null => {
    const next: Errors = {};
    const strikeValue = parseNumber(strike);
    const contractsValue = parseNumber(contracts);
    const priceValue = parseNumber(price);
    const feesValue = parseNumber(fees);
    const spotValue = parseNumber(spot);
    if (symbol.trim() === '') next.symbol = 'Enter a symbol.';
    if (!DATE_RE.test(expiry)) next.expiry = 'Expiry as YYYY-MM-DD.';
    if (strikeValue === null || strikeValue <= 0) next.strike = 'Strike must be above 0.';
    if (contractsValue === null || !Number.isInteger(contractsValue) || contractsValue < 1)
      next.contracts = 'Whole contracts, at least 1.';
    if (priceValue === null || priceValue < 0) next.price = 'Premium per share, 0 or more.';
    if (!DATE_RE.test(date)) next.date = 'Date as YYYY-MM-DD.';
    if (fees.trim() !== '' && (feesValue === null || feesValue < 0)) next.fees = 'Fees must be 0 or more.';
    if (spot.trim() !== '' && (spotValue === null || spotValue <= 0)) next.spot = 'Spot must be above 0.';
    setErrors(next);
    if (Object.keys(next).length > 0 || strikeValue === null || contractsValue === null || priceValue === null)
      return null;
    const input: PositionAddInput = {
      symbol: symbol.trim().toUpperCase(),
      strike: strikeValue,
      expiry,
      contracts: contractsValue,
      price: priceValue,
      date,
    };
    if (market) input.market = market;
    if (feesValue !== null) input.fees = feesValue;
    if (spotValue !== null) input.spot = spotValue;
    return input;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const input = validate();
    if (!input) return;
    const result = await mutation.run(() => api.addPosition(input), {
      success: `${input.symbol} logged. New ideas on this name are blocked until you close it.`,
      inlineError: true,
    });
    if (result) onClose();
  };

  return (
    <Modal
      title="Log a fill"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="log-fill-form" className="btn primary" disabled={mutation.busy}>
            {mutation.busy ? 'Saving...' : 'Save fill'}
          </button>
        </>
      }
    >
      <form id="log-fill-form" className="stack" onSubmit={submit} noValidate>
        <p className="muted">Record the put you sold in your broker. The app never places orders.</p>
        {mutation.error ? (
          <Callout kind="fail" role="alert">
            {mutation.error.message}
          </Callout>
        ) : null}
        <div className="grid2">
          <Field label="Symbol" error={errors.symbol}>
            <input value={symbol} onChange={(e) => setSymbol(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Market" hint="Auto picks it from the symbol">
            <select value={market} onChange={(e) => setMarket(e.target.value as '' | Market)}>
              <option value="">Auto</option>
              <option value="US">US</option>
              <option value="HK">HK</option>
            </select>
          </Field>
          <Field label="Expiry" error={errors.expiry}>
            <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} placeholder="YYYY-MM-DD" />
          </Field>
          <Field label="Strike" error={errors.strike}>
            <input inputMode="decimal" value={strike} onChange={(e) => setStrike(e.target.value)} />
          </Field>
          <Field label="Contracts" error={errors.contracts}>
            <input inputMode="numeric" value={contracts} onChange={(e) => setContracts(e.target.value)} />
          </Field>
          <Field label="Credit per share" error={errors.price}>
            <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
          <Field label="Date sold" error={errors.date}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Fees (total, optional)" error={errors.fees}>
            <input inputMode="decimal" value={fees} onChange={(e) => setFees(e.target.value)} />
          </Field>
          <Field label="Underlying price then (optional)" error={errors.spot}>
            <input inputMode="decimal" value={spot} onChange={(e) => setSpot(e.target.value)} />
          </Field>
        </div>
        <small>Open puts block new ideas on that name until you close them.</small>
      </form>
    </Modal>
  );
}
