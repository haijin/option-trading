import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type JournalDocJson, renderMarkdown } from '../../../../src/journal';
import type { JournalEntryInput, JournalEntryView } from '../../api/types';
import { ToastProvider } from '../../state/toast';
import { DEBOUNCE_MS } from './autosave';
import { EditorBody } from './EditorBody';
import { blankDraft } from './entryModel';
import { localKey, makeLocalCopy, readLocalCopy, writeLocalCopy } from './localCopy';

const DATE = '2026-10-13';
const docOf = (text: string): JournalDocJson => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function entry(patch: Partial<JournalEntryView> = {}): JournalEntryView {
  const doc = docOf('HK open weak again and I did not sell');
  return {
    id: 'e1',
    date: DATE,
    title: 'Evening review',
    template: 'evening',
    marketView: 'neutral',
    tags: ['hk'],
    status: 'draft',
    wordCount: 412,
    excerpt: '',
    mentions: [],
    thumbnailAssetId: null,
    aiPolished: false,
    updatedAt: new Date(2026, 9, 13, 16, 42).toISOString(),
    doc,
    markdown: renderMarkdown(doc),
    revisionNo: 3,
    createdAt: new Date(2026, 9, 13, 9, 12).toISOString(),
    revisionCount: 3,
    lastAi: null,
    ...patch,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Sent {
  method: string;
  url: string;
  body: JournalEntryInput | null;
  keepalive: boolean;
}

function stubServer(handler: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      // the AI rewrite lookup on opening the editor is not what these tests are about: no run
      if (url.endsWith('/ai')) return json(null);
      const request: Sent = {
        method: init.method ?? 'GET',
        url,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as JournalEntryInput) : null,
        keepalive: init.keepalive === true,
      };
      sent.push(request);
      return handler(request);
    }),
  );
  return sent;
}

