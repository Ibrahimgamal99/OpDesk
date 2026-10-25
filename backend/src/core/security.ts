/**
 * Authentication and authorization.
 *
 * OpDesk owns its sessions: `POST /api/auth/login` checks a bcrypt password and signs an
 * HS256 JWT (`sub` = user id, `username`, `role`, 24 h). Every request carries it as
 * `Authorization: Bearer <jwt>`; this module verifies it, reloads the user's role and scope
 * from the DB (so a role or group change applies on the next request), and turns that into
 * the request principal. Also here: machine API keys (`opd_...`), the login brute-force
 * limiter, and the guards routes use to require a login, a role or an API-key scope (wired
 * to routes by @Auth in api/routing.ts).
 *
 * Visibility rules (what a principal may SEE) live in core/scope.ts; this module only loads
 * the lists those rules read.
 */

import * as crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { Request } from 'express';
import { HttpError } from '../api/http-error';
import { placeholders, query, queryOne, execute } from '../db/pool';
import type { Row } from '../db/pool';
import { env } from './config';
import { getLogger } from './logger';
import { nowIso } from './py';
import { runtime } from './runtime';
import { filterLiveState, liveExtensions, liveQueues } from './scope';
import { scopeFromPrincipal } from './ws-manager';

const log = getLogger('core.security');

// ---------------------------------------------------------------------------
// Principal and scope
// ---------------------------------------------------------------------------

export type Role = 'admin' | 'supervisor' | 'agent';

/** The request principal every route receives (keys as the Python dict had them). */
export interface Principal {
  id: number | null;
  username: string;
  name: string | null;
  role: Role;
  extension: string | null;
  monitor_modes: string[];
  // HISTORY scope (call log, recordings, journey, VAD, analytics, notifications). null = unrestricted.
  allowed_agent_extensions: string[] | null;
  allowed_queue_names: string[] | null;
  // LIVE scope (extensions/queues/active-calls panels and WS frames). null = unrestricted.
  live_agent_extensions: string[] | null;
  live_queue_names: string[] | null;
  api_key?: boolean;
  api_key_id?: number | null;
  scopes?: string[];
}

/** _get_user_scope's result, plus the live lists and the account fields the principal needs. */
export interface UserScope {
  user_id: number;
  /** false when the user row is gone or deactivated (the token no longer authenticates). */
  exists: boolean;
  is_active: boolean;
  username: string | null;
  name: string | null;
  role: Role;
  extension: string | null;
  monitor_modes: string[];
  allowed_agent_extensions: string[] | null;
  allowed_queue_names: string[] | null;
  live_agent_extensions: string[] | null;
  live_queue_names: string[] | null;
}

const VALID_MONITOR_MODES = new Set(['listen', 'whisper', 'barge']);

function strList(rows: Row[], key: string): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const v = r[key];
    if (v !== null && v !== undefined && String(v) !== '' && !out.includes(String(v))) out.push(String(v));
  }
  return out;
}

/** get_user_monitor_modes: modes from user_monitor_modes, default ['listen'] when none. */
async function userMonitorModes(userId: number): Promise<string[]> {
  try {
    const rows = await query('SELECT mode FROM user_monitor_modes WHERE user_id = ? ORDER BY mode', [userId]);
    const modes = rows.map((r) => String(r.mode)).filter((m) => VALID_MONITOR_MODES.has(m));
    return modes.length ? modes : ['listen'];
  } catch (e) {
    log.warning('Database error get_user_monitor_modes: %s', e);
    return ['listen'];
  }
}

/** (agent extensions, queue extensions) reachable through the given groups. */
async function groupMembers(groupIds: number[]): Promise<[string[], string[]]> {
  if (!groupIds.length) return [[], []];
  const ph = placeholders(groupIds.length);
  const agents = await query(`SELECT DISTINCT agent_ext FROM group_agents WHERE group_id IN (${ph})`, groupIds);
  const queues = await query(
    `SELECT DISTINCT q.extension FROM group_queues gq JOIN queues q ON gq.queue_extension = q.extension WHERE gq.group_id IN (${ph})`,
    groupIds,
  );
  return [strList(agents, 'agent_ext'), strList(queues, 'extension')];
}

