import type { CSSProperties } from 'react';

export function Skeleton({
  width = '100%',
  height = 14,
  style,
}: {
  width?: string | number;
  height?: number;
  style?: CSSProperties;
}) {
  return <span className="skeleton" aria-hidden="true" style={{ width, height, ...style }} />;
}

/** Placeholder rows for a list pane while the first load is in flight. */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-busy="true">
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholder rows
          key={`sk${index}`}
          style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)', display: 'grid', gap: 6 }}
        >
          <Skeleton width="55%" />
          <Skeleton width="85%" height={10} />
        </div>
      ))}
    </div>
  );
}

/** Placeholder for a detail pane. */
export function DetailSkeleton() {
  return (
    <div aria-busy="true" style={{ display: 'grid', gap: 12 }}>
      <span className="sr-only">Loading</span>
      <Skeleton width="40%" height={26} />
      <Skeleton height={56} />
      <Skeleton height={64} />
      <Skeleton height={200} />
    </div>
  );
}
