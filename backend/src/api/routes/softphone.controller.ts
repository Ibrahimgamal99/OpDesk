/**
 * Softphone bootstrap: the browser softphone's WebRTC config, the transport-aware SIP
 * account (extension-config) for apps, the Medut setup QR data, the caller's own SIP
 * password, and the per-extension WebRTC switch.
 */

import { randomInt } from 'crypto';
import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { env } from '../../core/config';
import { setRedactedAuditDetail } from '../../core/audit';
import { getLogger } from '../../core/logger';
import { truthy } from '../../core/py';
import type { Principal } from '../../core/security';
import * as dbm from '../../db/db-manager';
import type { Row } from '../../db/pool';
import { pbxApplyCommand, reloadAsteriskSip } from '../../services/dialplan';
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

export const ExtensionCredentialsBody = v.model({
  regenerate: v.bool().default(false), // generate a new random SIP secret
  password: v.str().nullish(), // or set this exact secret
});

export const SIP_SECRET_LENGTH = 16;
const SECRET_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A random SIP secret: letters and digits only, which every SIP client and PBX accepts. */
export function generateSipSecret(length = SIP_SECRET_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) out += SECRET_ALPHABET[randomInt(SECRET_ALPHABET.length)];
  return out;
}

/** The PBX flavour for a reload: the PBX setting, else env PBX. */
export async function pbxSetting(): Promise<string | null> {
  return (await dbm.getSetting('PBX', env('PBX', ''))) || process.env.PBX || null;
}

/**
 * GET /api/settings/extensions/:extension/credentials's body, shared with the PUT. max_contacts
 * is null when the PBX DB could not be read, so a form leaves its multi-device toggle alone
 * rather than drawing (and then saving) a wrong state.
 */
export async function extensionCredentialsOut(extension: string) {
  const secret = await dbm.getExtensionSecretFromDb(extension);
  const names = await dbm.getExtensionNamesFromDb();
  const webrtcList = await dbm.getExtensionsWithWebrtcFromUsers();
  const webrtc = webrtcList.find((e) => String(e.extension) === extension)?.webrtc ?? 'no';
  return {
    username: extension,
    password: secret || '',
    name: names[extension] || '',
    webrtc,
    max_contacts: await dbm.getExtensionMaxContacts(extension),
  };
}

/** True when `password` is the caller's current OpDesk sign-in password. */
async function checkCurrentPassword(currentUser: Principal, password: string): Promise<Row> {
  const user = await dbm.getUserByUsername(currentUser.username || '');
  if (!user || !(await dbm.verifyUserPassword(user.password_hash || '', password || ''))) {
    throw new HttpError(400, 'Current password is incorrect');
  }
  return user;
}

/** Medut's media_enc for the PBX's media_encryption. */
const MEDUT_MEDIA_ENC: Record<SipMediaOut['encryption'], string> = { none: 'none', sdes: 'sdes', dtls: 'dtls_srtp' };

/**
 * The full Medut account (medut-softphone docs/account-setup.md) for one extension, built
 * from the same answer as /api/extension-config, so the phone connects the way the PBX
 * endpoint actually accepts calls. Every connection key is written: with no `transport`
 * Medut signs in on "Auto" and keeps whichever transport registers first -- on a DTLS
 * (WebRTC) extension that is often UDP, which registers but every call is then refused
 * because the media is not DTLS-SRTP.
 *
 *   * transport: the first one the extension can use (cfg.transports is most secure first:
 *     WSS for a DTLS extension, else TLS / TCP / UDP as offered). With none offered, the
 *     extension's own transport, else WSS for DTLS and UDP for the rest.
 *   * media_enc / ice_enabled: the endpoint's media_encryption and icesupport; WebSocket
 *     always gets ICE, which WebRTC needs.
 *   * stun_server / turn_*: the first STUN and TURN server of OpDesk's ICE list, with ICE on.
 *   * verify_tls: false without a public domain (self-signed certificate).
 */
export function medutAccount(cfg: ExtensionConfigOut, opts: { verifyTls: boolean }): Record<string, unknown> {
  const ext = String(cfg.extension ?? '');
  const media = cfg.media ?? { encryption: 'none' as const, ice: false, avpf: false, rtcp_mux: false, codecs: null };
  const fallbackType: SipTransportType = media.encryption === 'dtls' ? 'wss' : 'udp';
  const chosen = cfg.transports[0] ?? null;
  const type: SipTransportType = chosen?.type ?? fallbackType;
  const host = chosen?.host || cfg.domain;
  const ws = type === 'wss' || type === 'ws';
  // TLS always names its port (as Medut's own TLS example does); UDP/TCP only a non-default
  // one; a WebSocket carries its port in server_url.
  const sipPort = chosen?.port ?? (type === 'tls' ? SIP_TLS_PORT : SIP_PLAIN_PORT);
  const port = ws ? '' : type === 'tls' || sipPort !== SIP_PLAIN_PORT ? `:${sipPort}` : '';
  const uri = `${ext}@${host}${port}`;
  const iceEnabled = media.ice || ws;

  const account: Record<string, unknown> = {
    name: `OpDesk ${ext}`,
    uri,
    password: cfg.secret || '',
    display_name: cfg.display_name || '',
    auth_user: cfg.auth_username || ext,
    transport: type,
  };
  if (ws && chosen) account.server_url = chosen.uri;
  account.media_enc = MEDUT_MEDIA_ENC[media.encryption];
  account.ice_enabled = iceEnabled;
  if (iceEnabled) {
    const stun = cfg.ice_servers.find((s) => /^stuns?:/i.test(s.urls));
    const turn = cfg.ice_servers.find((s) => /^turns?:/i.test(s.urls));
    if (stun) account.stun_server = stun.urls;
    if (turn) {
      account.turn_server = turn.urls;
      if (turn.username) account.turn_user = turn.username;
      if (turn.credential) account.turn_pass = turn.credential;
    }
  }
  account.verify_tls = opts.verifyTls;
  return account;
}

