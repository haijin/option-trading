import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { type ReactNode, type RefObject, useRef } from 'react';
import { insertJournalTable, toggleJournalCallout } from './editorCommands';

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

function Btn({
  label,
  onClick,
  pressed,
  disabled,
  className = '',
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`jr-tb ${className}`.trim()}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      // keep the selection and the keyboard: a button must not take focus from the editor
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Words on the buttons of the table group: clearer than icons for "add a row" versus "add a column". */
function TableBtn({
  label,
  text,
  onClick,
  danger,
}: {
  label: string;
  text: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <Btn label={label} onClick={onClick} className={danger ? 'jr-tb-text danger' : 'jr-tb-text'}>
      {text}
    </Btn>
  );
}

/**
 * The formatting bar: fixed above the tab bar on a phone (pinned to the top of the keyboard while it is open, see
 * `useKeyboardPin`), inline under the document on desktop. The AI rewrite button is pinned to the right end; the snapshot
 * button (J4) goes at the marked place.
 */
/** What the AI rewrite button and the chip next to it show. */
export interface AiToolbarState {
  /** `running`: a rewrite is being written; `ready`: a suggestion waits for a decision. */
  status: 'idle' | 'running' | 'ready';
  /** The button looks off and tapping it says why (no text yet, an image uploading, the model unavailable). */
  off: boolean;
  /** The sheet is open: the chip is not needed. */
  sheetOpen: boolean;
  onPress: () => void;
}

export function Toolbar({
  editor,
  wrapRef,
  onStockButton,
  onPickImages,
  ai,
}: {
  editor: Editor;
  wrapRef: RefObject<HTMLDivElement | null>;
  /** The `$` button inserted a `$`: the page shows its one-line hint. */
  onStockButton: () => void;
  /** Images chosen in the file picker (Camera and Photo Library on a phone). */
  onPickImages: (files: File[]) => void;
  ai: AiToolbarState;
}) {
  const pickerRef = useRef<HTMLInputElement>(null);
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      // Toggles only read as "on" while the document has focus: a heading under a caret that is not there is no state to show.
      const on = (active: boolean) => e.isFocused && active;
      return {
        bold: on(e.isActive('bold')),
        italic: on(e.isActive('italic')),
        strike: on(e.isActive('strike')),
        h2: on(e.isActive('heading', { level: 2 })),
        bullet: on(e.isActive('bulletList')),
        ordered: on(e.isActive('orderedList')),
        task: on(e.isActive('taskList')),
        quote: on(e.isActive('blockquote')),
        table: e.isActive('table'),
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
      };
    },
  });
  const run = () => editor.chain().focus();

  return (
    <div className="jr-toolwrap" ref={wrapRef}>
      <input
        ref={pickerRef}
        className="jr-hidden-input"
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        data-testid="jr-image-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) onPickImages(files);
        }}
      />
      {ai.status !== 'idle' && !ai.sheetOpen ? (
        <button type="button" className="jr-aichip" onClick={ai.onPress}>
          <i className={ai.status === 'running' ? 'jr-pulse' : 'jr-pulse still'} aria-hidden="true" />
          {ai.status === 'running' ? 'AI is writing…' : 'Suggestion ready'}
          <span className="jr-aichip-go">Open</span>
        </button>
      ) : null}
      {s.table ? (
        <div className="jr-tbltools" role="toolbar" aria-label="Table">
          <TableBtn label="Add a row below" text="+ Row" onClick={() => run().addRowAfter().run()} />
          <TableBtn label="Delete this row" text="− Row" onClick={() => run().deleteRow().run()} />
          <TableBtn label="Add a column to the right" text="+ Col" onClick={() => run().addColumnAfter().run()} />
          <TableBtn label="Delete this column" text="− Col" onClick={() => run().deleteColumn().run()} />
          <TableBtn label="Delete the table" text="Delete table" danger onClick={() => run().deleteTable().run()} />
        </div>
      ) : null}
      <div className="jr-toolbar" role="toolbar" aria-label="Formatting">
        <Btn label="Bold" pressed={s.bold} onClick={() => run().toggleBold().run()}>
          <b>B</b>
        </Btn>
        <Btn label="Italic" pressed={s.italic} onClick={() => run().toggleItalic().run()}>
          <i style={{ fontFamily: 'serif' }}>I</i>
        </Btn>
        <Btn label="Strikethrough" pressed={s.strike} onClick={() => run().toggleStrike().run()}>
          <s>S</s>
        </Btn>
        <Btn label="Heading" pressed={s.h2} onClick={() => run().toggleHeading({ level: 2 }).run()}>
          H
        </Btn>
        <span className="jr-sep" aria-hidden="true" />
        <Btn label="Bulleted list" pressed={s.bullet} onClick={() => run().toggleBulletList().run()}>
          <Svg>
            <path d="M9 6h11M9 12h11M9 18h11" />
            <circle cx="4.5" cy="6" r="1" fill="currentColor" />
            <circle cx="4.5" cy="12" r="1" fill="currentColor" />
            <circle cx="4.5" cy="18" r="1" fill="currentColor" />
          </Svg>
        </Btn>
        <Btn label="Numbered list" pressed={s.ordered} onClick={() => run().toggleOrderedList().run()}>
          <Svg>
            <path d="M10 6h10M10 12h10M10 18h10M4 5h1v3M4 11.5c0-.8.6-1.3 1.2-1.3.7 0 1.3.5 1.3 1.2 0 1-2.5 2-2.5 2.6h2.7M4 16.5h1.6c.6 0 1 .4 1 .9s-.4.9-1 .9h-.6h.7c.6 0 1 .4 1 .9s-.4.9-1 .9H4" />
          </Svg>
        </Btn>
        <Btn label="Checklist" pressed={s.task} onClick={() => run().toggleTaskList().run()}>
          <Svg>
            <rect x="3" y="4" width="7" height="7" rx="1.5" />
            <path d="M5 7.5l1.5 1.5L9 6M13 7h8M13 17h8" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
          </Svg>
        </Btn>
        <Btn label="Callout" pressed={s.quote} onClick={() => toggleJournalCallout(editor)}>
          <Svg>
            <path d="M5 5h14M5 12h9M5 19h14M19 10v4" />
          </Svg>
        </Btn>
        <span className="jr-sep" aria-hidden="true" />
        <Btn label="Table" pressed={s.table} onClick={() => insertJournalTable(editor)}>
          <Svg>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 10h18M3 15h18M9 4v16M15 4v16" />
          </Svg>
        </Btn>
        <Btn label="Image" onClick={() => pickerRef.current?.click()}>
          <Svg>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="8.5" cy="9" r="1.5" />
            <path d="M21 16l-5-5-8 8" />
          </Svg>
        </Btn>
        {/* J4 adds the snapshot button here. */}
        <Btn
          label="Stock name"
          onClick={() => {
            run().insertContent('$').run();
            onStockButton();
          }}
        >
          $
        </Btn>
        <span className="jr-sep" aria-hidden="true" />
        <Btn label="Undo" disabled={!s.canUndo} onClick={() => run().undo().run()}>
          <Svg>
            <path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />
          </Svg>
        </Btn>
        <Btn label="Redo" disabled={!s.canRedo} onClick={() => run().redo().run()}>
          <Svg>
            <path d="M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3" />
          </Svg>
        </Btn>
        <button
          type="button"
          className={ai.off ? 'jr-aibtn is-off' : 'jr-aibtn'}
          aria-label="AI rewrite"
          aria-disabled={ai.off || undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={ai.onPress}
        >
          <svg className="jr-aisvg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8zM5 2l.6 1.6L7 4l-1.4.6L5 6l-.6-1.4L3 4l1.4-.4z" />
          </svg>
          <span className="jr-ai-long">AI rewrite</span>
          <span className="jr-ai-short" aria-hidden="true">
            AI
          </span>
        </button>
      </div>
    </div>
  );
}
