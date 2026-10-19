import { ProviderError } from '../yahoo/client';

const UA = 'Mozilla/5.0 (compatible; OptionTradingNews/1.0)';
const TIMEOUT_MS = 20_000;

/** GET as text with a timeout and a plain user agent. Non-2xx is a ProviderError (429 is `rate_limit`). */
export async function getText(
  fetchFn: typeof fetch,
  provider: string,
  target: string,
  url: string,
  accept = '*/*',
): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { 'user-agent': UA, accept },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // A replay miss in a test is a test bug, not a feed failure: let it through unwrapped.
    if ((err as Error).name === 'ReplayMissError') throw err;
    throw new ProviderError(provider, target, (err as Error).message.split('\n')[0] ?? 'request failed');
  }
  if (!res.ok)
    throw new ProviderError(provider, target, `HTTP ${res.status}`, res.status === 429 ? 'rate_limit' : 'error');
  return res.text();
}
