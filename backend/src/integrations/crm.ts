/**
 * CRM Connector Interface
 *
 * A unified interface for integrating with CRM systems using different authentication
 * methods: API Key, Basic Auth, Bearer Token, and OAuth2. The connector sends call data to
 * the CRM in a standardized format (the call-data sync push) and GETs contact lookups.
 *
 * Python: backend/crm.py, plus the settings-backed helpers server.py kept next to it
 * (init_crm_connector, load_crm_sync_config, load_crm_lookup_config,
 * _migrate_crm_sync_fields). The delivery queue and retry worker the AMI monitor and the
 * delivery-resend route share are in integrations/crm-delivery; the retry POLICY they apply
 * (isRetryableFailure, retryDelayFor) is here.
 *
 * The HTTP transport is `fetch`; tests swap it with setCrmFetch() so nothing here ever
 * reaches a real CRM from a test run.
 */

import * as dns from 'dns';
import { env } from '../core/config';
import { getLogger } from '../core/logger';
import { AsyncLock, isoformat, nowIso, pyInt, truthy } from '../core/py';
import * as dbm from '../db/db-manager';
import { CALL_OUTCOMES, RETIRED_SPELLINGS } from '../services/call-outcomes';

const log = getLogger('integrations.crm');

type Json = Record<string, unknown>;

/** Supported authentication types. */
export enum AuthType {
  API_KEY = 'api_key',
  BASIC_AUTH = 'basic_auth',
  BEARER_TOKEN = 'bearer_token',
  OAUTH2 = 'oauth2',
}

/** Python's ValueError from this module: a config problem the API reports as a 400. */
export class CrmValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

/** httpx.RequestError: no response arrived (refused, DNS, TLS, timeout). */
export class RequestError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** httpx.HTTPStatusError from raise_for_status(): a response arrived but was not 2xx. */
export class HTTPStatusError extends Error {
  constructor(readonly response: HttpResponse) {
    super(`HTTP ${response.status_code}`);
    this.name = 'HTTPStatusError';
  }
}

/** send_call_data / get_json result. */
export interface CrmResult {
  success: boolean;
  status_code: number | null;
  data: unknown;
  error: string | null;
  /** Seconds a non-2xx answer's Retry-After header asked for (see parseRetryAfter). */
  retry_after?: number | null;
}

/** test_connection result. */
export interface CrmConnectionTest {
  success: boolean;
  status_code: number | null;
  message: string;
  method: string;
  details?: CrmResult | null;
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

/** What this module reads off a response. */
export interface HttpResponse {
  status_code: number;
  text: string;
  headers?: Headers;
}

/** Redirect hops a followRedirects request takes before giving up (each one is vetted). */
export const MAX_REDIRECTS = 5;

/** A fetch-compatible function. `init` may carry an undici `dispatcher`. */
export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

let fetchOverride: FetchImpl | null = null;

/** Replace the transport (tests). `null` restores the real one. */
export function setCrmFetch(impl: FetchImpl | null): void {
  fetchOverride = impl;
}

interface UndiciModule {
  Agent: new (opts: object) => { close(): Promise<void> };
  fetch: FetchImpl;
}

let undiciWarned = false;

function loadUndici(): UndiciModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('undici') as UndiciModule;
  } catch {
    if (!undiciWarned) {
      undiciWarned = true;
      log.warning('verify_ssl is off for the CRM connector but the undici package failed to load; TLS stays verified');
    }
    return null;
  }
}

// Errno texts httpx carried in str(ConnectError) (it wrapped the OSError's message), so the
// delivery log's `error` column reads the way it did.
const ERRNO_TEXT: Record<string, [string, string]> = {
  ECONNREFUSED: ['ConnectError', '[Errno 111] Connection refused'],
  ENOTFOUND: ['ConnectError', '[Errno -2] Name or service not known'],
  EAI_AGAIN: ['ConnectError', '[Errno -3] Temporary failure in name resolution'],
  EHOSTUNREACH: ['ConnectError', '[Errno 113] No route to host'],
  ENETUNREACH: ['ConnectError', '[Errno 101] Network is unreachable'],
  ECONNRESET: ['ReadError', '[Errno 104] Connection reset by peer'],
  ETIMEDOUT: ['ConnectTimeout', 'timed out'],
  UND_ERR_CONNECT_TIMEOUT: ['ConnectTimeout', 'timed out'],
  UND_ERR_HEADERS_TIMEOUT: ['ReadTimeout', 'timed out'],
  UND_ERR_BODY_TIMEOUT: ['ReadTimeout', 'timed out'],
  UND_ERR_SOCKET: ['RemoteProtocolError', 'Server disconnected without sending a response.'],
};

function toRequestError(e: unknown): RequestError {
  if (e instanceof RequestError) return e;
  const err = e as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return new RequestError('ReadTimeout', 'timed out');
  const code = err?.cause?.code ?? err?.code;
  if (code && ERRNO_TEXT[code]) return new RequestError(...ERRNO_TEXT[code]);
  if (code && /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO/.test(code)) {
    return new RequestError('ConnectError', `[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: ${err?.cause?.message ?? code}`);
  }
  return new RequestError('ConnectError', err?.cause?.message ?? err?.message ?? String(e));
}

/** The connector's HTTP client (httpx.AsyncClient's role): timeout + TLS verification. */
export class AsyncHttpClient {
  isClosed = false;
  private agent: { close(): Promise<void> } | null = null;
  private undiciFetch: FetchImpl | null = null;

  constructor(
    readonly timeout: number,
    readonly verifySsl: boolean,
  ) {
    if (!verifySsl) {
      const undici = loadUndici();
      if (undici) {
        this.agent = new undici.Agent({ connect: { rejectUnauthorized: false } });
        this.undiciFetch = undici.fetch;
      }
    }
  }

  /**
   * One request, no raise_for_status. Throws RequestError when no response arrived.
   *
   * Redirects are never left to fetch: with `followRedirects` each Location is resolved,
   * vetted by `vetHop` (the SSRF guard) and only then requested, at most MAX_REDIRECTS
   * times; without it a 3xx comes back as the answer. A CRM that redirects into the
   * metadata service or loopback is refused at the hop, not after the request was made.
   */
  // NOTE(port): httpx applied the timeout to each of connect/read/write; here it bounds the
  // whole request.
  async request(
    method: string,
    url: string,
    opts: {
      headers?: Record<string, string>;
      body?: string;
      followRedirects?: boolean;
      vetHop?: (url: string) => Promise<void>;
    } = {},
  ): Promise<HttpResponse> {
    let target = url;
    for (let hop = 0; ; hop++) {
      const res = await this.requestOnce(method, target, opts);
      const location = res.headers?.get('location');
      if (!opts.followRedirects || res.status_code < 300 || res.status_code >= 400 || !location) return res;
      if (hop >= MAX_REDIRECTS) throw new RequestError('TooManyRedirects', `Exceeded maximum allowed redirects (${MAX_REDIRECTS}).`);
      let next: string;
      try {
        next = new URL(location, target).toString();
      } catch {
        return res;
      }
      if (opts.vetHop) await opts.vetHop(next);
      target = next;
    }
  }

  private async requestOnce(
    method: string,
    url: string,
    opts: { headers?: Record<string, string>; body?: string },
  ): Promise<HttpResponse> {
    let scheme = '';
    try {
      scheme = new URL(url).protocol.replace(/:$/, '');
    } catch {
      throw new RequestError('UnsupportedProtocol', "Request URL is missing an 'http://' or 'https://' protocol.");
    }
    if (scheme !== 'http' && scheme !== 'https') {
      throw new RequestError('UnsupportedProtocol', `Request URL has an unsupported protocol '${scheme}://'.`);
    }
    const init: RequestInit & Record<string, unknown> = {
      method,
      headers: opts.headers,
      body: opts.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.max(1, this.timeout) * 1000),
    };
    let doFetch: FetchImpl = (u, i) => fetch(u, i);
    if (this.agent && this.undiciFetch) {
      (init as Record<string, unknown>).dispatcher = this.agent;
      doFetch = this.undiciFetch;
    }
    if (fetchOverride) doFetch = fetchOverride;
    try {
      const res = await doFetch(url, init);
      const text = method === 'HEAD' ? '' : await res.text();
      return { status_code: res.status, text, headers: res.headers };
    } catch (e) {
      throw toRequestError(e);
    }
  }

  async aclose(): Promise<void> {
    this.isClosed = true;
    if (this.agent) await this.agent.close().catch(() => undefined);
    this.agent = null;
  }
}

function raiseForStatus(r: HttpResponse): void {
  if (r.status_code < 200 || r.status_code >= 300) throw new HTTPStatusError(r);
}

/** response.json(), or undefined where json.loads raised. */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** str(list_of_str) for the "Missing required fields" message. */
function pyReprList(items: string[]): string {
  return `[${items.map((s) => `'${s}'`).join(', ')}]`;
}

// ---------------------------------------------------------------------------
// CRMConnector
// ---------------------------------------------------------------------------

export interface CRMConnectorOptions {
  apiKey?: string | null;
  apiKeyHeader?: string;
  username?: string | null;
  password?: string | null;
  bearerToken?: string | null;
  oauth2ClientId?: string | null;
  oauth2ClientSecret?: string | null;
  oauth2TokenUrl?: string | null;
  oauth2Scope?: string | null;
  /** Pre-obtained token */
  oauth2Token?: string | null;
  endpointPath?: string;
  timeout?: number;
  verifySsl?: boolean;
  customHeaders?: Record<string, string> | null;
  /** SSRF posture for the send-time address check: also refuse RFC-1918 targets. */
  blockPrivate?: boolean;
}

