/**
 * A Nest app around a few controllers, wired like main.ts/app.module.ts: the OpDesk adapter,
 * the trace-id middleware, the JSON body parser, the AuthGuard (APP_GUARD) and the error
 * envelope filter. Stands in for @nestjs/testing, which is not a dependency.
 *
 *     const app = await nestApp([AuthController]);
 *     await request(app.getHttpServer()).get('/api/auth/me').expect(401);
 *     await app.close();
 */

import express from 'express';
import { INestApplication, Module, Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import { EnvelopeExceptionFilter, jsonBodyErrors, OpDeskExpressAdapter, traceMiddleware } from '../../src/api/respond';
import { AuthGuard } from '../../src/api/routing';

export async function nestApp(controllers: Type<unknown>[]): Promise<INestApplication> {
  @Module({
    controllers,
    providers: [
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: EnvelopeExceptionFilter },
    ],
  })
  class RoutesTestModule {}

  const app = await NestFactory.create(RoutesTestModule, new OpDeskExpressAdapter(), { logger: false, bodyParser: false });
  app.use(traceMiddleware);
  app.use(express.json({ strict: false }));
  app.use(jsonBodyErrors);
  await app.init();
  return app;
}
