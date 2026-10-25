/**
 * API key management (admin only): list, mint, update and revoke integration keys.
 *
 * These routes are @Auth('admin'), i.e. JWT only, so a key can never mint, inspect or
 * escalate another key. Keys themselves are checked by the scope guards on the integration
 * surface ({scope: ...} / {apiKey: ...} policies).
 */

import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { setRedactedAuditDetail } from '../../core/audit';
import { getLogger } from '../../core/logger';
import { ALL_PERMISSIONS } from '../../core/security';
import * as dbm from '../../db/db-manager';
import { HttpError } from '../http-error';
import { RawResponse } from '../respond';
import { Auth, Delete, Get, Patch, Post, principal } from '../routing';
import { parseBody, pInt, v } from '../validation';

export const log = getLogger('api.routes.api_keys');

export const ApiKeyCreateBody = v.model({
  name: v.str(),
  scopes: v.list(),
  expires_at: v.str().nullish(), // 'YYYY-MM-DD' or ISO; omit/empty => never expires
});

export const ApiKeyUpdateBody = v.model({
  name: v.str().nullish(),
  scopes: v.list().nullish(),
  enabled: v.bool().nullish(),
  expires_at: v.str().nullish(), // "" clears the expiry
});

/** Reject unknown scope tokens (400 api_key.scope.unknown); return the list as strings. */
export function validateScopes(scopes: unknown[]): string[] {
  const known = ALL_PERMISSIONS as readonly string[];
  const unknown = scopes.filter((s) => typeof s !== 'string' || !known.includes(s));
  if (unknown.length) throw new HttpError(400, `Unknown scope(s): ${unknown.map(String).join(', ')}`);
  return scopes as string[];
}

@Controller()
export class ApiKeysController {
  /**
   * The permission tokens a key can be granted (drives the Settings scope picker).
   * Declared before /api/api-keys/:key_id; that route is PATCH/DELETE only, so the order
   * no longer matters as it did in FastAPI, but it reads the same.
   */
  @Get('/api/api-keys/permissions')
  @Auth('admin')
  async apiListPermissions() {
    return { permissions: ALL_PERMISSIONS };
  }

  /** List API keys, newest first. Metadata only: the plaintext is unrecoverable after creation. */
  @Get('/api/api-keys')
  @Auth('admin')
  async apiListApiKeys() {
    return { api_keys: await dbm.listApiKeys() };
  }

  /** Create an API key. The response carries the plaintext `key` (opd_...), shown exactly once. */
  @Post('/api/api-keys', { status: 201 })
  @Auth('admin')
  async apiCreateApiKey(@Req() req: Request) {
    const body = parseBody(ApiKeyCreateBody, req.body);
    const currentUser = principal(req);
    const name = (body.name || '').trim();
    if (!name) throw new HttpError(400, 'Name required');
    const scopes = validateScopes(body.scopes || []);
    if (!scopes.length) throw new HttpError(400, 'At least one scope is required');
    const result = await dbm.createApiKey(name, scopes, {
      createdBy: currentUser.id ?? null,
      expiresAt: body.expires_at || null,
    });
    if (!result) throw new HttpError(500, 'Failed to create API key');
    // Never the plaintext key: what was granted, and to whom.
    setRedactedAuditDetail(req, { name, scopes, expires_at: body.expires_at || null });
    log.info('API key created: %s (scopes=%s) by %s', name, scopes.join(','), currentUser.username);
    return result;
  }

  /** Update an API key's name, scopes, enabled flag or expiry. Partial update. */
  @Patch('/api/api-keys/:key_id')
  @Auth('admin')
  async apiUpdateApiKey(@Req() req: Request) {
    const keyId = pInt(req.params.key_id, 'key_id');
    const body = parseBody(ApiKeyUpdateBody, req.body);
    const existing = await dbm.getApiKey(keyId);
    if (!existing) throw new HttpError(404, 'API key not found');
    const scopes = body.scopes !== null && body.scopes !== undefined ? validateScopes(body.scopes) : null;
    const result = await dbm.updateApiKey(keyId, {
      name: body.name ?? null,
      scopes,
      enabled: body.enabled ?? null,
      expiresAt: body.expires_at ?? null,
    });
    if (!result) throw new HttpError(500, 'Failed to update API key');
    setRedactedAuditDetail(req, {
      name: existing.name,
      changes: Object.fromEntries(
        Object.entries({ name: body.name, scopes, enabled: body.enabled, expires_at: body.expires_at }).filter(
          ([, v]) => v !== null && v !== undefined,
        ),
      ),
    });
    return result;
  }

  /** Revoke (hard-delete) an API key. It stops authenticating immediately. */
  @Delete('/api/api-keys/:key_id', { status: 204 })
  @Auth('admin')
  async apiDeleteApiKey(@Req() req: Request) {
    const keyId = pInt(req.params.key_id, 'key_id');
    const existing = await dbm.getApiKey(keyId);
    if (!(await dbm.deleteApiKey(keyId))) throw new HttpError(404, 'API key not found');
    if (existing) setRedactedAuditDetail(req, { name: existing.name, scopes: existing.scopes ?? null });
    log.info('API key #%s revoked by %s', keyId, principal(req).username);
    return new RawResponse('', { status: 204 });
  }
}
