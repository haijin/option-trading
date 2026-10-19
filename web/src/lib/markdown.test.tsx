import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown, safeUrl } from './markdown';

function renderMd(source: string) {
  return render(<Markdown source={source} />);
}

describe('markdown renderer', () => {
  it('renders headings (shifted below the page title), paragraphs and inline styles', () => {
    const { container } = renderMd('# Title\n\nSome **bold**, *italic*, `code` and ~~gone~~ text.');
    expect(container.querySelector('h3')).toHaveTextContent('Title');
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('em')).toHaveTextContent('italic');
    expect(container.querySelector('code')).toHaveTextContent('code');
    expect(container.querySelector('del')).toHaveTextContent('gone');
  });

  it('renders bullet, numbered and nested lists', () => {
    const { container } = renderMd('- one\n- two\n  - nested a\n  - nested b\n- three\n\n1. first\n2. second');
    const lists = container.querySelectorAll('ul');
    expect(lists).toHaveLength(2);
    expect(container.querySelectorAll('ul > li')).toHaveLength(5);
    expect(container.querySelector('ul ul')).toBeInTheDocument();
    const ordered = container.querySelector('ol');
    expect(ordered?.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders tables with header and aligned cells', () => {
    const { container } = renderMd('| Name | Value |\n|:--|--:|\n| ROE | 12% |\n| FCF | 4% |');
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.querySelectorAll('td')[1]).toHaveStyle({ textAlign: 'right' });
  });

  it('renders blockquotes and horizontal rules', () => {
    const { container } = renderMd('> quoted **line**\n\n---\n\nafter');
    expect(container.querySelector('blockquote strong')).toHaveTextContent('line');
    expect(container.querySelector('hr')).toBeInTheDocument();
  });

  it('keeps fenced code verbatim, including markup characters', () => {
    const { container } = renderMd('```js\nconst a = "<b>x</b>"; // **not bold**\n```');
    expect(container.querySelector('pre code')?.textContent).toBe('const a = "<b>x</b>"; // **not bold**');
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });

  it('renders http and https links, and drops every other scheme', () => {
    const { container } = renderMd(
      '[ok](https://example.com/a?b=1) [also](http://example.com) [bad](javascript:alert(1)) [data](data:text/html,x)',
    );
    const anchors = container.querySelectorAll('a');
    expect(anchors).toHaveLength(2);
    expect(anchors[0]).toHaveAttribute('href', 'https://example.com/a?b=1');
    expect(anchors[0]).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(container).toHaveTextContent('bad');
    expect(container.innerHTML).not.toContain('javascript:');
    expect(safeUrl('https://x.test')).toBe('https://x.test/');
    expect(safeUrl('ftp://x.test')).toBeNull();
    expect(safeUrl('//x.test')).toBeNull();
  });

  it('renders <script> and other HTML in the input as plain text, never as elements', () => {
    const { container } = renderMd(
      'Hello <script>alert(1)</script> world\n\n<img src=x onerror="alert(2)">\n\n**<b>bold?</b>** [<i>link</i>](https://example.com)',
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('i')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('<img src=x onerror="alert(2)">');
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
  });

  it('handles Chinese reports, joining wrapped lines without a stray space', () => {
    const { container } = renderMd(
      '## 估值结论\n\n这是第一行\n接着第二行，**重点**在这里。\n\n- 现金流稳健\n- 护城河：宽',
    );
    expect(container.querySelector('h4')).toHaveTextContent('估值结论');
    expect(container.querySelector('p')?.textContent).toBe('这是第一行接着第二行，重点在这里。');
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('does not treat snake_case as emphasis and honours escapes', () => {
    const { container } = renderMd('use snake_case_name here and 2 \\* 3 \\* 4');
    expect(container.querySelector('em')).toBeNull();
    expect(container.textContent).toBe('use snake_case_name here and 2 * 3 * 4');
  });

  it('survives unterminated constructs without throwing', () => {
    const { container } = renderMd('```\nnever closed\n\n**open bold\n\n[link](https://x\n\n| a | b |\n');
    expect(container.textContent).toContain('never closed');
    expect(container.textContent).toContain('open bold');
  });

  it('renders empty input as nothing', () => {
    const { container } = renderMd('');
    expect(container.querySelector('.markdown')?.children).toHaveLength(0);
  });
});
