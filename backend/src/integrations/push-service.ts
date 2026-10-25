/**
 * Push notification dispatch for the OpDesk mobile softphone integration.
 *
 * Two delivery paths, both backend-initiated:
 *
 *   sendCallWake(...)  Incoming-call wake. Time-critical. Wakes a backgrounded/killed app so it can
 *                      show the native call UI (CallKit / ConnectionService) and register
 *                      SIP-over-WSS to take the call. iOS -> APNs VoIP push (PushKit token,
 *                      apns-push-type: voip). Android -> high-priority data-only FCM message.
 *                      Web -> Web Push to the stored browser subscription.
 *
 *   sendAlert(...)     Missed-call / general banner. Best-effort. iOS -> APNs alert push.
 *                      Android -> FCM notification message. Web -> Web Push banner.
 *
 *   sendRfc8599(...)   RFC 8599 push to the pn-provider / pn-prid / pn-param a softphone put in
 *                      its REGISTER Contact (see services/sip-push.ts). The provider, the APNs
 *                      host and topic come from the binding itself, not from an app-side token API.
 *
 * Providers: FCM HTTP v1 (Android) and direct APNs HTTP/2 with token-based auth (iOS).
 *
 * This module is a NO-OP when its settings are unset, so web-only / dev deployments are
 * unaffected. A push failure is logged and never propagates to the caller (the AMI/WebSocket
 * path must not break because a phone is unreachable).
 *
 * Config: Settings -> Mobile Wake (OpDesk DB, PUSH_* keys), falling back to the .env variables
 *     FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT_FILE
 *     APNS_AUTH_KEY_FILE, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_USE_SANDBOX
 *     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 *
 * The network goes through `transport` (fetch for FCM and Google OAuth, HTTP/2 for APNs, the
 * web-push library for browsers). Tests replace it with setPushTransport(), so a test run
 * can never reach FCM, APNs or a browser push service.
 *
 * Python: backend/push_service.py
 */

import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import * as http2 from 'node:http2';

import { getLogger } from '../core/logger';
import { createTask, time } from '../core/py';
import * as dbm from '../db/db-manager';

const log = getLogger('integrations.push_service');

type Json = Record<string, unknown>;

/** A device_tokens row as getDeviceTokensForExtension returns it. */
export interface DeviceTokenRow {
  token?: string | null;
  platform?: string | null;
  token_type?: string | null;
  [k: string]: unknown;
}

/** A sip_push_bindings row (or anything carrying its pn_* fields). */
export interface PushBindingRow {
  pn_provider?: string | null;
  pn_prid?: string | null;
  pn_param?: string | null;
  [k: string]: unknown;
}

export type OnDead = (token: string) => unknown;

// =============================================================================
// Transport (swappable for tests)
// =============================================================================

/** The subset of the web-push library this module uses. */
export interface WebPushLib {
  sendNotification(
    subscription: unknown,
    payload: string,
    options: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL: number },
  ): Promise<unknown>;
}

export interface PushTransport {
  /** FCM sends and the Google OAuth token exchange. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** One APNs HTTP/2 POST. */
  h2Post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; text: string }>;
  /** The web-push library, or null when it is not installed (Web Push then stays off). */
  webPush: () => WebPushLib | null;
}

const HTTP_TIMEOUT_MS = 10_000;
const h2Sessions = new Map<string, http2.ClientHttp2Session>();

function h2Session(origin: string): http2.ClientHttp2Session {
  const existing = h2Sessions.get(origin);
  if (existing && !existing.closed && !existing.destroyed) return existing;
  const session = http2.connect(origin);
  // Errors reach the pending request as its own error; this keeps an idle session's error
  // (GOAWAY, reset) from being an unhandled 'error' event.
  session.on('error', () => undefined);
  session.on('close', () => {
    if (h2Sessions.get(origin) === session) h2Sessions.delete(origin);
  });
  h2Sessions.set(origin, session);
  return session;
}

