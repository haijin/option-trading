import type { Help } from '../lib/glossary';

/** The three-question explanation of a rule or KPI: what it is, why it matters for selling puts, how to read it. */
export function HelpBody({ help }: { help: Help }) {
  return (
    <dl className="help">
      <div>
        <dt>What it is</dt>
        <dd>{help.what}</dd>
      </div>
      <div>
        <dt>Why it matters</dt>
        <dd>{help.why}</dd>
      </div>
      <div>
        <dt>How to read it</dt>
        <dd>{help.read}</dd>
      </div>
    </dl>
  );
}
