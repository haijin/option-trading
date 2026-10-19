import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ASSET_LIMITS } from '../journal';
import { registerAuth, requireSession } from './auth/routes';
import type { ServerDeps } from './deps';
import { toErrorResponse } from './errors';
import { registerHealth, registerRoutes } from './routes';
import { registerSecurity } from './security';
import { createServices, type Services } from './services';

/** Builds the Fastify app. No listening here: index.ts listens, tests call `app.inject`. */
export async function buildApp(
  deps: ServerDeps,
  services: Services = createServices(deps),
): Promise<FastifyInstance & { services: Services }> {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  // The public host is only let through when the login is on: without it nothing guards the data.
  registerSecurity(app, {
    publicHost: deps.auth?.publicOrigin ? new URL(deps.auth.publicOrigin).host : null,
  });

  // Writes without a body (POST /api/scan/run, cancel) still send Content-Type: application/json; accept an empty payload.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error('the request body is not valid JSON') as Error & { statusCode: number; code: string };
      err.statusCode = 400;
      err.code = 'invalid_json';
      done(err, undefined);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toErrorResponse(err);
    if (status >= 500) deps.log(`500 ${(err as Error).stack ?? String(err)}`);
    void reply.code(status).send(body);
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api'))
      return void reply
        .code(404)
        .send({ error: { code: 'not_found', message: `no such endpoint: ${req.method} ${req.url.split('?')[0]}` } });
    return void reply.code(404).type('text/plain').send('not found');
  });

  // Public: liveness and the login endpoints. Everything else is registered inside one plugin that carries the gate, so a
  // new route is behind the login by default and no URL spelling can step around it.
  registerHealth(app, services);
  registerAuth(app, services.auth);
  const { auth } = services;
  await app.register(async (data) => {
    if (auth) data.addHook('onRequest', requireSession(auth));
    // Multipart is parsed only inside this gated scope (the journal's image upload); the gate above runs first.
    await data.register(fastifyMultipart, {
      limits: { fileSize: ASSET_LIMITS.maxBytes, files: 1, fields: 4, parts: 6 },
    });
    registerRoutes(data, services);
  });

  if (deps.webDir && existsSync(resolve(deps.webDir, 'index.html'))) {
    // Dynamic lookup (wildcard) so a UI rebuilt while the server runs is served without a restart.
    await app.register(fastifyStatic, { root: resolve(deps.webDir), index: false });
    app.get('/', (_req, reply) => reply.sendFile('index.html'));
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/plain')
        .send('Option Trading API is running. The web UI has not been built yet: run `pnpm web:build`.'),
    );
  }
  return Object.assign(app, { services }) as unknown as FastifyInstance & { services: Services };
}