/** get_user_agents_and_queues: the agents and queues of the groups the ACCOUNT belongs to (user_groups). */
export async function userAgentsAndQueues(userId: number): Promise<[string[], string[]]> {
  try {
    const rows = await query('SELECT group_id FROM user_groups WHERE user_id = ?', [userId]);
    return await groupMembers(rows.map((r) => Number(r.group_id)));
  } catch (e) {
    log.warning('Database error get_user_agents_and_queues: %s', e);
    return [[], []];
  }
}

/**
 * An agent's LIVE reach: every agent extension and queue of every group the agent belongs
 * to, through their account (user_groups) or their extension (group_agents).
 */
async function agentLiveGroupScope(userId: number, extension: string | null): Promise<[string[], string[]]> {
  try {
    const rows = await query(
      'SELECT group_id FROM user_groups WHERE user_id = ? UNION SELECT group_id FROM group_agents WHERE agent_ext = ?',
      [userId, extension || ''],
    );
    return await groupMembers(rows.map((r) => Number(r.group_id)));
  } catch (e) {
    log.warning('Database error loading agent live scope: %s', e);
    return [[], []];
  }
}

/**
 * Queues the user logs into (_agent_login_queues): the queues of the groups containing the
 * user's extension (group_agents -> group_queues), else the queues of the account's own groups.
 */
export async function agentLoginQueues(user: { id: number | null; extension?: string | null }): Promise<string[]> {
  const ext = String(user.extension ?? '').trim();
  let queues: string[] = [];
  if (ext) {
    try {
      const rows = await query('SELECT group_id FROM group_agents WHERE agent_ext = ?', [ext]);
      queues = (await groupMembers(rows.map((r) => Number(r.group_id))))[1];
    } catch (e) {
      log.warning('Database error get_agent_login_queues: %s', e);
    }
  }
  if (!queues.length && user.id !== null && user.id !== undefined) queues = (await userAgentsAndQueues(user.id))[1];
  return queues.filter(Boolean);
}

/**
 * _user_is_agent: the user's extension has queues to log in to, so the softphone header shows
 * the queue headset toggle; otherwise it is a plain extension with only Idle <-> DND.
 */
export async function isAgentUser(user: { id: number | null; extension?: string | null }): Promise<boolean> {
  try {
    return Boolean(user.extension) && (await agentLoginQueues(user)).length > 0;
  } catch (e) {
    log.warning('is_agent lookup failed for user %s: %s', user.id, e);
    return false;
  }
}

/**
 * Load a user's role, extension, monitor modes and both scopes (_get_user_scope).
 *
 *   admin       every list null (unrestricted).
 *   supervisor  history = live = agents/queues of the groups their account is in (user_groups).
 *   agent       history = own extension only; live = own extension + every agent and queue of
 *               the groups they belong to (user_groups or group_agents). monitor_modes = [].
 *
 * A missing user gets the Python's fallback (supervisor, empty lists) with exists=false, so
 * callers can refuse it.
 */