/** POST over HTTP/2 (APNs only speaks HTTP/2); resolves with the status and body text. */
async function realH2Post(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  const u = new URL(url);
  const session = h2Session(u.origin);
  return await new Promise((resolve, reject) => {
    const req = session.request({ ':method': 'POST', ':path': u.pathname + u.search, ...headers });
    let status = 0;
    const chunks: Buffer[] = [];
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      reject(new Error('timed out'));
    });
    req.on('response', (h) => {
      status = Number(h[':status']);
    });
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve({ status, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', reject);
    req.end(body);
  });
}

let webPushLib: WebPushLib | null | undefined;

function loadWebPush(): WebPushLib | null {
  if (webPushLib === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      webPushLib = require('web-push') as WebPushLib;
    } catch {
      webPushLib = null;
    }
  }
  return webPushLib;
}

const realTransport: PushTransport = {
  fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }),
  h2Post: realH2Post,
  webPush: loadWebPush,
};

let transport: PushTransport = realTransport;

/** Replace parts of the transport (tests). `null` restores the real one. */
export function setPushTransport(t: Partial<PushTransport> | null): void {
  transport = t ? { ...realTransport, ...t } : realTransport;
}

/** Close the shared HTTP/2 connections (call on app shutdown). */
export async function close(): Promise<void> {
  const sessions = [...h2Sessions.values()];
  h2Sessions.clear();
  await Promise.all(
    sessions.map(
      (s) =>
        new Promise<void>((resolve) => {
          if (s.closed || s.destroyed) return resolve();
          // close() waits for open streams; a stuck APNs stream must not hold up shutdown.
          const timer = setTimeout(() => {
            s.destroy();
            resolve();
          }, 2000);
          timer.unref();
          s.close(() => {
            clearTimeout(timer);
            resolve();
          });
        }),
    ),
  );
}

// =============================================================================
// Configuration
// =============================================================================
// Settings -> Mobile Wake writes these to the OpDesk DB, so keys can be uploaded from the UI.
// Each falls back to the older .env variable, so existing installs keep working untouched.
// The service-account JSON and the .p8 key are stored as their contents, not as paths.

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const APNS_HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };

/** The loaded push configuration (the Python `_config` dict; keys unchanged). */
export interface PushConfig {
  fcm_project_id: string;
  fcm_sa_info: Json | null;
  fcm_sa_source: 'ui' | 'env' | null;
  apns_key_id: string;
  apns_team_id: string;
  apns_bundle_id: string;
  apns_key_pem: string;
  apns_key_source: 'ui' | 'env' | null;
  apns_sandbox: boolean;
  vapid_public: string;
  vapid_private: string;
  vapid_subject: string;
}

const UNLOADED_CONFIG: PushConfig = {
  fcm_project_id: '',
  fcm_sa_info: null,
  fcm_sa_source: null,
  apns_key_id: '',
  apns_team_id: '',
  apns_bundle_id: '',
  apns_key_pem: '',
  apns_key_source: null,
  apns_sandbox: false,
  vapid_public: '',
  vapid_private: '',
  vapid_subject: 'mailto:admin@opdesk.local',
};

let config: PushConfig | null = null;
let configLoading: Promise<unknown> | null = null;

/** The UI value of `key`, else the .env variable `envName`, else `fallback`; trimmed. */
async function setting(key: string, envName = '', fallback = ''): Promise<string> {
  let value: string | null = null;
  if (key) {
    try {
      value = await dbm.getSetting(key, null);
    } catch {
      value = null;
    }
  }
  if (value === null || value === undefined || value === '') {
    value = envName ? (process.env[envName] ?? fallback) : fallback;
  }
  return (value || '').trim();
}

async function readFile(path: string): Promise<string> {
  if (!path) return '';
  try {
    return await fs.readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // The installer writes placeholder paths into .env; a missing file just means unset.
      log.info('Push key file %s not found; that provider stays off unless set in Settings', path);
      return '';
    }
    log.warning('⚠️  Push key file %s unreadable: %s', path, e);
    return '';
  }
}

function truthyFlag(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value || '').trim().toLowerCase());
}

