/**
 * Push and Mobile Wake: device tokens (app push registration), the VAPID key for Web Push,
 * the dialplan's loopback wake hooks (/api/internal/mobile-wake/...), the Mobile Wake
 * toggles, and the admin push configuration (Settings -> Mobile Wake).
 *
 * Envelopes follow OpDesk's contract per route: the device-token, VAPID and mobile-wake
 * status routes are bare; mobile-wake enable/disable and the /api/push/config family are
 * `{data}`; the internal hooks answer text/plain "1" or "".
 *
 * Python: the matching server.py routes (+ _mobile_wake_settings, _apply_mobile_wake,
 * _push_config_payload).
 */

import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { env } from '../../core/config';
import { getLogger } from '../../core/logger';
import { pyJsonDumps } from '../../core/py';
import { runtime } from '../../core/runtime';
import * as dbm from '../../db/db-manager';
import type { Row } from '../../db/pool';
import * as pushService from '../../integrations/push-service';
import { disableMobileWake, enableMobileWake } from '../../services/dialplan';
import * as sipPush from '../../services/sip-push';
import { HttpError } from '../http-error';
import { RawResponse, respond } from '../respond';
import { Auth, Delete, Get, Post, Put, principal } from '../routing';
import { parseBody, pInt, pStr, qStr, v } from '../validation';
import type { QueryParams } from '../validation';

const log = getLogger('api.routes.push');

export const DeviceTokenBody = v.model({
  token: v.str(),
  platform: v.str(), // "ios" | "android" | "web"
  token_type: v.str().optional(), // "voip" (iOS PushKit) | "alert" (regular APNs/FCM); default alert
  app_version: v.str().nullish(),
});

export const DeleteDeviceTokenBody = v.model({ token: v.str() });

export const WebResubscribeBody = v.dict();

export const MobileWakeConfigBody = v.model({
  hold_seconds: v.int().nullish(),
  settle_seconds: v.int().nullish(),
  wait_seconds: v.int().nullish(), // old name of hold_seconds
});

export const PushConfigBody = v.model({
  enabled: v.bool(),
  hold_seconds: v.int().optional(),
  settle_seconds: v.int().optional(),
  client_marker: v.str().optional(),
  fcm_project_id: v.str().optional(),
  // Key file contents. null/absent keeps what is stored; "" removes it.
  fcm_service_account: v.str().nullish(),
  apns_key_id: v.str().optional(),
  apns_team_id: v.str().optional(),
  apns_bundle_id: v.str().optional(),
  apns_auth_key: v.str().nullish(),
  apns_sandbox: v.bool().optional(),
});

/** A plain-text answer for the dialplan's CURL() (Starlette PlainTextResponse). */
function plain(text: string): RawResponse {
  return new RawResponse(text, { contentType: 'text/plain; charset=utf-8' });
}

/** The value of a query parameter as FastAPI's `name: str = ""` read it. */
function q(req: Request, name: string): string {
  return String(qStr(req.query as QueryParams, name, ''));
}

// ---------------------------------------------------------------------------
// Mobile Wake settings
// ---------------------------------------------------------------------------

export interface MobileWakeSettings {
  enabled: boolean;
  hold_seconds: number;
  settle_seconds: number;
  client_marker: string;
}

/** Mobile Wake settings from the DB (falling back to .env), clamped to their ranges. */
export async function mobileWakeSettings(): Promise<MobileWakeSettings> {
  const number = async (key: string, fallback: number, lo: number, hi: number): Promise<number> => {
    const raw = (await dbm.getSetting(key, env(key, String(fallback)))) || String(fallback);
    const f = Number(String(raw).trim());
    // int(float(raw)): a non-number falls back to the default.
    if (String(raw).trim() === '' || !Number.isFinite(f)) return fallback;
    return Math.max(lo, Math.min(Math.trunc(f), hi));
  };
  const enabled = ((await dbm.getSetting('MOBILE_WAKE_ENABLED', env('MOBILE_WAKE_ENABLED', ''))) || '').toLowerCase();
  const marker = await dbm.getSetting('MOBILE_CLIENT_MARKER', null);
  return {
    enabled: ['true', '1', 'yes'].includes(enabled),
    hold_seconds: await number('MOBILE_WAKE_WAIT', sipPush.DEFAULT_HOLD, 8, 30),
    settle_seconds: await number('MOBILE_WAKE_SETTLE', sipPush.DEFAULT_SETTLE, 0, 10),
    // A missing or empty row takes the default (get_setting maps '' to the fallback).
    client_marker: marker === null ? sipPush.DEFAULT_MARKER : marker,
  };
}

