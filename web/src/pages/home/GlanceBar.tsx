import { type CountKind, type PanelId, type PanelSummary, panelDomId } from './HomePanel';

export interface GlanceTile {
  id: PanelId;
  title: string;
  summary: PanelSummary;
}

const reducedMotion = (): boolean => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

function jump(id: PanelId): void {
  document
    .getElementById(panelDomId(id))
    ?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

function Tile({ tile }: { tile: GlanceTile }) {
  const { value, label } = tile.summary.tile ?? { value: '–', label: tile.title };
  const kind: CountKind = tile.summary.tile ? tile.summary.kind : 'quiet';
  return (
    <button
      type="button"
      className={`hm-tile ${kind}`}
      onClick={() => jump(tile.id)}
      aria-label={`${tile.title}: ${value} ${label}`}
    >
      <b className="fig">{value}</b>
      <span className="cap">{label}</span>
    </button>
  );
}

/**
 * The whole desk in one row, for a phone or a tablet where the panels stack: one figure per module, and a tap scrolls
 * to its panel. The laptop grid shows every panel at once, so it hides this bar.
 */
export function GlanceBar({ tiles }: { tiles: GlanceTile[] }) {
  return (
    <nav className="hm-glance" aria-label="Jump to a module">
      {tiles.map((tile) => (
        <Tile key={tile.id} tile={tile} />
      ))}
    </nav>
  );
}
