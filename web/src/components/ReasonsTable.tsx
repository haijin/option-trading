import { useState } from 'react';
import type { Level, ReasonView, SkillRowView } from '../api/types';
import { num } from '../lib/format';
import { ruleHelp } from '../lib/glossary';
import { Chip, TierChip, VerdictChip } from './Chip';
import { HelpBody } from './HelpBody';

const GROUP_ORDER = [
  'Market',
  'Quality gate',
  'Events',
  'Timing',
  'Volatility',
  'Option',
  'Rank',
  'Sizing',
  'Freshness',
  'Other',
];
const LEVEL_LABEL: Record<Level, string> = { PASS: 'OK', WARN: 'WARN', FAIL: 'FAIL', INFO: 'INFO' };
const LEVEL_CLASS: Record<Level, string> = { PASS: 'ok', WARN: 'warn', FAIL: 'fail', INFO: 'info' };

export function groupReasons(reasons: readonly ReasonView[]): { group: string; reasons: ReasonView[] }[] {
  const byGroup = new Map<string, ReasonView[]>();
  for (const reason of reasons) {
    const list = byGroup.get(reason.group) ?? [];
    list.push(reason);
    byGroup.set(reason.group, list);
  }
  const rank = (group: string) => {
    const index = GROUP_ORDER.indexOf(group);
    return index < 0 ? GROUP_ORDER.length : index;
  };
  return [...byGroup.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([group, list]) => ({ group, reasons: list }));
}

function valueText(value: ReasonView['value']): string {
  if (value === null) return '';
  if (typeof value === 'number') return num(value, 0, 3);
  return String(value);
}

/** One rule row. The rule name opens a plain-English explanation (what it is, why it matters, how to read it). */
function ReasonRow({ reason }: { reason: ReasonView }) {
  const [open, setOpen] = useState(false);
  const help = ruleHelp(reason.rule);
  return (
    <div className={`rrow ${LEVEL_CLASS[reason.level]}`}>
      <span className="lv">{LEVEL_LABEL[reason.level]}</span>
      <span className="rule">
        {help ? (
          <button type="button" className="rule-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
            {reason.rule}
            <span className="qm" aria-hidden="true">
              {open ? '−' : '?'}
            </span>
          </button>
        ) : (
          reason.rule
        )}
        {reason.kind === 'data' ? <em>data</em> : null}
      </span>
      <span className="val">{valueText(reason.value)}</span>
      <span className="want">{reason.threshold ? `want ${reason.threshold}` : ''}</span>
      {reason.note ? <span className="rnote">{reason.note}</span> : null}
      {open && help ? (
        <div className="rhelp">
          <HelpBody help={help} />
        </div>
      ) : null}
    </div>
  );
}

/** Every rule that was applied, grouped; `kind: 'data'` rows are data-quality notes and say so. */
export function ReasonsTable({ reasons }: { reasons: readonly ReasonView[] }) {
  if (reasons.length === 0) return <p className="muted">No rules were evaluated.</p>;
  return (
    <div>
      {groupReasons(reasons).map(({ group, reasons: list }) => (
        <div className="rgrp" key={group}>
          <div className="rg-h">{group}</div>
          {list.map((reason, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a rule can repeat within a skill; the list is static
            <ReasonRow reason={reason} key={`${reason.skillId}-${reason.rule}-${index}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** One chip per scanner family (market, fundamental, technical, volatility, option) showing how real its data was. */
export function TiersRow({ skills }: { skills: readonly SkillRowView[] }) {
  const seen = new Set<string>();
  const items = skills.filter((skill) => {
    const family = skill.skillId.split('.')[0] ?? skill.skillId;
    if (['rank', 'size', 'explain'].includes(family) || seen.has(family)) return false;
    seen.add(family);
    return true;
  });
  if (items.length === 0) return null;
  return (
    <div className="tiers">
      {items.map((skill) => (
        <span key={skill.skillId} className="row" style={{ gap: 4 }}>
          <span className="k">{skill.skillId.split('.')[0]}</span>
          <TierChip tier={skill.tier} />
        </span>
      ))}
    </div>
  );
}

export function SkillsTable({ skills }: { skills: readonly SkillRowView[] }) {
  if (skills.length === 0)
    return <p className="muted">No skills ran: the freshness gate dropped this name before scoring.</p>;
  return (
    <div style={{ overflow: 'auto' }}>
      <table className="tbl">
        <thead>
          <tr>
            <th>Skill</th>
            <th>Ver</th>
            <th>Verdict</th>
            <th className="num">Score</th>
            <th>Data tier</th>
          </tr>
        </thead>
        <tbody>
          {skills.map((skill) => (
            <tr key={skill.skillId}>
              <td className="mono">
                {skill.skillId}
                {skill.missing.length > 0 ? (
                  <div>
                    <Chip kind="warn" title={skill.missing.join(', ')}>
                      missing: {skill.missing.length}
                    </Chip>
                  </div>
                ) : null}
              </td>
              <td className="muted">{skill.version}</td>
              <td>
                <VerdictChip verdict={skill.verdict} />
              </td>
              <td className="num">{skill.score === null ? '-' : num(skill.score, 0, 1)}</td>
              <td>
                <TierChip tier={skill.tier} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
