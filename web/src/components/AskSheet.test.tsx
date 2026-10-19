import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskItemView, AskThreadView } from '../api/types';
import { DataVersionProvider } from '../state/dataVersion';
import { ToastProvider } from '../state/toast';
import { AskSheet } from './AskSheet';

const api = { askThread: vi.fn(), ask: vi.fn() };
vi.mock('../api/endpoints', () => ({
  api: {
    askThread: (...a: unknown[]) => api.askThread(...a),
    ask: (...a: unknown[]) => api.ask(...a),
  },
}));

const TARGET = { kind: 'idea', market: 'US', symbol: 'SNOW' } as const;

function item(over: Partial<AskItemView> = {}): AskItemView {
  return {
    id: 'q1',
    target: TARGET,
    symbol: 'SNOW',
    market: 'US',
    question: 'Why this put?',
    answer:
      '**Short answer:** the cushion is 9.9%.\n\n- `vol.vrpForward` is unmeasured (pitfall 36).\n- `vol.ivRank` 72 picks the vega side (pitfall 19).',
    status: 'done',
    error: null,
    pitfalls: [36, 19],
    grounding: ['idea from the scan as of 2026-10-18, 31 reasons', 'IV row 2026-10-17'],
    progress: [],
    model: 'claude-sonnet-5-5',
    costUsd: 0.04,
    createdAt: '2026-10-19T02:00:00Z',
    finishedAt: '2026-10-19T02:00:31Z',
    ...over,
  };
}

function thread(items: AskItemView[], over: Partial<AskThreadView> = {}): AskThreadView {
  return {
    target: TARGET,
    symbol: 'SNOW',
    market: 'US',
    name: 'Snowflake',
    items,
    executor: 'fake',
    limits: { perRunUsd: 0.25, dailyUsd: 2, spentTodayUsd: 0.08, runsToday: 2 },
    ...over,
  };
}

function renderSheet(onClose = vi.fn()) {
  render(
    <ToastProvider>
      <DataVersionProvider>
        <AskSheet
          target={TARGET}
          title="Ask about SNOW"
          suggestions={['Why this put?', 'Results risk?']}
          onClose={onClose}
        />
      </DataVersionProvider>
    </ToastProvider>,
  );
  return onClose;
}

const dialog = () => screen.getByRole('dialog', { name: 'Ask about SNOW' });
const box = () => screen.getByRole('textbox', { name: 'Your question' });
const askButton = () => screen.getByRole('button', { name: /^(Ask|Waiting…)$/ });

beforeEach(() => {
  api.askThread.mockReset();
  api.ask.mockReset();
});

