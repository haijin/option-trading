/**
 * A small universe in a test database for the Leaders scan, service and API tests: three leaders with scripted shapes
 * (a Setup, a Watch, a deep base), a crowd of random-walk names that gives the rank table something to rank against, and the
 * index and vol-index bars the regime needs. Names are US unless said otherwise.
 */
import { eq } from 'drizzle-orm';
import type { Market } from '../../src/core/calendar';
import type { Instrument } from '../../src/core/types';
import type { Db } from '../../src/db/client';
import { findInstrument, setSettings } from '../../src/db/repos';
import { universeMembers } from '../../src/db/schema';
import { writeBars, writeFxRates } from '../../src/db/writers';
import { barsFromCloses, END, linear, walkCloses } from './history';
import { leaderBars, N, type Shape } from './leaders';
import { seedInstrument } from './seed';

export interface LeadersWorld {
  asOf: string;
  setup: Instrument;
  watch: Instrument;
  deep: Instrument;
  crowd: Instrument[];
  all: Instrument[];
}

export interface WorldOptions {
  market?: Market;
  crowd?: number;
  /** Extra shape for the Setup name (for example a wider stop). */
  setupShape?: Shape;
  withUniverse?: boolean;
}

export async function seedLeadersWorld(db: Db, o: WorldOptions = {}): Promise<LeadersWorld> {
  const market = o.market ?? 'US';
  const ccy = market === 'HK' ? 'HKD' : 'USD';
  const sym = (s: string): string => (market === 'HK' ? s.replace(/\D/g, '').padStart(4, '0') || '0001' : s);
  const mk = async (symbol: string, name: string): Promise<Instrument> =>
    seedInstrument(db, market, symbol, { name, sector: 'Technology', hasListedOptions: false });

  // index and vol index: a rising market, calm
  const spy = (await findInstrument(db, market, market === 'US' ? 'SPY' : '2800')) as Instrument;
  const vol = (await findInstrument(db, market, market === 'US' ? 'VIX' : 'VHSI')) as Instrument;
  await writeBars(db, spy.id, barsFromCloses(linear(400, 520, 600), END, market, { volume: 5_000_000 }));
  await writeBars(db, vol.id, barsFromCloses(linear(16, 16, 600), END, market, { volume: 0 }));
  await writeFxRates(db, [{ day: END, pair: 'USDHKD', rate: 7.8, source: 'test' }]);
  await setSettings(db, { equity: 2_000_000, baseCurrency: 'HKD' });

  const setup = await mk(market === 'HK' ? '0981' : 'LEAD1', 'Setup Corp');
  const watch = await mk(market === 'HK' ? '1810' : 'LEAD2', 'Watch Corp');
  const deep = await mk(market === 'HK' ? '3750' : 'LEAD3', 'Deep Corp');
  const stockLot = market === 'HK' ? { providerSymbols: { stockLot: 100 } } : {};
  if (market === 'HK') {
    for (const i of [setup, watch, deep])
      await seedInstrument(db, 'HK', i.symbol, { providerSymbols: stockLot.providerSymbols, hasListedOptions: false });
  }
  await writeBars(db, setup.id, leaderBars(o.setupShape ?? {}, market));
  await writeBars(db, watch.id, leaderBars({ last: { open: 95.4, close: 95.1, low: 94.8, high: 95.6 } }, market));
  await writeBars(
    db,
    deep.id,
    leaderBars(
      {
        base: [99.6, 98.8, 96.0, 92.0, 88.0, 84.0, 80.0, 76.0, 72.0, 76.0, 82.0, 87.0, 90.0],
        last: { open: 90.0, close: 92.0, low: 89.8, high: 92.2 },
      },
      market,
    ),
  );
  // the crowd: random walks without drift, 1M shares a day
  const crowd: Instrument[] = [];
  const n = o.crowd ?? 60;
  for (let i = 0; i < n; i++) {
    const c = await mk(sym(`C${String(i).padStart(3, '0')}`), `Crowd ${i}`);
    const closes = walkCloses({
      n: N,
      start: 80 + (i % 7) * 10,
      drift: 0.0003 * ((i % 5) - 2),
      vol: 0.012,
      seed: 100 + i,
    });
    await writeBars(db, c.id, barsFromCloses(closes, END, market, { volume: 1_000_000 }));
    crowd.push(c);
  }
  const all = [setup, watch, deep, ...crowd];
  if (o.withUniverse !== false) {
    for (const i of all)
      await db
        .insert(universeMembers)
        .values({ instrumentId: i.id, indexCode: market === 'US' ? 'SPX' : 'HSI', addedAt: '2026-01-01' })
        .onConflictDoNothing();
  }
  void ccy;
  return { asOf: END, setup, watch, deep, crowd, all };
}

export async function removeFromUniverse(db: Db, instrumentId: number, day = '2026-10-01'): Promise<void> {
  await db.update(universeMembers).set({ removedAt: day }).where(eq(universeMembers.instrumentId, instrumentId));
}
