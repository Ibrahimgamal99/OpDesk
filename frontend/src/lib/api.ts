/**
 * The single API boundary (Rules 4 + 5).
 *
 * Every call goes through `request()`, so error normalisation exists in exactly
 * one place. Before this module there were 14 different error-handling idioms
 * across 26 call sites, each re-deriving `.detail || 'Something failed'`.
 *
 *   const user = await api<User>('/api/auth/me');            // unwraps {data}
 *   const { items, page } = await apiList<Contact>('/api/contacts');
 *
 * Failures throw `ApiError`, which carries the whole Rule 4.1 envelope: a
 * stable `code` to switch on, the `message` to display, `severity` → tone,
 * `retryable` → whether a Retry button renders, `traceId` for support, and
 * `fields` for binding validation errors to form controls by `name`.
 *
 * NOTE (Rule 5.4): the standard requires this client be GENERATED from the
 * OpenAPI spec, and the spec generated from the handlers. It is hand-written
 * for now because `docs/api/openapi.yaml` is still hand-maintained and covers
 * only the public integration API. Generating both is tracked work; until then
 * this file is the one place to change when a payload shape changes.
 */
import { getToken, removeToken } from '../auth';

export type Severity = 'info' | 'warning' | 'error' | 'critical';

/** One entry of the Rule 4.1 `fields` array. `path` matches a control's `name`. */
export interface ApiFieldError {
  path: string;
  code: string;
  message: string;
  params: Record<string, unknown>;
}

interface ErrorEnvelope {
  code: string;
  message: string;
  severity: Severity;
  retryable: boolean;
  trace_id: string;
  params?: Record<string, unknown>;
  fields?: ApiFieldError[];
  details?: Record<string, unknown>;
}

/** Mirrors the backend `page` object exactly, so collection components can
 *  wire to any list endpoint with no adapter (Rule 2.2). */
export interface PageState {
  cursor: string | null;
  next_cursor: string | null;
  limit: number;
  total?: number;
}

/**
 * Client-side codes. Namespaced under `client.` so they never collide with a
 * server code, and so the UI has ONE code space to switch on — a dropped
 * connection and a 503 are both just codes, not two different shapes.
 */
export const CLIENT_CODES = {
  OFFLINE: 'client.network.offline',
  UNREACHABLE: 'client.network.unreachable',
  MALFORMED: 'client.response.malformed',
  ABORTED: 'client.request.aborted',
} as const;

export class ApiError extends Error {
  readonly code: string;
  readonly severity: Severity;
  readonly retryable: boolean;
  readonly traceId: string;
  readonly fields: ApiFieldError[];
  readonly params: Record<string, unknown>;
  readonly details: Record<string, unknown>;
  readonly status: number;

  constructor(env: ErrorEnvelope, status: number) {
    super(env.message);
    this.name = 'ApiError';
    this.code = env.code;
    this.severity = env.severity ?? 'error';
    this.retryable = env.retryable ?? false;
    this.traceId = env.trace_id ?? '';
    this.fields = env.fields ?? [];
    this.params = env.params ?? {};
    this.details = env.details ?? {};
    this.status = status;
  }

  /** `path` → message, ready to hand to a Field's `error` prop. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of this.fields) {
      // First error per path wins; `fields` is ordered by the server.
      if (!(f.path in out)) out[f.path] = f.message;
    }
    return out;
  }

  /** True when the failure is about specific inputs rather than the whole request. */
  get isValidation(): boolean {
    return this.fields.length > 0;
  }
}

function clientError(code: string, message: string, retryable: boolean): ApiError {
  return new ApiError(
    { code, message, severity: 'error', retryable, trace_id: '', fields: [] },
    0
  );
}

/** Fired on 401 so the app can bounce to login from one listener. */
const UNAUTHORIZED_EVENT = 'opdesk:unauthorized';
export function onUnauthorized(fn: () => void): () => void {
  const h = () => fn();
  window.addEventListener(UNAUTHORIZED_EVENT, h);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, h);
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip the Authorization header (login, public keys). */
  anonymous?: boolean;
}

/**
 * Core transport. Returns the parsed body; throws `ApiError` on any failure.
 * Nothing else in the app should call `fetch` against `/api`.
 */
