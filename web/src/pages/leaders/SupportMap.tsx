import type { LeaderCandidateView } from '../../api/types';
import { gain, price } from './leadersLib';

/** Every support the skill found, nearest above the price first, with the one in play marked. */
export function SupportMap({ c }: { c: LeaderCandidateView }) {
  if (c.levels.length === 0) return null;
  const levels = [...c.levels].sort((a, b) => a.distPct - b.distPct);
  return (
    <div className="ld-sec">
      <h3>Support map</h3>
      <ul className="ld-levels" aria-label={`Support levels for ${c.symbol}`}>
        {levels.map((l) => (
          <li key={`${l.source}:${l.label}`} className={l.inPlay ? 'play' : ''}>
            <span className="s">
              {l.label}
              {l.inPlay ? ' · in play' : ''}
            </span>
            <span className="n">{price(c, l.level)}</span>
            <span className="d">{gain(l.distPct)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
