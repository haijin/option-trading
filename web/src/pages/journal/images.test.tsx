import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type JournalDocJson, type JournalNodeJson, renderMarkdown } from '../../../../src/journal';
import type { JournalEntryInput, JournalEntryView } from '../../api/types';
import { ToastProvider } from '../../state/toast';
import { DEBOUNCE_MS } from './autosave';
import { EditorBody } from './EditorBody';
import { readLocalCopy } from './localCopy';
import { FakeXhr } from './testXhr';

const DATE = '2026-10-13';
const REAL = '11111111-1111-4111-8111-111111111111';
const docOf = (...content: JournalNodeJson[]): JournalDocJson => ({ type: 'doc', content });
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

function entry(patch: Partial<JournalEntryView> = {}): JournalEntryView {
  const doc = docOf(para('HK open weak again'));
  return {
    id: 'e1',
    date: DATE,
    title: 'Evening review',
    template: 'evening',
    marketView: 'neutral',
    tags: [],
    status: 'draft',
    wordCount: 4,
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

/** Every PUT body the editor sent, with the server answering as the real one does. */
function stubServer() {
  const puts: JournalEntryInput[] = [];
  let revision = 3;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit = {}) => {
      if (init.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as JournalEntryInput;
        puts.push(body);
        revision += 1;
        return json(entry({ doc: body.doc, title: body.title, revisionNo: revision, wordCount: 9 }));
      }
      return json({});
    }),
  );
  return puts;
}

async function mount(server: JournalEntryView | null = entry()) {
  await act(async () => {
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
    await vi.advanceTimersByTimeAsync(0);
  });
  return {
    pm: screen.getByRole('textbox', { name: 'Entry text' }),
    title: screen.getByLabelText('Title') as HTMLInputElement,
  };
}

const png = (name = 'chart.png', size = 1000) => new File([new Uint8Array(size)], name, { type: 'image/png' });
const statusText = () => screen.getAllByRole('status').map((el) => el.textContent ?? '');
const hasStatus = (re: RegExp) => statusText().some((t) => re.test(t));
const picker = () => screen.getByTestId('jr-image-input') as HTMLInputElement;
const tick = (ms = 10) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

async function pick(files: File[]) {
  await act(async () => {
    fireEvent.change(picker(), { target: { files } });
    await vi.advanceTimersByTimeAsync(0);
  });
}

// jsdom has no layout: ProseMirror asks ranges for their rectangles when it scrolls the cursor into view
const emptyRect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => emptyRect as DOMRect;