export async function getUserScope(userId: number): Promise<UserScope> {
  let user: Row | null = null;
  try {
    user = await queryOne('SELECT id, username, extension, name, role, is_active FROM users WHERE id = ?', [userId]);
  } catch (e) {
    log.warning('Database error get_user_by_id: %s', e);
  }
  if (!user) {
    return {
      user_id: userId, exists: false, is_active: false, username: null, name: null, role: 'supervisor', extension: null,
      monitor_modes: ['listen'], allowed_agent_extensions: [], allowed_queue_names: [], live_agent_extensions: [], live_queue_names: [],
    };
  }
  const role: Role = user.role === 'admin' || user.role === 'agent' ? user.role : 'supervisor';
  const extension: string | null = user.extension ? String(user.extension) : null;
  const base = {
    user_id: userId,
    exists: true,
    // users.is_active defaults to 1; NULL reads as inactive, as login's `user.get('is_active', 1)` did.
    is_active: Boolean(Number(user.is_active ?? 0)),
    username: user.username ?? null,
    name: user.name ?? null,
    role,
    extension,
  };
  if (role === 'admin') {
    return {
      ...base, monitor_modes: await userMonitorModes(userId),
      allowed_agent_extensions: null, allowed_queue_names: null, live_agent_extensions: null, live_queue_names: null,
    };
  }
  if (role === 'agent') {
    const own = extension ? [extension] : [];
    const [groupAgents, groupQueues] = await agentLiveGroupScope(userId, extension);
    const live = [...own, ...groupAgents.filter((e) => !own.includes(e))];
    return {
      ...base, monitor_modes: [],
      allowed_agent_extensions: own, allowed_queue_names: [], live_agent_extensions: live, live_queue_names: groupQueues,
    };
  }
  const [agents, queues] = await userAgentsAndQueues(userId);
  return {
    ...base, monitor_modes: await userMonitorModes(userId),
    allowed_agent_extensions: agents, allowed_queue_names: queues, live_agent_extensions: [...agents], live_queue_names: [...queues],
  };
}

/**
 * The supervision modes a user may use: none for an agent (agents never supervise, so the UI
 * offers them no Listen button and the WS refuses it), else the granted ones, at least listen.
 */
export function principalMonitorModes(scope: Pick<UserScope, 'role' | 'monitor_modes'>): string[] {
  if (scope.role === 'agent') return [];
  return scope.monitor_modes.length ? scope.monitor_modes : ['listen'];
}

/** Shape a loaded scope into the request principal. `username` is the token's claim when known. */
export function principalFromScope(scope: UserScope, username?: string | null): Principal {
  return {
    id: scope.user_id,
    username: username ?? scope.username ?? '',
    name: scope.name,
    role: scope.role,
    extension: scope.extension,
    monitor_modes: principalMonitorModes(scope),
    allowed_agent_extensions: scope.allowed_agent_extensions,
    allowed_queue_names: scope.allowed_queue_names,
    live_agent_extensions: scope.live_agent_extensions,
    live_queue_names: scope.live_queue_names,
  };
}

/** The principal of a user id (null when the user is gone or deactivated). */
export async function principalFromUserId(userId: number, username?: string | null): Promise<Principal | null> {
  const scope = await getUserScope(userId);
  if (!scope.exists || !scope.is_active) return null;
  return principalFromScope(scope, username);
}

// ---------------------------------------------------------------------------
// Passwords (bcrypt, compatible with the $2b$ hashes Python's bcrypt wrote)
// ---------------------------------------------------------------------------

// bcrypt.gensalt()'s default work factor.
const BCRYPT_ROUNDS = 12;
const BCRYPT_HASH_RE = /^\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/** bcrypt.hashpw(password, gensalt()) -> a `$2b$12$...` string. */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * bcrypt.checkpw. Takes (password, hash); a call written in the Python's
 * verify_user_password(hash, password) order is recognised and still works.
 * Never throws: an empty or malformed hash is simply a mismatch.
 */
export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  if (BCRYPT_HASH_RE.test(password || '') && !BCRYPT_HASH_RE.test(passwordHash || '')) {
    [password, passwordHash] = [passwordHash, password];
  }
  if (!password || !passwordHash) return false;
  try {
    return await bcrypt.compare(password, passwordHash);
  } catch (e) {
    log.debug('Password verify failed: %s', e);
    return false;
  }
}

/** verify_user_password(password_hash, password): the Python argument order. */
export function verifyUserPassword(passwordHash: string, password: string): Promise<boolean> {
  return verifyPassword(password, passwordHash);
}

// ---------------------------------------------------------------------------
// JWT (HS256, PyJWT-compatible)
// ---------------------------------------------------------------------------

export const JWT_ALGORITHM = 'HS256';
export const JWT_EXPIRE_HOURS = 24;
const DEV_SECRET = 'opdesk-dev-secret-change-in-production';

