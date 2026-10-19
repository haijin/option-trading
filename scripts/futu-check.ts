/**
 * Live check of the moomoo OpenD connection (read-only). Run once OpenD is up and logged in:
 *   pnpm tsx scripts/futu-check.ts 0700 --multiplier 400
 *   pnpm tsx scripts/futu-check.ts AAPL --market US --multiplier 100
 * Reads FUTU_HOST / FUTU_PORT / FUTU_WS_KEY from the environment (or .env via dotenv).
 * --multiplier must match the instrument's board lot (HK) or 100 (US); a mismatch is reported, not rescaled.
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { canonicalSymbol } from '../src/core/symbols';
import { FutuClient, fetchFutuPutChain, futuSecurity, openDSdk } from '../src/providers/futu';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    market: { type: 'string', default: 'HK' },
    multiplier: { type: 'string', default: '100' },
  },
});
const raw = positionals[0];
if (!raw) {
  console.error('usage: pnpm tsx scripts/futu-check.ts <symbol> [--market HK|US] [--multiplier N]');
  process.exit(2);
}
const market = values.market === 'US' ? 'US' : 'HK';
const symbol = canonicalSymbol(market, raw);
const multiplier = Number(values.multiplier);
const port = Number(process.env.FUTU_PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error('FUTU_PORT is not set. It is the OpenD WebSocket port (websocket_port in OpenD.xml).');
  process.exit(2);
}

const host = process.env.FUTU_HOST?.trim() || '127.0.0.1';
const client = new FutuClient(openDSdk(), {
  host,
  port,
  ...(process.env.FUTU_WS_KEY?.trim() ? { wsKey: process.env.FUTU_WS_KEY.trim() } : {}),
});

try {
  await client.connect();
  console.log(`connected to OpenD at ${host}:${port}`);

  const owner = futuSecurity(market, symbol);
  const [under] = await client.snapshots([owner]);
  console.log(`underlying ${owner.code}: ${under?.basic.curPrice ?? 'no price'}`);

  const expirations = await client.optionExpirations(owner);
  const next = expirations.slice(0, 3).map((e) => `${e.strikeTime} (${e.distance}d)`);
  console.log(`expirations: ${expirations.length}, next: ${next.join(', ') || 'none'}`);

  const snap = await fetchFutuPutChain(
    client,
    { market, symbol, multiplier },
    { now: new Date(), minDte: 14, maxDte: 75 },
  );
  console.log(`put chain (14-75 DTE): ${snap.quotes.length} puts @ ${snap.snapshotDate}`);
  for (const q of snap.quotes.slice(0, 5)) {
    console.log(`  ${q.expiry} ${q.strike}P bid ${q.bid} ask ${q.ask} iv ${q.iv} delta ${q.delta}`);
  }
} catch (err) {
  console.error(`FAILED: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  client.close();
}
