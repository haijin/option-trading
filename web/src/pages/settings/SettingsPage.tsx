import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/endpoints';
import type { Currency, DegearTierView, SettingsView } from '../../api/types';
import { Callout, ErrorBanner } from '../../components/Callout';
import { Chip } from '../../components/Chip';
import { Field } from '../../components/Field';
import { Panel } from '../../components/Panel';
import { Skeleton } from '../../components/Skeleton';
import { useMutation } from '../../hooks/useMutation';
import { useResource } from '../../hooks/useResource';
import { n2, num, parseNumber } from '../../lib/format';
import { toHash } from '../../lib/route';
import { useOverview } from '../../state/overview';
import { ParamsTree } from './ParamsTree';

function AccountForm({ settings, fx }: { settings: SettingsView; fx: number | null }) {
  const mutation = useMutation();
  const [equity, setEquity] = useState(settings.equity === null ? '' : num(settings.equity));
  const [currency, setCurrency] = useState<Currency>(settings.baseCurrency);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEquity(settings.equity === null ? '' : num(settings.equity));
    setCurrency(settings.baseCurrency);
  }, [settings.equity, settings.baseCurrency]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = parseNumber(equity);
    if (value === null || value <= 0) return setError('Equity must be a number above 0.');
    setError(null);
    await mutation.run(() => api.putSettings({ equity: value, baseCurrency: currency }), {
      success: 'Settings saved.',
    });
  };

  return (
    <Panel title="Account">
      <form className="stack" onSubmit={submit} noValidate>
        {settings.equity === null ? (
          <Callout kind="fail" role="alert">
            <b>Equity is not set.</b> The scan refuses to run until you set it.
          </Callout>
        ) : null}
        <div className="grid2">
          <Field
            label="Equity"
            error={error}
            hint="Total capital that sizing and the deployment caps are measured against"
          >
            <input inputMode="decimal" value={equity} onChange={(e) => setEquity(e.target.value)} />
          </Field>
          <Field label="Base currency">
            <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
              <option value="HKD">HKD</option>
              <option value="USD">USD</option>
            </select>
          </Field>
          <Field label="USD/HKD used today">
            <input value={fx === null ? 'not stored yet' : n2(fx)} disabled readOnly />
          </Field>
          <Field label="Per-name cap (default)">
            <input value={`${num(settings.perNameCapPct, 0, 1)}% of equity`} disabled readOnly />
          </Field>
        </div>
        <Callout kind="blue">
          Sizing always uses full notional (strike x multiplier); broker margin is display only. Changing equity changes
          the contracts the scan proposes at the next scan.
        </Callout>
        <div className="row">
          <button type="submit" className="btn primary" disabled={mutation.busy}>
            {mutation.busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </Panel>
  );
}

interface TierDraft {
  key: number;
  drawdownPct: string;
  multiplier: string;
}

const tierDrafts = (tiers: DegearTierView[]): TierDraft[] =>
  tiers.map((t, i) => ({ key: i + 1, drawdownPct: num(t.drawdownPct, 0, 2), multiplier: num(t.multiplier, 0, 2) }));

