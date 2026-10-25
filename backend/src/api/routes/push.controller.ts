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
import { setRedactedAuditDetail } from '../../core/audit';
import { runtime } from '../../core/runtime';
import * as dbm from '../../db/db-manager';
import type { Row } from '../../db/pool';
import * as pushService from '../../integrations/push-service';
import { disableMobileWake, enableMobileWake } from '../../services/dialplan';
import * as sipPush from '../../services/sip-push';
import { codes } from '../errors';
import { HttpError } from '../http-error';
import type { ErrorField } from '../http-error';
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

// A service-account key is ~2.4 KB and a .p8 ~250 bytes; anything far past that is not one.
export const KEY_TEXT_MAX = 20000;
export const MARKER_MAX = 64;
export const RE_APPLE_ID = /^[A-Z0-9]{10}$/;
export const RE_BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/;
export const RE_FCM_PROJECT = /^[a-z0-9][a-z0-9-]{4,62}$/;

/**
 * PUT /api/push/config. Every field is optional: one the client leaves out keeps what is
 * stored. For the two key files, null also keeps what is stored and "" removes it.
 */
export const PushConfigBody = v.model({
  enabled: v.bool().optional(),
  hold_seconds: v.int().optional(),
  settle_seconds: v.int().optional(),
  client_marker: v.maxLen(v.str(), MARKER_MAX).optional(),
  fcm_project_id: v.maxLen(v.str(), 64).optional(),
  // Key file contents. null/absent keeps what is stored; "" removes it.
  fcm_service_account: v.maxLen(v.str(), KEY_TEXT_MAX).nullish(),
  apns_key_id: v.maxLen(v.str(), 16).optional(),
  apns_team_id: v.maxLen(v.str(), 16).optional(),
  apns_bundle_id: v.maxLen(v.str(), 160).optional(),
  apns_auth_key: v.maxLen(v.str(), KEY_TEXT_MAX).nullish(),
  apns_sandbox: v.bool().optional(),
});
export type PushConfigBodyT = ReturnType<typeof PushConfigBody.parse>;

function fieldError(path: string, code: string, message: string): ErrorField {
  return { path, code, message, params: {} };
}

/** The audit/log word for what a PUT did to a key file. */
export function keyChange(value: string | null | undefined): string {
  return value === null || value === undefined ? 'kept' : value === '' ? 'removed' : 'replaced';
}

/**
 * The OpDesk_settings rows a PUT /api/push/config writes, or a 422 listing every field that
 * is wrong (not just the first). Only the fields the body carries are written.
 */
