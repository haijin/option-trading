export function Stars({ value, max = 5 }: { value: number | null | undefined; max?: number }) {
  if (!value) return <span className="faint">-</span>;
  const filled = Math.max(0, Math.min(max, Math.round(value)));
  return (
    <span className="stars" role="img" aria-label={`${filled} of ${max} stars`} title={`${filled} of ${max}`}>
      {'★'.repeat(filled)}
      <i>{'★'.repeat(max - filled)}</i>
    </span>
  );
}

export function ScoreBar({ score }: { score: number }) {
  const width = Math.max(0, Math.min(100, score));
  return (
    <span className="sbar" aria-hidden="true">
      <i style={{ width: `${width}%` }} />
    </span>
  );
}