/** The drawdown governor (pitfall 31): every field empty means the rule is off and sizing is unchanged. */
function GovernorForm({ settings }: { settings: SettingsView }) {
  const mutation = useMutation();
  const g = settings.governor;
  const [dailyLoss, setDailyLoss] = useState(g.dailyLossLimit === null ? '' : num(g.dailyLossLimit));
  const [streak, setStreak] = useState(g.consecutiveLossHalt === null ? '' : String(g.consecutiveLossHalt));
  const [tiers, setTiers] = useState<TierDraft[]>(tierDrafts(g.degearTiers));
  const [nextKey, setNextKey] = useState(g.degearTiers.length + 1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDailyLoss(g.dailyLossLimit === null ? '' : num(g.dailyLossLimit));
    setStreak(g.consecutiveLossHalt === null ? '' : String(g.consecutiveLossHalt));
    setTiers(tierDrafts(g.degearTiers));
    setNextKey(g.degearTiers.length + 1);
  }, [g.dailyLossLimit, g.consecutiveLossHalt, g.degearTiers]);

  const setTier = (key: number, patch: Partial<TierDraft>) =>
    setTiers((list) => list.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  const addTier = () => {
    setTiers((list) => [...list, { key: nextKey, drawdownPct: '', multiplier: '' }]);
    setNextKey((k) => k + 1);
  };
  const removeTier = (key: number) => setTiers((list) => list.filter((t) => t.key !== key));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const limit = parseNumber(dailyLoss);
    if (dailyLoss.trim() !== '' && (limit === null || limit <= 0))
      return setError('The daily loss limit must be a number above 0, or empty for none.');
    const halt = parseNumber(streak);
    if (streak.trim() !== '' && (halt === null || !Number.isInteger(halt) || halt <= 0))
      return setError('The consecutive-loss halt must be a whole number above 0, or empty for none.');
    const parsed: DegearTierView[] = [];
    for (const t of tiers) {
      const dd = parseNumber(t.drawdownPct);
      const m = parseNumber(t.multiplier);
      if (dd === null || dd <= 0 || dd > 100 || m === null || m < 0 || m > 1)
        return setError('Each tier needs a drawdown between 0 and 100% and a size multiplier from 0 to 1.');
      parsed.push({ drawdownPct: dd, multiplier: m });
    }
    setError(null);
    await mutation.run(
      () =>
        api.putSettings({
          governor: {
            dailyLossLimit: dailyLoss.trim() === '' ? null : limit,
            consecutiveLossHalt: streak.trim() === '' ? null : halt,
            degearTiers: parsed,
          },
        }),
      { success: 'Governor saved.' },
    );
  };

  return (
    <Panel title="Drawdown governor">
      <form className="stack" onSubmit={submit} noValidate aria-label="Drawdown governor">
        <small>
          Portfolio brakes outside the per-name rules. Leave a field empty to switch that rule off; with everything
          empty the scan sizes exactly as before.
        </small>
        <div className="grid2">
          <Field
            label={`Daily loss limit (${settings.baseCurrency})`}
            hint="A day P&L (closes booked today plus the change in open marks) at or below minus this halts new puts for the day"
          >
            <input
              inputMode="decimal"
              value={dailyLoss}
              onChange={(e) => setDailyLoss(e.target.value)}
              placeholder="none"
              aria-label="Daily loss limit"
            />
          </Field>
          <Field label="Consecutive-loss halt" hint="This many losing closes in a row halts new puts">
            <input
              inputMode="numeric"
              value={streak}
              onChange={(e) => setStreak(e.target.value)}
              placeholder="none"
              aria-label="Consecutive-loss halt"
            />
          </Field>
        </div>
        <fieldset className="stack" aria-label="De-gear tiers" style={{ border: 0, padding: 0, margin: 0 }}>
          <b>De-gear tiers</b>
          <small>
            At a drawdown of this share of equity under the P&amp;L peak, every new put is sized by the multiplier (0
            stops new puts). The deepest tier reached applies.
          </small>
          {tiers.length === 0 ? <small>No tiers: size multiplier 1.</small> : null}
          {tiers.map((t, i) => (
            <div className="row" key={t.key} style={{ gap: 8, alignItems: 'flex-end' }}>
              <Field label={`Tier ${i + 1} drawdown %`} style={{ flex: 1 }}>
                <input
                  inputMode="decimal"
                  value={t.drawdownPct}
                  onChange={(e) => setTier(t.key, { drawdownPct: e.target.value })}
                  aria-label={`Tier ${i + 1} drawdown percent`}
                />
              </Field>
              <Field label="Size multiplier" style={{ flex: 1 }}>
                <input
                  inputMode="decimal"
                  value={t.multiplier}
                  onChange={(e) => setTier(t.key, { multiplier: e.target.value })}
                  aria-label={`Tier ${i + 1} size multiplier`}
                />
              </Field>
              <button
                type="button"
                className="btn"
                onClick={() => removeTier(t.key)}
                aria-label={`Remove tier ${i + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
          <div className="row">
            <button type="button" className="btn" onClick={addTier} disabled={tiers.length >= 10}>
              Add tier
            </button>
          </div>
        </fieldset>
        {error ? (
          <Callout kind="fail" role="alert">
            {error}
          </Callout>
        ) : null}
        <div className="row">
          <button type="submit" className="btn primary" disabled={mutation.busy}>
            {mutation.busy ? 'Saving...' : 'Save governor'}
          </button>
        </div>
      </form>
    </Panel>
  );
}

export function SettingsPage() {
  const settings = useResource((signal) => api.settings(signal), []);
  const health = useResource((signal) => api.health(signal), []);
  const overview = useOverview();

  if (settings.loading) {
    return (
      <div className="page" aria-busy="true">
        <Skeleton height={220} />
        <Skeleton height={160} />
      </div>
    );
  }
  if (settings.error && !settings.data) {
    return (
      <div className="page">
        <ErrorBanner error={settings.error} onRetry={settings.refresh} title="Could not load settings." />
      </div>
    );
  }
  const view = settings.data;
  if (!view) return null;
  const { params, database, skills } = view;

  return (
    <div className="page">
      <h2>Settings</h2>
      <AccountForm settings={view} fx={overview.data?.fxUsdHkd ?? null} />
      <GovernorForm settings={view} />

      <Panel
        title="Strategy parameters"
        actions={
          <span className="row" style={{ gap: 6 }}>
            <Chip kind="blue">
              {params.name} v{params.version} [{params.hash}]
            </Chip>
            <Chip>read-only</Chip>
          </span>
        }
      >
        <div className="stack">
          <small>
            Parameters are shown read-only. Every scan records the version it used; editing needs a versioned editor and
            is not built yet (change them with SQL meanwhile).
          </small>
          <ParamsTree tree={params.tree} />
        </div>
      </Panel>

      <div className="grid2">
        <Panel title="Database">
          <div className="stack">
            <div className="row">
              {health.data ? (
                <Chip kind={health.data.database.connected ? 'ok' : 'fail'}>
                  {health.data.database.connected ? 'connected' : 'not connected'}
                </Chip>
              ) : (
                <Chip>checking...</Chip>
              )}
              <span className="mono">
                {database.name} &middot; {database.host}:{database.port}
              </span>
            </div>
            <small>The password lives only in the git-ignored .env file on the server and is never shown here.</small>
          </div>
        </Panel>
        <Panel title="Environment checks">
          <div className="stack">
            <div className="row">
              <Chip kind={skills.rootFound ? 'ok' : 'fail'}>{skills.rootFound ? 'found' : 'missing'}</Chip>{' '}
              <b>Skills root</b> <small className="mono">{skills.root}</small>
            </div>
            <div className="row">
              <Chip kind={skills.python ? 'ok' : 'warn'}>{skills.python ? 'found' : 'missing'}</Chip> <b>Python</b>{' '}
              <small className="mono">{skills.python ?? 'needed for exact-decimal checks in some skills'}</small>
            </div>
            <div className="row">
              <Chip kind={skills.claudeCli ? 'ok' : 'warn'}>{skills.claudeCli ? 'found' : 'missing'}</Chip>{' '}
              <b>Claude CLI</b>{' '}
              <small className="mono">{skills.claudeCli ?? 'AI research skills cannot run without it'}</small>
            </div>
            <div className="row">
              <Chip kind={skills.executor === 'claude-cli' ? 'ok' : 'warn'}>{skills.executor}</Chip> <b>Executor</b>
              <small>
                {skills.executor === 'claude-cli'
                  ? 'AI skills run through the claude CLI'
                  : 'AI skills are not run with a real model'}
              </small>
            </div>
          </div>
        </Panel>
      </div>

      <Panel title="More pages">
        <a className="ld-morerow" href={toHash({ page: 'backtests' })}>
          <span>
            <b>Backtests</b>
            <span className="sub">Replay the sell-put rules over past years and compare runs</span>
          </span>
          <span aria-hidden="true">&rsaquo;</span>
        </a>
      </Panel>
    </div>
  );
}