/**
 * Unified CRM Connector that supports multiple authentication methods.
 *
 *     const crm = new CRMConnector('https://crm.example.com', AuthType.API_KEY, { apiKey: 'key' });
 *     await crm.sendCallData({ caller: '1002', destination: '1001', call_status: 'ANSWERED' });
 */
export class CRMConnector {
  serverUrl: string;
  authType: AuthType;
  endpointPath: string;
  timeout: number;
  verifySsl: boolean;
  customHeaders: Record<string, string>;
  blockPrivate: boolean;

  apiKey: string | null;
  apiKeyHeader: string;
  username: string | null;
  password: string | null;
  bearerToken: string | null;

  oauth2ClientId: string | null;
  oauth2ClientSecret: string | null;
  oauth2TokenUrl: string | null;
  oauth2Scope: string | null;
  private oauth2Token: string | null;
  private oauth2TokenExpiry: number | null = null; // epoch ms
  private tokenLock: AsyncLock | null = null;

  private client: AsyncHttpClient | null = null;

  constructor(serverUrl: string, authType: AuthType, opts: CRMConnectorOptions = {}) {
    // Normalize server URL (remove trailing slash)
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.authType = authType;
    this.endpointPath = opts.endpointPath ?? '/api/calls';
    this.timeout = opts.timeout ?? 30;
    this.verifySsl = opts.verifySsl ?? true;
    this.customHeaders = opts.customHeaders || {};
    this.blockPrivate = opts.blockPrivate ?? false;

    this.apiKey = opts.apiKey ?? null;
    this.apiKeyHeader = opts.apiKeyHeader ?? 'X-API-Key';
    this.username = opts.username ?? null;
    this.password = opts.password ?? null;
    this.bearerToken = opts.bearerToken ?? null;

    this.oauth2ClientId = opts.oauth2ClientId ?? null;
    this.oauth2ClientSecret = opts.oauth2ClientSecret ?? null;
    this.oauth2TokenUrl = opts.oauth2TokenUrl ?? null;
    this.oauth2Scope = opts.oauth2Scope ?? null;
    this.oauth2Token = opts.oauth2Token ?? null;

    this.validateAuthConfig();
  }

  /** server_url, the name the delivery log and ami.ts read it under. */
  get server_url(): string {
    return this.serverUrl;
  }

  /** Validate that required credentials are provided for the selected auth type. */
  private validateAuthConfig(): void {
    if (this.authType === AuthType.API_KEY) {
      if (!this.apiKey) throw new CrmValueError('API key is required for API_KEY authentication');
    } else if (this.authType === AuthType.BASIC_AUTH) {
      if (!this.username || !this.password) {
        throw new CrmValueError('Username and password are required for BASIC_AUTH authentication');
      }
    } else if (this.authType === AuthType.BEARER_TOKEN) {
      if (!this.bearerToken) throw new CrmValueError('Bearer token is required for BEARER_TOKEN authentication');
    } else if (this.authType === AuthType.OAUTH2) {
      if (!this.oauth2ClientId || !this.oauth2ClientSecret) {
        throw new CrmValueError('OAuth2 client_id and client_secret are required for OAUTH2 authentication');
      }
      if (!this.oauth2TokenUrl && !this.oauth2Token) {
        throw new CrmValueError('OAuth2 token_url is required if no pre-obtained token is provided');
      }
    }
  }

  /**
   * `{server_url}{path}`, refused unless it is still a URL on the CRM server: a path that
   * moves the authority ('@169.254.169.254/x' turns the server URL into userinfo) or swaps
   * the scheme is a CrmValueError, whatever validated the path on the way in.
   */
  targetUrl(path: string): string {
    const url = `${this.serverUrl}${path}`;
    let base: URL;
    let target: URL;
    try {
      base = new URL(this.serverUrl);
      target = new URL(url);
    } catch {
      throw new CrmValueError('CRM URL is not a valid URL');
    }
    if (target.origin !== base.origin || target.username !== base.username || target.password !== base.password) {
      throw new CrmValueError('CRM endpoint path must stay on the CRM server');
    }
    return url;
  }

  /**
   * The SSRF check again, at send time: what the host resolves to NOW, not what it resolved
   * to when the settings were saved (a DNS answer can change in between).
   */
  async vetUrl(url: string): Promise<void> {
    await validateCrmUrl(url, { blockPrivate: this.blockPrivate });
  }

  /** Get or create the HTTP client, recreating it if closed. */
  private getClient(): AsyncHttpClient {
    if (this.client === null || this.client.isClosed) {
      this.client = new AsyncHttpClient(this.timeout, this.verifySsl);
    }
    return this.client;
  }

  /**
   * Get OAuth2 access token, refreshing if necessary. The lock keeps two concurrent pushes
   * from both fetching a token.
   */
  private async getOauth2Token(): Promise<string> {
    if (this.tokenLock === null) this.tokenLock = new AsyncLock();
    return this.tokenLock.run(async () => {
      // Double-check token validity after acquiring lock
      if (this.oauth2Token && this.oauth2TokenExpiry !== null && Date.now() < this.oauth2TokenExpiry) {
        return this.oauth2Token;
      }
      if (!this.oauth2TokenUrl) throw new CrmValueError('OAuth2 token URL is required to fetch token');
      await this.vetUrl(this.oauth2TokenUrl);

      const form = new URLSearchParams();
      form.set('grant_type', 'client_credentials');
      form.set('client_id', this.oauth2ClientId ?? '');
      form.set('client_secret', this.oauth2ClientSecret ?? '');
      if (this.oauth2Scope) form.set('scope', this.oauth2Scope);

      try {
        const response = await this.getClient().request('POST', this.oauth2TokenUrl, {
          body: form.toString(),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        raiseForStatus(response);
        const parsed = parseJson(response.text);
        if (!parsed.ok) throw new CrmValueError('OAuth2 token response is not valid JSON');
        const tokenData = (parsed.value && typeof parsed.value === 'object' ? parsed.value : {}) as Json;
        const token = tokenData.access_token;
        this.oauth2Token = token ? String(token) : null;
        // Token expiry (default to 1 hour if not provided), with a 60 s buffer.
        const expiresIn = Number(hasOwn(tokenData, 'expires_in') ? tokenData.expires_in : 3600);
        this.oauth2TokenExpiry = Date.now() + ((Number.isFinite(expiresIn) ? expiresIn : 3600) - 60) * 1000;
        if (!this.oauth2Token) throw new CrmValueError('No access_token in OAuth2 response');
        return this.oauth2Token;
      } catch (e) {
        // Sanitize error logging - don't expose a response body which may contain secrets
        if (e instanceof HTTPStatusError) {
          log.error('Failed to fetch OAuth2 token: HTTP %s', e.response.status_code);
          if (log.isEnabledFor('DEBUG')) log.debug('OAuth2 token response body (truncated): %s...', e.response.text.slice(0, 200));
        } else if (e instanceof RequestError) {
          log.error('Failed to fetch OAuth2 token: %s', e.name);
        }
        throw e;
      }
    });
  }

  /** Build request headers based on authentication type. */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'OpDesk-CRM-Connector/1.0',
      ...this.customHeaders,
    };
    if (this.authType === AuthType.API_KEY) {
      headers[this.apiKeyHeader] = this.apiKey ?? '';
    } else if (this.authType === AuthType.BASIC_AUTH) {
      headers.Authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64')}`;
    } else if (this.authType === AuthType.BEARER_TOKEN) {
      headers.Authorization = `Bearer ${this.bearerToken}`;
    }
    // OAuth2: the token is added per request, after fetching it.
    return headers;
  }

  private async authorizedHeaders(): Promise<Record<string, string>> {
    const headers = this.buildHeaders();
    if (this.authType === AuthType.OAUTH2) headers.Authorization = `Bearer ${await this.getOauth2Token()}`;
    return headers;
  }

  /** A response as {success, status_code, data, error}; HTTP errors become success=false. */
  private async exchange(method: string, url: string, headers: Record<string, string>, body?: string): Promise<CrmResult> {
    await this.vetUrl(url);
    try {
      const response = await this.getClient().request(method, url, { headers, body });
      raiseForStatus(response);
      const parsed = parseJson(response.text);
      const data = parsed.ok ? parsed.value : { message: response.text, status_code: response.status_code };
      return { success: true, status_code: response.status_code, data, error: null };
    } catch (e) {
      if (e instanceof HTTPStatusError) {
        // Sanitize error logging - don't expose response body which may contain secrets
        log.error('HTTP error from CRM: %s', e.response.status_code);
        if (log.isEnabledFor('DEBUG')) log.debug('Response body (truncated): %s...', e.response.text.slice(0, 200));
        return {
          success: false,
          status_code: e.response.status_code,
          error: e.response.text,
          data: null,
          retry_after: parseRetryAfter(e.response.headers?.get('retry-after')),
        };
      }
      if (e instanceof RequestError) {
        log.error('Request error talking to CRM: %s', e.name);
        if (log.isEnabledFor('DEBUG')) log.debug('Request error details: %s', e.message);
        return { success: false, status_code: null, error: e.message, data: null };
      }
      throw e;
    }
  }

