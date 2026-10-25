/**
 * The Nest application: every controller in the FastAPI router order, the auth guard, the
 * error-envelope filter, and the lifespan hooks.
 *
 * The first matching route wins, so the controller order is load-bearing:
 *   - SettingsController serves GET /api/settings/:key, which would swallow
 *     /api/settings/users, /agents, /queues, /groups, /extensions if it came before the
 *     controllers that own them.
 *   - SpaController (the GET catch-all) goes last, after every /api route. Unrouted /api
 *     requests get the JSON 404/405 from api/respond.ts, never index.html.
 * (/ws is not a Nest route: see api/routes/ws.ts, attached to the HTTP server in main.ts.)
 */

import { BeforeApplicationShutdown, Injectable, Module, OnApplicationBootstrap } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { OpenApiBuilder } from './api/openapi';
import { EnvelopeExceptionFilter } from './api/respond';
import { AuthGuard, RoutePolicyCheck } from './api/routing';
import { AuditController } from './api/routes/audit.controller';
import { AuthController } from './api/routes/auth.controller';
import { SpaController } from './api/routes/spa.controller';
import { SystemController } from './api/routes/system.controller';
import { SoftphoneController } from './api/routes/softphone.controller';
import { PushController } from './api/routes/push.controller';
import { LogsController } from './api/routes/logs.controller';
import { ApiKeysController } from './api/routes/api-keys.controller';
import { UsersController } from './api/routes/users.controller';
import { GroupsController } from './api/routes/groups.controller';
import { AgentsController } from './api/routes/agents.controller';
import { LiveController } from './api/routes/live.controller';
import { PbxController } from './api/routes/pbx.controller';
import { RecordingController } from './api/routes/recording.controller';
import { CrmController } from './api/routes/crm.controller';
import { CallHistoryController } from './api/routes/call-history.controller';
import { SettingsController } from './api/routes/settings.controller';
import { AnalyticsController } from './api/routes/analytics.controller';
import { shutdown, startup } from './core/lifespan';

@Injectable()
export class LifespanService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(private readonly policies: RoutePolicyCheck) {}

  async onApplicationBootstrap(): Promise<void> {
    // Deny by default: refuse to serve if any route forgot its @Auth policy.
    this.policies.assertEveryRouteHasPolicy();
    await startup();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await shutdown();
  }
}

/** Controllers in registration order (first match wins). */
export const CONTROLLERS = [
  AuthController,
  SoftphoneController,
  PushController,
  LogsController,
  AuditController,
  ApiKeysController,
  UsersController,
  GroupsController,
  AgentsController,
  LiveController,
  PbxController,
  RecordingController,
  CrmController,
  CallHistoryController,
  SettingsController, // after Softphone/Users/Groups/Agents/Live/Pbx: its /api/settings/:key would shadow /api/settings/users|agents|groups|queues
  AnalyticsController,
  SystemController,
  SpaController, // last: the GET catch-all
];

@Module({
  imports: [DiscoveryModule],
  controllers: CONTROLLERS,
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: EnvelopeExceptionFilter },
    RoutePolicyCheck,
    OpenApiBuilder,
    LifespanService,
  ],
})
export class AppModule {}
