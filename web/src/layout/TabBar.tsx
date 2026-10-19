import { type PageId, toHash } from '../lib/route';
import { Icon } from './Icon';
import { NAV_ITEMS } from './nav';

/** Phone only: the bottom tab bar from the iOS spec (icon over a small label, the active tab tinted green). */
export function TabBar({ page }: { page: PageId }) {
  return (
    <nav className="tabbar" aria-label="Main">
      {NAV_ITEMS.map((item) => (
        <a
          key={item.id}
          className={item.id === page ? 't active' : 't'}
          href={toHash({ page: item.id })}
          aria-current={item.id === page ? 'page' : undefined}
          aria-label={item.label}
        >
          <Icon name={item.icon} />
          <span>{item.short}</span>
        </a>
      ))}
    </nav>
  );
}
