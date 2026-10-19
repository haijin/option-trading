import { useEffect, useRef, useState } from 'react';
import { api } from '../api/endpoints';
import type { AskItemView, AskTarget } from '../api/types';
import { useMutation } from '../hooks/useMutation';
import { useResource } from '../hooks/useResource';
import { Markdown } from '../lib/markdown';
import { ErrorBanner } from './Callout';
import { Modal } from './Modal';
import { Skeleton } from './Skeleton';

export const QUESTION_MAX = 600;
const POLL_MS = 2000;

const isPending = (i: AskItemView): boolean => i.status === 'queued' || i.status === 'running';
const targetKey = (t: AskTarget): string =>
  t.kind === 'idea' ? `idea|${t.market}|${t.symbol}` : `position|${t.positionId}`;
const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const usd = (n: number): string => `US$${n.toFixed(2)}`;

function metaLine(item: AskItemView): string {
  const parts: string[] = [];
  if (item.pitfalls.length > 0) parts.push(`pitfalls ${item.pitfalls.join(', ')}`);
  if (item.grounding.length > 0) parts.push(`grounded on ${item.grounding.slice(0, 3).join(', ')}`);
  if (item.costUsd !== null) parts.push(usd(item.costUsd));
  return parts.join(' · ');
}

function AskItem({ item, onRetry }: { item: AskItemView; onRetry: () => void }) {
  let answer: React.ReactNode;
  if (isPending(item)) {
    const last = item.progress[item.progress.length - 1];
    answer = (
      <div className="ask-a ask-typing" role="status">
        <span className="ask-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>Thinking… usually 20 to 60 s.</span>
        {last ? <small className="ask-meta">{last}</small> : null}
      </div>
    );
  } else if (item.status === 'done' && item.answer) {
    answer = (
      <div className="ask-a">
        <div className="ask-md">
          <Markdown source={item.answer} />
        </div>
        <p className="ask-meta">{metaLine(item)}</p>
      </div>
    );
  } else {
    answer = (
      <div className="ask-a ask-failed" role="alert">
        <p>{item.status === 'cancelled' ? 'Cancelled.' : (item.error ?? 'No answer came back.')}</p>
        <button type="button" className="btn sm" onClick={onRetry}>
          Ask again
        </button>
      </div>
    );
  }
  return (
    <article className="ask-item" aria-label={`Question: ${item.question}`}>
      <div className="ask-q">
        <p>{item.question}</p>
        <time className="ask-meta" dateTime={item.createdAt}>
          {clock(item.createdAt)}
        </time>
      </div>
      {answer}
    </article>
  );
}

/**
 * The Ask sheet (docs/designs/trade-skills-integration.md, stage T2): one question at a time about an idea or an open put,
 * answered from the app's own numbers and the sell-put pitfalls. Earlier questions sit above; a pending answer shows a typing
 * state and the thread polls until it lands. The model never sizes or picks a strike; the sheet says so.
 */
export function AskSheet({
  target,
  title,
  suggestions = [],
  onClose,
}: {
  target: AskTarget;
  title: string;
  /** Short questions offered as chips while the thread is empty or idle. */
  suggestions?: string[];
  onClose: () => void;
}) {
  const key = targetKey(target);
  const thread = useResource((signal) => api.askThread(target, signal), [key], {
    refetchOnWrite: false,
    pollWhile: (t) => t.items.some(isPending),
    pollMs: POLL_MS,
  });
  const send = useMutation();
  const [question, setQuestion] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const data = thread.data;
  const items = data?.items ?? [];
  const busy = items.some(isPending);
  const unavailable = data?.executor === 'none';
  const count = items.length;
  const lastStatus = items[items.length - 1]?.status ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a question or an answer arrives
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [count, lastStatus]);

  const submit = async (text: string): Promise<void> => {
    const q = text.trim();
    if (!q || busy || send.busy || unavailable) return;
    const created = await send.run(() => api.ask({ target, question: q }), { bump: false, inlineError: true });
    if (!created) return;
    setQuestion('');
    thread.refresh();
  };

  const canSend = !unavailable && !busy && !send.busy && question.trim().length > 0;

  return (
    <Modal
      title={title}
      onClose={onClose}
      className="ask-sheet"
      footer={
        <form
          className="ask-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(question);
          }}
        >
          <textarea
            aria-label="Your question"
            value={question}
            rows={2}
            maxLength={QUESTION_MAX}
            placeholder={
              unavailable ? 'Ask needs the claude CLI on the server.' : 'Ask about this one, in English or 中文…'
            }
            disabled={unavailable}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit(question);
              }
            }}
          />
          <button type="submit" className="btn primary" disabled={!canSend}>
            {busy || send.busy ? 'Waiting…' : 'Ask'}
          </button>
        </form>
      }
    >
      {thread.error && !data ? (
        <ErrorBanner error={thread.error} onRetry={thread.refresh} title="Could not load the questions." />
      ) : null}
      {thread.loading ? (
        <div aria-busy="true" style={{ display: 'grid', gap: 8 }}>
          <span className="sr-only">Loading</span>
          <Skeleton height={44} />
          <Skeleton height={88} />
        </div>
      ) : null}
      {data && items.length === 0 ? (
        <p className="ask-intro">
          Ask anything about {data.symbol}. The answer uses the app's own numbers (the Reasons, the IV row, your open
          puts, today's brief) and the sell-put pitfalls that match the question. It never sizes a trade or picks a
          strike.
        </p>
      ) : null}
      {items.length > 0 ? (
        <div className="ask-thread">
          {items.map((item) => (
            <AskItem key={item.id} item={item} onRetry={() => void submit(item.question)} />
          ))}
          <div ref={endRef} />
        </div>
      ) : null}
      {data && !busy && !unavailable && suggestions.length > 0 ? (
        <fieldset className="ask-chips">
          <legend className="sr-only">Suggested questions</legend>
          {suggestions.map((s) => (
            <button key={s} type="button" className="btn sm" onClick={() => void submit(s)}>
              {s}
            </button>
          ))}
        </fieldset>
      ) : null}
      {send.error ? (
        <p className="ask-error" role="alert">
          {send.error.message}
        </p>
      ) : null}
      {data ? (
        <p className="note ask-limits">
          {usd(data.limits.perRunUsd)} per answer · {usd(data.limits.spentTodayUsd)} of {usd(data.limits.dailyUsd)} used
          today
          {unavailable ? ' · no AI executor on this machine' : ''}
        </p>
      ) : null}
    </Modal>
  );
}
