/** Plain-text tables for terminal output. */
export interface Column {
  header: string;
  align?: 'left' | 'right';
}

export function renderTable(columns: Column[], rows: string[][]): string[] {
  const widths = columns.map((c, i) => Math.max(c.header.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((cell, i) => {
        const w = widths[i] as number;
        return columns[i]?.align === 'right' ? cell.padStart(w) : cell.padEnd(w);
      })
      .join('  ')
      .trimEnd();
  const rule = widths.map((w) => '-'.repeat(w)).join('  ');
  return [fmt(columns.map((c) => c.header)), rule, ...rows.map(fmt)];
}

export function pct(x: number | null | undefined, digits = 1): string {
  return x === null || x === undefined || !Number.isFinite(x) ? '-' : `${(x * 100).toFixed(digits)}%`;
}

export function num2(x: number | null | undefined, digits = 2): string {
  return x === null || x === undefined || !Number.isFinite(x) ? '-' : x.toFixed(digits);
}

export function money(x: number | null | undefined, ccy: string): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '-';
  const sym = ccy === 'HKD' ? 'HK$' : ccy === 'USD' ? 'US$' : ccy === 'SGD' ? 'S$' : `${ccy} `;
  return `${sym}${Math.round(x).toLocaleString('en-US')}`;
}