/** Write (or clear) the pre-dial hook and reload Asterisk; persist the result. */
export async function applyMobileWake(enabled: boolean, hold: number, settle: number): Promise<boolean> {
  const ok = enabled ? await enableMobileWake(hold, settle) : await disableMobileWake();
  if (ok) {
    await dbm.setSetting('MOBILE_WAKE_ENABLED', enabled ? 'true' : 'false');
    await dbm.setSetting('MOBILE_WAKE_WAIT', String(hold));
    await dbm.setSetting('MOBILE_WAKE_SETTLE', String(settle));
    sipPush.configure({ enabled });
  }
  return Boolean(ok);
}

/** A push token shown in Settings: first 8 … last 6 characters. */
export function maskToken(token: string | null | undefined): string {
  const t = token || '';
  return t.length <= 16 ? t : `${t.slice(0, 8)}…${t.slice(-6)}`;
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}T${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
  }
  return String(v);
}

/** GET/PUT /api/push/config's payload: Mobile Wake, provider status, and the RFC 8599 bindings. */
export async function pushConfigPayload(): Promise<Record<string, unknown>> {
  const bindings = ((await dbm.listSipPushBindings()) as Row[]).map((b) => ({
    id: b.id,
    extension: b.extension,
    provider: b.pn_provider,
    param: b.pn_param ?? null,
    token: maskToken(b.pn_prid),
    user_agent: b.user_agent ?? null,
    created_at: iso(b.created_at),
    last_seen_at: iso(b.last_seen_at),
  }));
  return { mobile_wake: await mobileWakeSettings(), ...pushService.configStatus(), bindings };
}

@Controller()
export class PushController {
  // -------------------------------------------------------------------------
  // Device tokens (apps and the browser)
  // -------------------------------------------------------------------------

  /**
   * Register (or refresh) a push token for the current user so the backend can wake the
   * device for incoming calls and send missed-call alerts. iOS registers twice: its APNs
   * alert token (token_type=alert) and its PushKit VoIP token (token_type=voip).
   * platform='web' carries a JSON Web Push subscription in `token`.
   */
  @Post('/api/device-tokens')
  @Auth('user')
  async registerDeviceToken(@Req() req: Request) {
    const body = parseBody(DeviceTokenBody, req.body);
    const user = principal(req);
    const token = (body.token || '').trim();
    const platform = (body.platform || '').trim().toLowerCase();
    const tokenType = (body.token_type || 'alert').trim().toLowerCase();
    if (!token || !['ios', 'android', 'web'].includes(platform) || !['voip', 'alert'].includes(tokenType)) {
      throw new HttpError(400, 'Invalid token, platform, or token_type');
    }
    const ok = await dbm.registerDeviceToken(user.id, user.extension, platform, tokenType, token, body.app_version ?? null);
    if (!ok) throw new HttpError(500, 'Failed to register device token');
    return { status: 'ok' };
  }

  /** Unregister a push token (call on logout). Body: { token }. ok also for an unknown token. */
  @Delete('/api/device-tokens')
  @Auth('user')
  async deleteDeviceToken(@Req() req: Request) {
    const body = parseBody(DeleteDeviceTokenBody, req.body);
    const token = (body.token || '').trim();
    if (!token) throw new HttpError(400, 'token required');
    await dbm.deleteDeviceToken(token);
    return { status: 'ok' };
  }

  /**
   * Public VAPID key for the browser to subscribe to Web Push. Unauthenticated so the
   * service worker / PWA can fetch it early. enabled=false when Web Push is off.
   */
  @Get('/api/push/vapid-public-key')
  @Auth('public')
  async vapidPublicKey() {
    return { enabled: pushService.webPushEnabled(), public_key: pushService.vapidPublicKey() || null };
  }