async function request(path: string, opts: RequestOptions = {}): Promise<unknown> {
  const { body, anonymous, headers, ...rest } = opts;

  const h: Record<string, string> = { ...(headers as Record<string, string>) };
  if (!anonymous) {
    const token = getToken();
    if (token) h.Authorization = `Bearer ${token}`;
  }
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isForm) h['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      headers: h,
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw clientError(CLIENT_CODES.ABORTED, 'Request cancelled.', false);
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw clientError(CLIENT_CODES.OFFLINE,
        'You appear to be offline. Reconnect and try again.', true);
    }
    throw clientError(CLIENT_CODES.UNREACHABLE,
      'Could not reach the server. Try again shortly.', true);
  }

  if (res.status === 401) {
    removeToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }

  // 204 and other empty bodies are legitimate successes.
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    if (res.ok) return null;
  }

  const ctype = res.headers.get('content-type') || '';
  let parsed: unknown = null;
  if (ctype.includes('json')) {
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
  } else if (!res.ok) {
    // A proxy or the SPA catch-all served HTML for an API path. Do not surface
    // markup to the user; map it into the same code space as everything else.
    throw clientError(CLIENT_CODES.MALFORMED,
      `The server returned an unexpected response (HTTP ${res.status}).`, res.status >= 500);
  }

  if (!res.ok) {
    const env = (parsed as { error?: ErrorEnvelope } | null)?.error;
    if (env?.code) throw new ApiError(env, res.status);
    // Should not happen once every handler is behind the middleware, but a
    // bare non-enveloped failure must still arrive as an ApiError.
    throw new ApiError(
      {
        code: 'internal.server.unexpected',
        message: `Request failed (HTTP ${res.status}).`,
        severity: 'error',
        retryable: res.status >= 500,
        trace_id: res.headers.get('X-Trace-Id') ?? '',
        fields: [],
      },
      res.status
    );
  }

  return parsed;
}

/** Rule 5.1: success payloads live under `data`. */
function unwrap<T>(body: unknown): T {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as { data: T }).data;
  }
  // Endpoint not yet migrated to the {data} envelope. Returned as-is so the
  // screen keeps working; the audit script counts what is left.
  if (import.meta.env?.DEV) {
    console.warn('[api] response is not enveloped in {data} — endpoint not yet migrated');
  }
  return body as T;
}

/** Single resource. Throws `ApiError` on failure. */
export async function api<T>(path: string, opts?: RequestOptions): Promise<T> {
  return unwrap<T>(await request(path, opts));
}

/** Collection. Returns items plus the `page` envelope for cursor pagination. */
export async function apiList<T>(
  path: string,
  opts?: RequestOptions
): Promise<{ items: T[]; page: PageState }> {
  const body = (await request(path, opts)) as
    { data?: T[]; page?: PageState } | T[] | null;

  if (Array.isArray(body)) {
    // Un-migrated endpoint returning a bare array.
    return { items: body, page: { cursor: null, next_cursor: null, limit: body.length } };
  }
  const items = body?.data ?? [];
  return {
    items,
    page: body?.page ?? { cursor: null, next_cursor: null, limit: items.length },
  };
}

/** Build `?filter[x]=&sort=&cursor=&limit=` the way Rule 5.3 specifies. */
export function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * Turn any thrown value into an `ApiError`. Use at a catch boundary so the UI
 * only ever renders one error shape, whatever went wrong.
 */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return clientError(
    CLIENT_CODES.MALFORMED,
    e instanceof Error && e.message ? e.message : 'Something went wrong.',
    false
  );
}

/**
 * Throw an `ApiError` built from a failed `Response`.
 *
 * Bridge for call sites still using `fetchWithAuth` directly:
 *
 *     const res = await fetchWithAuth(url, { ... });
 *     if (!res.ok) await raiseFor(res);
 *
 * This replaces the 14 hand-rolled `(await res.json()).detail || 'X failed'`
 * variants with one idiom that reads the real Rule 4.1 envelope — so the user
 * sees the server's authored message, and `code`/`fields`/`traceId` survive.
 *
 * Prefer `api()` / `apiList()` in new code; this exists so screens can migrate
 * one at a time instead of in a single sweeping commit.
 */
export async function raiseFor(res: Response): Promise<never> {
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  const env = (parsed as { error?: ErrorEnvelope } | null)?.error;
  if (env?.code) throw new ApiError(env, res.status);
  throw new ApiError(
    {
      code: 'internal.server.unexpected',
      message: `Request failed (HTTP ${res.status}).`,
      severity: 'error',
      retryable: res.status >= 500,
      trace_id: res.headers.get('X-Trace-Id') ?? '',
      fields: [],
    },
    res.status
  );
}

/**
 * Read the displayable message out of an already-parsed error body.
 *
 * For call sites that parse the response themselves and set state rather than
 * throwing. Rule 4.1: `message` is the string the UI displays — error copy is
 * authored once, on the server, not twice.
 */
export function messageFrom(body: unknown, fallback: string): string {
  const env = (body as { error?: { message?: string } } | null | undefined)?.error;
  if (env && typeof env.message === 'string' && env.message) return env.message;
  return fallback;
}

/** The error `code` from a parsed body, for switching on a specific condition. */
export function codeFrom(body: unknown): string | null {
  const env = (body as { error?: { code?: string } } | null | undefined)?.error;
  return typeof env?.code === 'string' ? env.code : null;
}

/** Rule 4.1: severity → the `tone` prop the shared components take. */
export function toneFor(severity: Severity): 'info' | 'warning' | 'danger' {
  switch (severity) {
    case 'info': return 'info';
    case 'warning': return 'warning';
    default: return 'danger';
  }
}
