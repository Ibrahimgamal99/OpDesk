/**
 * Route declarations for every controller: method decorators that answer 200 by default
 * (FastAPI's default; Nest's POST default is 201) and @Auth, the one place a route says who
 * may call it.
 *
 * Deny by default: every route must carry exactly one @Auth policy. assertEveryRouteHasPolicy()
 * runs at startup and refuses to boot when one is missing, so a forgotten check is a crash on
 * deploy rather than an open endpoint.
 *
 *   'public'                 no credential (the handler may still check one itself)
 *   'user'                   get_current_user
 *   'admin'                  require_admin
 *   'supervisor'             admin or supervisor
 *   'loopback'               require_loopback (dialplan CURLs on 127.0.0.1)
 *   { scope: 'calls:read' }  require_scope("calls:read"): an API key with the scope, or any JWT
 *   { apiKey: 'extension-config:read' }  an API key with the scope, never a JWT
 */

import {
  applyDecorators,
  CanActivate,
  Delete as NestDelete,
  ExecutionContext,
  Get as NestGet,
  HttpCode,
  Injectable,
  Patch as NestPatch,
  Post as NestPost,
  Put as NestPut,
  SetMetadata,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  getCurrentUser,
  Principal,
  principalOf,
  requireAdmin,
  requireApiKey,
  requireScope,
  requireSupervisor,
} from '../core/security';
import { clientHost } from './client-host';
import { HttpError } from './http-error';

export { clientHost } from './client-host';

export type AuthPolicy =
  | 'public'
  | 'user'
  | 'admin'
  | 'supervisor'
  | 'loopback'
  | { scope: string }
  | { apiKey: string };

export const AUTH_POLICY = 'opdesk:auth-policy';

/** Declares who may call the route. Exactly one per handler. */
export const Auth = (policy: AuthPolicy) => SetMetadata(AUTH_POLICY, policy);

interface RouteOptions {
  /** status_code=... on the FastAPI decorator. */
  status?: number;
}

const route =
  (decorator: (path?: string | string[]) => MethodDecorator) =>
  (path: string, opts: RouteOptions = {}) =>
    applyDecorators(decorator(path), HttpCode(opts.status ?? 200));

export const Get = route(NestGet);
export const Post = route(NestPost);
export const Put = route(NestPut);
export const Patch = route(NestPatch);
export const Delete = route(NestDelete);

/**
 * Refuse anything but this box. The /api/internal/ endpoints are called by the dialplan's
 * CURL() on 127.0.0.1 and carry no JWT, so this check is their only guard.
 */
export function requireLoopback(req: Request): void {
  const host = clientHost(req) ?? '';
  if (host !== '127.0.0.1' && host !== '::1') throw new HttpError(403, 'Loopback only');
}

/** The principal the route's @Auth guard resolved. Throws on a public route (a bug). */
export function principal(req: Request): Principal {
  const p = principalOf(req);
  if (!p) throw new Error(`no principal on ${req.method} ${req.path}: the route is not behind an authenticating @Auth policy`);
  return p;
}

/** Runs the route's @Auth policy before the handler (FastAPI resolved Depends() first too). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const policy = this.reflector.get<AuthPolicy | undefined>(AUTH_POLICY, context.getHandler());
    if (policy === undefined) {
      // Unreachable once assertEveryRouteHasPolicy() has run; deny rather than allow.
      throw new HttpError(500, 'Route has no auth policy');
    }
    if (typeof policy === 'object') {
      if ('scope' in policy) await requireScope(req, policy.scope);
      else await requireApiKey(req, policy.apiKey);
      return true;
    }
    switch (policy) {
      case 'public':
        return true;
      case 'user':
        await getCurrentUser(req);
        return true;
      case 'admin':
        await requireAdmin(req);
        return true;
      case 'supervisor':
        await requireSupervisor(req);
        return true;
      case 'loopback':
        requireLoopback(req);
        return true;
    }
  }
}

/** Startup check: every controller handler declares an @Auth policy. */
@Injectable()
export class RoutePolicyCheck {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  assertEveryRouteHasPolicy(): void {
    const missing: string[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance) continue;
      const proto = Object.getPrototypeOf(instance) as object;
      for (const name of this.scanner.getAllMethodNames(proto)) {
        const handler = (proto as Record<string, unknown>)[name] as object;
        const isRoute = Reflect.getMetadata('path', handler) !== undefined;
        if (isRoute && this.reflector.get(AUTH_POLICY, handler as () => unknown) === undefined) {
          missing.push(`${wrapper.name}.${name}`);
        }
      }
    }
    if (missing.length) throw new Error(`Routes without an @Auth policy (deny by default): ${missing.join(', ')}`);
  }
}
