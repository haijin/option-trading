import type { LeadersCardView } from '../../api/types';
import { toHash } from '../../lib/route';

/** "Leaders · 7 setups · 3 new ›": the way in from Today. Hidden until a leaders scan has run (`card` is null). */
export function LeadersTodayCard({ card }: { card: LeadersCardView | null | undefined }) {
  if (!card) return null;
  const watchOnly = card.posture === 'watch_only';
  return (
    <a className={`ld-today${watchOnly ? ' off' : ''}`} href={toHash({ page: 'leaders' })}>
      <span className="t">Leaders</span>
      <span className="txt">
        {watchOnly ? 'watch only' : `${card.setups} ${card.setups === 1 ? 'setup' : 'setups'}`} · {card.newToday} new
      </span>
      <span className="go" aria-hidden="true">
        ›
      </span>
    </a>
  );
}
