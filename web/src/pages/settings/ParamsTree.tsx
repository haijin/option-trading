import type { ReactNode } from 'react';

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function leafText(value: Json): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function Node({ name, value, depth }: { name: string; value: Json; depth: number }): ReactNode {
  if (isRecord(value) || Array.isArray(value)) {
    const entries: [string, Json][] = Array.isArray(value)
      ? value.map((v, i): [string, Json] => [String(i), v])
      : Object.entries(value);
    return (
      <details open={depth < 1}>
        <summary>
          {name} <span className="muted">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span>
        </summary>
        {entries.map(([key, child]) => (
          <Node key={key} name={key} value={child} depth={depth + 1} />
        ))}
      </details>
    );
  }
  return (
    <div className="leaf">
      <span className="k">{name}:</span>
      <span>{leafText(value)}</span>
    </div>
  );
}

/** Read-only collapsible tree of the strategy parameters. */
export function ParamsTree({ tree }: { tree: Json }) {
  if (tree === null || tree === undefined) return <p className="muted">No parameters stored.</p>;
  return (
    <div className="tree" role="tree" aria-label="Strategy parameters">
      <Node name="params" value={tree} depth={0} />
    </div>
  );
}