export async function loadConfig(): Promise<PushConfig> {
  let saText = await setting('PUSH_FCM_SERVICE_ACCOUNT');
  let saSource: PushConfig['fcm_sa_source'] = saText ? 'ui' : null;
  if (!saText) {
    saText = await readFile(await setting('', 'FCM_SERVICE_ACCOUNT_FILE'));
    saSource = saText ? 'env' : null;
  }
  let saInfo: Json | null = null;
  try {
    saInfo = saText ? parseServiceAccount(saText) : null;
  } catch (e) {
    log.warning('⚠️  FCM service account ignored: %s', e);
    saInfo = null;
    saSource = null;
  }

  let p8 = await setting('PUSH_APNS_AUTH_KEY');
  let p8Source: PushConfig['apns_key_source'] = p8 ? 'ui' : null;
  if (!p8) {
    p8 = (await readFile(await setting('', 'APNS_AUTH_KEY_FILE'))).trim();
    p8Source = p8 ? 'env' : null;
  }

  return {
    fcm_project_id: (await setting('PUSH_FCM_PROJECT_ID', 'FCM_PROJECT_ID')) || String(saInfo?.project_id ?? ''),
    fcm_sa_info: saInfo,
    fcm_sa_source: saSource,
    apns_key_id: await setting('PUSH_APNS_KEY_ID', 'APNS_KEY_ID'),
    apns_team_id: await setting('PUSH_APNS_TEAM_ID', 'APNS_TEAM_ID'),
    apns_bundle_id: await setting('PUSH_APNS_BUNDLE_ID', 'APNS_BUNDLE_ID'),
    apns_key_pem: p8,
    apns_key_source: p8Source,
    apns_sandbox: truthyFlag(await setting('PUSH_APNS_SANDBOX', 'APNS_USE_SANDBOX', 'false')),
    vapid_public: await setting('PUSH_VAPID_PUBLIC_KEY', 'VAPID_PUBLIC_KEY'),
    vapid_private: await setting('PUSH_VAPID_PRIVATE_KEY', 'VAPID_PRIVATE_KEY'),
    vapid_subject: (await setting('PUSH_VAPID_SUBJECT', 'VAPID_SUBJECT')) || 'mailto:admin@opdesk.local',
  };
}

/**
 * The loaded config.
 *
 * NOTE(port): Python loaded it lazily and synchronously on first use. Loading reads the
 * database, which is async here, so the getters stay synchronous by reading the cache: until
 * the startup reloadConfig() (or the background load this starts) has finished, every
 * provider reads as not configured.
 */
export function cfg(): PushConfig {
  if (config === null) {
    if (configLoading === null) {
      configLoading = createTask(reloadConfig(), (e) => log.error('❌  Push config load failed: %s', e)).finally(() => {
        configLoading = null;
      });
    }
    return UNLOADED_CONFIG;
  }
  return config;
}

/**
 * Re-read the push settings and drop every cached credential. Call it after the settings
 * were saved, and once at startup.
 */
export async function reloadConfig(): Promise<void> {
  config = await loadConfig();
  fcmToken = { token: null, exp: 0 };
  apnsJwtCache.token = null;
  apnsJwtCache.exp = 0;
}

/** Validate a Firebase service-account key file; throws an Error with the reason. */
export function parseServiceAccount(text: string): Json {
  let info: unknown;
  try {
    info = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  if (!info || typeof info !== 'object' || Array.isArray(info) || (info as Json).type !== 'service_account') {
    throw new Error('not a service-account key ("type" must be "service_account")');
  }
  const obj = info as Json;
  const missing = ['project_id', 'private_key', 'client_email'].filter((k) => !obj[k]);
  if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
  return obj;
}

/** Validate an APNs .p8 auth key (PEM, EC P-256); returns it trimmed or throws with the reason. */
export function validateApnsKey(text: string): string {
  const pem = (text || '').trim();
  if (!pem.includes('BEGIN PRIVATE KEY')) throw new Error('not a .p8 key (no BEGIN PRIVATE KEY block)');
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new Error('the key could not be read');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('APNs keys are EC P-256; this is a different kind of key');
  }
  return pem;
}

