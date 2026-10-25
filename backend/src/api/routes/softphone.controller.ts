/**
 * Softphone bootstrap: the browser softphone's WebRTC config, the transport-aware SIP
 * account (extension-config) for apps, the Medut setup QR data, the caller's own SIP
 * password, and the per-extension WebRTC switch.
 */

import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { env } from '../../core/config';
import { getLogger } from '../../core/logger';
import { truthy } from '../../core/py';
import type { Principal } from '../../core/security';
import * as dbm from '../../db/db-manager';
import type { Row } from '../../db/pool';
import { reloadAsteriskSip } from '../../services/dialplan';
import { publicHost } from '../../services/sip-push';
import { HttpError } from '../http-error';
import { respond } from '../respond';
import { isValidSipSecret, publicPortSuffix, SIP_PLAIN_PORT, SIP_SECRET_RULE, SIP_TLS_PORT } from '../shared';
import { Auth, Get, Post, Put, principal } from '../routing';
import { parseBody, pInt, pStr, qStr, QueryParams, RequestValidationError, v } from '../validation';

export const log = getLogger('api.routes.softphone');

// The key scope of /api/extension-config/lookup.
export const EXTENSION_CONFIG_READ = 'extension-config:read';

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** urllib.parse.urlparse, the parts this file reads (no normalisation, unlike WHATWG URL). */
export interface ParsedUrl {
  scheme: string;
  netloc: string;
  path: string;
  hostname: string | null;
  port: number | null;
}

