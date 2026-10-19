import type { ReactNode } from 'react';
import { ErrorBanner } from '../../components/Callout';
import { ListSkeleton } from '../../components/Skeleton';
import type { Resource } from '../../hooks/useResource';
import type { PageId } from '../../lib/route';
import { toHash } from '../../lib/route';

export type CountKind = 'ok' | 'warn' | 'fail' | 'quiet';
export type PanelId = 'puts' | 'leaders' | 'news' | 'research' | 'remind';

/**
 * The one number each module puts on Home: `count` is the pill in the panel header, `tile` the figure and label on the
 * glance bar (phones and tablets). Each panel file derives both from the same resource so the two cannot disagree.
 */
export interface PanelSummary {
  count: string | null;
  kind: CountKind;
  tile: { value: string; label: string } | null;
}

/**
 * The shape every Home module shares: the name, the one number that matters, an optional action, "Open", the rows,
 * and a footer that accounts for the rest. `id` places the panel in the desktop grid (dashboard.css). The rows sit in
 * `.hm-body`, which scrolls inside the panel when the desktop grid gives it a fixed height.
 */
export function HomePanel({
  id,
  title,
  count,
  countKind = 'ok',
  action,
  page,
  foot,
  children,
}: {
  id: PanelId;
  title: string;
  count?: string | null;
  countKind?: CountKind;
  action?: ReactNode;
  page: PageId;
  foot?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={panelDomId(id)} className={`hm-mod hm-${id}`} aria-label={title}>
      <div className="hm-mh">
        <h2>{title}</h2>
        {count ? <span className={`hm-n ${countKind}`}>{count}</span> : null}
        <span className="hm-act">
          {action}
          <a className="hm-open" href={toHash({ page })}>
            Open &rsaquo;
          </a>
        </span>
      </div>
      <div className="hm-body">{children}</div>
      {foot ? <div className="hm-mf">{foot}</div> : null}
    </section>
  );
}

/** The DOM id a glance tile scrolls to. */
export const panelDomId = (id: PanelId): string => `hm-${id}`;

/** Loading rows, or the error with a retry, for a panel whose resource has no data yet. Null when there is data. */
export function PanelState<T>({ resource, rows = 3, title }: { resource: Resource<T>; rows?: number; title: string }) {
  if (resource.data !== undefined) return null;
  if (resource.loading) return <ListSkeleton rows={rows} />;
  if (resource.error) {
    return (
      <div className="hm-empty">
        <ErrorBanner error={resource.error} onRetry={resource.refresh} title={title} />
      </div>
    );
  }
  return null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="hm-empty">{children}</div>;
}

export function Sym({ symbol, name, market }: { symbol: string; name?: string | null; market: string }) {
  return (
    <span className="sym">
      <b>{symbol}</b>
      {name ? <small>{name}</small> : null}
      <span className="mk">{market}</span>
    </span>
  );
}