describe('AskSheet', () => {
  it('shows earlier questions above with the answers rendered as Markdown and the limits line', async () => {
    api.askThread.mockResolvedValue(
      thread([
        item(),
        item({
          id: 'q2',
          question: 'Results risk?',
          answer: 'None inside the expiry.',
          pitfalls: [7, 21, 37],
          costUsd: 0.03,
        }),
      ]),
    );
    renderSheet();
    const articles = await screen.findAllByRole('article');
    expect(articles.map((a) => a.getAttribute('aria-label'))).toEqual([
      'Question: Why this put?',
      'Question: Results risk?',
    ]);
    const first = within(articles[0] as HTMLElement);
    expect(first.getByText('Short answer:').tagName).toBe('STRONG');
    expect(first.getByText('vol.vrpForward').tagName).toBe('CODE');
    expect(first.getByText(/pitfalls 36, 19 · grounded on idea from the scan as of 2026-10-18/)).toBeInTheDocument();
    expect(first.getByText(/US\$0\.04/)).toBeInTheDocument();
    expect(screen.getByText(/US\$0\.25 per answer · US\$0\.08 of US\$2\.00 used today/)).toBeInTheDocument();
    expect(screen.queryByText(/Ask anything about/)).toBeNull();
    expect(askButton()).toBeDisabled();
  });

  it('sends a typed question, clears the box, shows the typing state while it runs and then the answer', async () => {
    const user = userEvent.setup();
    const running = item({
      id: 'q9',
      question: 'Is the IV worth selling?',
      answer: null,
      status: 'running',
      progress: ['thinking…'],
      costUsd: null,
    });
    api.askThread
      .mockResolvedValueOnce(thread([]))
      .mockResolvedValueOnce(thread([running]))
      .mockResolvedValue(
        thread([{ ...running, status: 'done', answer: 'Yes: `vol.vrpForward` says 7 of 10.', costUsd: 0.05 }]),
      );
    api.ask.mockResolvedValue({ ...running, status: 'queued' });
    renderSheet();
    expect(await screen.findByText(/Ask anything about SNOW/)).toBeInTheDocument();
    await user.type(box(), 'Is the IV worth selling?');
    expect(askButton()).toBeEnabled();
    await user.click(askButton());
    await waitFor(() => expect(api.ask).toHaveBeenCalledWith({ target: TARGET, question: 'Is the IV worth selling?' }));
    // the toast region is a status too: look inside the question's own article
    const typing = await within(await screen.findByRole('article')).findByRole('status');
    expect(typing).toHaveTextContent('Thinking… usually 20 to 60 s.');
    expect(typing).toHaveTextContent('thinking…');
    expect(box()).toHaveValue('');
    expect(askButton()).toHaveTextContent('Waiting…');
    expect(screen.queryByRole('button', { name: 'Why this put?' })).toBeNull();
    expect(await screen.findByText('vol.vrpForward', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(within(screen.getByRole('article')).queryByRole('status')).toBeNull();
    expect(askButton()).toHaveTextContent('Ask');
  });

  it('sends a suggestion chip as the question and Enter submits while Shift+Enter does not', async () => {
    const user = userEvent.setup();
    api.askThread.mockResolvedValue(thread([]));
    api.ask.mockResolvedValue(item({ status: 'queued', answer: null }));
    renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Results risk?' }));
    await waitFor(() => expect(api.ask).toHaveBeenCalledWith({ target: TARGET, question: 'Results risk?' }));
    await user.type(box(), 'line one{Shift>}{Enter}{/Shift}line two');
    expect(box()).toHaveValue('line one\nline two');
    expect(api.ask).toHaveBeenCalledTimes(1);
    await user.type(box(), '{Enter}');
    await waitFor(() => expect(api.ask).toHaveBeenCalledTimes(2));
    expect(api.ask).toHaveBeenLastCalledWith({ target: TARGET, question: 'line one\nline two' });
  });

  it('shows a failed answer with its reason and asks the same question again on request', async () => {
    const user = userEvent.setup();
    const failed = item({ status: 'failed', answer: null, error: 'The model did not answer within 150 seconds.' });
    api.askThread.mockResolvedValue(thread([failed]));
    api.ask.mockResolvedValue(item({ id: 'q3', status: 'queued', answer: null }));
    renderSheet();
    expect(await screen.findByRole('alert')).toHaveTextContent('The model did not answer within 150 seconds.');
    await user.click(screen.getByRole('button', { name: 'Ask again' }));
    await waitFor(() => expect(api.ask).toHaveBeenCalledWith({ target: TARGET, question: 'Why this put?' }));
  });

  it('shows the server refusal inline instead of a toast and keeps the question', async () => {
    const user = userEvent.setup();
    api.askThread.mockResolvedValue(thread([]));
    api.ask.mockRejectedValue(
      Object.assign(new Error("Today's Ask budget of US$2.00 is used up."), { code: 'daily_budget', status: 429 }),
    );
    renderSheet();
    await screen.findByText(/Ask anything about SNOW/);
    await user.type(box(), 'One more?');
    await user.click(askButton());
    expect(await screen.findByRole('alert')).toHaveTextContent("Today's Ask budget of US$2.00 is used up.");
    expect(box()).toHaveValue('One more?');
  });

  it('disables the box when the server has no AI executor and says so', async () => {
    api.askThread.mockResolvedValue(thread([], { executor: 'none' }));
    renderSheet();
    await screen.findByText(/no AI executor on this machine/);
    expect(box()).toBeDisabled();
    expect(box()).toHaveAttribute('placeholder', 'Ask needs the claude CLI on the server.');
    expect(screen.queryByRole('button', { name: 'Results risk?' })).toBeNull();
    expect(within(dialog()).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});
