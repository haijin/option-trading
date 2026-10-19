import type { LeaderDroppedView } from '../../api/types';

/** One quiet row per name that left the list since the previous run, with the rule that dropped it. */
export function DroppedCard({ dropped, archive }: { dropped: LeaderDroppedView[]; archive: boolean }) {
  return (
    <section className="ld-card ld-panel" aria-label="Dropped names">
      <h2 className="ld-h">{archive ? 'Dropped since the previous run' : 'Dropped since yesterday'}</h2>
      {dropped.length === 0 ? (
        <p className="ld-note">Nothing left the list.</p>
      ) : (
        <ul className="ld-quiet">
          {dropped.map((d) => (
            <li key={`${d.market}:${d.symbol}`}>
              <span className="sym">
                {d.symbol}
                <span className="ld-chip">{d.market}</span>
              </span>
              <span className="r">{d.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
