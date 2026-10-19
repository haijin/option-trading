import { getSettings, loadParams, setSettings } from '../../db/repos';
import type { SettingsPatch, SettingsView } from '../api-types';
import type { ServerDeps } from '../deps';
import { badRequest } from '../errors';
import { skillDef } from '../research/skills';
import type { AppState } from './state';

export class SettingsService {
  constructor(
    private readonly deps: ServerDeps,
    private readonly state: AppState,
  ) {}

  async view(): Promise<SettingsView> {
    const s = await getSettings(this.deps.db);
    const p = await loadParams(this.deps.db);
    const r = this.deps.research;
    const probe = skillDef('investment-checklist');
    return {
      baseCurrency: s.baseCurrency,
      equity: s.equity,
      governor: s.governor,
      perNameCapPct: p.params['size.position'].maxPerNamePct * 100,
      params: { name: p.name, version: p.version, hash: p.hash, tree: p.params },
      database: this.deps.database,
      skills: {
        root: r.root,
        rootFound: probe?.file
          ? (await this.deps.fileExists(`${r.root}/skills/${probe.file}`.replace(/\//g, '\\'))) ||
            (await this.deps.fileExists(`${r.root}/skills/${probe.file}`))
          : false,
        python: r.python,
        claudeCli: r.claudeCli,
        executor: r.executorKind,
      },
    };
  }

  async patch(p: SettingsPatch): Promise<SettingsView> {
    if (p.equity !== undefined && !(Number.isFinite(p.equity) && p.equity > 0))
      throw badRequest('invalid_equity', 'equity must be a positive number');
    if (p.baseCurrency !== undefined && p.baseCurrency !== 'HKD' && p.baseCurrency !== 'USD')
      throw badRequest('invalid_currency', 'base currency must be HKD or USD');
    const g = p.governor;
    if (g) {
      if (g.dailyLossLimit !== undefined && g.dailyLossLimit !== null && !(g.dailyLossLimit > 0))
        throw badRequest('invalid_governor', 'the daily loss limit must be a positive amount, or empty for none');
      if (
        g.consecutiveLossHalt !== undefined &&
        g.consecutiveLossHalt !== null &&
        !(Number.isInteger(g.consecutiveLossHalt) && g.consecutiveLossHalt > 0)
      )
        throw badRequest('invalid_governor', 'the consecutive-loss halt must be a whole number above 0, or empty');
      for (const t of g.degearTiers ?? []) {
        if (!(t.drawdownPct > 0 && t.drawdownPct <= 100) || !(t.multiplier >= 0 && t.multiplier <= 1))
          throw badRequest(
            'invalid_governor',
            'each tier needs a drawdown between 0 and 100% and a multiplier from 0 to 1',
          );
      }
    }
    await setSettings(this.deps.db, {
      ...(p.equity !== undefined ? { equity: p.equity } : {}),
      ...(p.baseCurrency ? { baseCurrency: p.baseCurrency } : {}),
      ...(g ? { governor: g } : {}),
    });
    this.state.bump();
    return this.view();
  }
}