  /**
   * Re-register a rotated browser subscription. Body: { subscription: {...} }. Stored as a
   * platform='web' device token whose `token` is the JSON subscription.
   */
  @Post('/api/push/web-resubscribe')
  @Auth('user')
  async webResubscribe(@Req() req: Request) {
    const body = parseBody(WebResubscribeBody, req.body);
    const user = principal(req);
    const sub = body.subscription;
    const empty =
      sub === null ||
      sub === undefined ||
      sub === '' ||
      sub === false ||
      sub === 0 ||
      (Array.isArray(sub) && sub.length === 0) ||
      (typeof sub === 'object' && !Array.isArray(sub) && Object.keys(sub as object).length === 0);
    if (empty) throw new HttpError(400, 'subscription required');
    // json.dumps(sub): the stored token is compared byte-for-byte (its SHA-256 is the key),
    // so it is serialised the way the Python did.
    const token = typeof sub === 'string' ? sub : pyJsonDumps(sub);
    const ok = await dbm.registerDeviceToken(user.id, user.extension, 'web', 'alert', token, null);
    if (!ok) throw new HttpError(500, 'Failed to store web push subscription');
    return { status: 'ok' };
  }

  // -------------------------------------------------------------------------
  // The dialplan's hooks (loopback only, text/plain)
  // -------------------------------------------------------------------------

  /**
   * Called by the dialplan (CURL) BEFORE the extension is dialed: the RFC 8599 push step
   * (sipPush.wake). The dialplan then holds the call and polls .../ready while a killed or
   * backgrounded app wakes up and re-registers. Asterisk's CURL() issues a GET, so GET and
   * POST are both accepted. Returns "1" when a push went out (the dialplan should hold the
   * call), "" otherwise — letting non-mobile extensions ring with no added latency.
   */
  @Get('/api/internal/mobile-wake/:extension')
  @Auth('loopback')
  async internalMobileWakeGet(@Req() req: Request) {
    return this.internalMobileWake(req);
  }

  @Post('/api/internal/mobile-wake/:extension')
  @Auth('loopback')
  async internalMobileWakePost(@Req() req: Request) {
    return this.internalMobileWake(req);
  }

  private async internalMobileWake(req: Request): Promise<RawResponse> {
    const extension = pStr(req.params.extension);
    const callerNum = q(req, 'caller').trim();
    const name = q(req, 'name').trim();
    // Enrich the wake with the caller's display name for internal callers, so the ring
    // card shows "Alice (101)" instead of a bare number.
    let displayName = name && name !== callerNum ? name : '';
    if (callerNum && runtime.bridge) {
      const names = (runtime.bridge as { extensionNames?: unknown }).extensionNames;
      const known =
        names instanceof Map ? names.get(callerNum) : names && typeof names === 'object' ? (names as Record<string, unknown>)[callerNum] : null;
      if (known) displayName = String(known);
    }
    const hold = (await mobileWakeSettings()).hold_seconds;
    if (!(await sipPush.wake(extension, q(req, 'uid'), callerNum, displayName, hold))) return plain('');
    // One VoIP push per call: the DialBegin path skips its own push while this is fresh.
    sipPush.markPreWoken(extension);
    return plain('1');
  }

  /**
   * The dialplan's hold loop: `ready` ("1" once a mobile contact registered since the push),
   * `done` (call released to the phone) and `cancel` (hold ran out or the caller hung up:
   * send the RFC 8599 cancel push).
   */
  @Get('/api/internal/mobile-wake/:extension/:op')
  @Auth('loopback')
  async internalMobileWakeStepGet(@Req() req: Request) {
    return this.internalMobileWakeStep(req);
  }

  @Post('/api/internal/mobile-wake/:extension/:op')
  @Auth('loopback')
  async internalMobileWakeStepPost(@Req() req: Request) {
    return this.internalMobileWakeStep(req);
  }