function mount(
  server: JournalEntryView | null,
  props: { local?: ReturnType<typeof makeLocalCopy> | null; offline?: boolean } = {},
) {
  const onChanged = vi.fn();
  render(
    <ToastProvider>
      <EditorBody
        date={DATE}
        server={server}
        local={props.local ?? null}
        offline={props.offline ?? false}
        onBack={() => undefined}
        onDeleted={() => undefined}
        onChanged={onChanged}
      />
    </ToastProvider>,
  );
  return { onChanged, title: screen.getByLabelText('Title') as HTMLInputElement };
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

describe('the editor body', () => {
  it('opens on the server entry with the saved line, footer and fields filled in', () => {
    stubServer(() => json({}));
    const { title } = mount(entry());
    expect(screen.getByText('Tue 13 Oct 2026')).toBeInTheDocument();
    expect(screen.getAllByRole('status').some((el) => el.textContent === 'Saved 16:42 · 412 words')).toBe(true);
    expect(title.value).toBe('Evening review');
    expect(screen.getByLabelText('Tags')).toHaveValue('#hk');
    expect(screen.getByRole('radio', { name: 'Neutral' })).toBeChecked();
    expect(screen.getByText(/Revisions:/).textContent).toBe('Revisions: 3');
    expect(screen.getByText(/Template:/).textContent).toBe('Template: Evening review');
    expect(screen.getByRole('textbox', { name: 'Entry text' })).toHaveTextContent(
      'HK open weak again and I did not sell',
    );
  });

  it('shows Saving… at once, saves 1.5 s later with the loaded revisionNo, then shows Saved with the server word count', async () => {
    const sent = stubServer((s) =>
      json(entry({ title: s.body?.title ?? null, revisionNo: 4, revisionCount: 4, wordCount: 7 })),
    );
    const { title, onChanged } = mount(entry());
    fireEvent.change(title, { target: { value: 'Evening review, edited' } });
    expect(screen.getAllByRole('status').some((el) => el.textContent === 'Saving…')).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 50);
    });
    expect(sent).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('PUT');
    expect(sent[0]?.url).toBe(`/api/journal/entries/${DATE}`);
    expect(sent[0]?.body).toMatchObject({
      title: 'Evening review, edited',
      revisionNo: 3,
      marketView: 'neutral',
      tags: ['hk'],
    });
    // the server derives these itself: the client never sends them
    expect(sent[0]?.body).not.toHaveProperty('markdown');
    expect(sent[0]?.body).not.toHaveProperty('wordCount');
    expect(screen.getAllByRole('status').some((el) => /^Saved \d\d:\d\d · 7 words$/.test(el.textContent ?? ''))).toBe(
      true,
    );
    expect(screen.getByText(/Revisions:/).textContent).toBe('Revisions: 4');
    expect(onChanged).toHaveBeenCalled();
    // the next save carries the revision the last one returned
    fireEvent.change(title, { target: { value: 'Evening review, edited again' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    });
    expect(sent[1]?.body?.revisionNo).toBe(4);
  });

  it('saves a changed market view at once', async () => {
    const sent = stubServer((s) => json(entry({ marketView: s.body?.marketView ?? 'neutral', revisionNo: 4 })));
    mount(entry());
    fireEvent.click(screen.getByRole('radio', { name: 'Bearish' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(sent[0]?.body?.marketView).toBe('bearish');
  });

  it('never replaces what is being typed with the server response', async () => {
    stubServer(() => json(entry({ title: 'SERVER TITLE', revisionNo: 4 })));
    const { title } = mount(entry());
    fireEvent.change(title, { target: { value: 'my words' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    });
    expect(title.value).toBe('my words');
  });

  it('says the connection is down, keeps the copy on the phone, and recovers when it is back', async () => {
    let up = false;
    const sent = stubServer((s) => {
      if (!up) throw new TypeError('Failed to fetch');
      return json(entry({ title: s.body?.title ?? null, revisionNo: 4, wordCount: 9 }));
    });
    const { title } = mount(entry());
    fireEvent.change(title, { target: { value: 'typed on the train' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    });
    expect(screen.getAllByRole('status').some((el) => el.textContent === 'Offline, saved on this phone')).toBe(true);
    const kept = readLocalCopy(DATE);
    expect(kept?.title).toBe('typed on the train');
    expect(kept?.synced).toBe(false);
    up = true;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(sent.length).toBeGreaterThan(1);
    expect(screen.getAllByRole('status').some((el) => /^Saved \d\d:\d\d · 9 words$/.test(el.textContent ?? ''))).toBe(
      true,
    );
    expect(readLocalCopy(DATE)?.synced).toBe(true);
  });

  it('asks what to do on 409: Reload takes the other version, Keep mine resends over it', async () => {
    let conflicts = 1;
    const sent = stubServer((s) => {
      if (s.method === 'PUT' && conflicts-- > 0) {
        return json(
          { error: { code: 'revision_conflict', message: 'changed', details: { currentRevisionNo: 7 } } },
          409,
        );
      }
      return json(entry({ title: s.body?.title ?? null, revisionNo: 8 }));
    });
    const { title } = mount(entry());
    fireEvent.change(title, { target: { value: 'mine' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    });
    expect(screen.getByRole('dialog', { name: 'This entry changed on another device' })).toBeInTheDocument();
    expect(screen.getAllByRole('status').some((el) => el.textContent === 'Not saved: changed on another device')).toBe(
      true,
    );
    // the dialog cannot be dismissed with Escape: a choice has to be made
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(sent.filter((s) => s.method === 'PUT')).toHaveLength(2);
    expect(sent.filter((s) => s.method === 'PUT')[1]?.body?.revisionNo).toBe(7);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(title.value).toBe('mine');
  });

  it('reloads the other version on 409 when asked', async () => {
    const other = entry({ title: 'Other device', revisionNo: 7, doc: docOf('written elsewhere') });
    const sent = stubServer((s) => {
      if (s.method === 'PUT') {
        return json(
          { error: { code: 'revision_conflict', message: 'changed', details: { currentRevisionNo: 7 } } },
          409,
        );
      }
      return json(other);
    });
    const { title } = mount(entry());
    fireEvent.change(title, { target: { value: 'mine' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(title.value).toBe('Other device');
    expect(screen.getByRole('textbox', { name: 'Entry text' })).toHaveTextContent('written elsewhere');
    expect(screen.queryByRole('dialog')).toBeNull();
    // putting the other version into the editor is not an edit: nothing is saved for it
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    });
    expect(sent.filter((s) => s.method === 'PUT')).toHaveLength(1);
    expect(screen.getAllByRole('status').some((el) => /^Saved /.test(el.textContent ?? ''))).toBe(true);
  });

  it('offers the copy kept on the phone when it differs, and uses it on request', async () => {
    const sent = stubServer((s) => json(entry({ title: s.body?.title ?? null, revisionNo: 4 })));
    const local = makeLocalCopy(
      DATE,
      { ...blankDraft(), title: 'Typed offline', doc: docOf('offline words') },
      3,
      false,
      Date.now() + 60_000,
    );
    writeLocalCopy(local);
    mount(entry(), { local });
    expect(screen.getByText(/was never sent/)).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Evening review');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use the copy saved on this phone' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByLabelText('Title')).toHaveValue('Typed offline');
    expect(screen.getByRole('textbox', { name: 'Entry text' })).toHaveTextContent('offline words');
    expect(screen.queryByText(/was never sent/)).toBeNull();
    expect(sent[0]?.body?.title).toBe('Typed offline');
  });

  it('can discard the copy kept on the phone', () => {
    stubServer(() => json({}));
    const local = makeLocalCopy(
      DATE,
      { ...blankDraft(), title: 'Typed offline', doc: docOf('offline words') },
      3,
      false,
      Date.now() + 60_000,
    );
    writeLocalCopy(local);
    mount(entry(), { local });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByText(/was never sent/)).toBeNull();
    expect(screen.getByLabelText('Title')).toHaveValue('Evening review');
    expect(readLocalCopy(DATE)?.synced).toBe(true);
    expect(localStorage.getItem(localKey(DATE))).not.toBeNull();
  });

  it('opens an empty day without creating anything on the server, with the template chooser', async () => {
    const sent = stubServer(() => json({}));
    mount(null);
    expect(screen.getAllByRole('status').some((el) => el.textContent === 'Saves as you type')).toBe(true);
    expect(screen.getByRole('button', { name: 'Morning plan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Weekly review' })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4);
    });
    expect(sent).toHaveLength(0);
  });

  it('applies a template on an empty day: it is sent at once with source "template" and revisionNo null', async () => {
    const sent = stubServer((s) =>
      json(entry({ revisionNo: 1, template: s.body?.template ?? null, doc: s.body?.doc as JournalDocJson })),
    );
    mount(null);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Evening review' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ template: 'evening', revisionNo: null, source: 'template' });
    expect(screen.getByRole('textbox', { name: 'Entry text' })).toHaveTextContent('What happened');
    expect(screen.queryByRole('button', { name: 'Morning plan' })).toBeNull();
  });

  it('opens offline on the copy from the phone when the server cannot be reached', () => {
    stubServer(() => json({}));
    const local = makeLocalCopy(DATE, { ...blankDraft(), title: 'From the phone', doc: docOf('words') }, 3, true);
    mount(null, { local, offline: true });
    expect(screen.getByLabelText('Title')).toHaveValue('From the phone');
    expect(screen.getAllByRole('status').some((el) => el.textContent === 'Offline, saved on this phone')).toBe(true);
  });

  it('saves at once with keepalive when the page is hidden or goes away', async () => {
    const sent = stubServer((s) => json(entry({ title: s.body?.title ?? null, revisionNo: 4 })));
    const { title } = mount(entry());
    fireEvent.change(title, { target: { value: 'typed, then the tab was switched away' } });
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.keepalive).toBe(true);
    expect(sent[0]?.body?.title).toBe('typed, then the tab was switched away');
    // visibilitychange to hidden does the same
    fireEvent.change(title, { target: { value: 'and again' } });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(10);
    });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.keepalive).toBe(true);
    expect(sent[1]?.body?.revisionNo).toBe(4);
  });

  it('saves when the title field loses focus, without waiting for the pause', async () => {
    const sent = stubServer((s) => json(entry({ title: s.body?.title ?? null, revisionNo: 4 })));
    const { title } = mount(entry());
    fireEvent.change(title, { target: { value: 'blurred' } });
    await act(async () => {
      fireEvent.blur(title);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.keepalive).toBe(false);
  });

  it('adopts the revision number a close returns, so the next save does not conflict with it', async () => {
    const sent = stubServer((s) => {
      if (s.url.endsWith('/close')) return json(entry({ status: 'closed', revisionNo: 9 }));
      return json(entry({ title: s.body?.title ?? null, revisionNo: 10 }));
    });
    const { title } = mount(entry());
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Close day/ }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(sent.at(-1)?.url).toBe(`/api/journal/entries/${DATE}/close`);
    expect(screen.getByText(/Status:/).textContent).toBe('Status: Closed');
    fireEvent.change(title, { target: { value: 'edited after closing' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    });
    expect(sent.at(-1)?.body?.revisionNo).toBe(9);
  });

  it('deletes with an Undo toast that restores the entry', async () => {
    const sent = stubServer((s) => (s.method === 'DELETE' ? json({ ok: true }) : json(entry())));
    const onDeleted = vi.fn();
    render(
      <ToastProvider>
        <EditorBody
          date={DATE}
          server={entry()}
          local={null}
          offline={false}
          onBack={() => undefined}
          onDeleted={onDeleted}
          onChanged={() => undefined}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete entry' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(sent.some((s) => s.method === 'DELETE' && s.url === `/api/journal/entries/${DATE}`)).toBe(true);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Deleted.')).toBeInTheDocument();
    // the Undo stays for 10 seconds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_500);
    });
    // (the toolbar has an Undo button of its own, so look inside the toast)
    const toast = screen.getByText('Deleted.').parentElement as HTMLElement;
    expect(within(toast).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(sent.some((s) => s.method === 'POST' && s.url.endsWith('/undelete'))).toBe(true);
    // a deleted entry is not saved again by a late timer
    expect(sent.filter((s) => s.method === 'PUT')).toHaveLength(0);
  });

  it('opens the menu as a labelled modal dialog and closes it with Escape', () => {
    stubServer(() => json({}));
    mount(entry());
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const dialog = screen.getByRole('dialog', { name: 'Tue 13 Oct 2026' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: /History/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply a template' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export as Markdown' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Close day/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete entry' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('disables History, Export, Close and Delete for a day that is not on the server yet', () => {
    stubServer(() => json({}));
    mount(null);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('button', { name: /History/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export as Markdown' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete entry' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apply a template' })).toBeEnabled();
  });
});
