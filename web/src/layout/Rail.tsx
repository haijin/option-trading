import { type PageId, toHash } from '../lib/route';
import { Icon } from './Icon';
import { RAIL_ITEMS } from './nav';

/** Desktop only: the left icon rail with every page. Phones get the TabBar instead (layout.css hides whichever does not apply). */
export function Rail({ page }: { page: PageId }) {
  return (
    <nav className="rail" aria-label="Main">
      <div className="logo" aria-hidden="true">
        <span className="brand-mark">OT</span>
      </div>
      {RAIL_ITEMS.map((item) => (
        <a
          key={item.id}
          href={toHash({ page: item.id })}
          aria-current={item.id === page ? 'page' : undefined}
          title={item.label}
        >
          <Icon name={item.icon} />
          <span className="lbl">{item.label}</span>
        </a>
      ))}
    </nav>
  );
}
