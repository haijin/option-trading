import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type JournalDocJson, type JournalNodeJson, renderMarkdown } from '../../../../src/journal';
import type { JournalAiRunView, JournalEntryInput, JournalEntryView } from '../../api/types';
import { ToastProvider } from '../../state/toast';
import { POLL_CLOSED_MS, POLL_OPEN_MS } from './aiRun';
import { DEBOUNCE_MS } from './autosave';
import { EditorBody } from './EditorBody';

const DATE = '2026-10-13';
const para = (text: string): JournalNodeJson => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const docOf = (...content: JournalNodeJson[]): JournalDocJson => ({ type: 'doc', content });

const ORIGINAL = docOf(para('HK open weak, didnt sell the put.'));
const REWRITTEN = docOf(para('Hong Kong opened weak, and I did not sell the put.'));

function entry(patch: Partial<JournalEntryView> = {}): JournalEntryView {
  const doc = patch.doc ?? ORIGINAL;
  return {
    id: 'e1',
    date: DATE,
    title: 'Evening review',
    template: 'evening',
    marketView: 'neutral',
    tags: [],
    status: 'draft',
    wordCount: 7,
    excerpt: '',
    mentions: [],
    thumbnailAssetId: null,
    aiPolished: false,
    updatedAt: new Date(2026, 9, 13, 16, 42).toISOString(),
    markdown: renderMarkdown(doc),
    revisionNo: 3,
    createdAt: new Date(2026, 9, 13, 9, 12).toISOString(),
    revisionCount: 3,
    lastAi: null,
    ...patch,
    doc,
  };
}

function run(patch: Partial<JournalAiRunView> = {}): JournalAiRunView {
  return {
    id: 'run-1',
    date: DATE,
    mode: 'polish',
    instruction: null,
    withContext: false,
    status: 'running',
    accepted: null,
    progress: ['prose: 7 words, 0 locked blocks', 'mode: Polish', 'writing…'],
    error: null,
    model: null,
    costUsd: null,
    durationMs: null,
    createdAt: '2026-10-13T08:00:00.000Z',
    finishedAt: null,
    result: null,
    ...patch,
  };
}

const doneRun = (patch: Partial<JournalAiRunView> = {}): JournalAiRunView =>
  run({
    status: 'done',
    model: 'claude-haiku-5-5',
    costUsd: 0.03,
    durationMs: 9000,
    result: {
      doc: REWRITTEN,
      inputMarkdown: 'HK open weak, didnt sell the put.\n\n[[FIG:1]]',
      outputMarkdown: 'Hong Kong opened weak, and I did not sell the put.\n\n[[FIG:1]]',
      lockedKept: 1,
      lockedTotal: 1,
    },
    ...patch,
  });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (status: number, code: string, message: string, details?: unknown) =>
  json({ error: { code, message, ...(details ? { details } : {}) } }, status);

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** A stand-in for the server: `latest` and `current` are what the AI endpoints answer; everything is recorded. */
function stubServer() {
  const calls: Call[] = [];
  const state = {
    latest: null as JournalAiRunView | null,
    latestError: null as Response | null,
    current: run({ status: 'running' }),
    startError: null as Response | null,
    acceptError: null as Response | null,
    accepted: {
      entry: entry({
        doc: REWRITTEN,
        revisionNo: 9,
        revisionCount: 5,
        aiPolished: true,
        lastAi: { mode: 'polish', at: new Date(2026, 9, 13, 17, 5).toISOString() },
      }),
      undoRevisionNo: 3,
    },
    restored: entry({ revisionNo: 10, revisionCount: 6 }),
    revision: 3,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ method, url, body });
      const path = url.split('?')[0] ?? '';
      if (path === `/api/journal/entries/${DATE}/ai`) {
        if (method === 'POST') return state.startError ?? json({ runId: 'run-1' }, 202);
        return state.latestError ?? json(state.latest);
      }
      if (path === '/api/journal/ai/run-1' || path === '/api/journal/ai/run-77') return json(state.current);
      if (path.endsWith('/cancel')) return json(run({ status: 'cancelled' }));
      if (path.endsWith('/accept')) return state.acceptError ?? json(state.accepted);
      if (path.endsWith('/reject')) return json(doneRun({ accepted: false }));
      if (path.includes('/revisions/') && path.endsWith('/restore')) return json(state.restored);
      if (method === 'PUT') {
        const input = body as JournalEntryInput;
        state.revision += 1;
        return json(entry({ title: input.title, doc: input.doc, revisionNo: state.revision }));
      }
      return json({});
    }),
  );
  return { calls, state };
}

