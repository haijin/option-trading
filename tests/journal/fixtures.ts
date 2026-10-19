import type { JournalDocJson, JournalNodeJson } from '../../src/journal';

const t = (text: string, marks?: { type: string; attrs?: Record<string, unknown> }[]): JournalNodeJson =>
  marks ? { type: 'text', text, marks } : { type: 'text', text };
const p = (...content: JournalNodeJson[]): JournalNodeJson => ({ type: 'paragraph', content });

/** One of every node and mark the journal allows (except `figure`, which needs an uploaded asset). */
export const KITCHEN_SINK: JournalDocJson = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [t('Market')] },
    p(
      t('HK open weak, '),
      t('0700.HK', [{ type: 'stockMention', attrs: { market: 'HK', symbol: '0700' } }]),
      t(' held 600. '),
      t('Not selling', [{ type: 'bold' }]),
      t(' and '),
      t('maybe later', [{ type: 'italic' }]),
      t(' or '),
      t('never', [{ type: 'strike' }]),
      t('.'),
    ),
    p(
      t('NKE', [{ type: 'stockMention', attrs: { market: 'US', symbol: 'NKE' } }, { type: 'bold' }]),
      t(' results * tonight_ [x]'),
    ),
    { type: 'paragraph', content: [t('first line'), { type: 'hardBreak' }, t('second line')] },
    { type: 'paragraph', content: [t('- not a list')] },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [p(t('one')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('nested'))] }] }],
        },
        { type: 'listItem', content: [p(t('two'))] },
      ],
    },
    {
      type: 'orderedList',
      attrs: { start: 3, type: null },
      content: [
        { type: 'listItem', content: [p(t('third'))] },
        { type: 'listItem', content: [p(t('fourth'))] },
      ],
    },
    {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: false }, content: [p(t('roll NKE'))] },
        { type: 'taskItem', attrs: { checked: true }, content: [p(t('update note'))] },
      ],
    },
    { type: 'blockquote', content: [p(t('Lesson: stop checking the price every 10 min.'))] },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [p(t('Name'))] },
            { type: 'tableHeader', content: [p(t('Strike'))] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [p(t('NKE'))] },
            { type: 'tableCell', content: [p(t('65 | 62.5'))] },
          ],
        },
      ],
    },
    {
      type: 'snapshot',
      attrs: {
        kind: 'positions',
        asOf: '2026-10-13T16:05',
        title: 'Open positions',
        columns: ['Name', 'Put', 'P&L'],
        align: ['l', 'r', 'r'],
        rows: [
          ['NKE', '65', '+$210'],
          ['KO', '60', '+$95'],
        ],
      },
    },
  ],
};
