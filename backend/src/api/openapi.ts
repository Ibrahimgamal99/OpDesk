/**
 * The OpenAPI document of every route the running server exposes, built from the registered
 * controllers (FastAPI generated /openapi.json the same way). It lists each path and method,
 * its path parameters, its @Auth policy and its controller; request and response bodies are
 * not described, because handlers validate them themselves (see api/validation.ts). The
 * hand-written spec of the machine-to-machine surface, with full schemas, stays at
 * /api/openapi.yaml.
 */

import { Injectable, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { AUTH_POLICY, AuthPolicy } from './routing';

export interface OpenApiOperation {
  tags: string[];
  operationId: string;
  summary: string;
  parameters: { name: string; in: 'path'; required: true; schema: { type: 'string' } }[];
  security?: Record<string, string[]>[];
  responses: Record<string, { description: string }>;
}

export type OpenApiDocument = {
  openapi: string;
  info: { title: string; version: string; description: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { securitySchemes: Record<string, Record<string, string>> };
};

const METHODS: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

function describePolicy(policy: AuthPolicy | undefined): { summary: string; security?: Record<string, string[]>[] } {
  if (policy === undefined || policy === 'public') return { summary: 'public', security: [] };
  if (policy === 'loopback') return { summary: 'loopback only (Asterisk dialplan)', security: [] };
  if (typeof policy === 'object') {
    if ('scope' in policy) return { summary: `user token or API key with ${policy.scope}`, security: [{ bearer: [] }, { apiKey: [policy.scope] }] };
    return { summary: `API key with ${policy.apiKey} only`, security: [{ apiKey: [policy.apiKey] }] };
  }
  return { summary: `${policy} (OpDesk sign-in token)`, security: [{ bearer: [] }] };
}

@Injectable()
export class OpenApiBuilder {
  private cached: OpenApiDocument | null = null;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  document(): OpenApiDocument {
    if (this.cached) return this.cached;
    const paths: OpenApiDocument['paths'] = {};
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as object | undefined;
      if (!instance) continue;
      const tag = wrapper.name.replace(/Controller$/, '');
      const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const name of this.scanner.getAllMethodNames(proto)) {
        const handler = proto[name] as object;
        const route = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
        const method = METHODS[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
        if (route === undefined || !method) continue;
        for (const raw of Array.isArray(route) ? route : [route]) {
          if (raw.includes('{*')) continue; // the SPA catch-all is not an API route
          // `:id` and the `*file_path` wildcard (Express 5) are both path parameters.
          const params = [...raw.matchAll(/[:*](\w+)/g)].map((m) => m[1]);
          const path = raw.replace(/[:*](\w+)/g, '{$1}');
          const policy = this.reflector.get<AuthPolicy | undefined>(AUTH_POLICY, handler as () => unknown);
          const { summary, security } = describePolicy(policy);
          paths[path] ??= {};
          paths[path][method] = {
            tags: [tag],
            operationId: `${tag}.${name}`,
            summary,
            parameters: params.map((p) => ({ name: p, in: 'path', required: true, schema: { type: 'string' } })),
            ...(security ? { security } : {}),
            responses: { '200': { description: 'Success' }, default: { description: 'Error: {"error": {...}}' } },
          };
        }
      }
    }
    this.cached = {
      openapi: '3.0.3',
      info: {
        title: 'OpDesk',
        version: '2.0.0',
        description:
          'Every route of the running server. Bodies are not described here; the integration ' +
          'surface with full schemas is /api/openapi.yaml, and docs/api/endpoints.md is the reference.',
      },
      paths,
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'OpDesk sign-in token (POST /api/auth/login)' },
          apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        },
      },
    };
    return this.cached;
  }
}
