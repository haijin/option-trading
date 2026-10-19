import { useMemo, useState } from 'react';
import { api } from '../../api/endpoints';
import type { LeaderCandidateView, PresetView, SkillCatalogView, SkillId, SkillInfoView } from '../../api/types';
import { ErrorBanner } from '../../components/Callout';
import { Chip } from '../../components/Chip';
import { Modal } from '../../components/Modal';
import { Skeleton } from '../../components/Skeleton';
import { useMutation } from '../../hooks/useMutation';
import { useResource } from '../../hooks/useResource';
import { useRouter } from '../../state/router';
import { useToast } from '../../state/toast';
import { EFFORT } from '../research/RunSkillsTab';

/** The presets the sheet offers, in this order. "assign" is the put seller's pre-trade check and stays on the Research page. */
const PRESET_ORDER: readonly PresetView['id'][] = ['leader', 'numbers', 'full'];

export function leaderPresets(catalog: SkillCatalogView): PresetView[] {
  return PRESET_ORDER.map((id) => catalog.presets.find((p) => p.id === id)).filter(
    (p): p is PresetView => p !== undefined,
  );
}

function SkillRow({ skill, checked, onToggle }: { skill: SkillInfoView; checked: boolean; onToggle: () => void }) {
  const effort = EFFORT[skill.effort];
  return (
    <label className={`ld-skill${skill.available ? '' : ' off'}`}>
      <input type="checkbox" checked={checked && skill.available} disabled={!skill.available} onChange={onToggle} />
      <span className="body">
        <span className="t">
          {skill.enName}
          <span className="zh">{skill.zhName}</span>
        </span>
        <span className="d" title={skill.does}>
          {skill.does}
        </span>
      </span>
      <span className="e">
        {skill.available ? effort.text : <Chip kind="warn">{skill.unavailableReason ?? 'unavailable'}</Chip>}
      </span>
    </label>
  );
}

function SheetBody({
  c,
  catalog,
  onClose,
}: {
  c: LeaderCandidateView;
  catalog: SkillCatalogView;
  onClose: () => void;
}) {
  const start = useMutation();
  const toast = useToast();
  const { navigate } = useRouter();
  const presets = useMemo(() => leaderPresets(catalog), [catalog]);
  const [presetId, setPresetId] = useState<string>(presets[0]?.id ?? 'leader');
  const [custom, setCustom] = useState<ReadonlySet<SkillId> | null>(null);

  const preset = presets.find((p) => p.id === presetId) ?? presets[0];
  const usable = new Set(catalog.skills.filter((s) => s.available).map((s) => s.id));
  const picked: ReadonlySet<SkillId> = custom ?? new Set(preset?.skillIds ?? []);
  const chosen = catalog.skills.filter((s) => picked.has(s.id) && usable.has(s.id)).map((s) => s.id);

  const toggle = (id: SkillId): void => {
    const next = new Set(picked);
    if (!next.delete(id)) next.add(id);
    setCustom(next);
  };
  const choosePreset = (id: string): void => {
    setPresetId(id);
    setCustom(null);
  };

  const run = async (): Promise<void> => {
    const created = await start.run(() => api.startResearch({ symbol: c.symbol, market: c.market, skillIds: chosen }));
    if (!created) return;
    onClose();
    toast.push(`Queued ${created.length} ${created.length === 1 ? 'run' : 'runs'} for ${c.symbol}`, 'info', {
      actionLabel: 'Open Research ›',
      onAction: () => navigate({ page: 'research', market: c.market, symbol: c.symbol }),
    });
  };

  return (
    <Modal
      title={`Investigate ${c.symbol}${c.name ? ` · ${c.name}` : ''}`}
      onClose={onClose}
      className="ld-sheet"
      footer={
        <>
          <button
            type="button"
            className="btn primary"
            onClick={() => void run()}
            disabled={chosen.length === 0 || start.busy}
          >
            {start.busy ? 'Starting...' : `Run ${chosen.length} ${chosen.length === 1 ? 'skill' : 'skills'}`}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <p className="ld-note first">Runs the research skills on this name and files the reports under Research.</p>
      <div className="ld-presets">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            className={custom === null && preset?.id === p.id ? 'on' : ''}
            aria-pressed={custom === null && preset?.id === p.id}
            onClick={() => choosePreset(p.id)}
          >
            {p.name}
          </button>
        ))}
      </div>
      {custom === null && preset ? <p className="ld-note first">{preset.description}</p> : null}
      {c.hasStatements ? null : (
        <p className="ld-fetchnote" role="status">
          No stored statements: they will be fetched first, about 30 s, so the quality screen can run.
        </p>
      )}
      <div className="ld-skills">
        {catalog.skills.map((s) => (
          <SkillRow key={s.id} skill={s} checked={picked.has(s.id)} onToggle={() => toggle(s.id)} />
        ))}
      </div>
      {catalog.executor === 'none' ? (
        <p className="ld-fetchnote" role="status">
          No AI executor is configured on this machine: only the local quality screen can run.
        </p>
      ) : null}
    </Modal>
  );
}

/** "Investigate VRT · Vertiv Holdings": pick a preset or individual research skills and queue them for this name. */
export function InvestigateSheet({ c, onClose }: { c: LeaderCandidateView; onClose: () => void }) {
  const catalog = useResource((signal) => api.skills(signal), []);
  if (catalog.data) return <SheetBody c={c} catalog={catalog.data} onClose={onClose} />;
  return (
    <Modal title={`Investigate ${c.symbol}${c.name ? ` · ${c.name}` : ''}`} onClose={onClose} className="ld-sheet">
      {catalog.error ? (
        <ErrorBanner error={catalog.error} onRetry={catalog.refresh} title="Could not load the research skills." />
      ) : (
        <div aria-busy="true" style={{ display: 'grid', gap: 8 }}>
          <span className="sr-only">Loading</span>
          <Skeleton height={40} />
          <Skeleton height={52} />
          <Skeleton height={52} />
          <Skeleton height={52} />
        </div>
      )}
    </Modal>
  );
}