function mount(server: JournalEntryView | null = entry()) {
  render(
    <ToastProvider>
      <EditorBody
        date={DATE}
        server={server}
        local={null}
        offline={false}
        onBack={() => undefined}
        onDeleted={() => undefined}
        onChanged={() => undefined}
      />
    </ToastProvider>,
  );
  return { title: screen.getByLabelText('Title') as HTMLInputElement };
}

const tick = (ms = 10) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const aiButton = () => screen.getByRole('button', { name: 'AI rewrite' });
const dialog = () => screen.getByRole('dialog', { name: 'AI rewrite' });
const stage = () =>
  within(dialog()).getByText(/^(Choose|Running|Suggestion|Failed)$/, { selector: '.jr-chip' }).textContent;
const footerButtons = () => Array.from(dialog().querySelectorAll('.jr-sf button')).map((b) => b.textContent);
const editorText = () => screen.getByRole('textbox', { name: 'Entry text' }).textContent;
const ai = (calls: Call[]) => calls.filter((c) => c.url.includes('/ai'));

async function openSheet() {
  fireEvent.click(aiButton());
  await tick(0);
}

async function startPolish(h: ReturnType<typeof stubServer>) {
  await openSheet();
  await act(async () => {
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Rewrite' }));
    await vi.advanceTimersByTimeAsync(10);
  });
  return h;
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('the AI rewrite button', () => {
  it('sits at the right end of the toolbar, labelled for screen readers, and opens the Choose stage', async () => {
    stubServer();
    mount();
    expect(aiButton()).toHaveClass('jr-aibtn');
    expect(aiButton()).not.toHaveAttribute('aria-disabled');
    await openSheet();
    expect(dialog()).toHaveAttribute('aria-modal', 'true');
    expect(stage()).toBe('Choose');
    expect(footerButtons()).toEqual(['Cancel', 'Rewrite']);
  });

  it('is off, and says why when tapped, while the entry has no text', async () => {
    stubServer();
    mount(entry({ doc: docOf({ type: 'paragraph' }), wordCount: 0 }));
    expect(aiButton()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(aiButton());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('There is no text to rewrite yet. Write something first.')).toBeInTheDocument();
  });

  it('is off while an image is still uploading', async () => {
    stubServer();
    mount();
    // a figure with no real id and an upload under way is "pending"
    const { FakeXhr } = await import('./testXhr');
    FakeXhr.reset();
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const input = screen.getByTestId('jr-image-input');
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File([new Uint8Array(10)], 'a.png', { type: 'image/png' })] } });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(aiButton()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(aiButton());
    expect(screen.getByText('Wait for the image to finish uploading, then rewrite.')).toBeInTheDocument();
  });

  it("is off with the server's own words when the AI is unavailable (503 on opening the editor)", async () => {
    const h = stubServer();
    h.state.latestError = apiError(503, 'ai_unavailable', 'The AI rewrite needs the claude CLI and it was not found.');
    mount();
    await tick(0);
    expect(aiButton()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(aiButton());
    expect(screen.getByText('The AI rewrite needs the claude CLI and it was not found.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not look up a rewrite for a day that is not on the server yet', async () => {
    const h = stubServer();
    mount(null);
    await tick(0);
    expect(ai(h.calls)).toEqual([]);
  });
});

describe('the Choose stage', () => {
  it('offers six modes (Polish, Tighten, Structure, Lessons & actions, 中文, Custom) and no English', async () => {
    stubServer();
    mount();
    await openSheet();
    const modes = within(dialog())
      .getAllByRole('radio')
      .map((r) => r.closest('label')?.querySelector('.jr-mode-t')?.textContent);
    expect(modes).toEqual(['Polish', 'Tighten', 'Structure', 'Lessons & actions', '中文', 'Custom']);
    expect(within(dialog()).getByRole('radio', { name: /Polish/ })).toBeChecked();
    expect(
      within(dialog()).getByText('Fix grammar and flow. Keep my words, my view and every number.'),
    ).toBeInTheDocument();
  });

  it('has a 500-character instruction box, a context switch that is off, and a note that does not hard-code a model or a price', async () => {
    stubServer();
    mount();
    await openSheet();
    const box = within(dialog()).getByLabelText('Instruction');
    expect(box).toHaveAttribute('maxlength', '500');
    const sw = within(dialog()).getByRole('switch');
    expect(sw).not.toBeChecked();
    expect(sw).toHaveAttribute('aria-checked', 'false');
    const note = within(dialog()).getByText(/Runs through the same claude CLI as Research/);
    expect(note.textContent).toContain('no tools and a small spending cap');
    expect(note.textContent).not.toMatch(/\$|haiku|0\.10/i);
  });

  it('needs an instruction for Custom, and says so, before Rewrite can be pressed', async () => {
    const h = stubServer();
    mount();
    await openSheet();
    fireEvent.click(within(dialog()).getByRole('radio', { name: /Custom/ }));
    const rewrite = within(dialog()).getByRole('button', { name: 'Rewrite' });
    expect(rewrite).toBeDisabled();
    expect(within(dialog()).getByText('Tell it what to do in the box, or pick another mode.')).toBeInTheDocument();
    fireEvent.change(within(dialog()).getByLabelText('Instruction'), { target: { value: '   ' } });
    expect(rewrite).toBeDisabled();
    fireEvent.change(within(dialog()).getByLabelText('Instruction'), {
      target: { value: '  write it as a letter to my future self  ' },
    });
    expect(rewrite).toBeEnabled();
    await act(async () => {
      fireEvent.click(rewrite);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(ai(h.calls).find((c) => c.method === 'POST')?.body).toEqual({
      mode: 'custom',
      withContext: false,
      instruction: 'write it as a letter to my future self',
    });
  });

  it('starts with the picked mode, and the context switch when it is on', async () => {
    const h = stubServer();
    mount();
    await openSheet();
    fireEvent.click(within(dialog()).getByRole('radio', { name: /Lessons & actions/ }));
    fireEvent.click(within(dialog()).getByRole('switch'));
    expect(within(dialog()).getByRole('switch')).toBeChecked();
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Rewrite' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(ai(h.calls).find((c) => c.method === 'POST')?.body).toEqual({ mode: 'lessons', withContext: true });
  });

  it("saves what is typed first: the run works from the server's copy", async () => {
    const h = stubServer();
    const { title } = mount();
    fireEvent.change(title, { target: { value: 'Typed just now' } });
    await openSheet();
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Rewrite' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    const order = h.calls
      .filter((c) => c.method === 'PUT' || (c.method === 'POST' && c.url.endsWith('/ai')))
      .map((c) => c.method);
    expect(order).toEqual(['PUT', 'POST']);
    const put = h.calls.find((c) => c.method === 'PUT');
    expect((put?.body as JournalEntryInput | undefined)?.title).toBe('Typed just now');
  });

  it("shows the server's message when the start is refused (daily limit), and stays on Choose", async () => {
    const h = stubServer();
    h.state.startError = apiError(
      429,
      'daily_limit',
      "You have used today's 20 rewrites. The count restarts at midnight UTC.",
    );
    mount();
    await startPolish(h);
    expect(stage()).toBe('Choose');
    expect(within(dialog()).getByRole('alert')).toHaveTextContent("You have used today's 20 rewrites.");
  });

  it("turns the button off with the server's reason once the AI turns out to be unavailable", async () => {
    const h = stubServer();
    h.state.startError = apiError(503, 'ai_unavailable', 'The AI rewrite needs the claude CLI.');
    mount();
    await startPolish(h);
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('The AI rewrite needs the claude CLI.');
    expect(within(dialog()).getByRole('button', { name: 'Rewrite' })).toBeDisabled();
  });
});

describe('the Running stage', () => {
  it('shows the run\'s lines with ticks and a pulsing last line, a Cancel run button and the "keep writing" note', async () => {
    const h = stubServer();
    mount();
    await startPolish(h);
    await tick(0);
    expect(stage()).toBe('Running');
    const lines = within(dialog()).getAllByRole('listitem');
    expect(lines.map((l) => l.textContent?.replace('✓', '').trim())).toEqual([
      'prose: 7 words, 0 locked blocks',
      'mode: Polish',
      'writing…',
    ]);
    expect(lines[0]?.querySelector('.jr-tick')).not.toBeNull();
    expect(lines[2]?.querySelector('.jr-pulse')).not.toBeNull();
    expect(lines[2]?.querySelector('.jr-tick')).toBeNull();
    expect(footerButtons()).toEqual(['Cancel run']);
    expect(within(dialog()).getByText(/You can close this and keep writing/)).toBeInTheDocument();
  });

  it('follows the run every 2 s while the sheet is open and moves to the suggestion when it is done', async () => {
    const h = stubServer();
    mount();
    await startPolish(h);
    await tick(0);
    const polls = () => h.calls.filter((c) => c.method === 'GET' && c.url === '/api/journal/ai/run-1').length;
    const before = polls();
    await tick(POLL_OPEN_MS * 2 + 50);
    expect(polls()).toBe(before + 2);
    h.state.current = doneRun();
    await tick(POLL_OPEN_MS + 50);
    expect(stage()).toBe('Suggestion');
  });

  it('Cancel run cancels on the server, says so, and goes back to Choose with the choices kept', async () => {
    const h = stubServer();
    mount();
    await openSheet();
    fireEvent.click(within(dialog()).getByRole('radio', { name: /Tighten/ }));
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Rewrite' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel run' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(h.calls.some((c) => c.url === '/api/journal/ai/run-1/cancel' && c.method === 'POST')).toBe(true);
    expect(screen.getByText('Run cancelled. Nothing changed.')).toBeInTheDocument();
    expect(stage()).toBe('Choose');
    expect(within(dialog()).getByRole('radio', { name: /Tighten/ })).toBeChecked();
  });

  it('attaches to the run that is already going (409 run_in_progress)', async () => {
    const h = stubServer();
    h.state.startError = apiError(409, 'run_in_progress', 'A rewrite is already running for this entry.', {
      runId: 'run-77',
    });
    h.state.current = run({ id: 'run-77', status: 'running', progress: ['writing…'] });
    mount();
    await startPolish(h);
    expect(stage()).toBe('Running');
    expect(within(dialog()).getByText(/already running for this entry/)).toBeInTheDocument();
  });

  it('keeps working after the sheet is closed: a chip says the AI is writing, then that the suggestion is ready, polled every 10 s', async () => {
    const h = stubServer();
    mount();
    await startPolish(h);
    await tick(0);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /AI is writing…/ })).toBeInTheDocument();
    const polls = () => h.calls.filter((c) => c.method === 'GET' && c.url === '/api/journal/ai/run-1').length;
    await tick(0);
    const base = polls();
    await tick(POLL_OPEN_MS * 3);
    expect(polls()).toBe(base); // not at the open pace
    h.state.current = doneRun();
    await tick(POLL_CLOSED_MS);
    expect(polls()).toBe(base + 1);
    const chip = screen.getByRole('button', { name: /Suggestion ready/ });
    // the editor was never touched
    expect(editorText()).toContain('didnt sell the put');
    fireEvent.click(chip);
    await tick(0);
    expect(stage()).toBe('Suggestion');
    expect(screen.queryByRole('button', { name: /Suggestion ready/ })).toBeNull();
  });

  it('reopening the sheet while it runs shows where it is', async () => {
    const h = stubServer();
    mount();
    await startPolish(h);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: /AI is writing…/ }));
    await tick(0);
    expect(stage()).toBe('Running');
    expect(footerButtons()).toEqual(['Cancel run']);
  });
});

