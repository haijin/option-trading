import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/endpoints';
import type { Market, ResearchRunView, SkillCatalogView, SkillId, SkillInfoView } from '../../api/types';
import { Callout } from '../../components/Callout';
import { Chip, type ChipKind } from '../../components/Chip';
import { Panel } from '../../components/Panel';
import { Tabs } from '../../components/Tabs';
import { useMutation } from '../../hooks/useMutation';
import { isActiveRun, RunCard } from './RunCard';

export const EFFORT: Record<SkillInfoView['effort'], { text: string; kind: ChipKind }> = {
  local: { text: 'local, instant', kind: 'ok' },
  light: { text: 'Light AI run', kind: 'blue' },
  medium: { text: 'Medium AI run', kind: 'blue' },
  heavy: { text: 'Heavy AI run', kind: 'warn' },
};

const STATUS_ICON: Record<ResearchRunView['status'], string> = {
  queued: '⌛',
  running: '⌛',
  done: '✓',
  failed: '✗',
  cancelled: '⊘',
};

/** The newest run of each skill, in catalog order. */
export function latestRuns(runs: readonly ResearchRunView[], catalog: SkillCatalogView): ResearchRunView[] {
  const latest = new Map<SkillId, ResearchRunView>();
  for (const run of runs) {
    const current = latest.get(run.skillId);
    if (!current || Date.parse(run.createdAt) > Date.parse(current.createdAt)) latest.set(run.skillId, run);
  }
  return catalog.skills.map((skill) => latest.get(skill.id)).filter((run): run is ResearchRunView => run !== undefined);
}

function SkillCard({
  skill,
  on,
  disabledReason,
  onToggle,
}: {
  skill: SkillInfoView;
  on: boolean;
  disabledReason: string | null;
  onToggle: () => void;
}) {
  const effort = EFFORT[skill.effort];
  const disabled = disabledReason !== null;
  return (
    <button
      type="button"
      className="sk"
      aria-pressed={on && !disabled}
      disabled={disabled}
      onClick={onToggle}
      title={disabledReason ?? skill.does}
    >
      <span className="bx" aria-hidden="true">
        {on && !disabled ? '☑' : '☐'}
      </span>
      <span className="t">
        {skill.enName}
        <span className="zh">{skill.zhName}</span>
      </span>
      <span>
        {disabled ? <Chip kind="warn">{disabledReason}</Chip> : <Chip kind={effort.kind}>{effort.text}</Chip>}
      </span>
      <span className="d">{skill.does}</span>
    </button>
  );
}

/** Pick a preset or individual skills, run them on the stock, and watch each run's progress and report. */
export function RunSkillsTab({
  market,
  symbol,
  catalog,
  runs,
  hasNumbers,
}: {
  market: Market;
  symbol: string;
  catalog: SkillCatalogView;
  runs: readonly ResearchRunView[];
  hasNumbers: boolean;
}) {
  const start = useMutation();
  const cancel = useMutation();
  const [preset, setPreset] = useState<string>('assign');
  const [picked, setPicked] = useState<Set<SkillId>>(new Set());
  const [view, setView] = useState<SkillId | null>(null);

  const disabledReason = (skill: SkillInfoView): string | null => {
    if (!skill.available) return skill.unavailableReason ?? 'unavailable';
    if (skill.local && !hasNumbers) return 'needs stored numbers: run ingest first';
    return null;
  };
  const usable = useMemo(
    () =>
      new Set(
        catalog.skills.filter((skill) => skill.available && !(skill.local && !hasNumbers)).map((skill) => skill.id),
      ),
    [catalog, hasNumbers],
  );

  // Start with the first preset ("Would I accept assignment?") ticked once the catalog is here.
  const firstPreset = catalog.presets.find((p) => p.id === 'assign') ?? catalog.presets[0];
  const usableKey = [...usable].sort().join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed once per stock, and again only if the set of usable skills changes
  useEffect(() => {
    if (firstPreset) setPicked(new Set(firstPreset.skillIds.filter((id) => usable.has(id))));
  }, [firstPreset?.id, usableKey, symbol, market]);

  const chosen = [...picked].filter((id) => usable.has(id));
  const results = latestRuns(runs, catalog);
  const nameOf = (id: SkillId) => catalog.skills.find((skill) => skill.id === id)?.enName ?? id;
  const activeView = results.some((run) => run.skillId === view) ? view : (results[0]?.skillId ?? null);
  const shown = results.find((run) => run.skillId === activeView);

  const choosePreset = (id: string) => {
    const found = catalog.presets.find((p) => p.id === id);
    if (!found) return;
    setPreset(id);
    setPicked(new Set(found.skillIds.filter((skillId) => usable.has(skillId))));
  };
  const toggle = (id: SkillId) => {
    setPreset('custom');
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const run = async () => {
    const created = await start.run(() => api.startResearch({ symbol, market, skillIds: chosen }), {
      success: (list) => `Started ${list.length} ${list.length === 1 ? 'run' : 'runs'} on ${symbol}.`,
    });
    if (created?.[0]) setView(created[0].skillId);
  };

  const cancelRun = async (target: ResearchRunView) => {
    await cancel.run(() => api.cancelResearch(target.id), { success: `${nameOf(target.skillId)} cancelled.` });
  };

  return (
    <div className="stack">
      <Panel title={`Run analysis skills on ${symbol}`} actions={<small>{catalog.root}</small>}>
        <div className="stack">
          {catalog.executor === 'none' ? (
            <Callout role="alert">
              <b>No AI executor is configured.</b> Only the local quality screen can run. See Settings, environment
              checks.
            </Callout>
          ) : null}
          <div className="pre">
            {catalog.presets.map((p) => (
              <button key={p.id} type="button" aria-pressed={preset === p.id} onClick={() => choosePreset(p.id)}>
                <b>{p.name}</b>
                <small>{p.description}</small>
              </button>
            ))}
          </div>
          {catalog.skills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              on={picked.has(skill.id)}
              disabledReason={disabledReason(skill)}
              onToggle={() => toggle(skill.id)}
            />
          ))}
          <div className="row">
            <button type="button" className="btn primary" onClick={run} disabled={chosen.length === 0 || start.busy}>
              {start.busy
                ? 'Starting...'
                : `Run ${chosen.length} ${chosen.length === 1 ? 'skill' : 'skills'} on ${symbol}`}
            </button>
            <small>
              AI runs take minutes in the background and save a report; one runs at a time, the rest wait in the queue.
            </small>
          </div>
          {catalog.notes.map((note) => (
            <small key={note}>{note}</small>
          ))}
        </div>
      </Panel>

      {results.length === 0 ? (
        <Callout kind="blue">
          Pick skills above and press Run. The latest result of each skill for {symbol} appears here, one tab per skill.
        </Callout>
      ) : (
        <Panel title={`Results: ${symbol}`} flush>
          <div style={{ padding: '0 8px' }}>
            <Tabs
              label="Skill results"
              tabs={results.map((r) => ({ id: r.skillId, label: `${STATUS_ICON[r.status]} ${nameOf(r.skillId)}` }))}
              value={activeView as SkillId}
              onChange={setView}
            />
          </div>
          <div style={{ padding: '12px 14px' }}>
            {shown ? (
              <RunCard
                key={shown.id}
                run={shown}
                skillName={nameOf(shown.skillId)}
                onCancel={cancelRun}
                cancelling={cancel.busy}
              />
            ) : null}
          </div>
        </Panel>
      )}
      {results.some(isActiveRun) ? (
        <small className="faint">Progress refreshes every 1.5 seconds while a run is queued or running.</small>
      ) : null}
    </div>
  );
}