/**
 * New VAPID P-256 key pair as [public, private], both base64url: the public key is the
 * uncompressed point (the browser's applicationServerKey), the private key the raw scalar.
 */
export function generateVapidKeys(): [string, string] {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pad32 = (s: string | undefined) => {
    const b = Buffer.from(s ?? '', 'base64url');
    return Buffer.concat([Buffer.alloc(Math.max(0, 32 - b.length)), b]);
  };
  const pub = Buffer.concat([Buffer.from([4]), pad32(jwk.x), pad32(jwk.y)]);
  return [pub.toString('base64url'), pad32(jwk.d).toString('base64url')];
}

/** What the admin UI shows: identifiers and whether each secret is present, never the secrets. */
export function configStatus(): { fcm: Json; apns: Json; web: Json } {
  const c = cfg();
  const sa = c.fcm_sa_info || {};
  return {
    fcm: {
      project_id: c.fcm_project_id,
      has_service_account: Object.keys(sa).length > 0,
      service_account_email: sa.client_email ?? '',
      service_account_project: sa.project_id ?? '',
      source: c.fcm_sa_source,
      ready: fcmEnabled(),
    },
    apns: {
      key_id: c.apns_key_id,
      team_id: c.apns_team_id,
      bundle_id: c.apns_bundle_id,
      has_auth_key: Boolean(c.apns_key_pem),
      source: c.apns_key_source,
      sandbox: c.apns_sandbox,
      ready: apnsEnabled(),
    },
    web: {
      public_key: c.vapid_public,
      ready: webPushEnabled(),
      library_installed: transport.webPush() !== null,
    },
  };
}

// --- Web Push (VAPID) --------------------------------------------------------

/** The VAPID public key served to the browser so it subscribes with a matching key. */
export function vapidPublicKey(): string {
  return cfg().vapid_public;
}

/**
 * Web Push is available only when the web-push library is installed and both VAPID keys
 * are set. Everything degrades to a no-op otherwise, so the feature is opt-in and safe.
 */
export function webPushEnabled(): boolean {
  const c = cfg();
  return Boolean(transport.webPush() !== null && c.vapid_public && c.vapid_private);
}

/**
 * Send one Web Push message to a stored browser subscription (JSON string). Returns true on
 * success. Deletes the stored token on a 404/410 (expired subscription).
 */
export async function sendWebPush(subscriptionJson: string, payload: Json): Promise<boolean> {
  if (!webPushEnabled()) return false;
  let subscription: unknown;
  try {
    subscription = JSON.parse(subscriptionJson);
  } catch {
    return false;
  }
  const lib = transport.webPush() as WebPushLib;
  const c = cfg();
  try {
    await lib.sendNotification(subscription, JSON.stringify(payload), {
      vapidDetails: { subject: c.vapid_subject, publicKey: c.vapid_public, privateKey: c.vapid_private },
      TTL: 30,
    });
    return true;
  } catch (e) {
    const status = (e as { statusCode?: number })?.statusCode;
    if (status === 404 || status === 410) {
      // Subscription is gone — drop it so we stop trying.
      try {
        await dbm.deleteDeviceToken(subscriptionJson);
      } catch {
        // ignore
      }
    } else {
      log.warning('Web push failed: %s', e instanceof Error ? e.name : typeof e);
    }
    return false;
  }
}

export function fcmEnabled(): boolean {
  const c = cfg();
  return Boolean(c.fcm_project_id && c.fcm_sa_info);
}

export function apnsEnabled(): boolean {
  const c = cfg();
  return Boolean(c.apns_key_pem && c.apns_key_id && c.apns_team_id && c.apns_bundle_id);
}

function apnsHost(sandbox: boolean | null = null): string {
  const useSandbox = sandbox === null ? cfg().apns_sandbox : sandbox;
  return useSandbox ? APNS_HOSTS.sandbox : APNS_HOSTS.production;
}

// =============================================================================
// Cached credentials
// =============================================================================

