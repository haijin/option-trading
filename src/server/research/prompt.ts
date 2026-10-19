/**
 * Builds the prompt for one AI skill run from the Invest-agent skill file. The skill text is the user's own file and is kept
 * verbatim except for three mechanical substitutions: `$ARGUMENTS`, the hard-coded `~/ai-berkshire` tool root, and `python3`.
 */
export interface PromptInput {
  skillMarkdown: string;
  /** What the skill is about, e.g. "Coca-Cola (KO, US)". */
  target: string;
  /** Invest-agent repository root (forward slashes). */
  root: string;
  python: string | null;
  today: string;
  /** Facts from the user's own database, shown as context and flagged as possibly stale. */
  context?: string[];
}

const posix = (p: string): string => p.replace(/\\/g, '/');

export function buildPrompt(i: PromptInput): string {
  const root = posix(i.root).replace(/\/+$/, '');
  let skill = i.skillMarkdown.split('$ARGUMENTS').join(i.target).split('~/ai-berkshire').join(root);
  const py = i.python ? posix(i.python) : null;
  skill = py ? skill.replace(/\bpython3\b/g, `"${py}"`) : skill;
  const rules = [
    'You are running inside a personal decision-support app (the app never places orders). Rules for this run:',
    '1. Do not create, edit or save any file. Return the COMPLETE final report as your final message, in Markdown; the app saves it.',
    '2. Where the skill text below says to write a report file or a saved document, put that content in your final message instead.',
    '3. If a tool the skill names is not available to you (for example team or agent tools), do that work yourself, step by step. Saved report files of the Invest-agent repository do not apply here: treat this as a first run.',
    py
      ? `4. For exact-decimal checks run the Python tool as "${py}" ${root}/tools/financial_rigor.py <subcommand> ... (the interpreter is already set to UTF-8; read-only commands only; no other shell commands are allowed).`
      : '4. The exact-decimal Python tool is not available on this machine: compute carefully by hand and state that the figures were not machine-verified.',
    `5. Today is ${i.today}. Cite the source and date of every figure. If data is missing say so; do not invent numbers.`,
    '6. This is decision support, not investment advice.',
  ];
  const ctx =
    i.context && i.context.length > 0
      ? [
          '',
          "Facts from the user's own database (may be stale; verify before relying on them):",
          ...i.context.map((c) => `- ${c}`),
        ]
      : [];
  return [...rules, ...ctx, '', '=== SKILL ===', skill.trim(), ''].join('\n');
}