  private async internalMobileWakeStep(req: Request): Promise<RawResponse> {
    const op = pStr(req.params.op);
    const uid = q(req, 'uid');
    if (op === 'ready') return plain((await sipPush.ready(uid)) ? '1' : '');
    if (op === 'done') {
      sipPush.done(uid);
      return plain('');
    }
    if (op === 'cancel') {
      await sipPush.cancel(uid);
      return plain('');
    }
    throw new HttpError(404, 'Unknown step');
  }

  // -------------------------------------------------------------------------
  // Mobile Wake toggles (superseded in the UI by /api/push/config, kept for clients)
  // -------------------------------------------------------------------------

  /** Current Mobile Wake configuration. `wait_seconds` is the old name of hold_seconds. */
  @Get('/api/mobile-wake/status')
  @Auth('user')
  async mobileWakeStatus() {
    const wake = await mobileWakeSettings();
    return { ...wake, wait_seconds: wake.hold_seconds };
  }

  /** Enable the mobile pre-dial wake dialplan. Optionally set hold_seconds / settle_seconds. */
  @Post('/api/mobile-wake/enable')
  @Auth('admin')
  async enableMobileWake(@Req() req: Request) {
    const body = parseBody(MobileWakeConfigBody, req.body ?? {});
    const wake = await mobileWakeSettings();
    const hold = Math.max(8, Math.min(body.hold_seconds || body.wait_seconds || wake.hold_seconds, 30));
    const settle = Math.max(0, Math.min(body.settle_seconds ?? wake.settle_seconds, 10));
    let ok: boolean;
    try {
      ok = await applyMobileWake(true, hold, settle);
    } catch (e) {
      log.error('Failed to enable mobile wake: %s', e);
      throw new HttpError(500, 'Internal server error');
    }
    if (!ok) throw new HttpError(500, 'Failed to enable mobile wake. Check server logs.');
    return respond({ message: `Mobile wake enabled (hold=${hold}s, settle=${settle}s). Asterisk dialplan reloaded.` });
  }

  /** Disable the mobile pre-dial wake dialplan. */
  @Post('/api/mobile-wake/disable')
  @Auth('admin')
  async disableMobileWake() {
    const wake = await mobileWakeSettings();
    let ok: boolean;
    try {
      ok = await applyMobileWake(false, wake.hold_seconds, wake.settle_seconds);
    } catch (e) {
      log.error('Failed to disable mobile wake: %s', e);
      throw new HttpError(500, 'Internal server error');
    }
    if (!ok) throw new HttpError(500, 'Failed to disable mobile wake. Check server logs.');
    return respond({ message: 'Mobile wake disabled. Asterisk dialplan reloaded.' });
  }

  // -------------------------------------------------------------------------
  // Push configuration (Settings -> Mobile Wake)
  // -------------------------------------------------------------------------

  /** Mobile Wake + push provider settings. Secrets are reported as present/absent only. */
  @Get('/api/push/config')
  @Auth('admin')
  async getPushConfig() {
    return respond(await pushConfigPayload());
  }