describe('picking a rewrite up again when the editor opens', () => {
  it('a run that is still running shows the chip', async () => {
    const h = stubServer();
    h.state.latest = run({ status: 'running' });
    mount();
    await tick(0);
    expect(screen.getByRole('button', { name: /AI is writing…/ })).toBeInTheDocument();
    expect(ai(h.calls)[0]).toMatchObject({ method: 'GET', url: `/api/journal/entries/${DATE}/ai` });
  });

  it('a finished suggestion nobody decided on shows "Suggestion ready"', async () => {
    const h = stubServer();
    h.state.latest = doneRun();
    mount();
    await tick(0);
    expect(screen.getByRole('button', { name: /Suggestion ready/ })).toBeInTheDocument();
  });

  it('a failed, cancelled or decided run shows nothing', async () => {
    for (const latest of [
      run({ status: 'failed', error: 'x' }),
      run({ status: 'cancelled' }),
      doneRun({ accepted: true }),
      doneRun({ accepted: false }),
    ]) {
      const h = stubServer();
      h.state.latest = latest;
      const view = render(
        <ToastProvider>
          <EditorBody
            date={DATE}
            server={entry()}
            local={null}
            offline={false}
            onBack={() => undefined}
            onDeleted={() => undefined}
            onChanged={() => undefined}
          />
        </ToastProvider>,
      );
      await tick(0);
      expect(screen.queryByRole('button', { name: /AI is writing…|Suggestion ready/ })).toBeNull();
      view.unmount();
      vi.unstubAllGlobals();
    }
  });
});