beforeEach(() => {
  localStorage.clear();
  FakeXhr.reset();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:preview', revokeObjectURL: () => undefined }));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const figureBox = (state: string) => document.querySelector(`.jr-figbox[data-state="${state}"]`);

describe('adding an image from the file picker', () => {
  it('has an Image button that opens a picker offering the camera and the photo library, several files at once', async () => {
    stubServer();
    await mount();
    expect(screen.getByRole('button', { name: 'Image' })).toBeInTheDocument();
    expect(picker()).toHaveAttribute('accept', 'image/*');
    expect(picker()).toHaveAttribute('multiple');
    const click = vi.spyOn(picker(), 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Image' }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('shows the picture at once with a progress ring, says it is uploading (not Saved), and uploads in the field "file"', async () => {
    stubServer();
    await mount();
    await pick([png('shot.png', 2048)]);
    expect(figureBox('uploading')).not.toBeNull();
    expect(figureBox('uploading')?.querySelector('img')).toHaveAttribute('src', 'blob:preview');
    expect(screen.getByRole('progressbar', { name: 'Uploading' })).toHaveAttribute('aria-valuenow', '0');
    expect(hasStatus(/^Uploading image…$/)).toBe(true);
    expect(hasStatus(/^Saved/)).toBe(false);
    expect(FakeXhr.last().url).toBe('/api/journal/assets');
    expect(FakeXhr.last().file?.name).toBe('shot.png');
    act(() => FakeXhr.last().progress(500, 1000));
    expect(screen.getByRole('progressbar', { name: 'Uploading' })).toHaveAttribute('aria-valuenow', '50');
  });

  it('never sends or keeps a figure that has no real id: a save while it uploads carries the text only', async () => {
    const puts = stubServer();
    const { title } = await mount();
    await pick([png()]);
    fireEvent.change(title, { target: { value: 'Edited while the image uploads' } });
    await tick(DEBOUNCE_MS + 50);
    expect(puts).toHaveLength(1);
    expect(JSON.stringify(puts[0])).not.toContain('pending-');
    expect(JSON.stringify(puts[0]?.doc)).not.toContain('figure');
    expect(JSON.stringify(readLocalCopy(DATE))).not.toContain('pending-');
    // the save landed but the picture has not: the header must not say "Saved"
    expect(hasStatus(/^Uploading image…$/)).toBe(true);
    expect(hasStatus(/^Saved/)).toBe(false);
  });

  it('on success the figure takes the real id and the next save carries it', async () => {
    const puts = stubServer();
    await mount();
    await pick([png()]);
    await act(async () => {
      FakeXhr.last().respond(201, { id: REAL, url: `/api/journal/assets/${REAL}`, width: 800, height: 600 });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(document.querySelector(`figure[data-asset-id="${REAL}"]`)).not.toBeNull();
    expect(figureBox('uploading')).toBeNull();
    await tick(DEBOUNCE_MS + 50);
    expect(puts).toHaveLength(1);
    const figures = (puts[0]?.doc.content ?? []).filter((n) => n.type === 'figure');
    expect(figures).toHaveLength(1);
    expect(figures[0]?.attrs).toEqual({ assetId: REAL, caption: null });
    expect(hasStatus(/^Saved \d\d:\d\d · 9 words$/)).toBe(true);
    expect(readLocalCopy(DATE)?.doc.content?.some((n) => n.type === 'figure')).toBe(true);
  });

  it('on failure keeps a placeholder with the reason, Retry and Remove; Retry uploads the same file again', async () => {
    stubServer();
    await mount();
    await pick([png('again.png')]);
    await act(async () => {
      FakeXhr.last().respond(415, { error: { code: 'unsupported_image', message: 'x' } });
      await vi.advanceTimersByTimeAsync(10);
    });
    const failed = figureBox('failed') as HTMLElement;
    expect(failed).not.toBeNull();
    expect(within(failed).getByText('Upload failed')).toBeInTheDocument();
    expect(within(failed).getByText(/Only PNG, JPEG, WebP, GIF or HEIC images/)).toBeInTheDocument();
    expect(hasStatus(/^Image not uploaded\. Retry or remove it$/)).toBe(true);
    expect(hasStatus(/^Saved/)).toBe(false);
    await act(async () => {
      fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(FakeXhr.instances).toHaveLength(2);
    expect(FakeXhr.last().file?.name).toBe('again.png');
    expect(figureBox('uploading')).not.toBeNull();
    await act(async () => {
      FakeXhr.last().respond(201, { id: REAL, url: `/api/journal/assets/${REAL}`, width: 1, height: 1 });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(document.querySelector(`figure[data-asset-id="${REAL}"]`)).not.toBeNull();
  });

  it('Remove on a failed upload takes the figure out and clears the warning', async () => {
    stubServer();
    await mount();
    await pick([png()]);
    await act(async () => {
      FakeXhr.last().fail();
      await vi.advanceTimersByTimeAsync(10);
    });
    const failed = figureBox('failed') as HTMLElement;
    expect(within(failed).getByText(/Cannot reach the server/)).toBeInTheDocument();
    fireEvent.click(within(failed).getByRole('button', { name: 'Remove' }));
    expect(document.querySelector('figure')).toBeNull();
    expect(hasStatus(/^Image not uploaded/)).toBe(false);
  });

  it('removing a picture that is still uploading stops the upload', async () => {
    stubServer();
    await mount();
    await pick([png()]);
    const xhr = FakeXhr.last();
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    expect(xhr.aborted).toBe(true);
    expect(document.querySelector('figure')).toBeNull();
    expect(hasStatus(/^Uploading/)).toBe(false);
  });

  it('adds one figure per picked file, in order', async () => {
    stubServer();
    await mount();
    await pick([png('one.png'), png('two.png'), png('three.png')]);
    expect(document.querySelectorAll('figure')).toHaveLength(3);
    expect(FakeXhr.instances.map((x) => x.file?.name)).toEqual(['one.png', 'two.png', 'three.png']);
    expect(hasStatus(/^Uploading 3 images…$/)).toBe(true);
  });

  it('refuses a file over 8 MB before sending anything, and says so', async () => {
    stubServer();
    await mount();
    await pick([png('big.png', 9 * 1024 * 1024)]);
    expect(FakeXhr.instances).toHaveLength(0);
    expect(document.querySelector('figure')).toBeNull();
    expect(screen.getByText('big.png: This image is 9.0 MB. Images are limited to 8 MB.')).toBeInTheDocument();
  });
});

describe('pasting and dropping images', () => {
  it('uploads an image from the clipboard (an iOS screenshot) and does not paste text', async () => {
    stubServer();
    const { pm } = await mount();
    const shot = png('image.png');
    const event = fireEvent.paste(pm, {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => shot }],
        files: [shot],
        types: ['Files'],
        getData: () => '',
      },
    });
    expect(event).toBe(false); // preventDefault was called: the browser's own paste did not run
    expect(FakeXhr.instances).toHaveLength(1);
    expect(FakeXhr.last().file?.name).toBe('image.png');
    await tick();
    expect(document.querySelectorAll('figure')).toHaveLength(1);
  });

  it('leaves an ordinary text paste alone', async () => {
    stubServer();
    const { pm } = await mount();
    fireEvent.paste(pm, {
      clipboardData: {
        items: [],
        files: [],
        types: ['text/plain'],
        getData: (f: string) => (f === 'text/plain' ? 'just words' : ''),
      },
    });
    expect(FakeXhr.instances).toHaveLength(0);
    expect(document.querySelector('figure')).toBeNull();
  });
});

describe('a stored figure', () => {
  const withFigure = (caption: string | null = null) =>
    entry({ doc: docOf(para('before'), { type: 'figure', attrs: { assetId: REAL, caption } }, para('after')) });

  it('shows the stored image lazily, with its caption as the alt text and the field', async () => {
    stubServer();
    await mount(withFigure('Tencent held 600'));
    const img = document.querySelector('figure img') as HTMLImageElement;
    expect(img).toHaveAttribute('src', `/api/journal/assets/${REAL}`);
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('alt', 'Tencent held 600');
    expect(screen.getByLabelText('Caption')).toHaveValue('Tencent held 600');
    expect(screen.getByLabelText('Caption')).toHaveAttribute('maxlength', '300');
  });

  it('edits the caption into the document and saves it', async () => {
    const puts = stubServer();
    await mount(withFigure(null));
    fireEvent.change(screen.getByLabelText('Caption'), { target: { value: 'New caption' } });
    await tick(DEBOUNCE_MS + 50);
    const fig = (puts[0]?.doc.content ?? []).find((n) => n.type === 'figure');
    expect(fig?.attrs).toEqual({ assetId: REAL, caption: 'New caption' });
    // clearing it stores null, not an empty string
    fireEvent.change(screen.getByLabelText('Caption'), { target: { value: '' } });
    await tick(DEBOUNCE_MS + 50);
    expect((puts[1]?.doc.content ?? []).find((n) => n.type === 'figure')?.attrs?.caption).toBeNull();
  });

  it('removes the figure from the document with the Remove image button', async () => {
    const puts = stubServer();
    await mount(withFigure());
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    expect(document.querySelector('figure')).toBeNull();
    await tick(DEBOUNCE_MS + 50);
    expect(JSON.stringify(puts[0]?.doc)).not.toContain('figure');
  });

  it('falls back to a message with Try again and Remove when the image will not load', async () => {
    stubServer();
    await mount(withFigure());
    fireEvent.error(document.querySelector('figure img') as HTMLImageElement);
    const note = figureBox('broken') as HTMLElement;
    expect(within(note).getByText('Image not available')).toBeInTheDocument();
    fireEvent.click(within(note).getByRole('button', { name: 'Try again' }));
    expect(document.querySelector('figure img')).not.toBeNull();
    expect(figureBox('broken')).toBeNull();
  });

  it('shows a figure with no real id and no upload under way as never uploaded, with Remove', async () => {
    stubServer();
    await mount(
      entry({ doc: docOf(para('x'), { type: 'figure', attrs: { assetId: 'pending-9-zzz', caption: null } }) }),
    );
    const note = figureBox('orphan') as HTMLElement;
    expect(within(note).getByText('This image was never uploaded')).toBeInTheDocument();
    fireEvent.click(within(note).getByRole('button', { name: 'Remove' }));
    expect(document.querySelector('figure')).toBeNull();
  });
});
