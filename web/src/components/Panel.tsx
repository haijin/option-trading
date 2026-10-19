import type { ReactNode } from 'react';

export function Panel({
  title,
  actions,
  flush = false,
  children,
  className = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  /** No padding and horizontal scroll: for tables. */
  flush?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`.trim()}>
      {title !== undefined || actions ? (
        <div className="ph">
          <h3>{title}</h3>
          {actions}
        </div>
      ) : null}
      <div className={flush ? 'pb flush' : 'pb'}>{children}</div>
    </section>
  );
}

export function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="panel tile">
      <small>{label}</small>
      <h2>
        {value} {sub ? <small>{sub}</small> : null}
      </h2>
    </div>
  );
}

export function KvGrid({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <div className="kv">
      {items.map((item) => (
        <div key={item.label}>
          <span className="kvl">{item.label}</span>
          <b>{item.value}</b>
        </div>
      ))}
    </div>
  );
}
