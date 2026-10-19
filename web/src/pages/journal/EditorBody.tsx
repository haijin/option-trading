import type { Editor, JSONContent } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import {
  deriveFromDoc,
  isEmptyDoc,
  JOURNAL_LIMITS,
  JOURNAL_TEMPLATES,
  type JournalDocJson,
  type JournalMarketView,
  type JournalMentionRef,
  type JournalTemplateId,
  mentionLabel,
} from '../../../../src/journal';
import { errorMessage, isApiError } from '../../api/client';
import { api } from '../../api/endpoints';
import type { JournalAiAcceptView, JournalEntryView } from '../../api/types';
import { Icon } from '../../layout/Icon';
import { toHash } from '../../lib/route';
import { useToast } from '../../state/toast';
import { AiSheet } from './AiSheet';
import { aiModeLabel, DEFAULT_AI_CHOICES, startInputOf } from './aiModes';
import { Autosaver, autosaveText, type SaveStatus } from './autosave';
import { localTime, longDate } from './dates';
import { journalEditorExtensions } from './editorExtensions';
import {
  applyTemplateToDraft,
  blankDraft,
  type Draft,
  draftFromEntry,
  formatTags,
  parseTags,
  TEMPLATE_LABEL,
  type TemplateId,
} from './entryModel';
import { downloadMarkdown } from './exportMd';
import {
  clearLocalCopy,
  draftFromLocal,
  type LocalCopy,
  type LocalOffer,
  localOffer,
  makeLocalCopy,
  pruneLocalCopies,
  writeLocalCopy,
} from './localCopy';
import { ConflictSheet, HistorySheet, MoreSheet, TemplateSheet } from './Sheets';
import { Toolbar } from './Toolbar';
import {
  handleImageDrop,
  handleImagePaste,
  insertImageFiles,
  pendingFigureIds,
  stripPendingFigures,
  swapFigureId,
  UploadManager,
} from './uploads';
import { useAiRun } from './useAiRun';
import { useKeyboardPin } from './useKeyboardPin';

const VIEWS: { id: JournalMarketView; label: string }[] = [
  { id: 'bullish', label: 'Bullish' },
  { id: 'neutral', label: 'Neutral' },
  { id: 'bearish', label: 'Bearish' },
];

/** The `$` button explains itself once per page load, not on every tap. */
let stockHintShown = false;

export interface EditorBodyProps {
  date: string;
  /** The server's entry; null when the day has none yet. */
  server: JournalEntryView | null;
  /** The copy this phone kept for the day. */
  local: LocalCopy | null;
  /** The server could not be reached and the editor opened on `local`. */
  offline: boolean;
  /** Phone: the back arrow in the header. */
  onBack: () => void;
  /** The entry was deleted (the page leaves it and the toast offers Undo). */
  onDeleted: () => void;
  /** A save, restore, close or delete reached the server: lists and the calendar refetch. */
  onChanged: () => void;
}

interface Initial {
  draft: Draft;
  revisionNo: number | null;
  status: SaveStatus;
  offer: { kind: LocalOffer; copy: LocalCopy } | null;
  exists: boolean;
}

function initialOf({ server, local, offline }: Pick<EditorBodyProps, 'server' | 'local' | 'offline'>): Initial {
  if (server) {
    const kind = localOffer(local, server);
    return {
      draft: draftFromEntry(server),
      revisionNo: server.revisionNo,
      status: { kind: 'saved', at: Date.parse(server.updatedAt) || Date.now(), words: server.wordCount },
      offer: kind && local ? { kind, copy: local } : null,
      exists: true,
    };
  }
  if (offline && local) {
    return {
      draft: draftFromLocal(local),
      revisionNo: local.revisionNo,
      status: { kind: 'offline' },
      offer: null,
      exists: local.revisionNo !== null,
    };
  }
  const kind = localOffer(local, null);
  return {
    draft: blankDraft(),
    revisionNo: null,
    status: { kind: 'idle' },
    offer: kind && local ? { kind, copy: local } : null,
    exists: false,
  };
}

const sameMentions = (a: JournalMentionRef[], b: JournalMentionRef[]): boolean =>
  a.length === b.length && a.every((m, i) => m.market === b[i]?.market && m.symbol === b[i]?.symbol);

