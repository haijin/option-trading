import { useEffect, useId, useRef, useState } from 'react';
import { pct } from '../../lib/format';

export const RATE_MIN = 7;
export const RATE_MAX = 13;
export const RATE_STEP = 0.5;

/**
 * Required-return slider, 7 to 13 in steps of 0.5. The label follows the thumb while dragging; the value is committed
 * (and the valuation refetched) on the native `change` event, which fires on release.
 */
export function RateSlider({ value, onCommit }: { value: number; onCommit: (rate: number) => void }) {
  const id = useId();
  const [shown, setShown] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;

  useEffect(() => setShown(value), [value]);

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const onChange = () => commit.current(Number(element.value));
    element.addEventListener('change', onChange);
    return () => element.removeEventListener('change', onChange);
  }, []);

  return (
    <div className="rate">
      <label htmlFor={id}>Required return</label>
      <input
        id={id}
        ref={input}
        type="range"
        min={RATE_MIN}
        max={RATE_MAX}
        step={RATE_STEP}
        value={shown}
        onChange={(event) => setShown(Number(event.target.value))}
        aria-valuetext={pct(shown, 1)}
      />
      <b>{pct(shown, 1)}</b>
    </div>
  );
}
