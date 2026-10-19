import type { FastifyInstance } from 'fastify';
import { ApiError } from './errors';

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

export const isLoopbackHost = (host: string): boolean => LOCAL_HOST.test(host);

export interface SecurityOptions {
  /** `host[:port]` of the configured public URL (`APP_URL`), the one non-loopback Host that is let through; null for none. */
  publicHost?: string | null;
}

/**
 * The API can write to the database and start AI runs, so a web page on another origin must never be able to drive it:
 *  - `Host` must be a loopback name, or exactly the host of `APP_URL` when the login is on (defeats DNS rebinding);
 *  - a browser `Origin`, when sent, must be the same host:port as `Host` (defeats cross-site requests);
 *  - every write must declare `Content-Type: application/json` (a plain HTML form cannot, and a cross-origin fetch that
 *    sets it needs a CORS preflight that this server never grants).
 * The server also binds to 127.0.0.1 only (see index.ts); a tunnel or reverse proxy on this machine is what makes `APP_URL`
 * reachable, and every request through it then needs a signed-in session (src/server/auth).
 */
export function registerSecurity(app: FastifyInstance, options: SecurityOptions = {}): void {
  const publicHost = options.publicHost?.toLowerCase() ?? null;
  app.addHook('onRequest', async (req) => {
    const host = req.headers.host ?? '';
    if (!LOCAL_HOST.test(host) && host.toLowerCase() !== publicHost)
      throw new ApiError(403, 'forbidden_host', 'this server only answers on localhost');
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch {
        throw new ApiError(403, 'forbidden_origin', 'malformed Origin header');
      }
      if (originHost.toLowerCase() !== host.toLowerCase())
        throw new ApiError(403, 'forbidden_origin', 'cross-origin requests are not allowed');
    } else if (origin === 'null') {
      throw new ApiError(403, 'forbidden_origin', 'opaque origins are not allowed');
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const ct = (req.headers['content-type'] ?? '').toLowerCase();
      // The one multipart endpoint is the journal's image upload. The route is matched by the pattern Fastify resolved,
      // never by the raw URL, so no spelling of the path can claim the exemption. A cross-site form post is still
      // stopped by the Origin check above and by the SameSite session cookie.
      const upload =
        req.method === 'POST' &&
        req.routeOptions?.url === '/api/journal/assets' &&
        ct.startsWith('multipart/form-data');
      if (!ct.startsWith('application/json') && !upload)
        throw new ApiError(415, 'json_required', 'writes must send Content-Type: application/json');
    }
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.url.startsWith('/api') || (req.routeOptions?.url ?? '').startsWith('/api')) {
      // API answers are never cached, except a route that says so itself (the journal's images: private, a day).
      if (!reply.hasHeader('cache-control')) reply.header('Cache-Control', 'no-store');
    } else
      reply.header(
        'Content-Security-Policy',
        // blob: is the local preview of an image that is still uploading; the images themselves are same-origin.
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
  });
}