/**
 * One day's editor: header with the save state, title, market view, tags, detected names, the TipTap document, the
 * toolbar and the sheets. It owns the unsaved text; the server's answers only ever update the revision number and the
 * numbers shown, never the text a person is typing.
 */
export function EditorBody(props: EditorBodyProps) {
  const { date } = props;
  const toast = useToast();
  const propsRef = useRef(props);
  propsRef.current = props;
  const mounted = useRef(false);
  const [initial] = useState(() => initialOf(props));

  const draftRef = useRef<Draft>(initial.draft);
  const [title, setTitle] = useState(initial.draft.title);
  const [tagsText, setTagsText] = useState(formatTags(initial.draft.tags));
  const [view, setView] = useState<JournalMarketView>(initial.draft.marketView);
  const [template, setTemplate] = useState<JournalTemplateId | null>(initial.draft.template);
  const [names, setNames] = useState<JournalMentionRef[]>(() => deriveFromDoc(initial.draft.doc).mentions);
  const [empty, setEmpty] = useState(() => isEmptyDoc(initial.draft.doc));
  const [hasText, setHasText] = useState(() => deriveFromDoc(initial.draft.doc).wordCount > 0);
  const [aiChoices, setAiChoices] = useState(DEFAULT_AI_CHOICES);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(initial.status);
  const [meta, setMeta] = useState({
    revisionCount: props.server?.revisionCount ?? null,
    closed: props.server?.status === 'closed',
    exists: initial.exists,
    lastAi: props.server?.lastAi ?? null,
  });
  const [offer, setOffer] = useState(initial.offer);
  const [sheet, setSheet] = useState<'more' | 'history' | 'templates' | 'ai' | null>(null);
  const [conflict, setConflict] = useState<{ current: number | null } | null>(null);
  const namesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [saver] = useState(
    () =>
      new Autosaver(
        {
          save: (input, options) => api.putJournalEntry(date, input, { keepalive: options.keepalive }),
          // a figure still uploading has no real image id: it never goes to the server or the copy on the phone
          getDraft: () => ({ ...draftRef.current, doc: stripPendingFigures(draftRef.current.doc) }),
          onStatus: (s) => {
            if (mounted.current) setSaveStatus(s);
          },
          onSaved: (saved) => {
            if (mounted.current)
              setMeta({
                revisionCount: saved.revisionCount,
                closed: saved.status === 'closed',
                exists: true,
                lastAi: saved.lastAi,
              });
            propsRef.current.onChanged();
          },
          onConflict: (current) => {
            if (mounted.current) setConflict({ current });
          },
          onError: (error) => toast.error(error.message),
          mirror: (draft, revisionNo, synced) => {
            writeLocalCopy(makeLocalCopy(date, draft, revisionNo, synced));
          },
        },
        initial.revisionNo,
      ),
  );

  const [uploads] = useState(
    () => new UploadManager({ upload: (file, options) => api.uploadJournalImage(file, options) }),
  );
  const [uploadSummary, setUploadSummary] = useState({ pending: 0, failed: 0 });
  const [extensions] = useState(() => journalEditorExtensions({ uploads }));
  const editor = useEditor({
    extensions,
    content: initial.draft.doc as JSONContent,
    editorProps: {
      handlePaste: (_view, event) => handleImagePaste(event, insertFiles),
      handleDrop: (view, event, _slice, moved) =>
        handleImageDrop(event, moved, insertFiles, (left, top) => {
          try {
            // drop where the pointer is
            const at = view.posAtCoords({ left, top });
            if (at) editor.commands.setTextSelection(at.pos);
          } catch {
            // no layout to ask (a test, a hidden pane): drop at the cursor
          }
        }),
      attributes: {
        class: 'jr-doc',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Entry text',
        spellcheck: 'true',
        autocapitalize: 'sentences',
      },
    },
    onUpdate: ({ editor: e }) => docChanged(e),
    onBlur: () => void saver.flush(),
  });

  // ------------------------------------------------------------------------------------------ changes
  /** Refreshes the detected names shortly after typing stops (deriving them walks the whole document). */
  function scheduleNames(doc: JournalDocJson): void {
    if (namesTimer.current) clearTimeout(namesTimer.current);
    namesTimer.current = setTimeout(() => {
      const derived = deriveFromDoc(doc);
      setNames((prev) => (sameMentions(prev, derived.mentions) ? prev : derived.mentions));
      setHasText(derived.wordCount > 0);
    }, 250);
  }

  function docChanged(e: Editor): void {
    const doc = e.getJSON() as JournalDocJson;
    draftRef.current = { ...draftRef.current, doc };
    setEmpty(isEmptyDoc(doc));
    scheduleNames(doc);
    refreshUploads();
    saver.change();
  }

  /** Figures still uploading (or failed) in the document: the header says so instead of "Saved". */
  function refreshUploads(): void {
    const next = uploads.summary(pendingFigureIds(draftRef.current.doc));
    setUploadSummary((prev) => (prev.pending === next.pending && prev.failed === next.failed ? prev : next));
  }

  /** One figure per image, in order, each uploading in the background. */
  function insertFiles(files: File[]): void {
    insertImageFiles(editor, uploads, files, (message) => toast.error(message));
  }

  function onTitle(value: string): void {
    setTitle(value);
    draftRef.current = { ...draftRef.current, title: value };
    saver.change();
  }

  function onTags(value: string): void {
    setTagsText(value);
    draftRef.current = { ...draftRef.current, tags: parseTags(value) };
    saver.change();
  }

  function onView(next: JournalMarketView): void {
    setView(next);
    draftRef.current = { ...draftRef.current, marketView: next };
    saver.change({ immediate: true });
  }

  /** Puts a whole entry into the editor and the fields (Reload, Restore, "use the copy from this phone"). */
  function showDraft(d: Draft): void {
    editor.commands.setContent(d.doc as JSONContent, { emitUpdate: false });
    const doc = editor.getJSON() as JournalDocJson;
    draftRef.current = { ...d, doc };
    setTitle(d.title);
    setTagsText(formatTags(d.tags));
    setView(d.marketView);
    setTemplate(d.template);
    setEmpty(isEmptyDoc(doc));
    const derived = deriveFromDoc(doc);
    setNames(derived.mentions);
    setHasText(derived.wordCount > 0);
    refreshUploads();
  }

  /** The editor now equals this server entry. */
  function adoptServerEntry(entry: JournalEntryView): void {
    showDraft(draftFromEntry(entry));
    saver.adopt(entry);
    writeLocalCopy(makeLocalCopy(date, draftRef.current, entry.revisionNo, true));
    setMeta({
      revisionCount: entry.revisionCount,
      closed: entry.status === 'closed',
      exists: true,
      lastAi: entry.lastAi,
    });
    setConflict(null);
    propsRef.current.onChanged();
  }

  // ------------------------------------------------------------------------------------------ lifecycle
  useEffect(() => {
    mounted.current = true;
    saver.start();
    pruneLocalCopies();
    return () => {
      mounted.current = false;
      if (namesTimer.current) clearTimeout(namesTimer.current);
      saver.stop();
    };
  }, [saver]);

  // An upload finished: the figure takes the real image id (an edit like any other, so it is saved), and the header follows the uploads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshUploads only reads refs and setters
  useEffect(() => {
    uploads.onUploaded = (tempId, asset) => {
      if (!editor.isDestroyed) swapFigureId(editor, tempId, asset.id);
    };
    const unsubscribe = uploads.subscribe(() => {
      if (mounted.current) refreshUploads();
    });
    return () => {
      unsubscribe();
      uploads.onUploaded = null;
    };
  }, [uploads, editor]);
  useEffect(() => () => uploads.dispose(), [uploads]);

  // Page hide and the connection coming back. iOS kills background tabs without warning, so hide saves with keepalive.
  useEffect(() => {
    const onHide = () => void saver.flush({ keepalive: true });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHide();
    };
    const onOnline = () => saver.retryNow();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('online', onOnline);
    };
  }, [saver]);

  const toolbarRef = useRef<HTMLDivElement>(null);
  const inTable = useEditorState({ editor, selector: ({ editor: e }) => e.isActive('table') });
  useKeyboardPin(toolbarRef, editor, inTable);

  // ------------------------------------------------------------------------------------------ actions
  const fail = (error: unknown) => toast.error(errorMessage(error));

  // ---- AI rewrite: a suggestion that changes nothing until Use suggestion
  const { controller: ai, state: aiState } = useAiRun(date, {
    // a run works from the server's copy: what is typed is saved first
    ensureSaved: async () => {
      await saver.flush();
      return !saver.hasUnsaved && !saver.inConflict;
    },
    onAccepted: (result) => acceptedByAuthor(result),
    onCancelled: () => toast.push('Run cancelled. Nothing changed.'),
  });

  useEffect(() => {
    if (initial.exists) void ai.resume();
  }, [ai, initial.exists]);
  useEffect(() => ai.setSheetOpen(sheet === 'ai'), [ai, sheet]);

  /** The suggestion replaced the entry. Undo restores the revision that held the author's own version. */
  function acceptedByAuthor({ entry, undoRevisionNo }: JournalAiAcceptView): void {
    if (mounted.current && !editor.isDestroyed) adoptServerEntry(entry);
    else propsRef.current.onChanged();
    setSheet(null);
    toast.push('Replaced. Your version is in History.', 'info', {
      ms: 8_000,
      ...(undoRevisionNo !== null ? { actionLabel: 'Undo', onAction: () => void undoAiRewrite(undoRevisionNo) } : {}),
    });
  }

  async function undoAiRewrite(no: number): Promise<void> {
    try {
      // anything typed since is saved first, so it stays in History
      if (mounted.current) await saver.flush();
      const restored = await api.restoreJournalRevision(date, no);
      if (mounted.current && !editor.isDestroyed) adoptServerEntry(restored);
      else propsRef.current.onChanged();
      toast.push('Undone.');
    } catch (error) {
      fail(error);
    }
  }

  const aiBusy = aiState.phase.kind === 'running' || aiState.phase.kind === 'starting';
  const aiHasRun =
    aiState.phase.kind === 'running' || aiState.phase.kind === 'result' || aiState.phase.kind === 'failed';
  /** Why a new rewrite cannot start now; null when it can. */
  const aiReason: string | null =
    aiState.unavailable ??
    (!hasText
      ? 'There is no text to rewrite yet. Write something first.'
      : uploadSummary.pending > 0
        ? 'Wait for the image to finish uploading, then rewrite.'
        : conflict
          ? 'This entry changed on another device. Choose Reload or Keep mine first.'
          : null);

  function pressAi(): void {
    if (!aiHasRun && aiReason) {
      toast.push(aiReason);
      return;
    }
    setSheet('ai');
  }

  async function applyTemplate(id: TemplateId): Promise<void> {
    setSheet(null);
    await saver.flush(); // what was typed so far is saved first, so it stays in History
    const current: Draft = { ...draftRef.current, doc: editor.getJSON() as JournalDocJson };
    const { draft: next, appended } = applyTemplateToDraft(current, id);
    showDraft(next);
    saver.change({ source: 'template', immediate: true });
    toast.push(appended ? 'Template appended below your text.' : 'Template added.');
  }

  async function openHistory(): Promise<void> {
    setSheet(null);
    await saver.flush();
    setSheet('history');
  }

  async function restore(no: number): Promise<void> {
    await saver.flush();
    try {
      const entry = await api.restoreJournalRevision(date, no);
      adoptServerEntry(entry);
      setSheet(null);
      toast.push('Restored as a new revision. Nothing was deleted.');
    } catch (error) {
      fail(error);
    }
  }

  async function exportMarkdown(): Promise<void> {
    setSheet(null);
    await saver.flush();
    try {
      await downloadMarkdown(date);
      toast.push('Markdown saved.');
    } catch (error) {
      fail(error);
    }
  }

  async function toggleClosed(): Promise<void> {
    setSheet(null);
    await saver.flush();
    try {
      const entry = await api.closeJournalEntry(date, meta.closed);
      saver.setRevision(entry.revisionNo);
      setMeta((m) => ({ ...m, closed: entry.status === 'closed', revisionCount: entry.revisionCount }));
      toast.push(entry.status === 'closed' ? 'Day closed. You can still edit it.' : 'Day reopened.');
      propsRef.current.onChanged();
    } catch (error) {
      fail(error);
    }
  }

  async function deleteEntry(): Promise<void> {
    setSheet(null);
    await saver.flush();
    try {
      await api.deleteJournalEntry(date);
    } catch (error) {
      fail(error);
      return;
    }
    saver.discard();
    clearLocalCopy(date);
    toast.push('Deleted.', 'info', {
      actionLabel: 'Undo',
      ms: 10_000,
      onAction: () => {
        api.undeleteJournalEntry(date).then(
          () => {
            toast.push('Entry restored.');
            propsRef.current.onChanged();
          },
          (error: unknown) => toast.error(errorMessage(error)),
        );
      },
    });
    propsRef.current.onChanged();
    propsRef.current.onDeleted();
  }

  async function reload(): Promise<void> {
    try {
      adoptServerEntry(await api.journalEntry(date));
    } catch (error) {
      if (isApiError(error) && error.status === 404) {
        // deleted on the other device: keep what is typed here and save it as a new entry
        toast.push('The other device deleted this entry. Your text is kept and will be saved again.');
        saver.keepMine(null);
        setConflict(null);
        return;
      }
      fail(error);
    }
  }

  async function keepMine(): Promise<void> {
    let revisionNo = conflict?.current ?? null;
    if (revisionNo === null) {
      try {
        revisionNo = (await api.journalEntry(date)).revisionNo;
      } catch (error) {
        if (!(isApiError(error) && error.status === 404)) {
          fail(error);
          return;
        }
      }
    }
    saver.keepMine(revisionNo);
    setConflict(null);
  }

  function adoptLocalCopy(): void {
    if (!offer) return;
    showDraft(draftFromLocal(offer.copy));
    setOffer(null);
    saver.change({ immediate: true });
  }

  function discardLocalCopy(): void {
    setOffer(null);
    if (props.server) writeLocalCopy(makeLocalCopy(date, draftFromEntry(props.server), props.server.revisionNo, true));
    else clearLocalCopy(date);
  }

  const ownProblem = saveStatus.kind === 'offline' || saveStatus.kind === 'conflict' || saveStatus.kind === 'error';
  const statusClass =
    saveStatus.kind === 'saving' || (!ownProblem && uploadSummary.pending > 0)
      ? 'jr-saving'
      : ownProblem || uploadSummary.failed > 0
        ? 'jr-bad'
        : '';

  return (
    <div className="jr-editorpane">
      <header className="jr-edtop">
        <div className="jr-row">
          <button type="button" className="jr-back" onClick={props.onBack}>
            <Icon name="back" size={18} strokeWidth={2.2} />
            Journal
          </button>
          <div className="jr-ttl">
            <b className="jr-date">{longDate(date)}</b>
            <span className={statusClass} role="status">
              {autosaveText(saveStatus, uploadSummary)}
            </span>
          </div>
          <button
            type="button"
            className="jr-more"
            aria-label="More"
            aria-haspopup="dialog"
            onClick={() => setSheet('more')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="5" cy="12" r="1.6" fill="currentColor" />
              <circle cx="12" cy="12" r="1.6" fill="currentColor" />
              <circle cx="19" cy="12" r="1.6" fill="currentColor" />
            </svg>
          </button>
        </div>
      </header>

      {offer ? (
        <div className="callout blue jr-offer" role="status">
          <span className="ctext">
            {offer.kind === 'newer'
              ? `A copy saved on this phone at ${localTime(offer.copy.savedAt)} was never sent and differs from the server's.`
              : `A copy saved on this phone at ${localTime(offer.copy.savedAt)} was never sent. The server has a newer version.`}
          </span>
          <span className="jr-offer-actions">
            <button type="button" className="btn sm primary" onClick={adoptLocalCopy}>
              Use the copy saved on this phone
            </button>
            <button type="button" className="btn sm" onClick={discardLocalCopy}>
              Discard
            </button>
          </span>
        </div>
      ) : null}

      <div className="jr-meta-wrap">
        <input
          className="jr-title"
          value={title}
          maxLength={JOURNAL_LIMITS.titleChars}
          placeholder="Title (optional)"
          aria-label="Title"
          enterKeyHint="next"
          onChange={(event) => onTitle(event.target.value)}
          onBlur={() => void saver.flush()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              editor.commands.focus('start');
            }
          }}
        />
        <div className="jr-meta">
          <div className="jr-r">
            <span className="jr-lbl" aria-hidden="true">
              View
            </span>
            <fieldset className="jr-seg jr-viewseg">
              <legend className="sr-only">Market view</legend>
              {VIEWS.map((v) => (
                <label key={v.id} className={`jr-opt ${v.id}`}>
                  <input
                    type="radio"
                    name="jr-market-view"
                    value={v.id}
                    checked={view === v.id}
                    onChange={() => onView(v.id)}
                  />
                  {v.label}
                </label>
              ))}
            </fieldset>
          </div>
          <div className="jr-r">
            <label className="jr-lbl" htmlFor="jr-tags">
              Tags
            </label>
            <input
              id="jr-tags"
              className="jr-ti"
              value={tagsText}
              placeholder="#roll-rule #hk"
              autoCapitalize="none"
              autoCorrect="off"
              enterKeyHint="done"
              onChange={(event) => onTags(event.target.value)}
              onBlur={() => {
                setTagsText(formatTags(parseTags(tagsText)));
                void saver.flush();
              }}
            />
          </div>
          <div className="jr-r jr-r-top">
            <span className="jr-lbl">Names</span>
            <div className="jr-names">
              {names.length > 0 ? (
                names.map((m) => (
                  <a
                    key={`${m.market}:${m.symbol}`}
                    className="jr-chip jr-tk"
                    href={toHash({ page: 'research', market: m.market, symbol: m.symbol })}
                  >
                    {mentionLabel(m)}
                  </a>
                ))
              ) : (
                <span className="jr-hint">Type $NKE or 0700.HK and it shows here, linked to Research.</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <section className="jr-card jr-editor">
        <EditorContent editor={editor} />
      </section>

      {empty ? (
        <div className="jr-tplrow">
          <span>Or start from a template</span>
          <div>
            {JOURNAL_TEMPLATES.map((t) => (
              <button key={t.id} type="button" className="jr-pill" onClick={() => void applyTemplate(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <Toolbar
        editor={editor}
        wrapRef={toolbarRef}
        onPickImages={insertFiles}
        ai={{
          status: aiState.phase.kind === 'running' ? 'running' : aiState.phase.kind === 'result' ? 'ready' : 'idle',
          off: !aiHasRun && !aiBusy && aiReason !== null,
          sheetOpen: sheet === 'ai',
          onPress: pressAi,
        }}
        onStockButton={() => {
          if (stockHintShown) return;
          stockHintShown = true;
          toast.push('Type a symbol: NKE or 0700.HK. It links to Research.');
        }}
      />

      <p className="jr-edfoot">
        <span>
          Last AI:{' '}
          <b className="jr-v">
            {meta.lastAi ? `${aiModeLabel(meta.lastAi.mode)} at ${localTime(meta.lastAi.at)}` : 'none yet'}
          </b>
        </span>
        <span>
          Revisions: <b className="jr-v">{meta.revisionCount ?? '–'}</b>
        </span>
        <span>
          Template: <b className="jr-v">{template ? TEMPLATE_LABEL[template] : 'none'}</b>
        </span>
        <span>
          Status: <b className="jr-v">{meta.closed ? 'Closed' : 'Draft'}</b>
        </span>
      </p>
      <p className="jr-foot">Saves as you type. A copy stays on this phone until the server has it.</p>

      {sheet === 'more' ? (
        <MoreSheet
          date={date}
          onClose={() => setSheet(null)}
          revisionCount={meta.revisionCount}
          closed={meta.closed}
          saved={meta.exists}
          onHistory={() => void openHistory()}
          onTemplates={() => setSheet('templates')}
          onExport={() => void exportMarkdown()}
          onToggleClosed={() => void toggleClosed()}
          onDelete={() => void deleteEntry()}
        />
      ) : null}
      {sheet === 'history' ? <HistorySheet date={date} onClose={() => setSheet(null)} onRestore={restore} /> : null}
      {sheet === 'templates' ? (
        <TemplateSheet onClose={() => setSheet(null)} onPick={(id) => void applyTemplate(id)} />
      ) : null}
      {sheet === 'ai' ? (
        <AiSheet
          state={aiState}
          choices={aiChoices}
          onChoices={setAiChoices}
          onStart={() => void ai.start(startInputOf(aiChoices))}
          onCancelRun={() => void ai.cancel()}
          onAccept={() => void ai.accept()}
          onKeepMine={() => {
            void ai.reject();
            setSheet(null);
          }}
          onTryAgain={() => ai.reset()}
          onClose={() => setSheet(null)}
          disabledReason={aiReason}
        />
      ) : null}
      {conflict ? <ConflictSheet onReload={reload} onKeepMine={keepMine} /> : null}
    </div>
  );
}
