/** HTTP-layer helpers shared by more than one controller. */

import type { Request } from 'express';
import { env } from '../core/config';
import { fromisoformat } from '../core/py';

export { requireLoopback } from './routing';
export { modelDict } from './validation';

/**
 * The one sentinel every credential surface uses for "a value is stored here, but you are
 * not being shown it". Read paths substitute it; write paths treat it (and blank, where the
 * route says so) as "keep what is stored".
 */
export const SECRET_MASK = '********';

/** Setting keys whose values are secrets (masked on read, kept when the mask is posted back). */
// PRIVATE only as a key-material word (VAPID_PRIVATE_KEY), not as an adjective in a flag
// name (CRM_BLOCK_PRIVATE: block private-network CRM URLs).
// PASS only as a whole word (WEBRTC_TURN_PASS, SMTP_PASS), never as a prefix of a longer word
// (a *_PASSTHROUGH flag is not a secret).
const SECRET_KEY_RE = /(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY|API_KEY|AUTH_KEY|CREDENTIAL|SERVICE_ACCOUNT|(?:^|_)PASS(?:_|$))/i;

/** True for a settings key that holds a secret (JWT_SECRET, CRM_PASSWORD, VAPID_PRIVATE_KEY, ...). */
export function isSecretKey(key: string): boolean {
  // Paths, URLs and header names that merely mention a secret are not secrets themselves
  // (FCM_SERVICE_ACCOUNT_FILE, CRM_OAUTH2_TOKEN_URL, CRM_API_KEY_HEADER).
  return SECRET_KEY_RE.test(key) && !/_(FILE|URL|HEADER|PATH|ENABLED|TYPE)$/i.test(key);
}

/** The value a read path shows: the mask for a non-empty secret, the value otherwise. */
export function maskSecret(key: string, value: unknown): unknown {
  if (!isSecretKey(key)) return value;
  return value === null || value === undefined || value === '' ? value : SECRET_MASK;
}

/** True when a posted value is the mask, i.e. "leave the stored secret unchanged". */
export function isMasked(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === SECRET_MASK;
}

// Plain-SIP ports. Asterisk binds UDP + TCP on 5060 and TLS on 5061 (see /api/sip-tls).
// What a SIP secret may contain: no spaces or quotes, which break dial strings and configs.
const SIP_SECRET_RE = /^[A-Za-z0-9!#$%*+\-.=?@^_~]{8,64}$/;

export const SIP_SECRET_RULE = 'The SIP password needs 8 to 64 characters, with letters and digits, and no spaces or quotes';

/** True when `pw` may become an extension's SIP secret (the extension is reachable from the internet). */
export function isValidSipSecret(pw: string): boolean {
  return SIP_SECRET_RE.test(pw) && /[A-Za-z]/.test(pw) && /\d/.test(pw);
}

export const SIP_PLAIN_PORT = 5060;
export const SIP_TLS_PORT = 5061;

/** request.query_params.get(name): the last value as a string, or undefined. */
export function queryParam(req: Request, name: string): string | undefined {
  const raw = (req.query as Record<string, unknown>)[name];
  const val = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  return val === undefined || val === null ? undefined : String(val);
}

/** A setting value read as a flag ("true"/"1"/"yes"/"on", case-insensitive). */
export function settingTruthy(v: unknown, fallback = false): boolean {
  if (v === null || v === undefined || String(v).trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

/** _parse_dt: an ISO string -> naive local Date, or null. Offsets are converted to local. */
export function parseDt(s: unknown): Date | null {
  if (!s) return null;
  return fromisoformat(String(s).replace('Z', '+00:00'));
}

/**
 * The host the browser used: the first X-Forwarded-Host (nginx sets it), else Host. Used to
 * build URLs the client must reach back on (wss://<host>/sip-ws).
 */
export function requestHost(req: Request): string {
  const fwd = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
  return fwd || String(req.headers.host ?? '').trim();
}

/** `:<NGINX_HTTPS_PORT>` when nginx serves HTTPS on a non-default port, else ''. */
export function publicPortSuffix(): string {
  const p = env('NGINX_HTTPS_PORT', '').trim();
  return p && p !== '443' ? `:${p}` : '';
}