describe('the Suggestion stage', () => {
  async function withSuggestion() {
    const h = stubServer();
    h.state.latest = doneRun();
    mount();
    await tick(0);
    fireEvent.click(screen.getByRole('button', { name: /Suggestion ready/ }));
    await tick(0);
    return h;
  }

  it('shows the suggested entry, the tabs, the cost line and the three buttons', async () => {
    await withSuggestion();
    expect(stage()).toBe('Suggestion');
    expect(within(dialog()).getByRole('tab', { name: 'Suggestion' })).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog()).getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'false');
    expect(within(dialog()).getByRole('document', { name: 'Suggested entry' })).toHaveTextContent(
      'Hong Kong opened weak, and I did not sell the put.',
    );
    const cost = dialog().querySelector('.jr-costline');
    expect(cost?.textContent).toBe('Mode PolishModel claude-haiku-5-5Cost $0.03Took 9 sLocked blocks kept 1 of 1');
    expect(footerButtons()).toEqual(['Keep mine', 'Try again', 'Use suggestion']);
  });

  it('the suggestion is read-only and the entry behind the sheet is untouched', async () => {
    await withSuggestion();
    const preview = within(dialog()).getByRole('document', { name: 'Suggested entry' });
    expect(preview).toHaveAttribute('contenteditable', 'false');
    expect(editorText()).toContain('didnt sell the put');
    expect(editorText()).not.toContain('Hong Kong');
  });

  it('Changes shows what was removed and added, leaves the locked block out and names it', async () => {
    await withSuggestion();
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Changes' }));
    const changes = within(dialog()).getByRole('region', { name: 'Changes' });
    expect(Array.from(changes.querySelectorAll('ins')).map((e) => e.textContent?.trim())).toContain('Hong Kong opened');
    expect(Array.from(changes.querySelectorAll('del')).map((e) => e.textContent?.trim())).toContain('HK open');
    expect(changes.textContent).not.toContain('[[FIG');
    expect(changes).toHaveTextContent('Image: kept as written (locked).');
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Suggestion' }));
    expect(within(dialog()).getByRole('document', { name: 'Suggested entry' })).toBeVisible();
  });

  it('Use suggestion replaces the entry, closes the sheet, and offers Undo for 8 seconds; Undo restores the revision before it', async () => {
    const h = await withSuggestion();
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Use suggestion' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/journal/ai/run-1/accept')).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(editorText()).toContain('Hong Kong opened weak');
    expect(editorText()).not.toContain('didnt');
    const toast = screen.getByText('Replaced. Your version is in History.').parentElement as HTMLElement;
    expect(screen.getByText(/Revisions:/).textContent).toBe('Revisions: 5');
    expect(screen.getByText(/Last AI:/).textContent).toBe('Last AI: Polish at 17:05');
    await tick(7_500);
    expect(screen.getByText('Replaced. Your version is in History.')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(
      h.calls.some((c) => c.method === 'POST' && c.url === `/api/journal/entries/${DATE}/revisions/3/restore`),
    ).toBe(true);
    expect(editorText()).toContain('didnt sell the put');
    expect(screen.getByText('Undone.')).toBeInTheDocument();
  });

  it('the Undo toast goes away after 8 seconds', async () => {
    await withSuggestion();
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Use suggestion' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    await tick(8_100);
    expect(screen.queryByText('Replaced. Your version is in History.')).toBeNull();
  });

  it('Keep mine rejects the suggestion, closes the sheet, and leaves the entry exactly as it was', async () => {
    const h = await withSuggestion();
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Keep mine' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/journal/ai/run-1/reject')).toBe(true);
    expect(h.calls.some((c) => c.url.endsWith('/accept'))).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(editorText()).toContain('didnt sell the put');
    expect(screen.queryByRole('button', { name: /Suggestion ready/ })).toBeNull();
  });

  it('Try again goes back to Choose and keeps what was picked', async () => {
    await withSuggestion();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Try again' }));
    expect(stage()).toBe('Choose');
    expect(within(dialog()).getByRole('radio', { name: /Polish/ })).toBeChecked();
  });

  it('says the entry changed (entry_changed) and keeps the sheet open on that message, with Try again', async () => {
    const h = await withSuggestion();
    h.state.acceptError = apiError(
      409,
      'entry_changed',
      'You edited this entry after the suggestion was made. Ask again to get one for what you have now.',
    );
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Use suggestion' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(dialog()).toBeInTheDocument();
    expect(within(dialog()).getByRole('alert')).toHaveTextContent(
      'You edited this entry after the suggestion was made.',
    );
    expect(editorText()).toContain('didnt sell the put');
    expect(screen.queryByText('Replaced. Your version is in History.')).toBeNull();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Try again' }));
    expect(stage()).toBe('Choose');
  });

  it('what is typed after the suggestion was made is saved first, so accepting is refused instead of overwriting it', async () => {
    const h = await withSuggestion();
    h.state.acceptError = apiError(409, 'entry_changed', 'You edited this entry after the suggestion was made.');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Typed after the suggestion' } });
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Use suggestion' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    const puts = h.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    const putAt = h.calls.indexOf(puts[0] as Call);
    const acceptAt = h.calls.findIndex((c) => c.url.endsWith('/accept'));
    expect(putAt).toBeLessThan(acceptAt);
    expect(screen.getByLabelText('Title')).toHaveValue('Typed after the suggestion');
  });
});

