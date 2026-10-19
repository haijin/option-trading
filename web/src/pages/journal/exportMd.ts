import { links } from '../../api/endpoints';

/** The file name a Markdown export is saved under. */
export const exportFileName = (date: string): string => `journal-${date}.md`;

/**
 * Fetches `GET /api/journal/entries/:date/export.md` and hands it to the browser as a download. It is fetched rather than
 * linked so a failure can be shown in the app, and the saved copy always reflects the entry as of now.
 */
export async function downloadMarkdown(date: string): Promise<void> {
  const response = await fetch(links.journalExportUrl(date), { headers: { Accept: 'text/markdown' } });
  if (!response.ok) throw new Error(`The server answered HTTP ${response.status} for the export.`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = exportFileName(date);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