let fcmToken: { token: string | null; exp: number } = { token: null, exp: 0 };
export const apnsJwtCache: { token: string | null; exp: number } = { token: null, exp: 0 };

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

/**
 * An OAuth2 access token for FCM HTTP v1, from the service account (the JWT-bearer grant
 * google-auth performed). Cached until a minute before it expires; null when FCM is off or
 * the exchange failed.
 */
export async function getFcmAccessToken(): Promise<string | null> {
  if (!fcmEnabled()) return null;
  const now = time();
  if (fcmToken.token && now < fcmToken.exp) return fcmToken.token;
  try {
    const sa = cfg().fcm_sa_info as Json;
    const tokenUri = String(sa.token_uri || 'https://oauth2.googleapis.com/token');
    const iat = Math.trunc(now);
    const header: Json = { alg: 'RS256', typ: 'JWT' };
    if (sa.private_key_id) header.kid = sa.private_key_id;
    const claims = { iss: sa.client_email, scope: FCM_SCOPE, aud: tokenUri, iat, exp: iat + 3600 };
    const unsigned = `${b64urlJson(header)}.${b64urlJson(claims)}`;
    const signature = crypto.sign('sha256', Buffer.from(unsigned), String(sa.private_key)).toString('base64url');
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    });
    const resp = await transport.fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await resp.text();
    if (resp.status !== 200) throw new Error(`token endpoint answered ${resp.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text) as Json;
    if (!data.access_token) throw new Error('no access_token in the token response');
    fcmToken = { token: String(data.access_token), exp: now + Math.max(60, Number(data.expires_in ?? 3600) - 60) };
    return fcmToken.token;
  } catch (e) {
    log.warning('⚠️  FCM access token error: %s', e);
    return null;
  }
}

/** A cached ES256 provider JWT for APNs token-based auth (valid ~1h, refreshed at 50m). */
export function getApnsJwt(): string | null {
  if (!apnsEnabled()) return null;
  const now = time();
  if (apnsJwtCache.token && now < apnsJwtCache.exp) return apnsJwtCache.token;
  try {
    const c = cfg();
    const unsigned = `${b64urlJson({ alg: 'ES256', kid: c.apns_key_id, typ: 'JWT' })}.${b64urlJson({
      iss: c.apns_team_id,
      iat: Math.trunc(now),
    })}`;
    const signature = crypto
      .sign('sha256', Buffer.from(unsigned), { key: c.apns_key_pem, dsaEncoding: 'ieee-p1363' })
      .toString('base64url');
    apnsJwtCache.token = `${unsigned}.${signature}`;
    apnsJwtCache.exp = now + 50 * 60;
    return apnsJwtCache.token;
  } catch (e) {
    log.warning('⚠️  APNs JWT signing error: %s', e);
    return null;
  }
}

// =============================================================================
// Low-level senders
// =============================================================================

/**
 * Send one FCM HTTP v1 message. `message` is the inner object (without the 'token' field).
 * `onDead(token)` runs when FCM says the token is gone (default: drop it from device_tokens).
 */
export async function sendFcm(token: string, message: Json, onDead: OnDead | null = null): Promise<void> {
  const accessToken = await getFcmAccessToken();
  if (!accessToken) return;
  const url = `https://fcm.googleapis.com/v1/projects/${cfg().fcm_project_id}/messages:send`;
  try {
    const resp = await transport.fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token, ...message } }),
    });
    if (resp.status === 200) return;
    const body = (await resp.text()) || '';
    // Only prune on UNREGISTERED or 404 — INVALID_ARGUMENT also covers malformed payloads
    // and should not be treated as a dead-token signal.
    if (body.includes('UNREGISTERED') || resp.status === 404) {
      log.info('Pruning stale FCM token');
      await (onDead ?? dbm.deleteDeviceToken)(token);
    }
    log.warning('⚠️  FCM send failed (%s): %s', resp.status, body.slice(0, 300));
  } catch (e) {
    log.warning('⚠️  FCM send error: %s', e);
  }
}