describe('a failed run', () => {
  it('shows the error in words and offers Try again; the entry is untouched', async () => {
    const h = stubServer();
    h.state.current = run({
      status: 'failed',
      error: 'The suggestion was refused and nothing was changed. A number changed: 62.5.',
    });
    mount();
    await startPolish(h);
    await tick(0);
    expect(stage()).toBe('Failed');
    expect(within(dialog()).getByRole('alert')).toHaveTextContent(
      'The suggestion was refused and nothing was changed.',
    );
    expect(footerButtons()).toEqual(['Close', 'Try again']);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Try again' }));
    expect(stage()).toBe('Choose');
    expect(editorText()).toContain('didnt sell the put');
  });
});

describe('the footer line', () => {
  it('says "none yet" without an accepted suggestion, and names the last one with its mode and time', () => {
    stubServer();
    const { unmount } = render(
      <ToastProvider>
        <EditorBody
          date={DATE}
          server={entry()}
          local={null}
          offline={false}
          onBack={() => undefined}
          onDeleted={() => undefined}
          onChanged={() => undefined}
        />
      </ToastProvider>,
    );
    expect(screen.getByText(/Last AI:/).textContent).toBe('Last AI: none yet');
    unmount();
    render(
      <ToastProvider>
        <EditorBody
          date={DATE}
          server={entry({ lastAi: { mode: 'tighten', at: new Date(2026, 9, 13, 16, 42).toISOString() } })}
          local={null}
          offline={false}
          onBack={() => undefined}
          onDeleted={() => undefined}
          onChanged={() => undefined}
        />
      </ToastProvider>,
    );
    expect(screen.getByText(/Last AI:/).textContent).toBe('Last AI: Tighten at 16:42');
  });

  it('copes with a suggestion accepted without a recorded mode', () => {
    stubServer();
    mount(entry({ lastAi: { mode: null, at: new Date(2026, 9, 13, 16, 42).toISOString() } }));
    expect(screen.getByText(/Last AI:/).textContent).toBe('Last AI: AI at 16:42');
  });
});

describe('the sheet is an ordinary sheet', () => {
  it('closes with Escape and gives the editor back, even while a run is going', async () => {
    const h = stubServer();
    mount();
    await startPolish(h);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /AI is writing…/ })).toBeInTheDocument();
    // the autosave still works with it closed
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'still typing' } });
    await tick(DEBOUNCE_MS + 50);
    expect(h.calls.some((c) => c.method === 'PUT')).toBe(true);
  });
});