/**
 * What the Medut setup QR is built from: the user's extension, SIP password, the PBX host,
 * and `account`, the full Medut account JSON (medutAccount) the QR encodes.
 */
export async function mobileSetup(req: Request, user: Row): Promise<Record<string, unknown>> {
  const ext = String(user.extension ?? '').trim();
  if (!ext) throw new HttpError(404, 'This user has no extension');
  let displayName = user.name ? String(user.name) : '';
  if (!displayName) displayName = (await dbm.getExtensionNamesFromDb())[ext] || '';
  const cfg = await extensionConfigFor(req, { ...user, name: displayName || null }, 'active');
  // A self-signed certificate (no public domain) would fail the app's TLS / WSS checks.
  const verifyTls = Boolean(await settingOrEnv('OPDESK_DOMAIN'));
  return {
    extension: ext,
    display_name: displayName,
    password: cfg.secret || '',
    host: cfg.domain,
    verify_tls: verifyTls,
    account: medutAccount(cfg, { verifyTls }),
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
    const pbx = await pbxSetting();
    if (!(await reloadAsteriskSip(pbx))) {
      throw new HttpError(502, `The SIP password was saved but the PBX did not apply it. Ask an admin to run '${pbxApplyCommand(pbx)}'.`);
    }
    setRedactedAuditDetail(req, { extension: ext, secret: 'changed' });
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

  /**
   * PBX SIP username, secret, display name, WebRTC flag and max_contacts of an extension
   * (admin only).
   */
  @Get('/api/settings/extensions/:extension/credentials')
  @Auth('admin')
  async extensionCredentials(@Req() req: Request) {
    return extensionCredentialsOut(pStr(req.params.extension));
  }

  /**
   * Change an extension's SIP secret (admin only), independently of any OpDesk sign-in
   * password: `regenerate: true` for a random one, or `password` for an exact value of at
   * least 8 characters. Applies the PBX config and returns the same shape as the GET.
   */
  @Put('/api/settings/extensions/:extension/credentials')
  @Auth('admin')
  async setExtensionCredentials(@Req() req: Request) {
    const ext = pStr(req.params.extension).trim();
    const body = parseBody(ExtensionCredentialsBody, req.body);
    if (!ext) throw new HttpError(400, 'Extension required');
    const exists = await dbm.extensionExistsInPbx(ext);
    if (exists === null) throw new HttpError(503, 'Cannot reach the PBX database to check the extension');
    if (!exists) throw new HttpError(404, 'Extension not found');
    let secret: string;
    if (body.regenerate) {
      secret = generateSipSecret();
    } else {
      secret = (body.password || '').trim();
      if (!isValidSipSecret(secret)) throw new HttpError(400, SIP_SECRET_RULE);
    }
    if (!(await dbm.setExtensionSecretInPbx(ext, secret))) throw new HttpError(502, 'Could not update the SIP secret in the PBX');
    const pbx = await pbxSetting();
    if (!(await reloadAsteriskSip(pbx))) {
      throw new HttpError(502, `The SIP secret was saved but the PBX did not apply it. Run '${pbxApplyCommand(pbx)}'.`);
    }
    setRedactedAuditDetail(req, { extension: ext, secret: 'changed', regenerated: body.regenerate });
    log.info('SIP secret changed for extension %s by user %s', ext, principal(req).id ?? null);
    return extensionCredentialsOut(ext);
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
    setRedactedAuditDetail(req, { extension: ext, webrtc: enabled });
    return { ok: true, extension: ext };
  }

  /**
   * Allow (2) or forbid (1) web and mobile holding a registration on this extension at the
   * same time. At 1 (the PBX default) the second client to REGISTER evicts the first; at 2
   * Asterisk forks the call to both and the first answer wins. A value an admin set by hand
   * above 2 is left alone when enabling: the toggle already reads on, and writing 2 would
   * take a device away. Same permission rule as the WebRTC switch.
   */
  @Put('/api/settings/extensions/:extension/max-contacts')
  @Auth('user')
  async setExtensionMaxContacts(@Req() req: Request) {
    const ext = pStr(req.params.extension);
    const { enabled } = parseBody(EnabledBody, req.body);
    if (!mayChangeExtension(principal(req), ext)) {
      throw new HttpError(403, 'Not allowed to change devices for this extension');
    }
    const current = await dbm.getExtensionMaxContacts(ext);
    if (current === null) throw new HttpError(503, 'Cannot reach the PBX database');
    if (enabled && current >= dbm.MULTI_DEVICE_MAX_CONTACTS) return { ok: true, extension: ext, max_contacts: current };
    const target = enabled ? dbm.MULTI_DEVICE_MAX_CONTACTS : dbm.SINGLE_DEVICE_MAX_CONTACTS;
    if (current === target) return { ok: true, extension: ext, max_contacts: current };
    if (!(await dbm.setExtensionMaxContacts(ext, target, { pbx: await pbxSetting() }))) {
      throw new HttpError(502, 'Could not update the extension in the PBX');
    }
    setRedactedAuditDetail(req, { extension: ext, max_contacts: target, previous: current });
    log.info('Multi-device %s for extension %s (max_contacts=%s)', enabled ? 'enabled' : 'disabled', ext, target);
    return { ok: true, extension: ext, max_contacts: target };
  }
}
