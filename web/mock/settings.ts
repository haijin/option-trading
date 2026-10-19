import type { GovernorSettingsView, SettingsView } from '../../src/server/api-types';
import { PARAMS_TREE, SKILLS_ROOT } from './seed-ref';
import { PER_NAME_CAP_PCT, store } from './state';
import { Body } from './validate';

/** The drawdown governor (T3): off by default, kept in memory like the rest of the mock. */
let governor: GovernorSettingsView = { dailyLossLimit: null, consecutiveLossHalt: null, degearTiers: [] };

export function getSettings(): SettingsView {
  return {
    baseCurrency: store.baseCurrency,
    equity: store.equity,
    governor: { ...governor, degearTiers: governor.degearTiers.map((t) => ({ ...t })) },
    perNameCapPct: PER_NAME_CAP_PCT,
    params: { name: 'default', version: 1, hash: '6cacf9ab', tree: PARAMS_TREE },
    database: { name: 'option_trading', host: '127.0.0.1', port: 5433 },
    skills: {
      root: SKILLS_ROOT,
      rootFound: true,
      python: 'C:\\Python314\\python.exe',
      claudeCli: 'C:\\Users\\me\\.local\\bin\\claude.exe',
      executor: 'fake',
    },
  };
}

function patchGovernor(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const g = raw as Partial<GovernorSettingsView>;
  if (g.dailyLossLimit !== undefined) governor.dailyLossLimit = g.dailyLossLimit;
  if (g.consecutiveLossHalt !== undefined) governor.consecutiveLossHalt = g.consecutiveLossHalt;
  if (Array.isArray(g.degearTiers)) {
    governor = {
      ...governor,
      degearTiers: g.degearTiers
        .filter((t) => t.drawdownPct > 0 && t.multiplier >= 0 && t.multiplier <= 1)
        .map((t) => ({ drawdownPct: t.drawdownPct, multiplier: t.multiplier }))
        .sort((a, b) => a.drawdownPct - b.drawdownPct),
    };
  }
}

export function putSettings(raw: unknown): SettingsView {
  const b = Body.from(raw);
  const equity = b.optNumber('equity', { positive: true, max: 1e12 });
  const currency = b.optOneOf('baseCurrency', ['HKD', 'USD'] as const);
  if (equity !== undefined) store.equity = equity;
  if (currency !== undefined) store.baseCurrency = currency;
  patchGovernor((raw as { governor?: unknown } | null)?.governor);
  return getSettings();
}