export function urlparse(url: string): ParsedUrl {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(url);
  const scheme = m ? m[1].toLowerCase() : '';
  let rest = m ? m[2] : url;
  let netloc = '';
  if (rest.startsWith('//')) {
    const end = rest.slice(2).search(/[/?#]/);
    netloc = end === -1 ? rest.slice(2) : rest.slice(2, 2 + end);
    rest = end === -1 ? '' : rest.slice(2 + end);
  }
  const path = rest.split(/[?#]/)[0];
  const hostport = netloc.includes('@') ? netloc.slice(netloc.lastIndexOf('@') + 1) : netloc;
  let hostname: string | null;
  let portText = '';
  if (hostport.startsWith('[')) {
    const close = hostport.indexOf(']');
    hostname = close === -1 ? hostport.slice(1) : hostport.slice(1, close);
    const after = close === -1 ? '' : hostport.slice(close + 1);
    if (after.startsWith(':')) portText = after.slice(1);
  } else {
    const colon = hostport.indexOf(':');
    hostname = colon === -1 ? hostport : hostport.slice(0, colon);
    if (colon !== -1) portText = hostport.slice(colon + 1);
  }
  hostname = hostname ? hostname.toLowerCase() : null;
  // NOTE(port): urlparse's .port raised ValueError for a non-numeric or out-of-range port;
  // here such a port reads as absent.
  const port = /^\d+$/.test(portText) && Number(portText) <= 65535 ? Number(portText) : null;
  return { scheme, netloc, path, hostname, port };
}

/**
 * The PBX WebSocket URL phones and browsers register through (normally OpDesk's own
 * Nginx at wss://<host>/sip-ws, which proxies to Asterisk's /ws).
 */
export async function webrtcServerUrl(req: Request): Promise<string> {
  const stored = ((await dbm.getSetting('WEBRTC_PBX_SERVER', env('WEBRTC_PBX_SERVER', ''))) || '').trim();
  let server: string;
  // When the stored value is empty or still the legacy direct-Asterisk default (port 8089),
  // compute the URL from the request host so it works on any hostname without reconfiguration.
  if (!stored || /^wss?:\/\/[^:/]+:8089\/ws$/.test(stored)) {
    let host = req.header('x-forwarded-host') || req.header('host') || '';
    host = host.split(',')[0].trim();
    // A Host header without a port (older Nginx config forwarding $host) means the default
    // port was assumed; add Nginx's real one so the URL doesn't land on another site's 443.
    if (host && !/:\d+$/.test(host)) host += publicPortSuffix();
    server = host ? `wss://${host}/sip-ws` : stored;
  } else {
    server = stored;
  }

  // If the resulting URL points at a raw IP but a domain is configured, rewrite the host to
  // the domain. The Let's Encrypt cert is issued for the domain only, so a wss:// connection to
  // the bare IP fails the TLS handshake (browser reports WebSocket close code 1015). Applying this
  // to the final URL fixes both auto-detected hosts and stale IP-based values saved in settings.
  const domain = env('OPDESK_DOMAIN', '').trim();
  if (domain && server) {
    const m = /^(wss?:\/\/)\d{1,3}(?:\.\d{1,3}){3}(:\d+)?(\/.*)?$/.exec(server);
    if (m) server = `${m[1]}${domain}${m[2] || ''}${m[3] || '/sip-ws'}`;
  }
  return server;
}

// ---------------------------------------------------------------------------
// extension-config
// ---------------------------------------------------------------------------

/** One ICE server as the clients take it; unset optional keys are written as null. */
export interface IceServerOut {
  urls: string;
  username: string | null;
  credential: string | null;
}

// Google's public STUN, handed out when no STUN/TURN is configured. Reflexive candidates
// only, no relay; a symmetric NAT still needs a configured TURN server.
export const DEFAULT_STUN_SERVERS: readonly IceServerOut[] = [
  { urls: 'stun:stun.l.google.com:19302', username: null, credential: null },
  { urls: 'stun:stun1.l.google.com:19302', username: null, credential: null },
];

export type SipTransportType = 'wss' | 'ws' | 'tls' | 'tcp' | 'udp';

export interface SipTransportOut {
  type: SipTransportType;
  uri: string;
  host: string;
  port: number;
  path: string | null; // WebSocket path; null for tls/tcp/udp
}

export interface SipMediaOut {
  encryption: 'none' | 'sdes' | 'dtls';
  ice: boolean;
  avpf: boolean;
  rtcp_mux: boolean;
  // In priority order: the extension's own list, else the PBX-wide one; null when
  // neither could be read.
  codecs: string[] | null;
}

export interface ExtensionConfigOut {
  extension: string | null;
  auth_username: string | null;
  secret: string | null;
  display_name: string | null;
  domain: string;
  transports: SipTransportOut[];
  media: SipMediaOut | null;
  ice_servers: IceServerOut[];
}

async function settingOrEnv(key: string): Promise<string> {
  return ((await dbm.getSetting(key, env(key, ''))) || '').trim();
}

async function settingFlag(key: string): Promise<boolean> {
  return ['true', '1', 'yes'].includes(String((await dbm.getSetting(key, 'false')) || '').trim().toLowerCase());
}

/**
 * STUN/TURN servers from settings/env (WEBRTC_STUN_URL, WEBRTC_TURN_URL/USER/PASS); Google
 * STUN when none is configured.
 */
export async function webrtcIceServers(): Promise<IceServerOut[]> {
  const out: IceServerOut[] = [];
  const stun = await settingOrEnv('WEBRTC_STUN_URL');
  if (stun) out.push({ urls: stun, username: null, credential: null });
  const turn = await settingOrEnv('WEBRTC_TURN_URL');
  if (turn) {
    out.push({
      urls: turn,
      username: (await settingOrEnv('WEBRTC_TURN_USER')) || null,
      credential: (await settingOrEnv('WEBRTC_TURN_PASS')) || null,
    });
  }
  return out.length ? out : DEFAULT_STUN_SERVERS.map((s) => ({ ...s }));
}

/**
 * '0.0.0.0-udp' (FreePBX) / 'transport-wss' (Issabel) -> 'udp' / 'wss'. null when blank
 * or unrecognised: the endpoint then accepts any transport. A ws-bound extension is
 * reached through Nginx's wss:// proxy, so it reports as wss.
 */
export function pjsipTransportType(transportId: string | null | undefined): SipTransportType | null {
  const parts = (transportId || '').trim().toLowerCase().split('-');
  const kind = parts[parts.length - 1];
  if (kind === 'ws') return 'wss';
  return kind === 'wss' || kind === 'tls' || kind === 'tcp' || kind === 'udp' ? kind : null;
}

/**
 * The public SIP domain apps register to: the OPDESK_DOMAIN setting (env fallback), else
 * sip-push's publicHost() (OPDESK_DOMAIN env, else the WEBRTC_PBX_SERVER host). '' when
 * neither is known; the caller then falls back to the WSS host.
 */
export async function sipDomain(): Promise<string> {
  const configured = await settingOrEnv('OPDESK_DOMAIN');
  if (configured) return configured;
  return String((await publicHost()) || '').trim();
}

/**
 * Every transport a client outside the network can register on, most secure first:
 * WSS through Nginx's /sip-ws (always), TLS 5061 when SIP TLS is on, TCP/UDP 5060 only
 * when the admin marked them reachable (setting SIP_UDP_TCP_PUBLIC).
 */
export async function sipOfferedTransports(req: Request, domain: string): Promise<SipTransportOut[]> {
  const offered: SipTransportOut[] = [];
  const wsUrl = await webrtcServerUrl(req);
  if (wsUrl) {
    const u = urlparse(wsUrl);
    const type: SipTransportType = u.scheme === 'ws' ? 'ws' : 'wss';
    offered.push({ type, uri: wsUrl, host: u.hostname || domain, port: u.port || (type === 'ws' ? 80 : 443), path: u.path || '/' });
  }
  if (domain && (await settingFlag('SIP_TLS_ENABLED'))) {
    offered.push({ type: 'tls', uri: `sip:${domain}:${SIP_TLS_PORT};transport=tls`, host: domain, port: SIP_TLS_PORT, path: null });
  }
  if (domain && (await settingFlag('SIP_UDP_TCP_PUBLIC'))) {
    for (const kind of ['tcp', 'udp'] as const) {
      offered.push({ type: kind, uri: `sip:${domain}:${SIP_PLAIN_PORT};transport=${kind}`, host: domain, port: SIP_PLAIN_PORT, path: null });
    }
  }
  return offered;
}

export async function sipMediaFromProfile(profile: Record<string, string | undefined>): Promise<SipMediaOut> {
  const enc = (profile.media_encryption || '').trim().toLowerCase();
  const yes = (...kws: string[]) => kws.some((k) => (profile[k] || '').trim().toLowerCase() === 'yes');
  // An empty allow row means the endpoint gets the PBX-wide list: report that list, it is
  // what Asterisk will actually offer.
  let codecs: string[] | null = dbm.parseCodecList(profile.allow);
  if (!codecs.length) codecs = await dbm.getPbxDefaultCodecs();
  return {
    encryption: enc === 'sdes' || enc === 'dtls' ? enc : 'none',
    ice: yes('icesupport', 'ice_support'),
    avpf: yes('avpf', 'use_avpf'),
    rtcp_mux: yes('rtcp_mux'),
    codecs: codecs && codecs.length ? codecs : null,
  };
}

/** 503 extension_config.unavailable: the client retries, keeping the credentials it has. */
export function unavailable(message: string): HttpError {
  return new HttpError(503, { code: 'extension_config.unavailable', message });
}

const TRANSPORTS_CHOICES = ['active', 'all'] as const;
export type TransportsChoice = (typeof TRANSPORTS_CHOICES)[number];

/** `transports: Literal['active', 'all'] = 'active'` as a query parameter. */
export function qTransports(q: QueryParams): TransportsChoice {
  const val = qStr(q, 'transports', 'active');
  if (!(TRANSPORTS_CHOICES as readonly string[]).includes(val)) {
    throw new RequestValidationError([
      { path: 'query.transports', code: 'literal_error', message: "Input should be 'active' or 'all'", params: { expected: "'active' or 'all'" } },
    ]);
  }
  return val as TransportsChoice;
}

/**
 * The extension-config answer for one OpDesk users row (its `extension` and `name`).
 *
 * A user with no extension gets 200 with null credentials and no transports (an app then
 * drops the account). A user whose extension the PBX has no SIP account for, or whose
 * account could not be read, gets 503 extension_config.unavailable.
 */
export async function extensionConfigFor(req: Request, user: Row, transports: TransportsChoice): Promise<ExtensionConfigOut> {
  let domain = await sipDomain();
  if (!domain) {
    // No public domain configured: fall back to the host the WSS URL resolves to.
    const wsUrl = await webrtcServerUrl(req);
    domain = (wsUrl ? urlparse(wsUrl).hostname : null) || '';
  }
  let offered = await sipOfferedTransports(req, domain);
  const iceServers = await webrtcIceServers();
  const displayName = user.name ? String(user.name) : null;

  const ext = String(user.extension ?? '').trim() || null;
  if (!ext) {
    return {
      extension: null,
      auth_username: null,
      secret: null,
      display_name: displayName,
      domain,
      transports: [],
      media: null,
      ice_servers: iceServers,
    };
  }

  const profile = await dbm.getExtensionSipProfile(ext);
  if (profile === null) throw unavailable("Could not read the extension's settings from the PBX. Try again.");
  if (!Object.keys(profile).length || !profile.secret) {
    throw unavailable(`The PBX has no SIP account for extension ${ext}.`);
  }
  const media = await sipMediaFromProfile(profile);

  if (transports === 'active') {
    const explicit = pjsipTransportType(profile.transport);
    let wanted: Set<string>;
    if (explicit) wanted = explicit === 'wss' ? new Set(['wss', 'ws']) : new Set([explicit]);
    else if (media.encryption === 'dtls') wanted = new Set(['wss', 'ws']);
    else wanted = new Set(['tls', 'tcp', 'udp']);
    offered = offered.filter((t) => wanted.has(t.type));
  }

  return {
    extension: ext,
    auth_username: (profile.username || '').trim() || ext,
    secret: profile.secret || null,
    display_name: displayName,
    domain,
    transports: offered,
    media,
    ice_servers: iceServers,
  };
}

/**
 * Body of POST /api/extension-config/lookup: exactly one of `username` (the OpDesk sign-in
 * name) or `extension`. Unknown keys are refused, as is sending both or neither.
 */
const LookupShape = {
  username: v.str().nullish(),
  extension: v.str().nullish(),
};
export const ExtensionConfigLookupBody = v.strictModel(LookupShape);

export function lookupKey(body: { username?: string | null; extension?: string | null }): { username: string } | { extension: string } {
  const username = (body.username ?? '').trim();
  const extension = (body.extension ?? '').trim();
  if (Boolean(username) === Boolean(extension)) {
    throw new RequestValidationError([
      { path: '', code: 'value_error', message: 'Value error, send exactly one of username or extension', params: {} },
    ]);
  }
  return username ? { username } : { extension };
}

// ---------------------------------------------------------------------------
// Self-service and admin helpers
// ---------------------------------------------------------------------------

export const ChangePasswordBody = v.model({
  current_password: v.str(),
  new_password: v.str(),
});

/** `enabled: bool = Body(..., embed=True)` */
export const EnabledBody = v.model({ enabled: v.bool() });

/** True when `password` is the caller's current OpDesk sign-in password. */
async function checkCurrentPassword(currentUser: Principal, password: string): Promise<Row> {
  const user = await dbm.getUserByUsername(currentUser.username || '');
  if (!user || !(await dbm.verifyUserPassword(user.password_hash || '', password || ''))) {
    throw new HttpError(400, 'Current password is incorrect');
  }
  return user;
}

/**
 * What the Medut setup QR is built from: the user's extension, SIP password and the PBX
 * host. The QR leaves the transport out on purpose, so Medut's sign-in finds the
 * connection itself (TLS, TCP, UDP and WSS at once; first to register wins).
 */
export async function mobileSetup(req: Request, user: Row): Promise<Record<string, unknown>> {
  const ext = String(user.extension ?? '').trim();
  if (!ext) throw new HttpError(404, 'This user has no extension');
  const secret = await dbm.getExtensionSecretFromDb(ext);
  let host = String((await publicHost()) || '');
  if (!host) {
    const wss = await webrtcServerUrl(req);
    host = (wss ? urlparse(wss).hostname : '') || '';
  }
  let displayName = user.name ? String(user.name) : '';
  if (!displayName) displayName = (await dbm.getExtensionNamesFromDb())[ext] || '';
  return {
    extension: ext,
    display_name: displayName,
    password: secret || '',
    host,
    // A self-signed certificate (no OPDESK_DOMAIN) would fail the app's TLS / WSS checks.
    verify_tls: Boolean(env('OPDESK_DOMAIN', '').trim()),
  };
}

/** Admin: any extension. Agent: only their own. Supervisor: their own or an allowed one. */
export function mayChangeExtension(currentUser: Principal, ext: string): boolean {
  const own = Boolean(currentUser.extension) && String(currentUser.extension) === ext;
  if (currentUser.role === 'admin') return true;
  if (currentUser.role === 'agent') return own;
  if (currentUser.role === 'supervisor') return own || (currentUser.allowed_agent_extensions || []).map(String).includes(ext);
  return false;
}

@Controller()
export class SoftphoneController {
  /**
   * The browser softphone's config: the PBX WebSocket URL, the caller's extension and its
   * SIP secret. See /api/extension-config for the full, transport-aware version.
   */
  @Get('/api/webrtc/config')
  @Auth('user')
  async webrtcConfig(@Req() req: Request) {
    const currentUser = principal(req);
    const server = await webrtcServerUrl(req);
    const creds = await dbm.getUserWebrtcCredentials(currentUser.id as number);
    if (!creds) return { server, extension: null, extension_secret: null };
    const ext = creds.extension ?? null;
    const secret = ext ? await dbm.getExtensionSecretFromDb(ext) : null;
    return { server, extension: ext, extension_secret: secret };
  }

  /**
   * Change the SIP password of the caller's own extension, confirmed with their OpDesk
   * sign-in password. Every phone on the extension has to sign in again with the new one.
   */
  @Post('/api/me/sip-password')
  @Auth('user')
  async changeMySipPassword(@Req() req: Request) {
    const body = parseBody(ChangePasswordBody, req.body);
    const currentUser = principal(req);
    await checkCurrentPassword(currentUser, body.current_password);
    const ext = String(currentUser.extension ?? '').trim();
    if (!ext) throw new HttpError(400, 'You have no extension');
    const pw = body.new_password || '';
    if (!isValidSipSecret(pw)) throw new HttpError(400, SIP_SECRET_RULE);
    if (!(await dbm.setExtensionSecretInPbx(ext, pw))) throw new HttpError(500, 'Could not save the SIP password');
    await reloadAsteriskSip();
    return respond({ message: 'SIP password changed. Sign your phones in again.' });
  }

  /** The caller's own Medut setup data (the same secret /api/webrtc/config returns). */
  @Get('/api/mobile-setup')
  @Auth('user')
  async myMobileSetup(@Req() req: Request) {
    const user = await dbm.getUserById(principal(req).id as number);
    if (!user) throw new HttpError(404, 'User not found');
    return respond(await mobileSetup(req, user));
  }

  /** Medut setup data for any user's extension (admin only). */
  @Get('/api/settings/users/:user_id/mobile-setup')
  @Auth('admin')
  async userMobileSetup(@Req() req: Request) {
    const userId = pInt(req.params.user_id, 'user_id');
    const user = await dbm.getUserById(userId);
    if (!user) throw new HttpError(404, 'User not found');
    return respond(await mobileSetup(req, user));
  }

  /**
   * Everything a softphone needs to register the signed-in user's extension: SIP
   * credentials, the transports to register on (full URIs), the extension's media settings
   * (encryption / ICE / AVPF / codecs) and ICE servers.
   *
   * transports=active (default) returns only the transport(s) this extension is set up
   * for: its explicit PJSIP transport if it has one, otherwise WSS for a WebRTC (DTLS)
   * extension and TLS/TCP/UDP for a plain one. transports=all returns every transport the
   * server offers to clients outside the network.
   */
  @Get('/api/extension-config')
  @Auth('user')
  async extensionConfig(@Req() req: Request) {
    const transports = qTransports(req.query);
    // null is a DB error (or a user deleted under a live JWT), never "no extension":
    // answering that as a 200 would have the apps drop working SIP credentials.
    const user = await dbm.getUserById(principal(req).id as number);
    if (!user) throw unavailable('Could not read your user settings. Try again.');
    return extensionConfigFor(req, user, transports);
  }

  /**
   * GET /api/extension-config for any active user, named by OpDesk username or by
   * extension: for a backend that hands its own app the signed-in agent's SIP account.
   *
   * API key only (scope extension-config:read); a user token is refused whatever its role.
   * POST so the identifier travels in the body, never in a URL or access log.
   */
  @Post('/api/extension-config/lookup')
  @Auth({ apiKey: EXTENSION_CONFIG_READ })
  async extensionConfigLookup(@Req() req: Request) {
    const transports = qTransports(req.query);
    const key = lookupKey(parseBody(ExtensionConfigLookupBody, req.body));
    let user: Row | null;
    try {
      user = 'username' in key ? await dbm.getUserByUsername(key.username) : await dbm.getUserByExtension(key.extension);
    } catch (e) {
      log.error('extension-config lookup: user lookup failed: %s', e);
      throw unavailable("Could not read the user's settings. Try again.");
    }
    if (!user || !truthy(user.is_active ?? null)) {
      throw new HttpError(404, { code: 'extension_config.user_not_found', message: 'No active OpDesk user matches this username or extension.' });
    }
    log.info('extension-config lookup: key %s read user %s', principal(req).username, user.id);
    return extensionConfigFor(req, user, transports);
  }

  /**
   * Extensions of OpDesk users with their WebRTC flag. Admin: all; anyone else: their own
   * extension plus allowed_agent_extensions (the same rule the DND and WebRTC switches use).
   */
  @Get('/api/settings/extensions/webrtc')
  @Auth('user')
  async listExtensionsWebrtc(@Req() req: Request) {
    const currentUser = principal(req);
    const all = await dbm.getExtensionsWithWebrtcFromUsers();
    if (currentUser.role === 'admin') return { extensions: all };
    const allow = new Set<string>();
    if (currentUser.extension) allow.add(String(currentUser.extension));
    for (const e of currentUser.allowed_agent_extensions || []) allow.add(String(e));
    return { extensions: all.filter((e) => allow.has(String(e.extension))) };
  }

  /** PBX SIP username, secret, display name and WebRTC flag of an extension (admin only). */
  @Get('/api/settings/extensions/:extension/credentials')
  @Auth('admin')
  async extensionCredentials(@Req() req: Request) {
    const extension = pStr(req.params.extension);
    const secret = await dbm.getExtensionSecretFromDb(extension);
    const names = await dbm.getExtensionNamesFromDb();
    const webrtcList = await dbm.getExtensionsWithWebrtcFromUsers();
    const webrtc = webrtcList.find((e) => String(e.extension) === extension)?.webrtc ?? 'no';
    return { username: extension, password: secret || '', name: names[extension] || '', webrtc };
  }

  /**
   * Enable/disable WebRTC on an extension (enable = transport/AVPF/ICE/DTLS on, disable =
   * all off). Admin: any extension; agent: their own; supervisor: own or allowed.
   */
  @Put('/api/settings/extensions/:extension/webrtc')
  @Auth('user')
  async setExtensionWebrtc(@Req() req: Request) {
    const ext = pStr(req.params.extension);
    const { enabled } = parseBody(EnabledBody, req.body);
    if (!mayChangeExtension(principal(req), ext)) {
      throw new HttpError(403, 'Not allowed to change WebRTC for this extension');
    }
    if (!(await dbm.setExtensionWebrtc(ext, enabled, process.env.PBX ?? null))) {
      throw new HttpError(404, 'Extension not found in users');
    }
    log.info('WebRTC enabled/disabled for extension: %s - %s', ext, enabled);
    return { ok: true, extension: ext };
  }
}
