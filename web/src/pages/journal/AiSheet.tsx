import { useEffect, useId, useRef, useState } from 'react';
import type { JournalAiRunView } from '../../api/types';
import { AiPreview } from './AiPreview';
import { costLine } from './aiFormat';
import { AI_MODES, type AiChoices, choiceProblem, INSTRUCTION_MAX } from './aiModes';
import type { AiState } from './aiRun';
import { Sheet } from './Sheet';
import { changesView } from './wordDiff';

type Stage = 'choose' | 'run' | 'result' | 'failed';

const STAGE_LABEL: Record<Stage, string> = { choose: 'Choose', run: 'Running', result: 'Suggestion', failed: 'Failed' };

function stageOf(state: AiState): Stage {
  switch (state.phase.kind) {
    case 'running':
      return 'run';
    case 'result':
      return 'result';
    case 'failed':
      return 'failed';
    default:
      return 'choose';
  }
}

/** "Changes": the word diff of what the model was given against what it returned. */
function ChangesPanel({ run }: { run: JournalAiRunView }) {
  const result = run.result;
  if (!result) return null;
  const view = changesView(result.inputMarkdown, result.outputMarkdown);
  if (view.kind === 'whole') {
    return (
      <div className="jr-diff-whole">
        <p className="jr-note">
          This entry is long, so the changes are shown as your text and the suggestion, side by side.
        </p>
        <h4>Your text</h4>
        <pre className="jr-whole">{view.before}</pre>
        <h4>Suggestion</h4>
        <pre className="jr-whole">{view.after}</pre>
        {view.note ? <span className="jr-kept">{view.note}</span> : null}
      </div>
    );
  }
  return (
    <section className="jr-diff" aria-label="Changes">
      {view.changed ? (
        view.parts.map((part, i) =>
          part.kind === 'ins' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed list rendered once
            <ins key={i}>{part.text}</ins>
          ) : part.kind === 'del' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed list rendered once
            <del key={i}>{part.text}</del>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed list rendered once
            <span key={i}>{part.text}</span>
          ),
        )
      ) : (
        <span className="jr-kept">No changes: the suggestion is the same as your text.</span>
      )}
      {view.note ? <span className="jr-kept">{view.note}</span> : null}
    </section>
  );
}

function Notice({ text }: { text: string | null }) {
  return text ? (
    <p className="jr-notice" role="alert">
      {text}
    </p>
  ) : null;
}

/**
 * The AI rewrite sheet (docs/prototypes/daily-journal.html, `aiSheet`): Choose, Running, Suggestion. Same sheet pattern as
 * History. Nothing here changes the entry; Use suggestion hands the accepted entry to the editor.
 */
