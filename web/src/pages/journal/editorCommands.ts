import type { Editor } from '@tiptap/core';

/**
 * A 3 x 3 table with a header row. Inside a list, a callout or another table it goes on a fresh line after that block:
 * inserting it at the cursor would split the list and leave an empty item behind.
 */
export function insertJournalTable(editor: Editor): void {
  const { $from } = editor.state.selection;
  const top = $from.depth >= 1 ? $from.node(1) : null;
  const chain = editor.chain().focus();
  if (top && !top.isTextblock) {
    const at = $from.after(1);
    chain.insertContentAt(at, { type: 'paragraph' }).setTextSelection(at + 1);
  }
  chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
}

/**
 * The callout button: leaves a callout, turns the current lines into one, and on an empty line starts the "Lesson: "
 * paragraph the Lessons list looks for.
 */
export function toggleJournalCallout(editor: Editor): void {
  if (editor.isActive('blockquote')) {
    editor.chain().focus().lift('blockquote').run();
    return;
  }
  const { $from } = editor.state.selection;
  const emptyLine = $from.parent.isTextblock && $from.parent.content.size === 0;
  if (emptyLine) {
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'blockquote',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Lesson: ' }] }],
      })
      .run();
  } else {
    editor.chain().focus().toggleBlockquote().run();
  }
}