  /**
   * Send call data to the CRM.
   *
   * `requireFields` (default true) rejects a body without caller/destination; the call-data
   * sync path passes false because the operator chooses exactly which fields to push.
   * `extraHeaders` are per-request additions (the delivery queue's idempotency key), applied
   * last; never credentials, those come from the config.
   *
   * @throws CrmValueError when required fields are missing, the target is refused by the
   *   SSRF guard, or no OAuth2 token can be obtained.
   */
  async sendCallData(
    callData: Json,
    opts: {
      endpointPath?: string | null;
      method?: string;
      requireFields?: boolean;
      extraHeaders?: Record<string, string> | null;
    } = {},
  ): Promise<CrmResult> {
    if (opts.requireFields ?? true) {
      const missing = ['caller', 'destination'].filter((f) => !hasOwn(callData, f) || !truthy(callData[f]));
      if (missing.length) throw new CrmValueError(`Missing required fields: ${pyReprList(missing)}`);
    }
    const url = this.targetUrl(opts.endpointPath || this.endpointPath);
    const headers = { ...(await this.authorizedHeaders()), ...(opts.extraHeaders ?? {}) };
    const result = await this.exchange(opts.method ?? 'POST', url, headers, JSON.stringify(callData));
    if (result.success) log.info('Successfully sent call data to CRM: %s', redactUrl(url));
    return result;
  }

  /**
   * GET {server_url}{endpointPath} and parse the JSON response. Used by the contact lookup;
   * the path must arrive fully rendered ([Number] substituted and URL-encoded).
   */
  async getJson(endpointPath: string): Promise<CrmResult> {
    const url = this.targetUrl(endpointPath);
    const headers = await this.authorizedHeaders();
    delete headers['Content-Type'];
    return this.exchange('GET', url, headers);
  }

  /**
   * Test the connection: a HEAD request first (lighter, no body); if that cannot be sent
   * at all, a POST of a small test body. Redirects are followed for the HEAD, each hop
   * through the SSRF guard. A target the guard refuses is reported, not attempted.
   */
  async testConnection(endpointPath: string | null = null): Promise<CrmConnectionTest> {
    const testEndpoint = endpointPath || this.endpointPath;
    let url: string;
    try {
      url = this.targetUrl(testEndpoint);
      await this.vetUrl(url);
    } catch (e) {
      return { success: false, status_code: null, message: `Connection test failed: ${e instanceof Error ? e.message : String(e)}`, method: 'HEAD' };
    }
    try {
      const headers = await this.authorizedHeaders();
      const response = await this.getClient().request('HEAD', url, {
        headers,
        followRedirects: true,
        vetHop: (next) => this.vetUrl(next),
      });
      const ok = response.status_code < 400;
      return {
        success: ok,
        status_code: response.status_code,
        message: ok ? 'Connection test successful' : 'Connection test failed',
        method: 'HEAD',
      };
    } catch (e) {
      // A redirect the SSRF guard refused is the answer, not a reason to try a POST.
      if (e instanceof CrmValueError) {
        return { success: false, status_code: null, message: `Connection test failed: ${e.message}`, method: 'HEAD' };
      }
      log.debug('HEAD request error: %s, trying POST with test data', (e as Error)?.name ?? e);
    }

    const testData = { test: true, timestamp: nowIso(), message: 'Connection test from OpDesk CRM Connector' };
    try {
      // The test body carries no caller/destination, so the required-field check is off: the
      // POST is really sent and a transport failure reports its own error.
      const result = await this.sendCallData(testData, { endpointPath, requireFields: false });
      return {
        success: result.success,
        status_code: result.status_code,
        message: result.success ? 'Connection test successful' : 'Connection test failed',
        method: 'POST',
        details: result,
      };
    } catch (e) {
      return {
        success: false,
        status_code: null,
        message: `Connection test failed: ${e instanceof Error ? e.message : String(e)}`,
        method: 'POST',
        details: null,
      };
    }
  }