export async function pushSettingsFromBody(body: PushConfigBodyT): Promise<Record<string, string>> {
  const errors: ErrorField[] = [];
  const values: Record<string, string> = {};

  if (body.hold_seconds !== undefined && !(body.hold_seconds >= 8 && body.hold_seconds <= 30)) {
    errors.push(fieldError('hold_seconds', 'value.out_of_range', 'Hold time must be 8 to 30 seconds'));
  }
  if (body.settle_seconds !== undefined && !(body.settle_seconds >= 0 && body.settle_seconds <= 10)) {
    errors.push(fieldError('settle_seconds', 'value.out_of_range', 'Settle window must be 0 to 10 seconds'));
  }

  let serviceAccount: Record<string, unknown> | null = null;
  if (body.fcm_service_account) {
    try {
      serviceAccount = pushService.parseServiceAccount(body.fcm_service_account);
    } catch (e) {
      errors.push(fieldError('fcm_service_account', 'value.invalid_key', `Service account JSON: ${(e as Error).message}`));
    }
  }
  let projectId: string | null = null;
  if (body.fcm_project_id !== undefined) {
    projectId = body.fcm_project_id.trim() || String(serviceAccount?.project_id ?? '');
  } else if (serviceAccount && !(await dbm.getSetting('PUSH_FCM_PROJECT_ID', ''))) {
    // A first service account names the project when none is set yet.
    projectId = String(serviceAccount.project_id ?? '');
  }
  if (projectId && !RE_FCM_PROJECT.test(projectId)) {
    errors.push(fieldError('fcm_project_id', 'value.invalid', "FCM project ID: lowercase letters, digits and '-', as in the Firebase console"));
  }

  const keyId = body.apns_key_id === undefined ? null : body.apns_key_id.trim().toUpperCase();
  const teamId = body.apns_team_id === undefined ? null : body.apns_team_id.trim().toUpperCase();
  for (const [path, label, value] of [
    ['apns_key_id', 'Key ID', keyId],
    ['apns_team_id', 'Team ID', teamId],
  ] as const) {
    if (value && !RE_APPLE_ID.test(value)) errors.push(fieldError(path, 'value.invalid', `APNs ${label} is 10 letters and digits`));
  }
  const bundleId = body.apns_bundle_id === undefined ? null : body.apns_bundle_id.trim();
  if (bundleId && !RE_BUNDLE_ID.test(bundleId)) {
    errors.push(fieldError('apns_bundle_id', 'value.invalid', "Bundle ID: letters, digits, '.' and '-', e.g. com.example.app"));
  }
  let authKey: string | null = null;
  if (body.apns_auth_key) {
    try {
      authKey = pushService.validateApnsKey(body.apns_auth_key);
    } catch (e) {
      errors.push(fieldError('apns_auth_key', 'value.invalid_key', `APNs auth key: ${(e as Error).message}`));
    }
  }

  if (errors.length) {
    throw new HttpError(422, { code: codes.PUSH_CONFIG_INVALID, message: errors.map((f) => f.message).join('; '), fields: errors });
  }

  if (projectId !== null) values.PUSH_FCM_PROJECT_ID = projectId;
  if (body.fcm_service_account !== null && body.fcm_service_account !== undefined) {
    values.PUSH_FCM_SERVICE_ACCOUNT = serviceAccount ? pyJsonDumps(serviceAccount) : '';
  }
  if (keyId !== null) values.PUSH_APNS_KEY_ID = keyId;
  if (teamId !== null) values.PUSH_APNS_TEAM_ID = teamId;
  if (bundleId !== null) values.PUSH_APNS_BUNDLE_ID = bundleId;
  if (body.apns_auth_key !== null && body.apns_auth_key !== undefined) values.PUSH_APNS_AUTH_KEY = authKey || '';
  if (body.apns_sandbox !== undefined) values.PUSH_APNS_SANDBOX = body.apns_sandbox ? 'true' : 'false';
  // '' is a real value here (no marker: only pn-* contacts count as mobile), so it is stored
  // as it is and read back as it is (see mobileWakeSettings).
  if (body.client_marker !== undefined) values.MOBILE_CLIENT_MARKER = body.client_marker.trim();
  return values;
}

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
  // Read the row itself rather than through getSetting, which maps an empty value to its
  // fallback: a marker the admin cleared must stay cleared, not turn back into the default.
  const all = await dbm.getAllSettings();
  const marker = Object.prototype.hasOwnProperty.call(all, 'MOBILE_CLIENT_MARKER') ? (all.MOBILE_CLIENT_MARKER ?? '') : null;
  return {
    enabled: ['true', '1', 'yes'].includes(enabled),
    hold_seconds: await number('MOBILE_WAKE_WAIT', sipPush.DEFAULT_HOLD, 8, 30),
    settle_seconds: await number('MOBILE_WAKE_SETTLE', sipPush.DEFAULT_SETTLE, 0, 10),
    // Only a missing row takes the default; a stored '' means "no marker".
    client_marker: marker === null ? sipPush.DEFAULT_MARKER : marker,
  };
}

