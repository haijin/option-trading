import type { ReactNode } from 'react';

/** A label wrapping its control (so the control is named), with an optional hint and error line. */
export function Field({
  label,
  hint,
  error,
  children,
  style,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the wrapped control is passed in as children
    <label className="f" style={style}>
      {label}
      {children}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </label>
  );
}