/**
 * Send one APNs HTTP/2 request. pushType: 'voip' | 'alert' | 'background'. `sandbox`
 * overrides the configured APNs host; `onDead(token)` runs when Apple says the token is gone
 * (default: drop it from device_tokens).
 */
export async function sendApns(
  token: string,
  payload: Json,
  pushType: string,
  topic: string,
  opts: { collapseId?: string | null; sandbox?: boolean | null; onDead?: OnDead | null } = {},
): Promise<void> {
  const providerJwt = getApnsJwt();
  if (!providerJwt) return;
  const url = `${apnsHost(opts.sandbox ?? null)}/3/device/${token}`;
  const isVoip = pushType === 'voip';
  const headers: Record<string, string> = {
    authorization: `bearer ${providerJwt}`,
    'apns-topic': topic,
    'apns-push-type': pushType,
    // voip: immediate; background: 5 (Apple rejects priority 10 for background);
    // alert: energy-efficient 5.
    'apns-priority': isVoip ? '10' : '5',
    // voip + background: expire immediately — a stale wake or phantom call UI is worse
    // than a missed push. Alert banners: 24-hour delivery window.
    'apns-expiration': isVoip || pushType === 'background' ? '0' : String(Math.trunc(time()) + 86400),
  };
  // Collapse duplicate wakes for the same call so only the latest is delivered.
  if (opts.collapseId) headers['apns-collapse-id'] = opts.collapseId;
  try {
    const resp = await transport.h2Post(url, headers, JSON.stringify(payload));
    if (resp.status === 200) return;
    // 410 Gone / 400 BadDeviceToken => token is dead, prune it.
    let reason = '';
    try {
      const parsed = JSON.parse(resp.text) as Json | null;
      reason = String((parsed && parsed.reason) || '');
    } catch {
      reason = resp.text || '';
    }
    if (resp.status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') {
      log.info('Pruning stale APNs token');
      await (opts.onDead ?? dbm.deleteDeviceToken)(token);
    }
    log.warning('⚠️  APNs send failed (%s): %s', resp.status, reason);
  } catch (e) {
    log.warning('⚠️  APNs send error: %s', e);
  }
}

// =============================================================================
// Public API
// =============================================================================

function stringData(data: Json | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data || {})) out[k] = v === null || v === undefined ? 'None' : String(v);
  return out;
}

/**
 * Silent background push that wakes a killed/backgrounded app so it can re-register SIP
 * BEFORE the real VoIP push arrives. It must NOT create a CallKit / ConnectionService UI:
 *   iOS  — APNs background push (content-available:1, priority 5) on the *alert* token with
 *          the plain bundle-id topic. PushKit pushes mandate CallKit reporting, and a second
 *          reportNewIncomingCall() on a different UUID would give the user two call screens
 *          and misroute the end-call event so no SIP BYE is ever sent.
 *   Android — FCM high-priority data message with type=pre_wake; the app registers SIP but
 *          shows no ConnectionService UI until the follow-up type=incoming_call push.
 */
export async function sendPreWake(extension: string, caller: string | null): Promise<void> {
  if (!fcmEnabled() && !apnsEnabled()) return;
  const allTokens = (await dbm.getDeviceTokensForExtension(extension)) as DeviceTokenRow[];
  if (!allTokens || !allTokens.length) return;

  const data = { type: 'pre_wake', extension: String(extension), caller: String(caller || '') };
  const bundleId = cfg().apns_bundle_id;
  const tasks: Promise<unknown>[] = [];
  const seen = new Set<string>();
  for (const row of allTokens) {
    const token = row.token;
    if (!token || seen.has(token)) continue;
    seen.add(token);
    if (row.platform === 'android' && fcmEnabled()) {
      tasks.push(sendFcm(token, { data, android: { priority: 'high', ttl: '0s' } }));
    } else if (row.platform === 'ios' && row.token_type === 'alert' && apnsEnabled()) {
      // The regular alert token + bundle topic (NOT the VoIP topic): content-available:1
      // wakes the app in the background and no CallKit call is created.
      tasks.push(sendApns(token, { aps: { 'content-available': 1 }, ...data }, 'background', bundleId));
    }
  }
  if (tasks.length) await Promise.allSettled(tasks);
}