// The Python re-read the secret from the DB on every encode/decode. A few seconds of cache
// keeps that behaviour (a rotated secret applies almost at once) without a query per request.
const SECRET_CACHE_MS = 5_000;
let secretCache: { value: string; at: number } | null = null;
let warnedDevSecret = false;

/** _get_jwt_secret: DB setting JWT_SECRET, else env JWT_SECRET, else the dev default (warned). */
export async function getJwtSecret(): Promise<string> {
  if (secretCache && Date.now() - secretCache.at < SECRET_CACHE_MS) return secretCache.value;
  let secret = '';
  try {
    const row = await queryOne('SELECT setting_value FROM OpDesk_settings WHERE setting_key = ?', ['JWT_SECRET']);
    secret = String(row?.setting_value ?? '').trim();
  } catch (e) {
    log.warning('Database error getting setting JWT_SECRET: %s', e);
  }
  if (!secret) secret = env('JWT_SECRET', '').trim();
  if (!secret) {
    secret = DEV_SECRET;
    if (!warnedDevSecret) log.warning('JWT_SECRET not set; using default (set JWT_SECRET in production)');
    warnedDevSecret = true;
  }
  secretCache = { value: secret, at: Date.now() };
  return secret;
}

/** Tests only: forget the cached secret. */
export function resetJwtSecretCache(): void {
  secretCache = null;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function sign(input: string, secret: string): Buffer {
  return crypto.createHmac('sha256', secret).update(input).digest();
}

/** The claims OpDesk signs. */
export interface TokenClaims {
  sub: string;
  username: string;
  role: string;
  exp: number;
  iat: number;
  [k: string]: unknown;
}

/** Sign a JWT with an explicit secret (PyJWT's jwt.encode with HS256). */
export function encodeJwt(payload: Record<string, unknown>, secret: string): string {
  // PyJWT writes the header in this key order.
  const header = b64url(JSON.stringify({ alg: JWT_ALGORITHM, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.${b64url(sign(`${header}.${body}`, secret))}`;
}

/**
 * Verify a JWT with an explicit secret (PyJWT's jwt.decode(algorithms=["HS256"])): signature,
 * `exp` (expired when exp <= now) and `nbf`. null on any failure.
 */
export function decodeJwt(token: string, secret: string, nowSecs = Date.now() / 1000): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!header || header.alg !== JWT_ALGORITHM) return null;
    const expected = sign(`${h}.${p}`, secret);
    const given = Buffer.from(s, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const claims = payload as Record<string, unknown>;
    if (claims.exp !== undefined) {
      if (typeof claims.exp !== 'number' || claims.exp <= nowSecs) return null;
    }
    if (claims.nbf !== undefined) {
      if (typeof claims.nbf !== 'number' || claims.nbf > nowSecs) return null;
    }
    if (claims.iat !== undefined && typeof claims.iat !== 'number') return null;
    return claims;
  } catch {
    return null;
  }
}

/** create_access_token(user): `{sub, username, role, exp: now+24h, iat: now}`. */
export async function createAccessToken(user: { id: number; username: string; role: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenClaims = {
    sub: String(user.id),
    username: user.username,
    role: user.role,
    exp: now + JWT_EXPIRE_HOURS * 3600,
    iat: now,
  };
  return encodeJwt(payload, await getJwtSecret());
}

/** decode_token: the verified claims, or null (bad signature, expired, garbage). */
export async function decodeAccessToken(token: string): Promise<TokenClaims | null> {
  if (!token) return null;
  return decodeJwt(token, await getJwtSecret()) as TokenClaims | null;
}

/**
 * A verified token -> its principal, or null. A `sub` that is not an integer (the Python
 * crashed with a 500) and a user that was deleted or deactivated since the token was issued
 * (the Python kept honouring it until exp) are both treated as an invalid token.
 */
async function principalFromToken(token: string): Promise<Principal | null> {
  const claims = await decodeAccessToken(token);
  if (!claims) return null;
  const sub = String(claims.sub ?? '');
  if (!/^\s*[+-]?\d+\s*$/.test(sub)) return null;
  const username = typeof claims.username === 'string' ? claims.username : null;
  return principalFromUserId(parseInt(sub, 10), username);
}

/** For the /ws handshake: a JWT -> principal, or null when it does not authenticate. */
export async function authenticateWsToken(token: unknown): Promise<Principal | null> {
  if (typeof token !== 'string' || !token.trim()) return null;
  try {
    return await principalFromToken(token.trim());
  } catch (e) {
    log.warning('WS token check failed: %s', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Request principal
// ---------------------------------------------------------------------------

/** Where the guards leave the principal for the handler and the audit log (request.state). */
type WithPrincipal = Request & { principal?: Principal | null };

export function setPrincipal(req: Request, p: Principal): Principal {
  (req as WithPrincipal).principal = p;
  return p;
}

/** The principal the route's @Auth guard resolved (null on a public route). */
export function principalOf(req: Request): Principal | null {
  return (req as WithPrincipal).principal ?? null;
}

/** HTTPBearer(auto_error=False): the credentials of `Authorization: Bearer <x>` (scheme case-insensitive), or null. */
export function bearerCredentials(req: Request): string | null {
  const auth = String(req.headers?.authorization ?? '');
  const m = /^\s*bearer\s+(.+?)\s*$/i.exec(auth);
  return m ? m[1] : null;
}

/** _user_from_jwt: 401 "Not authenticated" without a bearer token, "Invalid or expired token" when it fails. */
async function userFromJwt(token: string | null): Promise<Principal> {
  if (!token) throw new HttpError(401, 'Not authenticated');
  const p = await principalFromToken(token);
  if (!p) throw new HttpError(401, 'Invalid or expired token');
  return p;
}

/**
 * get_current_user: require a valid JWT.
 *
 * DELIBERATELY JWT-ONLY -- it never consults extractApiKey(). That is the fail-closed property
 * of the API-key design: a machine key works only on routes explicitly wired with
 * requireScope()/requireApiKey(), so every other route is unreachable by a key (a key sent as
 * `Bearer opd_...` here fails as an invalid token).
 */
export async function getCurrentUser(req: Request): Promise<Principal> {
  return setPrincipal(req, await userFromJwt(bearerCredentials(req)));
}

/** require_admin */
export async function requireAdmin(req: Request): Promise<Principal> {
  const user = await getCurrentUser(req);
  if (user.role !== 'admin') throw new HttpError(403, 'Admin only');
  return user;
}

/** require_supervisor: admin or supervisor. */
export async function requireSupervisor(req: Request): Promise<Principal> {
  const user = await getCurrentUser(req);
  if (user.role !== 'admin' && user.role !== 'supervisor') throw new HttpError(403, 'Supervisor or admin required');
  return user;
}

// ---------------------------------------------------------------------------
// Login brute-force limiter (in memory, per client IP)
// ---------------------------------------------------------------------------

export const LOGIN_MAX_ATTEMPTS = 10; // failures before lockout
export const LOGIN_WINDOW_SECS = 300; // sliding window (5 min)
export const LOCKOUT_SECS = 600; // lockout duration (10 min)
const loginAttempts = new Map<string, number[]>(); // ip -> [timestamp, ...]
const loginLocked = new Map<string, number>(); // ip -> lockout_until

function nowSecs(): number {
  return Date.now() / 1000;
}

/** _check_login_rate_limit: 429 + Retry-After while the IP is locked out. */
export function checkLoginRateLimit(ip: string): void {
  const now = nowSecs();
  const until = loginLocked.get(ip);
  if (until !== undefined) {
    if (now < until) {
      const retryAfter = Math.trunc(until - now);
      throw new HttpError(429, `Too many failed login attempts. Try again in ${retryAfter}s.`, { 'Retry-After': String(retryAfter) });
    }
    loginLocked.delete(ip);
    loginAttempts.delete(ip);
  }
  loginAttempts.set(ip, (loginAttempts.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_SECS));
}

/** _record_login_failure: the 10th failure inside the window locks the IP for 600 s. */
export function recordLoginFailure(ip: string): void {
  const now = nowSecs();
  const attempts = loginAttempts.get(ip) || [];
  attempts.push(now);
  loginAttempts.set(ip, attempts);
  if (attempts.length >= LOGIN_MAX_ATTEMPTS) {
    loginLocked.set(ip, now + LOCKOUT_SECS);
    loginAttempts.delete(ip);
    log.warning('Login rate limit: %s locked out for %ss', ip, LOCKOUT_SECS);
  }
}

/** _clear_login_failures: a successful login forgets the IP. */
export function clearLoginFailures(ip: string): void {
  loginAttempts.delete(ip);
  loginLocked.delete(ip);
}

/** Tests only. */
export function resetLoginLimiter(): void {
  loginAttempts.clear();
  loginLocked.clear();
}

// ---------------------------------------------------------------------------
// API keys (machine-to-machine)
// ---------------------------------------------------------------------------
//
// Keys are `opd_` + 40 hex chars, stored as unsalted SHA-256 hex (`api_keys.key_hash`): the
// input is 160 bits of CSPRNG output used as a deterministic lookup key, so there is nothing for
// a salt or a work factor to defend. Presented as `X-API-Key: <key>` or `Authorization: Bearer
// opd_...` (the prefix disambiguates it from a JWT).

export const API_KEY_HEADER = 'X-API-Key';
export const API_KEY_PREFIX = 'opd_';

/**
 * Permission tokens a key can be granted. Every one gates at least one real route --
 * unreachable "reserved" scopes are deliberately not offered.
 */
export const ALL_PERMISSIONS = [
  'calls:read', // live calls, extensions, queues, AMI status
  'calls:write', // call origination (click-to-call)
  'cdr:read', // call history, journey, VAD, recordings
  'analytics:read', // dashboards, KPIs, CSV/XLSX export
  'extension-config:read', // key only: any user's SIP account (POST /api/extension-config/lookup)
  'contacts:read', // the phonebook (GET /api/contacts, /api/contacts/{id})
  'contacts:write', // push contacts in (POST /api/contacts, /api/contacts/bulk); never edit or delete
];

/** SHA-256 hex digest of a plaintext key (what is stored and looked up by). */
export function hashApiKey(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** A new plaintext key: `opd_` + secrets.token_hex(20). Shown to the admin once. */
export function generateApiKey(): string {
  return API_KEY_PREFIX + crypto.randomBytes(20).toString('hex');
}

/** A presented API key from X-API-Key, or a Bearer token carrying the opd_ prefix; else null. */
export function extractApiKey(req: Request): string | null {
  const key = req.headers?.['x-api-key'];
  const raw = Array.isArray(key) ? key[0] : key;
  if (raw && raw.trim()) return raw.trim();
  const auth = String(req.headers?.authorization ?? '');
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token.startsWith(API_KEY_PREFIX)) return token;
  }
  return null;
}

/** The public metadata of a validated key. */
export interface ApiKeyMeta {
  id: number;
  name: string;
  key_prefix: string;
  scopes: string[];
  enabled: boolean;
}

/**
 * lookup_api_key: the key's metadata when it exists, is enabled and has not expired (both
 * enforced in SQL), else null. Stamps last_used_at on success.
 */
export async function resolveApiKey(plaintext: string): Promise<ApiKeyMeta | null> {
  if (!plaintext || !plaintext.startsWith(API_KEY_PREFIX)) return null;
  try {
    const row = await queryOne(
      'SELECT id, name, key_prefix, scopes, enabled FROM api_keys WHERE key_hash = ? AND enabled = 1 ' +
        'AND (expires_at IS NULL OR expires_at > NOW())',
      [hashApiKey(plaintext)],
    );
    if (!row) return null;
    await execute('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [row.id]);
    let scopes: unknown = [];
    try {
      scopes = JSON.parse(String(row.scopes || '[]'));
    } catch {
      scopes = [];
    }
    return {
      id: Number(row.id),
      name: String(row.name),
      key_prefix: String(row.key_prefix),
      scopes: Array.isArray(scopes) ? scopes.map(String) : [],
      enabled: Boolean(row.enabled),
    };
  } catch (e) {
    log.warning('Error looking up API key: %s', e);
    return null;
  }
}

/**
 * Shape a validated key into a principal: role admin and null scope lists so per-user row
 * filtering returns unrestricted data -- a machine credential is a system principal, not a
 * person. What it can reach is bounded by its scopes, not by this role.
 */
export function apikeyPrincipal(meta: ApiKeyMeta): Principal {
  return {
    id: null,
    username: `apikey:${meta.name}`,
    name: null,
    role: 'admin',
    extension: null,
    monitor_modes: ['listen', 'whisper', 'barge'],
    allowed_agent_extensions: null,
    allowed_queue_names: null,
    live_agent_extensions: null,
    live_queue_names: null,
    api_key: true,
    api_key_id: meta.id,
    scopes: meta.scopes,
  };
}

/** A presented key -> its principal: 401 when invalid or expired, 403 without `scope`. */
async function scopedKeyPrincipal(rawKey: string, scope: string): Promise<Principal> {
  const meta = await resolveApiKey(rawKey);
  if (!meta) throw new HttpError(401, 'Invalid or expired API key');
  if (!meta.scopes.includes(scope)) throw new HttpError(403, `API key missing required scope: ${scope}`);
  return apikeyPrincipal(meta);
}

/**
 * require_scope: the machine-reachable integration surface. An API key holding `scope`, or
 * any valid JWT (no role check: the read routes scope their rows by the caller, and any route
 * with a side effect adds its own check). A presented key wins over a JWT.
 */
export async function requireScope(req: Request, scope: string): Promise<Principal> {
  const rawKey = extractApiKey(req);
  const principal = rawKey ? await scopedKeyPrincipal(rawKey, scope) : await userFromJwt(bearerCredentials(req));
  return setPrincipal(req, principal);
}

/**
 * require_api_key: key-only routes. Unlike requireScope a signed-in user is never let
 * through, whatever their role: these routes act on any user's data (another user's SIP
 * account), which only a machine credential an admin minted for that purpose may reach.
 */
export async function requireApiKey(req: Request, scope: string): Promise<Principal> {
  const rawKey = extractApiKey(req);
  if (!rawKey) throw new HttpError(401, 'API key required');
  return setPrincipal(req, await scopedKeyPrincipal(rawKey, scope));
}

// ---------------------------------------------------------------------------
// Live scope refresh
// ---------------------------------------------------------------------------

/**
 * Re-resolve every open WebSocket's scope and send each connection whose visibility changed a
 * fresh `state_update`.
 *
 * Called after anything that changes who is in a group (group agents/queues/users, or a
 * user's role, extension or groups). A socket's scope is read once at connect; without this
 * the change would reach an already-open browser only after a reload. Never throws.
 */
export async function pushScopeRefresh(): Promise<void> {
  if (!runtime.manager.activeConnections.size) return;
  let changed;
  try {
    changed = await runtime.manager.refreshScopes(async (userId) => {
      const p = await principalFromUserId(userId);
      // A deleted or deactivated user keeps the socket's old scope until it reconnects (and fails).
      return p ? scopeFromPrincipal(p) : null;
    });
  } catch (e) {
    log.warning('Could not refresh live scopes: %s', e);
    return;
  }
  const bridge = runtime.bridge;
  if (!changed.length || !bridge) return;
  for (const [ws, scope] of changed) {
    try {
      const state = await bridge.getCurrentState(liveExtensions(scope), liveQueues(scope));
      await runtime.manager.sendPersonal(ws, { type: 'state_update', data: filterLiveState(scope, state), timestamp: nowIso() });
    } catch (e) {
      log.warning('Could not push a refreshed state: %s', e);
    }
  }
}