  /** Close the HTTP client and release its connections. */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.aclose();
      this.client = null;
    }
  }

  /**
   * Convert a duration to HH:MM:SS. Integers are seconds; a string containing ':' is
   * returned as-is; a numeric string is parsed as seconds; anything else is returned as-is.
   */
  static normalizeDuration(duration: unknown): string {
    let total: number;
    if (typeof duration === 'number' && Number.isInteger(duration)) {
      total = duration;
    } else if (typeof duration === 'string') {
      if (duration.includes(':')) return duration;
      const n = pyInt(duration);
      if (n === null) return duration;
      total = n;
    } else {
      return String(duration);
    }
    const sign = total < 0 ? '-' : '';
    const abs = Math.abs(total);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${sign}${p(Math.floor(abs / 3600))}:${p(Math.floor((abs % 3600) / 60))}:${p(abs % 60)}`;
  }

  /**
   * Parse a duration into integer seconds: an int, a numeric string, or "HH:MM:SS"/"MM:SS".
   * null when it can't be parsed.
   */
  static durationToSeconds(duration: unknown): number | null {
    if (duration === null || duration === undefined || duration === '' || typeof duration === 'boolean') return null;
    if (typeof duration === 'number') return Number.isInteger(duration) ? duration : null;
    const s = String(duration).trim();
    if (s.includes(':')) {
      let total = 0;
      for (const part of s.split(':')) {
        const p = pyInt(part);
        if (p === null) return null;
        total = total * 60 + p; // H:M:S or M:S — each part is the next-smaller unit
      }
      return total;
    }
    return pyInt(s);
  }

  /** The standard CRM body for one call (datetime defaults to now). */
  static formatCallDataForCrm(opts: {
    caller: string;
    destination: string;
    duration?: number | string | null;
    datetimeStr?: string | null;
    callStatus?: string | null;
    queue?: string | null;
    callType?: string | null;
    talkTime?: number | string | null;
    extra?: Json;
  }): Json {
    const out: Json = {
      caller: String(opts.caller),
      destination: String(opts.destination),
      datetime: opts.datetimeStr ?? nowIso(),
    };
    if (opts.duration !== null && opts.duration !== undefined) out.duration = CRMConnector.normalizeDuration(opts.duration);
    if (opts.callStatus !== null && opts.callStatus !== undefined) out.call_status = opts.callStatus;
    if (opts.queue !== null && opts.queue !== undefined) out.queue = opts.queue;
    if (opts.callType !== null && opts.callType !== undefined) out.call_type = opts.callType;
    if (opts.talkTime !== null && opts.talkTime !== undefined) out.talk_time = CRMConnector.normalizeDuration(opts.talkTime);
    return { ...out, ...(opts.extra ?? {}) };
  }
}

/**
 * Create a CRM connector from a configuration dict (snake_case keys, as server.py built
 * them): server_url, auth_type, api_key, api_key_header, username, password, bearer_token,
 * oauth2_client_id, oauth2_client_secret, oauth2_token_url, oauth2_scope, oauth2_token,
 * endpoint_path, timeout, verify_ssl, custom_headers.
 *
 * @throws CrmValueError for an unknown auth_type or missing credentials.
 */
export function createCrmConnector(config: Json): CRMConnector {
  const authTypes: Record<string, AuthType> = {
    api_key: AuthType.API_KEY,
    basic_auth: AuthType.BASIC_AUTH,
    bearer_token: AuthType.BEARER_TOKEN,
    oauth2: AuthType.OAUTH2,
  };
  const authTypeStr = String(config.auth_type ?? '').toLowerCase();
  if (!hasOwn(authTypes, authTypeStr)) {
    throw new CrmValueError(`Invalid auth_type: ${authTypeStr}. Must be one of: ${pyReprList(Object.keys(authTypes))}`);
  }
  const authType = authTypes[authTypeStr];
  const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  const timeout = pyInt(config.timeout ?? 30);
  const opts: CRMConnectorOptions = {
    endpointPath: config.endpoint_path === undefined ? '/api/calls' : String(config.endpoint_path ?? ''),
    timeout: timeout === null ? 30 : timeout,
    verifySsl: config.verify_ssl === undefined ? true : Boolean(config.verify_ssl),
    customHeaders: (config.custom_headers as Record<string, string> | null | undefined) ?? null,
    blockPrivate: truthy(config.block_private),
  };
  if (authType === AuthType.API_KEY) {
    opts.apiKey = str(config.api_key);
    // `||` rather than a default: a stored-but-empty header name would otherwise produce a
    // nameless auth header and a "missing apikey" from the CRM.
    opts.apiKeyHeader = str(config.api_key_header) || 'X-API-Key';
  } else if (authType === AuthType.BASIC_AUTH) {
    opts.username = str(config.username);
    opts.password = str(config.password);
  } else if (authType === AuthType.BEARER_TOKEN) {
    opts.bearerToken = str(config.bearer_token);
  } else {
    opts.oauth2ClientId = str(config.oauth2_client_id);
    opts.oauth2ClientSecret = str(config.oauth2_client_secret);
    opts.oauth2TokenUrl = str(config.oauth2_token_url);
    opts.oauth2Scope = str(config.oauth2_scope);
    opts.oauth2Token = str(config.oauth2_token);
  }
  return new CRMConnector(String(config.server_url ?? ''), authType, opts);
}

// ===========================================================================
// Call-Data Sync engine
// ---------------------------------------------------------------------------
// The "sync" layer is the operator-facing push: after every completed call the AMI
// monitor assembles the full set of available call values and this module decides
// *what* actually gets sent — which fields the operator selected, which call directions
// are enabled — and applies SSRF hardening before the request leaves the box. The
// default field selection reproduces the legacy 8-field body.
// ===========================================================================

/**
 * Canonical set of call fields that can be selected for the CRM push. The Settings API
 * serves this to the UI (one checkbox per entry), validates saved selections against it,
 * and the AMI monitor builds its payload from the same keys.
 */
export const CRM_SYNC_FIELD_CATALOG: readonly string[] = [
  'caller', // caller number/extension
  'destination', // destination number/extension
  'duration', // total call time (see duration_format)
  'talk_time', // answer→hangup time (see duration_format)
  'datetime', // call start, ISO 8601
  'call_status', // call status, one of call-outcomes CALL_OUTCOMES
  'call_type', // inbound | outbound | internal
  'queue', // queue name (queue calls only)
  'caller_name', // CallerID name, when Asterisk provides it
  'call_id', // Asterisk Linkedid — the call's cross-reference handle
  'uniqueid', // Asterisk channel Uniqueid (per-leg de-dup key)
  'disposition', // same call status as call_status
  'hangup_cause', // raw Asterisk hangup cause code
  'agent', // agent/extension that answered (queue calls)
  'agent_name', // display name of the answering agent
  'answered_extension', // extension that answered the call
  'queue_wait_time', // seconds spent waiting in queue before answer
];

const CRM_SYNC_FIELD_SET = new Set(CRM_SYNC_FIELD_CATALOG);

/**
 * Catalog names that no longer exist, mapped to their replacement. Used by the one-shot
 * settings migration so an upgraded install doesn't silently lose a selected field.
 */
export const RETIRED_CRM_SYNC_FIELDS: Readonly<Record<string, string>> = { linkedid: 'call_id' };

/** Default selection: exactly the field set the connector sent before the sync layer existed. */
export const DEFAULT_CRM_SYNC_FIELDS: readonly string[] = [
  'caller', 'destination', 'duration', 'talk_time', 'datetime', 'call_status', 'call_type', 'queue',
];

/**
 * Outbound JSON key names. The internal catalog uses snake_case names; the CRM receiver
 * gets camelCase keys. A field not listed keeps its internal name. The duration fields are
 * named dynamically (see outboundJsonKey) so the key reflects the unit.
 */
export const CRM_SYNC_JSON_KEYS: Readonly<Record<string, string>> = {
  datetime: 'startTime',
  call_status: 'status',
  call_type: 'callType',
  caller_name: 'callerName',
  call_id: 'callId',
  uniqueid: 'uniqueId',
  hangup_cause: 'hangupCause',
  agent: 'agentExt',
  agent_name: 'agentName',
  answered_extension: 'answeredExtension',
  queue_wait_time: 'queueWaitTime',
};

/**
 * Map an internal payload key to its outbound JSON key. In seconds mode the duration
 * fields become `durationInSeconds`/`talkTimeInSeconds`; in HH:MM:SS mode `duration`/`talkTime`.
 */
export function outboundJsonKey(fieldName: string, opts: { toSeconds: boolean }): string {
  if (fieldName === 'duration') return opts.toSeconds ? 'durationInSeconds' : 'duration';
  if (fieldName === 'talk_time') return opts.toSeconds ? 'talkTimeInSeconds' : 'talkTime';
  return hasOwn(CRM_SYNC_JSON_KEYS, fieldName) ? CRM_SYNC_JSON_KEYS[fieldName] : fieldName;
}

/** Every catalog field -> the outbound JSON key it uses by default (HH:MM:SS form). */
export function defaultOutboundKeys(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of CRM_SYNC_FIELD_CATALOG) out[f] = outboundJsonKey(f, { toSeconds: false });
  return out;
}

function loadMap(raw: unknown): Json | null {
  if (raw === null || raw === undefined || raw === '') return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const parsed = parseJson(raw);
    if (!parsed.ok) return null;
    value = parsed.value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Json;
}

/** str(x or '').strip() */
function strTrim(x: unknown): string {
  return truthy(x) ? String(x).trim() : '';
}

/**
 * Normalise a stored outbound-key rename map into a clean {from: to} dict. Only renames of
 * known default outbound keys (including the seconds-variant duration keys) are kept, so a
 * stale UI value can't inject arbitrary keys. Unknown/malformed input yields {}.
 */
export function parseKeyMap(raw: unknown): Record<string, string> {
  const map = loadMap(raw);
  if (!map) return {};
  const validSources = new Set([...Object.values(defaultOutboundKeys()), 'durationInSeconds', 'talkTimeInSeconds']);
  const out: Record<string, string> = {};
  for (const [kRaw, vRaw] of Object.entries(map)) {
    const k = strTrim(kRaw);
    const v = strTrim(vRaw);
    if (k && v && k !== v && validSources.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Normalise a stored status value-map into an upper-cased {from: to} dict (e.g.
 * {"BUSY": "UNANSWERED"} for a CRM whose enum has no BUSY). Blanks are dropped;
 * unknown/malformed input yields {}.
 */
export function parseStatusMap(raw: unknown): Record<string, string> {
  const map = loadMap(raw);
  if (!map) return {};
  const out: Record<string, string> = {};
  for (const [kRaw, vRaw] of Object.entries(map)) {
    const k = strTrim(kRaw).toUpperCase();
    const v = strTrim(vRaw).toUpperCase();
    if (k && v) out[k] = v;
  }
  return out;
}

/**
 * A status map whose sources use a retired call-status spelling (NO_ANSWER, CANCELED,
 * OUT_OF_REACH...) rewritten to today's word, so a map saved before the 10-value call status
 * keeps matching. An entry already written under the new word wins.
 */
export function modernizeStatusMap(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (!hasOwn(RETIRED_SPELLINGS, k)) out[k] = v;
  }
  for (const [k, v] of Object.entries(map)) {
    if (hasOwn(RETIRED_SPELLINGS, k)) {
      const modern = RETIRED_SPELLINGS[k];
      if (!hasOwn(out, modern)) out[modern] = v;
    }
  }
  return out;
}

/** Whether `name` is a recognised sync field. */
export function isCrmSyncField(name: string): boolean {
  return CRM_SYNC_FIELD_SET.has(name);
}

// ---------------------------------------------------------------------------
// SSRF hardening
// ---------------------------------------------------------------------------
// A CRM URL is operator-configured, so the main threat is a misconfiguration or a
// malicious admin steering the push at internal infrastructure (the box's own AMI/DB on
// loopback, or the cloud metadata service at 169.254.169.254). We always block loopback,
// link-local (incl. metadata), multicast, reserved and the unspecified address. RFC-1918
// private ranges are ALLOWED by default because an on-prem CRM on the LAN is a first-class
// OpDesk deployment; operators who want a stricter posture opt in via block_private.

/** An IP address as Python's ipaddress module classified it. */
export interface IpAddress {
  version: 4 | 6;
  ip: bigint;
}

function parseIPv4(s: string): bigint | null {
  const octets = s.split('.');
  if (octets.length !== 4) return null;
  let ip = 0n;
  for (const o of octets) {
    if (!/^[0-9]{1,3}$/.test(o) || (o.length > 1 && o[0] === '0')) return null;
    const n = Number(o);
    if (n > 255) return null;
    ip = (ip << 8n) | BigInt(n);
  }
  return ip;
}

function parseIPv6(full: string): bigint | null {
  const ipStr = full.split('%')[0];
  if (!ipStr || !ipStr.includes(':')) return null;
  const parts = ipStr.split(':');
  if (parts[parts.length - 1].includes('.')) {
    const v4 = parseIPv4(parts.pop()!);
    if (v4 === null) return null;
    parts.push(((v4 >> 16n) & 0xffffn).toString(16), (v4 & 0xffffn).toString(16));
  }
  const dbl = ipStr.indexOf('::');
  let groups: string[];
  if (dbl >= 0) {
    if (ipStr.indexOf('::', dbl + 1) >= 0) return null;
    const joined = parts.join(':');
    const [head, tail] = joined.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const missing = 8 - h.length - t.length;
    if (missing < 1) return null;
    groups = [...h, ...Array(missing).fill('0'), ...t];
  } else {
    groups = parts;
  }
  if (groups.length !== 8) return null;
  let ip = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    ip = (ip << 16n) | BigInt(parseInt(g, 16));
  }
  return ip;
}

/** ipaddress.ip_address(s), or null where it raised ValueError. */
export function parseIpAddress(s: string): IpAddress | null {
  const host = s.replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(host);
  if (v4 !== null) return { version: 4, ip: v4 };
  const v6 = parseIPv6(host);
  return v6 === null ? null : { version: 6, ip: v6 };
}

/** str(ip) for the error message: dotted quad, or the RFC 5952 compressed IPv6 form. */
export function ipToString(a: IpAddress): string {
  if (a.version === 4) return [24n, 16n, 8n, 0n].map((s) => String((a.ip >> s) & 0xffn)).join('.');
  const hextets = [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n].map((s) => ((a.ip >> s) & 0xffffn).toString(16));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (hextets[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && hextets[j] === '0') j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (bestLen < 2) return hextets.join(':');
  const head = hextets.slice(0, bestStart).join(':');
  const tail = hextets.slice(bestStart + bestLen).join(':');
  return `${head}::${tail}`;
}

type Net = [bigint, number];

const v4net = (s: string): Net => {
  const [addr, p] = s.split('/');
  return [parseIPv4(addr)!, Number(p)];
};
const v6net = (s: string): Net => {
  const [addr, p] = s.split('/');
  return [parseIPv6(addr)!, Number(p)];
};

function inNet(a: IpAddress, [net, prefix]: Net): boolean {
  const bits = BigInt((a.version === 4 ? 32 : 128) - prefix);
  return a.ip >> bits === net >> bits;
}

// The ranges Python 3.11's ipaddress classifies with.
const V4 = {
  linklocal: v4net('169.254.0.0/16'),
  loopback: v4net('127.0.0.0/8'),
  multicast: v4net('224.0.0.0/4'),
  reserved: v4net('240.0.0.0/4'),
  private: [
    '0.0.0.0/8', '10.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
    '192.0.0.170/31', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
    '203.0.113.0/24', '240.0.0.0/4', '255.255.255.255/32',
  ].map(v4net),
  privateExceptions: ['192.0.0.9/32', '192.0.0.10/32'].map(v4net),
};

const V6 = {
  linklocal: v6net('fe80::/10'),
  multicast: v6net('ff00::/8'),
  private: [
    '::1/128', '::/128', '::ffff:0:0/96', '64:ff9b:1::/48', '100::/64', '2001::/23', '2001:db8::/32',
    '2002::/16', 'fc00::/7', 'fe80::/10',
  ].map(v6net),
  privateExceptions: [
    '2001:1::1/128', '2001:1::2/128', '2001:3::/32', '2001:4:112::/48', '2001:20::/28', '2001:30::/28',
  ].map(v6net),
  reserved: [
    '::/8', '100::/8', '200::/7', '400::/6', '800::/5', '1000::/4', '4000::/3', '6000::/3', '8000::/3',
    'a000::/3', 'c000::/3', 'e000::/4', 'f000::/5', 'f800::/6', 'fe00::/9',
  ].map(v6net),
};

function ipIsPrivate(a: IpAddress): boolean {
  if (a.version === 6 && a.ip >> 32n === 0xffffn) return ipIsPrivate({ version: 4, ip: a.ip & 0xffffffffn });
  const c = a.version === 4 ? V4 : V6;
  return c.private.some((n) => inNet(a, n)) && c.privateExceptions.every((n) => !inNet(a, n));
}

/** True if `ip` must never be the target of an outbound CRM request. */
export function isBlockedIp(ip: IpAddress, opts: { blockPrivate: boolean; blockLoopback: boolean }): boolean {
  const unspecified = ip.ip === 0n;
  const multicast = inNet(ip, ip.version === 4 ? V4.multicast : V6.multicast);
  const reserved = ip.version === 4 ? inNet(ip, V4.reserved) : V6.reserved.some((n) => inNet(ip, n));
  if (unspecified || multicast || reserved) return true;
  // link-local covers IPv4 169.254/16 (incl. the 169.254.169.254 metadata service) and
  // IPv6 fe80::/10 — always blocked.
  if (inNet(ip, ip.version === 4 ? V4.linklocal : V6.linklocal)) return true;
  const loopback = ip.version === 4 ? inNet(ip, V4.loopback) : ip.ip === 1n;
  if (opts.blockLoopback && loopback) return true;
  if (opts.blockPrivate && ipIsPrivate(ip)) return true;
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;

let resolver: Resolver = async (host) => (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

/** Replace the DNS lookup used by validateCrmUrl (tests). `null` restores getaddrinfo. */
export function setCrmResolver(fn: Resolver | null): void {
  resolver = fn ?? (async (host) => (await dns.promises.lookup(host, { all: true })).map((a) => a.address));
}

/**
 * Vet a CRM base/target URL for the call-data push (SSRF protection).
 *
 * Rejects anything that is not an absolute http(s) URL and blocks loopback, link-local
 * (incl. cloud metadata), multicast, reserved and the unspecified address. An empty URL is
 * allowed (sync simply does nothing). A hostname that does not currently resolve is allowed
 * (it may resolve later); any address it *does* resolve to is checked.
 *
 * @throws CrmValueError if the URL is malformed or resolves to a blocked address.
 */
export async function validateCrmUrl(
  raw: string | null | undefined,
  opts: { blockPrivate?: boolean; blockLoopback?: boolean } = {},
): Promise<void> {
  const blockPrivate = opts.blockPrivate ?? false;
  const blockLoopback = opts.blockLoopback ?? true;
  const url = (raw || '').trim();
  if (!url) return;

  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
  if (scheme !== 'http' && scheme !== 'https') throw new CrmValueError('CRM URL scheme must be http or https');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // NOTE(port): httpx raised InvalidURL here, which the save route did not catch (a 500);
    // a malformed URL is reported as the 400 it is.
    throw new CrmValueError('CRM URL is not a valid URL');
  }
  // WHATWG URL also folds numeric shorthands (http://2130706433/) to their dotted form,
  // so they are checked as the address they really are.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new CrmValueError('CRM URL has no host');

  let ips: IpAddress[] = [];
  const literal = parseIpAddress(host);
  if (literal !== null) {
    ips.push(literal);
  } else {
    try {
      for (const addr of await resolver(host)) {
        const ip = parseIpAddress(addr);
        if (ip !== null) ips.push(ip);
      }
    } catch {
      ips = []; // unresolvable now — allow
    }
  }
  for (const ip of ips) {
    if (isBlockedIp(ip, { blockPrivate, blockLoopback })) {
      throw new CrmValueError(`CRM URL host resolves to a blocked address (${ipToString(ip)})`);
    }
  }
}

/** Strip the query string and any embedded credentials from a URL for logging. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    return u.toString();
  } catch {
    return '(crm endpoint)';
  }
}

/**
 * Vet a path that is appended to the CRM server URL (endpoint_path, sync_endpoint,
 * lookup_url). Only server_url goes through validateCrmUrl, so a path must not be able to
 * move the request somewhere else: it has to start with '/' and carry no '@' (which turns
 * the server URL into userinfo -- 'https://crm.example.com' + '@169.254.169.254/x' is a
 * request to the metadata service), no '://', no backslash and no whitespace. An empty path
 * is allowed (the caller's default applies).
 *
 * @throws CrmValueError naming `field`.
 */
export function validateCrmPath(raw: string | null | undefined, field: string): void {
  const path = (raw || '').trim();
  if (!path) return;
  if (!path.startsWith('/') || path.includes('@') || path.includes('://') || path.includes('\\') || /\s/.test(path)) {
    throw new CrmValueError(`${field} must be a path starting with '/' (no '@', '://' or spaces); it is appended to the CRM server URL`);
  }
}

// ---------------------------------------------------------------------------
// Delivery retry policy
//
// Which failed pushes are worth sending again, and how long to wait. Pure functions: the
// queue (db webhook_deliveries) and the worker (crm-delivery) both need this judgement and
// neither should own it.
//
// The split that matters is retryable vs permanent. A 5xx or a refused connection is the
// receiver's problem and will likely be gone in a minute; a 400 or 422 means the receiver
// read the payload and rejected it, so re-sending the same bytes only produces the same
// rejection. 401/403 are permanent on purpose -- a wrong credential is fixed in Settings,
// and the operator resends from the deliveries log once it is.
// ---------------------------------------------------------------------------

/** 4xx codes that ARE worth another attempt: timeout, locked, too-early, rate limited. */
export const RETRYABLE_4XX: ReadonlySet<number> = new Set([408, 423, 425, 429]);
/** 30 s, 2 min, 10 min, 30 min; the last value repeats. */
export const DEFAULT_RETRY_DELAYS: readonly number[] = [30, 120, 600, 1800];
export const DEFAULT_RETRY_MAX_ATTEMPTS = 5;
/** A queue, not an infinite loop. */
export const MAX_RETRY_ATTEMPTS_CEILING = 20;
/** 24 h between attempts is already a manual problem. */
export const MAX_RETRY_DELAY = 86400;

/**
 * Whether a failed push should be attempted again. No status code means the request never
 * got a response (DNS, refused, timeout): always retryable. 5xx and the transient 4xx codes
 * are retryable; every other 4xx is a rejection of this payload.
 */
export function isRetryableFailure(statusCode: number | string | null | undefined): boolean {
  if (statusCode === null || statusCode === undefined) return true;
  const code = pyInt(statusCode);
  if (code === null) return true;
  return code >= 500 || RETRYABLE_4XX.has(code);
}

/**
 * A Retry-After header in whole seconds, from either form (delta seconds or an HTTP date).
 * null when absent or unparseable; clamped to 0..MAX_RETRY_DELAY so a hostile or mistaken
 * header cannot park a delivery for a month (a past date is "retry now").
 */
export function parseRetryAfter(raw: string | null | undefined): number | null {
  const value = (raw || '').trim();
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.max(0, Math.min(Math.trunc(Number(value)), MAX_RETRY_DELAY));
  // An HTTP date always names its weekday or month; a bare number Date.parse would read as a year.
  if (!/[A-Za-z]/.test(value)) return null;
  const when = Date.parse(value);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.min(Math.trunc((when - Date.now()) / 1000), MAX_RETRY_DELAY));
}

/**
 * A stored backoff ladder ("30,120,600" or [30, 120, 600]) as positive second counts.
 * Anything unusable falls back to DEFAULT_RETRY_DELAYS rather than to an empty ladder,
 * which would mean "retry immediately, forever".
 */
export function parseRetryDelays(raw: string | readonly unknown[] | null | undefined): number[] {
  const items: unknown[] = raw === null || raw === undefined ? [] : typeof raw === 'string' ? raw.split(',') : [...raw];
  const out: number[] = [];
  for (const item of items) {
    const secs = pyInt(String(item ?? '').trim());
    if (secs !== null && secs > 0) out.push(Math.min(secs, MAX_RETRY_DELAY));
  }
  return out.length ? out : [...DEFAULT_RETRY_DELAYS];
}

/**
 * Seconds to wait before attempt `attempt + 1`, `attempt` attempts already made. The
 * ladder's last value repeats. A Retry-After wins when it asks for MORE time than the
 * ladder (the receiver knows its recovery window), never for less, so `Retry-After: 0`
 * from an overloaded CRM cannot turn the queue into a hot loop.
 */
export function retryDelayFor(
  attempt: number,
  opts: { delays?: string | readonly unknown[] | null; retryAfter?: number | null } = {},
): number {
  const ladder = parseRetryDelays(opts.delays ?? null);
  const idx = attempt ? Math.max(0, Math.trunc(attempt) - 1) : 0;
  const base = idx < ladder.length ? ladder[idx] : ladder[ladder.length - 1];
  const retryAfter = opts.retryAfter ?? null;
  if (retryAfter !== null && retryAfter > base) return Math.min(retryAfter, MAX_RETRY_DELAY);
  return base;
}

/** The push triggers: right at hangup, or once the answering agent's wrap-up is over. */
export const CRM_SYNC_TRIGGERS: readonly string[] = ['hangup', 'wrapup'];
export const DEFAULT_WRAPUP_TIMEOUT = 600;
export const MIN_WRAPUP_TIMEOUT = 5;
export const MAX_WRAPUP_TIMEOUT = 86400;

// ---------------------------------------------------------------------------
// Sync configuration + payload assembly
// ---------------------------------------------------------------------------

/** Resolved call-data sync configuration (read from settings). */
export class CRMSyncConfig {
  enabled = false;
  /** path appended to the connection server_url */
  endpoint = '';
  /** POST or PUT */
  method = 'POST';
  fields: string[] = [...DEFAULT_CRM_SYNC_FIELDS];
  dirInbound = true;
  dirOutbound = true;
  dirInternal = true;
  blockPrivate = false;
  /** "hms" | "seconds" */
  durationFormat = 'hms';
  /** {FROM: TO}, upper-cased */
  statusMap: Record<string, string> = {};
  /** {defaultKey: newKey} */
  keyMap: Record<string, string> = {};
  /**
   * When the push fires: "hangup" (at once, from live call state) or "wrapup" (once the
   * agent who took the call has finished wrap-up, or after wrapupTimeout seconds,
   * whichever comes first; an unanswered call has no wrap-up and goes at once).
   */
  trigger = 'hangup';
  wrapupTimeout = DEFAULT_WRAPUP_TIMEOUT;
  /**
   * Delivery retry policy. retryEnabled=false still records the delivery (so a failure is
   * visible and can be resent by hand); it only stops the worker from re-sending on its own.
   */
  retryEnabled = true;
  retryMaxAttempts = DEFAULT_RETRY_MAX_ATTEMPTS;
  retryDelays: number[] = [...DEFAULT_RETRY_DELAYS];

  constructor(init: Partial<CRMSyncConfig> = {}) {
    Object.assign(this, init);
  }

  /** Whether a call of this direction should be pushed. */
  directionAllowed(callType: string | null | undefined): boolean {
    if (callType === 'inbound') return this.dirInbound;
    if (callType === 'outbound') return this.dirOutbound;
    if (callType === 'internal') return this.dirInternal;
    // Unknown/blank direction: push it rather than silently dropping the call.
    return true;
  }
}

// ---------------------------------------------------------------------------
// Contact lookup (3CX-style): number formatting, JSON path extraction, name templates and
// configuration. Pure functions — no AMI/DB/HTTP.
// ---------------------------------------------------------------------------

export const LOOKUP_NUMBER_FORMATS: readonly string[] = ['digits', 'as_is', 'plus', 'zeros'];

const PATH_TOKEN_RE = /\[([^[\]]+)\]/g;

/**
 * Format a caller number the way the CRM expects it (3CX's Number prefix strategies):
 *   digits — strip everything but digits:      +20 100… -> 20100…
 *   as_is  — trimmed raw caller-ID
 *   plus   — international prefix as '+':      0020… -> +20…, keeps +20…
 *   zeros  — international prefix as '00':     +20…  -> 0020…
 */
export function formatLookupNumber(raw: string | null | undefined, fmt = 'digits'): string {
  const s = (raw || '').trim();
  if (fmt === 'as_is') return s;
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (fmt === 'plus') {
    if (digits.startsWith('00')) return '+' + digits.slice(2);
    return hasPlus ? '+' + digits : digits;
  }
  if (fmt === 'zeros') {
    if (hasPlus && !digits.startsWith('00')) return '00' + digits;
    return digits;
  }
  return digits;
}

/**
 * Cache/comparison key for a number: digits only, optionally reduced to the last N digits
 * so prefix variants (+20…, 0020…, 0…) share one entry.
 */
export function lookupCacheKey(raw: string | null | undefined, matchDigits = 0): string {
  let digits = (raw || '').replace(/\D/g, '');
  if (matchDigits && matchDigits > 0) digits = digits.slice(-matchDigits);
  return digits.slice(0, 32);
}

/**
 * Walk a dot/index path like 'data.0.name' through parsed JSON. Each segment indexes an
 * object by key or a list by integer (negative counts from the end, as in Python). Returns
 * the trimmed string of a scalar leaf, null on any miss or type mismatch.
 */
export function extractJsonPath(data: unknown, path: string | null | undefined): string | null {
  let node: unknown = data;
  for (const seg of (path || '').trim().split('.')) {
    if (!seg) return null;
    if (Array.isArray(node)) {
      const i = pyInt(seg);
      if (i === null) return null;
      const idx = i < 0 ? node.length + i : i;
      if (idx < 0 || idx >= node.length) return null;
      node = node[idx];
    } else if (node !== null && typeof node === 'object') {
      if (!hasOwn(node, seg)) return null;
      node = (node as Json)[seg];
    } else {
      return null;
    }
  }
  if (typeof node === 'string' || typeof node === 'number') {
    const text = String(node).trim();
    return text || null;
  }
  return null;
}

/**
 * Render a contact-name template like '[data.0.first_name] [data.0.last_name]' against a
 * JSON response. A template with no tokens is a single bare path. Returns null when no token
 * resolves (literal-only leftovers don't count as a name).
 */
export function renderNameTemplate(data: unknown, template: string | null | undefined): string | null {
  const t = (template || '').trim();
  if (!t) return null;
  if (!t.includes('[')) return extractJsonPath(data, t);
  let resolvedAny = false;
  const rendered = t.replace(PATH_TOKEN_RE, (_m, path: string) => {
    const value = extractJsonPath(data, path);
    if (value !== null) {
      resolvedAny = true;
      return value;
    }
    return '';
  });
  if (!resolvedAny) return null;
  const clean = rendered.replace(/\s+/g, ' ').trim();
  return clean || null;
}

/** urllib.parse.quote(s, safe=""): encodeURIComponent plus the five it leaves alone. */
function pyQuote(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Substitute the formatted, URL-encoded number into a lookup URL template's [Number]
 * placeholder. A template without the placeholder gets '?phone=[Number]' appended
 * ('&' if it already has a query string).
 */
export function renderLookupUrl(urlTemplate: string | null | undefined, rawNumber: string, numberFormat = 'digits'): string {
  let template = (urlTemplate || '').trim();
  if (!template.includes('[Number]')) template += (template.includes('?') ? '&' : '?') + 'phone=[Number]';
  return template.split('[Number]').join(pyQuote(formatLookupNumber(rawNumber, numberFormat)));
}

/** Resolved contact-lookup configuration (read from settings). */
export class CRMLookupConfig {
  enabled = false;
  /** path template appended to server_url, with [Number] */
  urlTemplate = '';
  /** e.g. "[data.0.first_name] [data.0.last_name]" */
  nameTemplate = '';
  numberFormat = 'digits';
  /** compare/cache on last N digits (0 = full) */
  matchDigits = 0;
  /** optional path to the matched record's phone field */
  verifyPath = '';
  ttlHours = 24;

  constructor(init: Partial<CRMLookupConfig> = {}) {
    Object.assign(this, init);
  }

  usable(): boolean {
    return this.enabled && Boolean(this.urlTemplate) && Boolean(this.nameTemplate);
  }
}

/**
 * Normalise a stored field selection (CSV string or list) into a clean, ordered list
 * limited to known catalog fields. Unknown/blank entries are dropped.
 */
export function parseSyncFields(raw: string | readonly unknown[] | null | undefined): string[] {
  const items: unknown[] = raw === null || raw === undefined ? [] : typeof raw === 'string' ? raw.split(',') : [...raw];
  const out: string[] = [];
  for (const item of items) {
    const f = (typeof item === 'string' ? item : item === null || item === undefined ? '' : String(item)).trim();
    if (f && CRM_SYNC_FIELD_SET.has(f) && !out.includes(f)) out.push(f);
  }
  return out;
}

const DURATION_FIELDS = ['duration', 'talk_time'] as const;
// The call-status fields a status map may rewrite. Both carry the same call status.
const STATUS_MAPPED_FIELDS = ['call_status', 'disposition'] as const;
// Fields always emitted as an integer rather than a string (the agent extension is a plain
// number, and CRMs that key on it expect a numeric id). Unparseable values are left as-is.
const INT_FIELDS = ['agent'] as const;

/**
 * Build the CRM push body from the full set of available call values, keeping only the
 * operator-selected fields that are present (not null/undefined/''; numeric 0 is kept).
 *
 * durationFormat: "hms" -> "HH:MM:SS" (default), "seconds" -> integer seconds, whatever
 * the stored form. The returned object uses the outbound JSON key names (startTime,
 * agentExt, status...) and then the operator's key renames, with a collision guard: a
 * rename that would land on a key already in the body is refused and the field keeps its
 * original key, so no value is ever silently dropped.
 */
export function buildCrmPayload(
  allFields: Json,
  selected: readonly string[],
  opts: { durationFormat?: string; statusMap?: Record<string, string> | null; keyMap?: Record<string, string> | null } = {},
): Json {
  const present = (v: unknown) => v !== null && v !== undefined && v !== '';
  const keys: string[] = [];
  for (const f of selected) if (CRM_SYNC_FIELD_SET.has(f) && !keys.includes(f)) keys.push(f);

  const payload: Json = {};
  for (const f of keys) if (hasOwn(allFields, f) && present(allFields[f])) payload[f] = allFields[f];

  const toSeconds = (opts.durationFormat ?? 'hms') === 'seconds';
  for (const f of DURATION_FIELDS) {
    if (!hasOwn(payload, f)) continue;
    if (toSeconds) {
      const secs = CRMConnector.durationToSeconds(payload[f]);
      if (secs !== null) payload[f] = secs;
    } else {
      payload[f] = CRMConnector.normalizeDuration(payload[f]);
    }
  }

  // Status remap: translate the call status to whatever this CRM accepts. Matched
  // case-insensitively on the value; an unmapped value passes through unchanged.
  const statusMap = opts.statusMap;
  if (statusMap && Object.keys(statusMap).length) {
    for (const f of STATUS_MAPPED_FIELDS) {
      if (hasOwn(payload, f) && payload[f] !== null && payload[f] !== undefined) {
        const k = String(payload[f]).trim().toUpperCase();
        if (hasOwn(statusMap, k)) payload[f] = statusMap[k];
      }
    }
  }

  // Numeric fields: always send as an integer (e.g. the agent extension "305" -> 305).
  for (const f of INT_FIELDS) {
    if (hasOwn(payload, f) && typeof payload[f] !== 'boolean') {
      const n = pyInt(String(payload[f]).trim());
      if (n !== null) payload[f] = n;
    }
  }

  // Rename internal snake_case keys to their outbound camelCase JSON names, in order.
  let out: Json = {};
  for (const [k, v] of Object.entries(payload)) out[outboundJsonKey(k, { toSeconds })] = v;

  let keyMap = opts.keyMap;
  if (keyMap && Object.keys(keyMap).length) {
    // In seconds mode the duration fields go out as *InSeconds, but the Settings UI keys
    // the rename on the HH:MM:SS form; translate those source keys to the active form.
    if (toSeconds) {
      const alias: Record<string, string> = { talkTime: 'talkTimeInSeconds', duration: 'durationInSeconds' };
      const translated: Record<string, string> = {};
      for (const [k, v] of Object.entries(keyMap)) translated[hasOwn(alias, k) ? alias[k] : k] = v;
      keyMap = translated;
    }
    const renamed: Json = {};
    for (const [k, v] of Object.entries(out)) {
      let target = hasOwn(keyMap, k) ? keyMap[k] : k;
      if (target !== k && hasOwn(out, target)) {
        // The target is (or will be) a real key from another field — keep the original.
        log.warning('CRM key rename %r -> %r skipped: target collides with an existing field; keeping %r', k, target, k);
        target = k;
      }
      if (hasOwn(renamed, target)) {
        // Two sources already resolved to the same target this pass — keep the first.
        log.warning('CRM key %r skipped: %r already emitted by another field', k, target);
        target = k;
        if (hasOwn(renamed, target)) continue; // even the original key is taken
      }
      renamed[target] = v;
    }
    out = renamed;
  }
  return out;
}

// ===========================================================================
// Settings-backed configuration (server.py)
// ===========================================================================

/** get_setting(key, os.getenv(key, default)): the DB value, else the env var, else default. */
async function settingOrEnv(key: string, fallback = ''): Promise<string> {
  const v = await dbm.getSetting(key, env(key, fallback));
  return v === null || v === undefined ? '' : String(v);
}

const isOn = (v: string | null | undefined) => ['true', '1', 'yes'].includes((v || '').toLowerCase());

// Why the last initCrmConnector() built nothing although CRM_ENABLED is on (missing URL or
// credential), or null. The push path reads it so an enabled-but-broken CRM records a failed
// delivery per call instead of looking like "no calls happened".
let unavailableReason: string | null = null;

/** The reason CRM is enabled but has no connector, or null (disabled, or working). */
export function crmUnavailableReason(): string | null {
  return unavailableReason;
}

/**
 * Build the CRM connector from settings (DB, falling back to env). null when CRM is
 * disabled or its configuration is incomplete — the reason is logged, and for an enabled
 * CRM kept for crmUnavailableReason().
 */
export async function initCrmConnector(): Promise<CRMConnector | null> {
  unavailableReason = null;
  if (!isOn(await settingOrEnv('CRM_ENABLED'))) {
    log.info('CRM is disabled (set CRM_ENABLED=true to enable)');
    return null;
  }
  const connector = await buildEnabledCrmConnector();
  if (connector === null && unavailableReason === null) unavailableReason = 'CRM connector not configured';
  return connector;
}

async function buildEnabledCrmConnector(): Promise<CRMConnector | null> {
  const unavailable = (reason: string): null => {
    unavailableReason = reason;
    return null;
  };
  const serverUrl = (await settingOrEnv('CRM_SERVER_URL')).trim();
  const authType = (await settingOrEnv('CRM_AUTH_TYPE')).trim().toLowerCase();
  if (!serverUrl) {
    log.warning('CRM_ENABLED is true but CRM_SERVER_URL is not set - CRM disabled');
    return unavailable('CRM server URL is not set');
  }
  if (!authType) {
    log.warning('CRM_ENABLED is true but CRM_AUTH_TYPE is not set - CRM disabled');
    return unavailable('CRM auth type is not set');
  }
  const timeout = pyInt(await settingOrEnv('CRM_TIMEOUT', '30'));
  const config: Json = {
    server_url: serverUrl,
    auth_type: authType,
    endpoint_path: await settingOrEnv('CRM_ENDPOINT_PATH', '/api/calls'),
    timeout: timeout === null ? 30 : timeout,
    verify_ssl: isOn(await settingOrEnv('CRM_VERIFY_SSL', 'true')),
    block_private: isOn(await settingOrEnv('CRM_BLOCK_PRIVATE', 'false')),
  };
  if (authType === 'api_key') {
    const apiKey = (await settingOrEnv('CRM_API_KEY')).trim();
    if (!apiKey) {
      log.warning("CRM_AUTH_TYPE is 'api_key' but CRM_API_KEY is not set - CRM disabled");
      return unavailable('CRM API key is not set');
    }
    config.api_key = apiKey;
    const header = (await settingOrEnv('CRM_API_KEY_HEADER')).trim();
    if (header) config.api_key_header = header;
  } else if (authType === 'basic_auth') {
    const username = (await settingOrEnv('CRM_USERNAME')).trim();
    const password = (await settingOrEnv('CRM_PASSWORD')).trim();
    if (!username || !password) {
      log.warning("CRM_AUTH_TYPE is 'basic_auth' but CRM_USERNAME or CRM_PASSWORD is not set - CRM disabled");
      return unavailable('CRM username or password is not set');
    }
    config.username = username;
    config.password = password;
  } else if (authType === 'bearer_token') {
    const token = (await settingOrEnv('CRM_BEARER_TOKEN')).trim();
    if (!token) {
      log.warning("CRM_AUTH_TYPE is 'bearer_token' but CRM_BEARER_TOKEN is not set - CRM disabled");
      return unavailable('CRM bearer token is not set');
    }
    config.bearer_token = token;
  } else if (authType === 'oauth2') {
    const clientId = (await settingOrEnv('CRM_OAUTH2_CLIENT_ID')).trim();
    const clientSecret = (await settingOrEnv('CRM_OAUTH2_CLIENT_SECRET')).trim();
    const tokenUrl = (await settingOrEnv('CRM_OAUTH2_TOKEN_URL')).trim();
    if (!clientId || !clientSecret) {
      log.warning("CRM_AUTH_TYPE is 'oauth2' but CRM_OAUTH2_CLIENT_ID or CRM_OAUTH2_CLIENT_SECRET is not set - CRM disabled");
      return unavailable('CRM OAuth2 client id or secret is not set');
    }
    config.oauth2_client_id = clientId;
    config.oauth2_client_secret = clientSecret;
    if (tokenUrl) config.oauth2_token_url = tokenUrl;
    const scope = (await settingOrEnv('CRM_OAUTH2_SCOPE')).trim();
    if (scope) config.oauth2_scope = scope;
  } else {
    log.warning('Invalid CRM_AUTH_TYPE: %s. Must be one of: api_key, basic_auth, bearer_token, oauth2', authType);
    return unavailable(`Invalid CRM auth type: ${authType}`);
  }
  try {
    const connector = createCrmConnector(config);
    log.info('✅ CRM connector initialized: %s (auth: %s)', redactUrl(serverUrl), authType);
    return connector;
  } catch (e) {
    log.error('Failed to initialize CRM connector: %s', e instanceof Error ? e.message : e);
    return unavailable(e instanceof Error ? e.message : String(e));
  }
}

/**
 * The call-data sync configuration from settings. Read at startup AND rebuilt whenever the
 * config is saved, so changes apply without a restart. Defaults keep the original
 * behaviour: sync enabled, all directions on, the legacy 8-field payload.
 */
export async function loadCrmSyncConfig(): Promise<CRMSyncConfig> {
  const flag = async (key: string, fallback = 'true') => isOn((await settingOrEnv(key, fallback)) || fallback);

  // The push endpoint falls back to the connection endpoint_path when unset, so an
  // upgraded install keeps POSTing to the same path it always did.
  let endpoint = (await settingOrEnv('CRM_SYNC_ENDPOINT')).trim();
  if (!endpoint) endpoint = await settingOrEnv('CRM_ENDPOINT_PATH', '/api/calls');

  let method = ((await settingOrEnv('CRM_SYNC_METHOD', 'POST')) || 'POST').toUpperCase();
  if (method !== 'POST' && method !== 'PUT') method = 'POST';

  const rawFields = await settingOrEnv('CRM_SYNC_FIELDS');
  let fields = rawFields ? parseSyncFields(rawFields) : [...DEFAULT_CRM_SYNC_FIELDS];
  if (!fields.length) fields = [...DEFAULT_CRM_SYNC_FIELDS];

  let durationFormat = ((await settingOrEnv('CRM_SYNC_DURATION_FORMAT', 'hms')) || 'hms').trim().toLowerCase();
  if (durationFormat !== 'hms' && durationFormat !== 'seconds') durationFormat = 'hms';

  let trigger = ((await settingOrEnv('CRM_SYNC_TRIGGER', 'hangup')) || 'hangup').trim().toLowerCase();
  if (!CRM_SYNC_TRIGGERS.includes(trigger)) trigger = 'hangup';
  const wrapupTimeout = clampWrapupTimeout(await settingOrEnv('CRM_SYNC_WRAPUP_TIMEOUT', String(DEFAULT_WRAPUP_TIMEOUT)));

  const retryEnabled = await flag('CRM_SYNC_RETRY_ENABLED');
  // Retries off means exactly one attempt, whatever the stored number says.
  const retryMaxAttempts = retryEnabled ? clampRetryMaxAttempts(await settingOrEnv('CRM_SYNC_RETRY_MAX_ATTEMPTS')) : 1;

  return new CRMSyncConfig({
    enabled: await flag('CRM_SYNC_ENABLED'),
    endpoint,
    method,
    fields,
    dirInbound: await flag('CRM_SYNC_DIR_INBOUND'),
    dirOutbound: await flag('CRM_SYNC_DIR_OUTBOUND'),
    dirInternal: await flag('CRM_SYNC_DIR_INTERNAL'),
    blockPrivate: await flag('CRM_BLOCK_PRIVATE', 'false'),
    durationFormat,
    statusMap: modernizeStatusMap(parseStatusMap(await dbm.getSetting('CRM_SYNC_STATUS_MAP', ''))),
    keyMap: parseKeyMap(await dbm.getSetting('CRM_SYNC_KEY_MAP', '')),
    trigger,
    wrapupTimeout,
    retryEnabled,
    retryMaxAttempts,
    retryDelays: parseRetryDelays(await settingOrEnv('CRM_SYNC_RETRY_DELAYS')),
  });
}

/** A wrap-up fallback window in seconds, clamped to MIN..MAX_WRAPUP_TIMEOUT; the default on bad input. */
export function clampWrapupTimeout(raw: unknown): number {
  const n = pyInt(truthy(raw) ? raw : DEFAULT_WRAPUP_TIMEOUT);
  return Math.max(MIN_WRAPUP_TIMEOUT, Math.min(n === null ? DEFAULT_WRAPUP_TIMEOUT : n, MAX_WRAPUP_TIMEOUT));
}

/** An attempt budget, clamped to 1..MAX_RETRY_ATTEMPTS_CEILING; the default on bad input. */
export function clampRetryMaxAttempts(raw: unknown): number {
  const n = pyInt(truthy(raw) ? raw : DEFAULT_RETRY_MAX_ATTEMPTS);
  return Math.max(1, Math.min(n === null ? DEFAULT_RETRY_MAX_ATTEMPTS : n, MAX_RETRY_ATTEMPTS_CEILING));
}

/** The contact-lookup configuration from settings (rebuilt on every config save). */
export async function loadCrmLookupConfig(): Promise<CRMLookupConfig> {
  const text = async (key: string, fallback = '') => ((await settingOrEnv(key, fallback)) || fallback).trim();
  const int = async (key: string, fallback: number, minimum: number) => {
    const n = pyInt((await text(key, String(fallback))) || fallback);
    return n === null ? fallback : Math.max(minimum, n);
  };
  let numberFormat = (await text('CRM_LOOKUP_NUMBER_FORMAT', 'digits')).toLowerCase();
  if (!LOOKUP_NUMBER_FORMATS.includes(numberFormat)) numberFormat = 'digits';
  return new CRMLookupConfig({
    enabled: isOn((await settingOrEnv('CRM_LOOKUP_ENABLED', 'false')) || 'false'),
    urlTemplate: await text('CRM_LOOKUP_URL'),
    nameTemplate: await text('CRM_LOOKUP_NAME_TEMPLATE'),
    numberFormat,
    matchDigits: await int('CRM_LOOKUP_MATCH_DIGITS', 0, 0),
    verifyPath: await text('CRM_LOOKUP_VERIFY_PATH'),
    ttlHours: await int('CRM_LOOKUP_TTL_HOURS', 24, 1),
  });
}

/**
 * One-shot: rewrite retired catalog names in the stored CRM_SYNC_FIELDS (parseSyncFields
 * silently drops unknown names, so an upgraded install would otherwise lose e.g.
 * `linkedid`, now `call_id`). Idempotent. Run at startup before any sync config is read.
 */
export async function migrateCrmSyncFields(): Promise<void> {
  try {
    const raw = await dbm.getSetting('CRM_SYNC_FIELDS', '');
    if (!raw) return;
    const out: string[] = [];
    let changed = false;
    for (let name of String(raw).split(',')) {
      name = name.trim();
      if (!name) continue;
      if (hasOwn(RETIRED_CRM_SYNC_FIELDS, name)) {
        name = RETIRED_CRM_SYNC_FIELDS[name];
        changed = true;
      }
      if (!out.includes(name)) out.push(name);
    }
    if (changed) {
      await dbm.setSetting('CRM_SYNC_FIELDS', out.join(','));
      log.info('Migrated retired CRM_SYNC_FIELDS names -> %s', out.join(','));
    }
  } catch (e) {
    log.warning('CRM_SYNC_FIELDS migration skipped: %s', e);
  }
}

/** The CRM settings seeded at startup when missing or empty (server.py default_settings). */
export const CRM_DEFAULT_SETTINGS: Readonly<Record<string, string>> = {
  CRM_ENABLED: 'false',
  CRM_AUTH_TYPE: 'api_key',
  CRM_ENDPOINT_PATH: '/api/calls',
  CRM_TIMEOUT: '30',
  CRM_VERIFY_SSL: 'true',
  CRM_SYNC_ENABLED: 'true',
  CRM_SYNC_METHOD: 'POST',
  CRM_SYNC_FIELDS: DEFAULT_CRM_SYNC_FIELDS.join(','),
  CRM_SYNC_DIR_INBOUND: 'true',
  CRM_SYNC_DIR_OUTBOUND: 'true',
  CRM_SYNC_DIR_INTERNAL: 'true',
  CRM_BLOCK_PRIVATE: 'false', // allow on-prem/LAN CRM by default
  CRM_SYNC_DURATION_FORMAT: 'hms', // hms | seconds
  CRM_SYNC_STATUS_MAP: '{}', // {FROM: TO} call-status remap
  CRM_SYNC_KEY_MAP: '{}', // {defaultKey: customKey} rename
  CRM_SYNC_TRIGGER: 'hangup', // hangup | wrapup
  CRM_SYNC_WRAPUP_TIMEOUT: String(DEFAULT_WRAPUP_TIMEOUT), // seconds before a wrap-up push goes anyway
  CRM_SYNC_RETRY_ENABLED: 'true',
  CRM_SYNC_RETRY_MAX_ATTEMPTS: String(DEFAULT_RETRY_MAX_ATTEMPTS),
  CRM_SYNC_RETRY_DELAYS: DEFAULT_RETRY_DELAYS.join(','), // backoff ladder, seconds; the last repeats
  CRM_LOOKUP_ENABLED: 'false',
  CRM_LOOKUP_URL: '',
  CRM_LOOKUP_NAME_TEMPLATE: '',
  CRM_LOOKUP_NUMBER_FORMAT: 'digits', // digits | as_is | plus | zeros
  CRM_LOOKUP_MATCH_DIGITS: '0', // compare/cache on last N digits (0 = full)
  CRM_LOOKUP_VERIFY_PATH: '',
  CRM_LOOKUP_TTL_HOURS: '24',
  WEBHOOK_LOG_RETENTION_DAYS: '30',
};

/** The CALL_OUTCOMES list the Settings UI renders the status-map editor from. */
export function crmCallOutcomes(): string[] {
  return [...CALL_OUTCOMES];
}

// ===========================================================================
// Push + delivery log: the sending itself lives in integrations/crm-delivery.
// ===========================================================================

/**
 * The call's identity for the delivery log, in internal snake_case (taken from the full
 * field set, not the outbound body, so an operator key rename can't corrupt the log's own
 * indexing), plus the resend lineage.
 */
export interface CrmDeliveryMeta {
  call_id?: string | null;
  uniqueid?: string | null;
  caller?: string | null;
  destination?: string | null;
  call_type?: string | null;
  call_status?: string | null;
  attempt?: number | null;
  parent_id?: number | null;
  resent_by?: number | null;
}

/** isoformat() of a DATETIME the DB layer may hand back as a Date. */
export function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? isoformat(v) : String(v);
}
