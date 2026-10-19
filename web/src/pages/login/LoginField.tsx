import { type ReactNode, useId } from 'react';

interface FieldProps {
  id: string;
  'aria-describedby'?: string;
}

/**
 * A label above a control. Unlike the app's `Field` the label holds only its own words, so a screen reader announces
 * "Password", not "Password Show": the hint is tied on with aria-describedby and any button sits beside the input.
 */
export function LoginField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (props: FieldProps) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="login-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-describedby': hint ? hintId : undefined })}
      {hint ? (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
