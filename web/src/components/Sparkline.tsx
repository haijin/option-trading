/** Tiny trend line for a handful of yearly values (oldest first). */
export function Sparkline({ values, label }: { values: readonly number[]; label?: string }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const step = 62 / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * step + 1).toFixed(1)},${(16 - ((v - lo) / span) * 14).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="spk" viewBox="0 0 64 18" role="img" aria-label={label ?? `trend of ${values.length} values`}>
      <polyline fill="none" stroke="currentColor" strokeWidth="1.6" points={points} />
    </svg>
  );
}
