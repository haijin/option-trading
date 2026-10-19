import { EditorContent, useEditor } from '@tiptap/react';
import { useState } from 'react';
import { type JournalDocJson, journalSchemaExtensions } from '../../../../src/journal';
import { withFigureView } from './editorExtensions';

/**
 * The suggested entry, read-only: the same document schema and node views as the editor (so images, tables, snapshots and
 * checklists look exactly as they do there), with nothing editable. A new run makes a new preview.
 */
export function AiPreview({ doc, runId }: { doc: JournalDocJson; runId: string }) {
  const [extensions] = useState(() => withFigureView(journalSchemaExtensions(), null));
  const editor = useEditor(
    {
      extensions,
      content: doc,
      editable: false,
      editorProps: { attributes: { class: 'jr-doc', role: 'document', 'aria-label': 'Suggested entry' } },
    },
    [runId],
  );
  return <EditorContent editor={editor} />;
}