/**
 * Wake the device(s) registered to `extension` for an incoming call. VoIP/high-priority push,
 * so a backgrounded or killed app can present CallKit/ConnectionService and register SIP.
 *
 * iOS: APNs VoIP push only to tokens with token_type='voip' (PushKit requirement).
 * Android: high-priority FCM to any registered token — Android has no PushKit distinction.
 * Web: Web Push to the stored subscription (the service worker shows a call notification).
 */
export async function sendCallWake(
  extension: string,
  caller: string | null,
  callId: string | null,
  displayName: string | null = null,
): Promise<void> {
  if (!fcmEnabled() && !apnsEnabled() && !webPushEnabled()) return;
  const allTokens = (await dbm.getDeviceTokensForExtension(extension)) as DeviceTokenRow[];
  if (!allTokens || !allTokens.length) return;

  const data = {
    type: 'incoming_call',
    extension: String(extension),
    caller: String(caller || ''),
    call_id: String(callId || ''),
    display_name: String(displayName || caller || ''),
  };
  const bundleId = cfg().apns_bundle_id;
  const tasks: Promise<unknown>[] = [];
  const seen = new Set<string>();
  for (const row of allTokens) {
    const token = row.token;
    if (!token || seen.has(token)) continue;
    seen.add(token);
    if (row.platform === 'android' && fcmEnabled()) {
      // TTL=0: discard if the device is offline — avoid a phantom incoming-call UI after hang-up.
      tasks.push(sendFcm(token, { data, android: { priority: 'high', ttl: '0s' } }));
    } else if (row.platform === 'ios' && row.token_type === 'voip' && apnsEnabled()) {
      // PushKit VoIP topic; collapse-id deduplicates retries for the same call.
      tasks.push(sendApns(token, data, 'voip', `${bundleId}.voip`, { collapseId: callId }));
    } else if (row.platform === 'web' && webPushEnabled()) {
      // Browser Web Push (the `token` holds the JSON subscription).
      tasks.push(sendWebPush(token, data));
    }
  }
  if (tasks.length) await Promise.allSettled(tasks);
}

/** Send a normal banner notification (e.g. missed call) to the device(s) for `extension`. */
export async function sendAlert(extension: string, title: string, body: string, data: Json | null): Promise<void> {
  if (!fcmEnabled() && !apnsEnabled() && !webPushEnabled()) return;
  const tokens = (await dbm.getDeviceTokensForExtension(extension, 'alert')) as DeviceTokenRow[];
  if (!tokens || !tokens.length) return;

  // FCM data values must be strings.
  const strData = stringData(data);
  const bundleId = cfg().apns_bundle_id;
  const tasks: Promise<unknown>[] = [];
  for (const row of tokens) {
    const token = row.token;
    if (!token) continue;
    if (row.platform === 'android' && fcmEnabled()) {
      tasks.push(sendFcm(token, { notification: { title, body }, data: strData }));
    } else if (row.platform === 'ios' && apnsEnabled()) {
      tasks.push(sendApns(token, { aps: { alert: { title, body }, sound: 'default' }, ...strData }, 'alert', bundleId));
    } else if (row.platform === 'web' && webPushEnabled()) {
      tasks.push(sendWebPush(token, { type: 'alert', title, body, ...strData }));
    }
  }
  if (tasks.length) await Promise.allSettled(tasks);
}

// =============================================================================
// RFC 8599 (push for SIP bindings)
// =============================================================================

/**
 * RFC 8599 §9.3: an APNs pn-param is "<Team ID>.<topic>", e.g. DEF123GHIJ.com.example.app.voip.
 * Without one, the topic is <bundle id>.voip.
 */
export function apnsTopic(pnParam: string | null | undefined): string {
  const param = (pnParam || '').trim();
  if (param) {
    const dot = param.indexOf('.');
    const team = dot === -1 ? param : param.slice(0, dot);
    const topic = dot === -1 ? '' : param.slice(dot + 1);
    if (topic && team.length === 10 && /^[A-Za-z0-9]+$/.test(team)) return topic;
    return param;
  }
  return `${cfg().apns_bundle_id}.voip`;
}

