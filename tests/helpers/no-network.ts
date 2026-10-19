/**
 * CI must never call Yahoo or Stooq live. Tests that need HTTP inject a replay fetch (src/providers/http-replay.ts);
 * anything that falls back to the global fetch fails loudly here instead of reaching the network.
 */
globalThis.fetch = (async (input: unknown) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : ((input as { url?: string }).url ?? String(input));
  throw new Error(`network access is disabled in tests (fetch ${url}); inject a replay fetch instead`);
}) as typeof fetch;

// A developer's .env may point at a live OpenD; tests must never reach it. Empty (not deleted) so dotenv cannot refill it.
process.env.FUTU_PORT = '';
process.env.FUTU_WS_KEY = '';