export function AiSheet({
  state,
  choices,
  onChoices,
  onStart,
  onCancelRun,
  onAccept,
  onKeepMine,
  onTryAgain,
  onClose,
  disabledReason,
}: {
  state: AiState;
  choices: AiChoices;
  onChoices: (next: AiChoices) => void;
  onStart: () => void;
  onCancelRun: () => void;
  onAccept: () => void;
  onKeepMine: () => void;
  onTryAgain: () => void;
  onClose: () => void;
  /** Why a rewrite cannot be started right now (no text yet, an image still uploading, the model is unavailable). */
  disabledReason: string | null;
}) {
  const stage = stageOf(state);
  const phase = state.phase;
  const [tab, setTab] = useState<'sug' | 'diff'>('sug');
  const customRef = useRef<HTMLTextAreaElement>(null);
  const switchId = useId();
  const problem = choiceProblem(choices);
  const starting = phase.kind === 'starting';

  // a new suggestion opens on the suggestion, not on the tab the last one was left on
  const runId = phase.kind === 'result' ? phase.run.id : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `runId` is the trigger
  useEffect(() => setTab('sug'), [runId]);

  const badge = <span className="jr-chip ai">{STAGE_LABEL[stage]}</span>;

  let footer: React.ReactNode;
  let body: React.ReactNode;

  if (stage === 'choose') {
    body = (
      <>
        <fieldset className="jr-modes">
          <legend className="sr-only">What should it do?</legend>
          {AI_MODES.map((m) => (
            <label key={m.id} className="jr-mode">
              <input
                className="jr-mode-in"
                type="radio"
                name="jr-ai-mode"
                value={m.id}
                checked={choices.mode === m.id}
                onChange={() => {
                  onChoices({ ...choices, mode: m.id });
                  if (m.id === 'custom') requestAnimationFrame(() => customRef.current?.focus());
                }}
              />
              <span className="jr-mode-t">{m.label}</span>
              <span className="jr-mode-d">{m.blurb}</span>
            </label>
          ))}
        </fieldset>
        <textarea
          ref={customRef}
          className="jr-custom"
          aria-label="Instruction"
          aria-describedby={problem ? 'jr-ai-hint' : undefined}
          placeholder="Optional instruction, e.g. “write it as a letter to my future self”"
          rows={2}
          maxLength={INSTRUCTION_MAX}
          value={choices.instruction}
          onChange={(event) => onChoices({ ...choices, instruction: event.target.value })}
        />
        {problem ? (
          <p className="jr-note" id="jr-ai-hint">
            {problem}
          </p>
        ) : null}
        <label className="jr-optrow" htmlFor={switchId}>
          <span>Give it today&rsquo;s positions and scan as context</span>
          <span className="jr-sw">
            <input
              id={switchId}
              className="jr-sw-in"
              type="checkbox"
              role="switch"
              aria-checked={choices.withContext}
              checked={choices.withContext}
              onChange={(event) => onChoices({ ...choices, withContext: event.target.checked })}
            />
            <span className="jr-sw-track" aria-hidden="true" />
          </span>
        </label>
        <p className="jr-note">
          Runs through the same claude CLI as Research, with no tools and a small spending cap. Images, tables,
          snapshots and checklists are locked; only prose changes. Nothing is written to the entry until you accept.
        </p>
        <Notice text={state.notice} />
        {disabledReason && !state.notice ? <Notice text={disabledReason} /> : null}
      </>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn ai"
          disabled={Boolean(problem) || Boolean(disabledReason) || starting}
          onClick={onStart}
        >
          {starting ? 'Saving…' : 'Rewrite'}
        </button>
      </>
    );
  } else if (stage === 'run' && phase.kind === 'running') {
    const lines = phase.run.progress;
    body = (
      <>
        <ol className="jr-prog" aria-live="polite" aria-label="Progress">
          {lines.length === 0 ? (
            <li className="jr-prog-l">
              <i className="jr-pulse" aria-hidden="true" />
              <span>{phase.run.status === 'queued' ? 'waiting to start…' : 'starting…'}</span>
            </li>
          ) : (
            lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: progress lines only ever grow at the end
              <li key={i} className="jr-prog-l">
                {i === lines.length - 1 ? (
                  <i className="jr-pulse" aria-hidden="true" />
                ) : (
                  <span className="jr-tick" aria-hidden="true">
                    ✓
                  </span>
                )}
                <span>{line}</span>
              </li>
            ))
          )}
        </ol>
        <p className="jr-note">
          Usually 5 to 20 seconds on a phone. You can close this and keep writing; the suggestion waits here.
        </p>
        <Notice text={state.notice} />
      </>
    );
    footer = (
      <button type="button" className="btn" disabled={state.deciding} onClick={onCancelRun}>
        Cancel run
      </button>
    );
  } else if (stage === 'result' && phase.kind === 'result') {
    const run = phase.run;
    const cost = costLine(run);
    body = (
      <>
        <div className="jr-seg jr-res-tabs" role="tablist" aria-label="Suggestion views">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'sug'}
            className={tab === 'sug' ? 'on' : ''}
            onClick={() => setTab('sug')}
          >
            Suggestion
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'diff'}
            className={tab === 'diff' ? 'on' : ''}
            onClick={() => setTab('diff')}
          >
            Changes
          </button>
        </div>
        <div className="jr-preview" role="tabpanel" hidden={tab !== 'sug'}>
          {run.result ? <AiPreview doc={run.result.doc} runId={run.id} /> : null}
        </div>
        {tab === 'diff' ? (
          <div role="tabpanel">
            <ChangesPanel run={run} />
          </div>
        ) : null}
        <p className="jr-costline">
          <span>
            Mode <b className="jr-v">{cost.mode}</b>
          </span>
          <span>
            Model <b className="jr-v">{cost.model}</b>
          </span>
          <span>
            Cost <b className="jr-v">{cost.cost}</b>
          </span>
          <span>
            Took <b className="jr-v">{cost.took}</b>
          </span>
          <span>
            Locked blocks kept <b className="jr-v">{cost.locked}</b>
          </span>
        </p>
        <Notice text={state.notice} />
      </>
    );
    footer = (
      <>
        <button type="button" className="btn" disabled={state.deciding} onClick={onKeepMine}>
          Keep mine
        </button>
        <button type="button" className="btn" disabled={state.deciding} onClick={onTryAgain}>
          Try again
        </button>
        <button type="button" className="btn primary" disabled={state.deciding} onClick={onAccept}>
          Use suggestion
        </button>
      </>
    );
  } else {
    const run = phase.kind === 'failed' ? phase.run : null;
    body = (
      <>
        <p className="jr-notice" role="alert">
          {run?.error ?? 'The rewrite did not finish. Nothing was changed.'}
        </p>
        <Notice text={state.notice} />
      </>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
        <button type="button" className="btn ai" onClick={onTryAgain}>
          Try again
        </button>
      </>
    );
  }

  return (
    <Sheet title="AI rewrite" badge={badge} onClose={onClose} footer={footer}>
      {body}
    </Sheet>
  );
}
