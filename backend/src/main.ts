/**
 * OpDesk server entry point (server.py `__main__`): HTTPS when HTTPS_CERT/HTTPS_KEY are set
 * and exist (port OPDESK_HTTPS_PORT, default 8443), otherwise HTTP on PORT (default 8765).
 * OPDESK_LISTEN_PORT overrides both, so a side-by-side instance can run beside the live one.
 */

import { BACKEND_DIR, env } from './core/config'; // first: loads .env before anything reads it
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { clientHost } from './api/client-host';
import { expressErrorHandler, jsonBodyErrors, OpDeskExpressAdapter, traceMiddleware } from './api/respond';
import { attachWebSocket } from './api/routes/ws';
import { FRONTEND_PATH } from './api/routes/spa.controller';
import { auditMutations } from './core/audit';
import { getLogger, logAccess } from './core/logger';

const log = getLogger('server');

/** (cert, key) for HTTPS if configured and present, else null. Relative paths resolve from backend/. */
function sslPaths(): { cert: string; key: string } | null {
  let cert = env('HTTPS_CERT', '').trim();
  let key = env('HTTPS_KEY', '').trim();
  if (!cert || !key) return null;
  if (!path.isAbsolute(cert)) cert = path.normalize(path.join(BACKEND_DIR, cert));
  if (!path.isAbsolute(key)) key = path.normalize(path.join(BACKEND_DIR, key));
  return fs.existsSync(cert) && fs.existsSync(key) ? { cert, key } : null;
}

/** CORS_ALLOWED_ORIGINS (comma list); empty = any origin, without credentials. */
function corsOrigins(): string[] {
  const list = env('CORS_ALLOWED_ORIGINS', '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return list.length ? list : ['*'];
}

/** The port to listen on: OPDESK_LISTEN_PORT, else OPDESK_HTTPS_PORT with TLS, else PORT. */
export function listenPort(tls: boolean): number {
  const override = Number(env('OPDESK_LISTEN_PORT', ''));
  if (override) return override;
  return tls ? Number(env('OPDESK_HTTPS_PORT', '8443')) || 8443 : Number(env('PORT', '8765')) || 8765;
}

async function bootstrap(): Promise<void> {
  const ssl = sslPaths();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, new OpDeskExpressAdapter(), {
    bodyParser: false,
    logger: ['error', 'warn'],
    // On shutdown, drop idle keep-alive connections instead of waiting for them to time out.
    forceCloseConnections: true,
    httpsOptions: ssl ? { cert: fs.readFileSync(ssl.cert), key: fs.readFileSync(ssl.key) } : undefined,
  });

  // X-Forwarded-For is trusted from loopback only (nginx on this box), as uvicorn's
  // forwarded_allow_ips=127.0.0.1 did: the login limiter keys on the real client IP and the
  // loopback-only routes refuse anything that arrived through nginx. See api/client-host.ts.
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  // Every response carries X-Trace-Id, set before anything else can answer.
  app.use(traceMiddleware);

  // CORS (outermost in the Python app): '*' without credentials, or the explicit list with them.
  const origins = corsOrigins();
  app.enableCors({
    origin: origins[0] === '*' ? true : origins,
    credentials: origins[0] !== '*',
    exposedHeaders: ['X-Trace-Id', 'Retry-After', 'Content-Disposition'],
  });

  // One access line per request, in uvicorn's shape, minus the quiet polls.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => logAccess(`${clientHost(req) ?? '-'}:${req.socket.remotePort ?? 0}`, req.method, req.originalUrl, req.httpVersion, res.statusCode));
    next();
  });

  // FastAPI read a JSON body when there was no Content-Type or an application/(*+)json one.
  app.use(
    express.json({
      limit: '50mb',
      strict: false,
      type: (req) => {
        const ct = String(req.headers['content-type'] || '');
        return !ct ? Number(req.headers['content-length'] || 0) > 0 : /^application\/([\w.+-]+\+)?json\b/i.test(ct);
      },
    }),
  );
  app.use(jsonBodyErrors);
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  app.use(auditMutations);

  if (fs.existsSync(path.join(FRONTEND_PATH, 'assets'))) {
    app.use('/assets', express.static(path.join(FRONTEND_PATH, 'assets'), { fallthrough: false }));
  }

  app.enableShutdownHooks();

  const port = listenPort(Boolean(ssl));
  const host = env('OPDESK_BIND_HOST', '0.0.0.0');
  await app.init();
  // Errors raised outside Nest's pipeline (express.static) still render the envelope.
  app.use(expressErrorHandler);
  attachWebSocket(app.getHttpServer());
  await app.listen(port, host);
  if (ssl) log.info('Starting OpDesk over HTTPS on port %s (cert=%s)', port, ssl.cert);
  else log.info('Starting OpDesk over HTTP on port %s (set HTTPS_CERT and HTTPS_KEY for HTTPS)', port);
}

bootstrap().catch((e: unknown) => {
  log.critical('OpDesk failed to start: %s', e, e);
  process.exitCode = 1;
});