/** Whether a "call" push to this binding can go out with the current configuration. */
export function rfc8599Sendable(row: PushBindingRow): boolean {
  const provider = (row.pn_provider || '').trim().toLowerCase();
  if (provider === 'fcm') {
    const param = (row.pn_param || '').trim();
    return fcmEnabled() && (!param || param === cfg().fcm_project_id);
  }
  return (provider === 'apns' || provider === 'apns-sandbox') && apnsEnabled();
}

/**
 * True when at least one call push could actually be sent, so holding a call for the phone
 * to wake up is worth it. With no provider configured the call rings at once.
 */
export function canWake(bindings: PushBindingRow[], legacyTokens: DeviceTokenRow[]): boolean {
  if (bindings.some((b) => rfc8599Sendable(b))) return true;
  return legacyTokens.some(
    (row) =>
      (row.platform === 'android' && fcmEnabled()) ||
      (row.platform === 'ios' && row.token_type === 'voip' && apnsEnabled()) ||
      (row.platform === 'web' && webPushEnabled()),
  );
}

function dropBinding(provider: string): OnDead {
  return async (prid: string) => {
    if (await dbm.deleteSipPushBindingsByPrid(provider, prid)) {
      log.info('Dropped RFC 8599 binding(s) for a dead %s token', provider);
    }
  };
}

/**
 * Push `data` to RFC 8599 bindings (rows of {pn_provider, pn_prid, pn_param}). `data.type` is
 * "call" or "cancel". Returns how many pushes were sent.
 *
 *   fcm           high-priority data-only message (a notification message would not run the
 *                 app's code); pn-param is the Firebase project ID and must be ours.
 *   apns          VoIP push on the production host (the sandbox host while "Use APNs sandbox"
 *                 is on); topic from pn-param, else <bundle id>.voip.
 *   apns-sandbox  the same on the sandbox host: a sandbox token fails silently anywhere else.
 *
 * A "cancel" is never sent over APNs: iOS kills an app that gets a VoIP push without
 * reporting a CallKit call, and the iOS SDK does not take cancel pushes yet.
 */
export async function sendRfc8599(
  bindings: PushBindingRow[],
  data: Json,
  ttlSeconds = 0,
  collapseId: string | null = null,
): Promise<number> {
  const kind = data.type;
  const strData: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) if (v !== null && v !== undefined) strData[k] = String(v);
  const tasks: Promise<unknown>[] = [];
  const seen = new Set<string>();
  for (const row of bindings) {
    const provider = (row.pn_provider || '').trim().toLowerCase();
    const prid = (row.pn_prid || '').trim();
    const param = (row.pn_param || '').trim();
    const key = `${provider}\n${prid}`;
    if (!provider || !prid || seen.has(key)) continue;
    seen.add(key);
    if (provider === 'fcm') {
      if (!fcmEnabled()) continue;
      if (!rfc8599Sendable(row)) {
        log.warning('⚠️  FCM binding is for project %r, OpDesk sends as %r: skipped', param, cfg().fcm_project_id);
        continue;
      }
      tasks.push(
        sendFcm(
          prid,
          { data: strData, android: { priority: 'high', ttl: `${Math.max(0, Math.trunc(ttlSeconds))}s` } },
          dropBinding(provider),
        ),
      );
    } else if (provider === 'apns' || provider === 'apns-sandbox') {
      if (!apnsEnabled() || kind !== 'call') continue;
      tasks.push(
        sendApns(prid, { ...strData }, 'voip', apnsTopic(param), {
          collapseId,
          sandbox: provider === 'apns-sandbox' ? true : null,
          onDead: dropBinding(provider),
        }),
      );
    } else {
      log.debug('RFC 8599 provider %r not supported; binding skipped', provider);
    }
  }
  if (tasks.length) await Promise.allSettled(tasks);
  return tasks.length;
}