  /**
   * Save Mobile Wake and push provider settings, rewrite the pre-dial hook if it is on (or
   * was), and reload the push credentials.
   */
  @Put('/api/push/config')
  @Auth('admin')
  async putPushConfig(@Req() req: Request) {
    const raw = parseBody(PushConfigBody, req.body);
    const body = {
      enabled: raw.enabled,
      hold_seconds: raw.hold_seconds ?? sipPush.DEFAULT_HOLD,
      settle_seconds: raw.settle_seconds ?? sipPush.DEFAULT_SETTLE,
      client_marker: raw.client_marker ?? sipPush.DEFAULT_MARKER,
      fcm_project_id: raw.fcm_project_id ?? '',
      fcm_service_account: raw.fcm_service_account ?? null,
      apns_key_id: raw.apns_key_id ?? '',
      apns_team_id: raw.apns_team_id ?? '',
      apns_bundle_id: raw.apns_bundle_id ?? '',
      apns_auth_key: raw.apns_auth_key ?? null,
      apns_sandbox: raw.apns_sandbox ?? false,
    };
    if (!(body.hold_seconds >= 8 && body.hold_seconds <= 30)) throw new HttpError(400, 'Hold time must be 8 to 30 seconds');
    if (!(body.settle_seconds >= 0 && body.settle_seconds <= 10)) throw new HttpError(400, 'Settle window must be 0 to 10 seconds');
    for (const [label, value] of [
      ['Key ID', body.apns_key_id],
      ['Team ID', body.apns_team_id],
    ] as const) {
      if (value.trim() && !/^[A-Za-z0-9]{10}$/.test(value.trim())) {
        throw new HttpError(400, `APNs ${label} is 10 letters and digits`);
      }
    }
    let serviceAccount: Record<string, unknown> | null = null;
    if (body.fcm_service_account) {
      try {
        serviceAccount = pushService.parseServiceAccount(body.fcm_service_account);
      } catch (e) {
        throw new HttpError(400, `Service account JSON: ${(e as Error).message}`);
      }
    }
    let authKey: string | null = null;
    if (body.apns_auth_key) {
      try {
        authKey = pushService.validateApnsKey(body.apns_auth_key);
      } catch (e) {
        throw new HttpError(400, `APNs auth key: ${(e as Error).message}`);
      }
    }

    const projectId = body.fcm_project_id.trim() || String(serviceAccount?.project_id ?? '');
    await dbm.setSetting('PUSH_FCM_PROJECT_ID', projectId);
    if (body.fcm_service_account !== null) {
      await dbm.setSetting('PUSH_FCM_SERVICE_ACCOUNT', serviceAccount ? pyJsonDumps(serviceAccount) : '');
    }
    await dbm.setSetting('PUSH_APNS_KEY_ID', body.apns_key_id.trim().toUpperCase());
    await dbm.setSetting('PUSH_APNS_TEAM_ID', body.apns_team_id.trim().toUpperCase());
    await dbm.setSetting('PUSH_APNS_BUNDLE_ID', body.apns_bundle_id.trim());
    if (body.apns_auth_key !== null) await dbm.setSetting('PUSH_APNS_AUTH_KEY', authKey || '');
    await dbm.setSetting('PUSH_APNS_SANDBOX', body.apns_sandbox ? 'true' : 'false');
    await dbm.setSetting('MOBILE_CLIENT_MARKER', body.client_marker.trim());
    sipPush.configure({ marker: body.client_marker });

    const was = await mobileWakeSettings();
    if (body.enabled || was.enabled) {
      if (!(await applyMobileWake(body.enabled, body.hold_seconds, body.settle_seconds))) {
        throw new HttpError(500, 'Saved, but the Asterisk dialplan could not be updated. Check server logs.');
      }
    } else {
      await dbm.setSetting('MOBILE_WAKE_WAIT', String(body.hold_seconds));
      await dbm.setSetting('MOBILE_WAKE_SETTLE', String(body.settle_seconds));
    }

    await pushService.reloadConfig();
    return respond(await pushConfigPayload());
  }

  /**
   * Replace the Web Push (VAPID) key pair. Every browser subscription was made for the old
   * public key, so they are deleted; browsers subscribe again on their next visit.
   */
  @Post('/api/push/vapid/rotate')
  @Auth('admin')
  async rotateVapidKeys() {
    const [publicKey, privateKey] = pushService.generateVapidKeys();
    await dbm.setSetting('PUSH_VAPID_PUBLIC_KEY', publicKey);
    await dbm.setSetting('PUSH_VAPID_PRIVATE_KEY', privateKey);
    const removed = await dbm.deleteWebPushSubscriptions();
    await pushService.reloadConfig();
    return respond({ public_key: publicKey, removed_subscriptions: removed });
  }

  /** Forget one RFC 8599 binding. The phone adds it back on its next REGISTER. */
  @Delete('/api/push/bindings/:binding_id')
  @Auth('admin')
  async deletePushBinding(@Req() req: Request) {
    const bindingId = pInt(req.params.binding_id, 'binding_id');
    if (!(await dbm.deleteSipPushBinding(bindingId))) throw new HttpError(404, 'Binding not found');
    await sipPush.reloadBindings();
    return respond({ deleted: bindingId });
  }
}
