import { type NodeViewProps, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Figure, isAssetId, JOURNAL_LIMITS } from '../../../../src/journal';
import { links } from '../../api/endpoints';
import type { UploadManager } from './uploads';

const noSubscribe = (): (() => void) => () => undefined;
const noVersion = (): number => 0;

/** A ring that fills as the bytes leave the phone. */
function ProgressRing({ value }: { value: number }) {
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span
      className="jr-ring"
      role="progressbar"
      aria-label="Uploading"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <svg className="jr-ring-svg" viewBox="0 0 44 44" aria-hidden="true" focusable="false">
        <circle className="jr-ring-bg" cx="22" cy="22" r={radius} />
        <circle
          className="jr-ring-fg"
          cx="22"
          cy="22"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - Math.min(1, Math.max(0, value)))}
        />
      </svg>
      <span className="jr-ring-pct">{pct}%</span>
    </span>
  );
}

/** The Retry and Remove buttons of a figure that cannot be shown: only where the document can be edited. */
function Actions({ show, children }: { show: boolean; children: React.ReactNode }) {
  return show ? <span className="jr-fig-actions">{children}</span> : null;
}

const RemoveIcon = () => (
  <svg className="jr-fig-xi" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

/**
 * An image with a caption. A figure whose id is a real asset id shows the stored image; one that is still uploading shows
 * the local preview with a progress ring; one whose upload failed says so and offers Retry and Remove. The caption is a
 * field of 300 characters at most, 16 px on phones so iOS does not zoom.
 */
export function FigureView({ node, updateAttributes, deleteNode, selected, extension, editor, getPos }: NodeViewProps) {
  const uploads = (extension.options as { uploads: UploadManager | null }).uploads;
  const id = typeof node.attrs.assetId === 'string' ? node.attrs.assetId : '';
  // re-render when an upload changes
  useSyncExternalStore(uploads?.subscribe ?? noSubscribe, uploads?.version ?? noVersion, noVersion);
  const state = uploads?.get(id);
  const real = isAssetId(id);
  // the suggestion preview of an AI rewrite is read-only: the picture and its caption, nothing to press
  const editable = editor.isEditable;
  const caption = typeof node.attrs.caption === 'string' ? node.attrs.caption : '';
  const [text, setText] = useState(caption);
  const [focused, setFocused] = useState(false);
  const [broken, setBroken] = useState(false);

  // the caption changed from outside (undo, a reload): show it, unless it is being typed right now
  useEffect(() => {
    if (!focused) setText(caption);
  }, [caption, focused]);
  // a different image: forget a previous load error
  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` is the trigger
  useEffect(() => setBroken(false), [id]);

  const remove = () => {
    uploads?.remove(id);
    deleteNode();
  };

  const commit = (value: string) => {
    setText(value);
    updateAttributes({ caption: value === '' ? null : value });
  };

  const leave = () => {
    // Enter in the caption goes on writing below the image
    const at = typeof getPos === 'function' ? getPos() : undefined;
    if (typeof at === 'number')
      editor
        .chain()
        .focus()
        .setTextSelection(Math.min(at + node.nodeSize + 1, editor.state.doc.content.size))
        .run();
  };

  // the failed, orphan and broken boxes carry their own Remove button
  const showRemove = editable && (state?.status === 'uploading' || (real && !state && !broken));
  const src = uploads?.previewFor(id) ?? links.journalAssetUrl(id);
  const classes = ['jr-figure', selected ? 'jr-fig-sel' : '', state?.status === 'failed' ? 'jr-fig-failed' : '']
    .filter(Boolean)
    .join(' ');

  let body: React.ReactNode;
  if (state?.status === 'uploading') {
    body = (
      <div className="jr-figbox" data-state="uploading">
        <img className="jr-fig-img jr-fig-dim" src={state.previewUrl} alt="" />
        <ProgressRing value={state.progress} />
      </div>
    );
  } else if (state?.status === 'failed') {
    body = (
      <div className="jr-figbox jr-fig-note" data-state="failed" role="alert">
        <img className="jr-fig-thumb" src={state.previewUrl} alt="" />
        <div className="jr-fig-msg">
          <b className="jr-fig-title">Upload failed</b>
          <span className="jr-fig-text">{state.message}</span>
          <Actions show={editable}>
            <button type="button" className="btn sm" onClick={() => uploads?.retry(id)}>
              Retry
            </button>
            <button type="button" className="btn sm danger" onClick={remove}>
              Remove
            </button>
          </Actions>
        </div>
      </div>
    );
  } else if (!real) {
    body = (
      <div className="jr-figbox jr-fig-note" data-state="orphan">
        <div className="jr-fig-msg">
          <b className="jr-fig-title">This image was never uploaded</b>
          <span className="jr-fig-text">The upload did not finish before the page was closed.</span>
          <Actions show={editable}>
            <button type="button" className="btn sm danger" onClick={remove}>
              Remove
            </button>
          </Actions>
        </div>
      </div>
    );
  } else if (broken) {
    body = (
      <div className="jr-figbox jr-fig-note" data-state="broken">
        <div className="jr-fig-msg">
          <b className="jr-fig-title">Image not available</b>
          <span className="jr-fig-text">
            It could not be loaded. It may have been deleted, or the connection dropped.
          </span>
          <Actions show={editable}>
            <button type="button" className="btn sm" onClick={() => setBroken(false)}>
              Try again
            </button>
            <button type="button" className="btn sm danger" onClick={remove}>
              Remove
            </button>
          </Actions>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="jr-figbox" data-state="ready">
        <img
          className="jr-fig-img"
          src={src}
          alt={caption}
          loading="lazy"
          decoding="async"
          onError={() => {
            // the local preview may have been released: fall back to the stored image before giving up
            if (uploads?.previewFor(id)) return;
            setBroken(true);
          }}
        />
      </div>
    );
  }

  return (
    <NodeViewWrapper as="figure" className={classes} data-asset-id={real ? id : undefined} contentEditable={false}>
      {body}
      {showRemove ? (
        <button type="button" className="jr-fig-x" aria-label="Remove image" onClick={remove}>
          <RemoveIcon />
        </button>
      ) : null}
      {!editable && caption !== '' ? <figcaption className="jr-figcap">{caption}</figcaption> : null}
      {editable && (real || state?.status === 'uploading') ? (
        <input
          className="jr-capin"
          aria-label="Caption"
          placeholder="Add a caption"
          maxLength={JOURNAL_LIMITS.captionChars}
          value={text}
          onChange={(event) => commit(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              leave();
            }
          }}
        />
      ) : null}
    </NodeViewWrapper>
  );
}

/**
 * The schema's `Figure` (attrs `assetId` and `caption`, nothing else) with the node view above. `uploads` is the manager
 * that knows the figures still uploading; the read-only preview of an AI suggestion passes null.
 */
export function figureExtension(uploads: UploadManager | null) {
  return Figure.extend<{ uploads: UploadManager | null }>({
    addOptions() {
      return { uploads };
    },
    addNodeView() {
      return ReactNodeViewRenderer(FigureView);
    },
  });
}