/** Write (or clear) the pre-dial hook and reload Asterisk; persist the result. */
export async function applyMobileWake(enabled: boolean, hold: number, settle: number): Promise<boolean> {
  const ok = enabled ? await enableMobileWake(hold, settle) : await disableMobileWake();
  if (!ok) return false;
  const saved = await dbm.setSettings({
    MOBILE_WAKE_ENABLED: enabled ? 'true' : 'false',
    MOBILE_WAKE_WAIT: String(hold),
    MOBILE_WAKE_SETTLE: String(settle),
  });
  if (saved) sipPush.configure({ enabled });
  return Boolean(saved);
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
    setRedactedAuditDetail(req, { enabled: true, hold_seconds: hold, settle_seconds: settle });
    return respond({ message: `Mobile wake enabled (hold=${hold}s, settle=${settle}s). Asterisk dialplan reloaded.` });
  }

  /** Disable the mobile pre-dial wake dialplan. */
  @Post('/api/mobile-wake/disable')
  @Auth('admin')
  async disableMobileWake(@Req() req: Request) {
    const wake = await mobileWakeSettings();
    let ok: boolean;
    try {
      ok = await applyMobileWake(false, wake.hold_seconds, wake.settle_seconds);
    } catch (e) {
      log.error('Failed to disable mobile wake: %s', e);
      throw new HttpError(500, 'Internal server error');
    }
    if (!ok) throw new HttpError(500, 'Failed to disable mobile wake. Check server logs.');
    setRedactedAuditDetail(req, { enabled: false });
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
   * Save Mobile Wake and push provider settings (all or nothing; a field the body leaves out
   * keeps what is stored), rewrite the pre-dial hook if it is on (or was), and reload the push
   * credentials. Invalid input is one 422 naming every field that is wrong.
   */
  @Put('/api/push/config')
  @Auth('admin')
  async putPushConfig(@Req() req: Request) {
    const body = parseBody(PushConfigBody, req.body);
    const values = await pushSettingsFromBody(body);
    const was = await mobileWakeSettings();
    const enabled = body.enabled ?? was.enabled;
    const hold = body.hold_seconds ?? was.hold_seconds;
    const settle = body.settle_seconds ?? was.settle_seconds;
    // With the wake off before and after, no dialplan is rewritten, so the timings are
    // stored here; otherwise applyMobileWake stores them once the dialplan took them.
    if (!enabled && !was.enabled) {
      if (body.hold_seconds !== undefined) values.MOBILE_WAKE_WAIT = String(hold);
      if (body.settle_seconds !== undefined) values.MOBILE_WAKE_SETTLE = String(settle);
    }
    if (Object.keys(values).length && !(await dbm.setSettings(values))) {
      throw new HttpError(500, { code: codes.SETTINGS_SAVE_FAILED, message: 'Could not save the push settings. Nothing was changed.' });
    }
    if (values.MOBILE_CLIENT_MARKER !== undefined) sipPush.configure({ marker: values.MOBILE_CLIENT_MARKER });
    setRedactedAuditDetail(req, {
      enabled,
      hold_seconds: hold,
      settle_seconds: settle,
      changed: Object.keys(values).sort(),
      fcm_service_account: keyChange(body.fcm_service_account),
      apns_auth_key: keyChange(body.apns_auth_key),
    });

    if (enabled || was.enabled) {
      if (!(await applyMobileWake(enabled, hold, settle))) {
        throw new HttpError(500, 'Saved, but the Asterisk dialplan could not be updated. Check server logs.');
      }
    }

    await pushService.reloadConfig();
    return respond(await pushConfigPayload());
  }

  /**
   * Replace the Web Push (VAPID) key pair. Every browser subscription was made for the old
   * public key, so they are deleted; browsers subscribe again on their next visit. Keys and
   * subscriptions change in one transaction: on failure nothing changed (a 500).
   */
  @Post('/api/push/vapid/rotate')
  @Auth('admin')
  async rotateVapidKeys(@Req() req: Request) {
    const [publicKey, privateKey] = pushService.generateVapidKeys();
    const removed = await dbm.replaceVapidKeys({ PUSH_VAPID_PUBLIC_KEY: publicKey, PUSH_VAPID_PRIVATE_KEY: privateKey });
    if (removed === null) {
      throw new HttpError(500, { code: codes.SETTINGS_SAVE_FAILED, message: 'Could not save the new web push keys. Nothing was changed.' });
    }
    await pushService.reloadConfig();
    setRedactedAuditDetail(req, { removed_subscriptions: removed });
    log.info('VAPID keys replaced by user %s; %s web subscription(s) removed', principal(req).id ?? null, removed);
    return respond({ public_key: publicKey, removed_subscriptions: removed });
  }

  /** Forget one RFC 8599 binding. The phone adds it back on its next REGISTER. */
  @Delete('/api/push/bindings/:binding_id')
  @Auth('admin')
  async deletePushBinding(@Req() req: Request) {
    const bindingId = pInt(req.params.binding_id, 'binding_id');
    if (!(await dbm.deleteSipPushBinding(bindingId))) throw new HttpError(404, 'Binding not found');
    await sipPush.reloadBindings();
    setRedactedAuditDetail(req, { deleted: bindingId });
    return respond({ deleted: bindingId });
  }
}
