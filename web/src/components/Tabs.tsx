import { type KeyboardEvent, type ReactNode, useId } from 'react';

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
}

/** Accessible tab strip: arrow keys move between tabs. Render the active panel yourself next to it. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: readonly TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  const base = useId();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = tabs.findIndex((tab) => tab.id === value);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (!next) return;
    event.preventDefault();
    onChange(next.id);
    requestAnimationFrame(() => document.getElementById(`${base}-${next.id}`)?.focus());
  };

  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown} tabIndex={-1}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          id={`${base}-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          tabIndex={tab.id === value ? 0 : -1}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
