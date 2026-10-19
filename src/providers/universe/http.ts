import { ProviderError } from '../yahoo/client';

/** Descriptive agent string (Wikimedia asks for one); carries no personal data. */
export const UNIVERSE_USER_AGENT =
  'OptionTradingUniverse/1.0 (personal decision-support tool; weekly index-constituent refresh, a handful of requests)';
const TIMEOUT_MS = 45_000;

async function request(fetchFn: typeof fetch, provider: string, target: string, url: string, accept: string) {
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { 'user-agent': UNIVERSE_USER_AGENT, accept },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // A replay miss in a test is a test bug, not a source failure: let it through unwrapped.
    if ((err as Error).name === 'ReplayMissError') throw err;
    throw new ProviderError(provider, target, (err as Error).message.split('\n')[0] ?? 'request failed');
  }
  if (!res.ok)
    throw new ProviderError(provider, target, `HTTP ${res.status}`, res.status === 429 ? 'rate_limit' : 'error');
  return res;
}

export async function getUniverseText(
  fetchFn: typeof fetch,
  provider: string,
  target: string,
  url: string,
  accept = 'application/json',
): Promise<string> {
  return (await request(fetchFn, provider, target, url, accept)).text();
}

export async function getUniverseBytes(
  fetchFn: typeof fetch,
  provider: string,
  target: string,
  url: string,
): Promise<Buffer> {
  const res = await request(fetchFn, provider, target, url, '*/*');
  return Buffer.from(await res.arrayBuffer());
}
