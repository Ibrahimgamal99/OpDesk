/**
 * One application error type, one code registry, one status mapping (api/errors.py).
 *
 * Every failure carries a stable machine-readable `code` (`domain.resource.condition`),
 * a human `message`, a `severity`, a `retryable` flag, a `trace_id`, and -- for
 * validation failures -- a `fields` array. The renderer in api/respond.ts writes it.
 *
 * Most handlers still throw `HttpError(status, 'message')` with the exact text the Python
 * raised; codeForLegacy() maps that text onto a code with the same ordered regex table the
 * Python middleware used, so a client sees the same `error.code` for the same failure.
 * Codes are STABLE: clients switch on them, so renaming one is a breaking change. Add, don't
 * rename.
 */

import type { ErrorField } from './http-error';

export type Severity = 'info' | 'warning' | 'error' | 'critical';

interface CodeMeta {
  severity: Severity;
  retryable: boolean;
}

const REGISTRY = new Map<string, CodeMeta>();
// domain.resource.condition; a two-part domain.condition is tolerated for codes clients already know.
const CODE_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*){1,}$/;

function reg(code: string, severity: Severity = 'error', retryable = false): string {
  if (REGISTRY.has(code)) throw new Error(`duplicate error code: ${code}`);
  if (!CODE_RE.test(code)) throw new Error(`code must be dotted domain.resource.condition: ${code}`);
  REGISTRY.set(code, { severity, retryable });
  return code;
}

/** Every error code the API can emit (api/errors.py `codes`). */
export const codes = {
  // -- auth ---------------------------------------------------------------
  AUTH_CREDENTIALS_INVALID: reg('auth.credentials.invalid'),
  AUTH_TOKEN_INVALID: reg('auth.token.invalid'),
  AUTH_TOKEN_MISSING: reg('auth.token.missing'),
  AUTH_APIKEY_INVALID: reg('auth.api_key.invalid'),
  AUTH_APIKEY_SCOPE_MISSING: reg('auth.api_key.scope_missing'),
  AUTH_APIKEY_REQUIRED: reg('auth.api_key.required'),

  // -- authorization ------------------------------------------------------
  ACCESS_ROLE_FORBIDDEN: reg('access.role.forbidden'),
  ACCESS_ADMIN_REQUIRED: reg('access.role.admin_required'),
  ACCESS_SUPERVISOR_REQUIRED: reg('access.role.supervisor_required'),
  ACCESS_EXTENSION_FORBIDDEN: reg('access.extension.forbidden'),
  ACCESS_LOOPBACK_REQUIRED: reg('access.origin.loopback_required'),
  ACCESS_CALL_FORBIDDEN: reg('access.call.forbidden'),

  // -- request shape -----------------------------------------------------
  REQUEST_BODY_INVALID: reg('request.body.invalid'),
  REQUEST_FIELD_REQUIRED: reg('request.field.required'),
  REQUEST_FIELD_INVALID: reg('request.field.invalid'),
  REQUEST_ROUTE_NOT_FOUND: reg('request.route.not_found'),
  REQUEST_METHOD_NOT_ALLOWED: reg('request.method.not_allowed'),
  REQUEST_CURSOR_INVALID: reg('request.cursor.invalid'),

  // -- user / group ------------------------------------------------------
  USER_RECORD_NOT_FOUND: reg('user.record.not_found'),
  USER_RECORD_CONFLICT: reg('user.record.conflict'),
  USER_EXTENSION_MISSING: reg('user.extension.missing'),
  USER_UPDATE_FAILED: reg('user.record.update_failed'),
  USER_DELETE_FAILED: reg('user.record.delete_failed'),
  USER_PASSWORD_INVALID: reg('user.password.invalid'),
  GROUP_RECORD_NOT_FOUND: reg('group.record.not_found'),
  GROUP_RECORD_CONFLICT: reg('group.record.conflict'),

  // -- contacts ----------------------------------------------------------
  CONTACT_RECORD_NOT_FOUND: reg('contact.record.not_found'),
  CONTACT_PHONE_CONFLICT: reg('contact.phone.conflict'),
  CONTACT_PHONE_INVALID: reg('contact.phone.invalid'),

  // -- telephony ---------------------------------------------------------
  TELEPHONY_AMI_UNAVAILABLE: reg('telephony.ami.unavailable', 'critical', true),
  TELEPHONY_MONITOR_UNAVAILABLE: reg('telephony.monitor.unavailable', 'warning', true),
  TELEPHONY_CALL_REJECTED: reg('telephony.call.rejected'),
  TELEPHONY_TRANSFER_FAILED: reg('telephony.transfer.failed', 'error', true),
  TELEPHONY_DND_FAILED: reg('telephony.dnd.update_failed', 'error', true),
  TELEPHONY_EXTENSION_NOT_FOUND: reg('telephony.extension.not_found'),
  TELEPHONY_QUEUE_UNASSIGNED: reg('telephony.queue.unassigned'),
  TELEPHONY_PAUSE_REASON_REQUIRED: reg('telephony.pause_reason.required'),

  // -- recordings --------------------------------------------------------
  RECORDING_FILE_NOT_FOUND: reg('recording.file.not_found'),
  RECORDING_FORMAT_UNSUPPORTED: reg('recording.format.unsupported'),
  RECORDING_TOGGLE_FAILED: reg('recording.config.update_failed'),

  // -- notifications / push ---------------------------------------------
  NOTIFICATION_RECORD_NOT_FOUND: reg('notification.record.not_found'),
  NOTIFICATION_STATUS_INVALID: reg('notification.status.invalid'),
  NOTIFICATION_FETCH_FAILED: reg('notification.list.fetch_failed', 'error', true),
  PUSH_TOKEN_INVALID: reg('push.device_token.invalid'),
  PUSH_TOKEN_STORE_FAILED: reg('push.device_token.store_failed', 'error', true),
  PUSH_SUBSCRIPTION_REQUIRED: reg('push.subscription.required'),
  PUSH_SUBSCRIPTION_STORE_FAILED: reg('push.subscription.store_failed', 'error', true),
  PUSH_CONFIG_INVALID: reg('push.config.invalid', 'warning'),

  // -- pause reasons -----------------------------------------------------
  PAUSE_REASON_INVALID: reg('pause_reason.record.invalid'),
  PAUSE_REASON_UNDELETABLE: reg('pause_reason.record.undeletable'),

  // -- CRM ---------------------------------------------------------------
  CRM_SERVER_URL_INVALID: reg('crm.server_url.invalid'),
  CRM_CONFIG_SAVE_FAILED: reg('crm.config.save_failed', 'error', true),
  CRM_LOOKUP_UNAVAILABLE: reg('crm.lookup.unavailable', 'warning', true),
  CRM_LOOKUP_CONFIG_INVALID: reg('crm.lookup.config_invalid'),
  CRM_TIMEOUT_INVALID: reg('crm.timeout.invalid'),

  // -- settings / config -------------------------------------------------
  SETTINGS_READ_FAILED: reg('settings.record.read_failed', 'error', true),
  SETTINGS_SAVE_FAILED: reg('settings.record.save_failed', 'error', true),
  CONFIG_DOMAIN_MISSING: reg('config.domain.missing', 'critical'),
  CONFIG_QOS_FAILED: reg('config.qos.update_failed'),
  CONFIG_TLS_FAILED: reg('config.tls.update_failed'),
  CONFIG_MOBILE_WAKE_FAILED: reg('config.mobile_wake.update_failed'),
  CONFIG_CODECS_FAILED: reg('config.codecs.update_failed', 'error', true),

  // -- analytics / reporting --------------------------------------------
  ANALYTICS_QUERY_FAILED: reg('analytics.query.failed', 'error', true),
  ANALYTICS_EXPORT_UNAVAILABLE: reg('analytics.export.unavailable'),
  CALL_LOG_FETCH_FAILED: reg('call_log.list.fetch_failed', 'error', true),
  CALL_JOURNEY_FETCH_FAILED: reg('call_log.journey.fetch_failed', 'error', true),
  CALL_VAD_FETCH_FAILED: reg('call_log.vad.fetch_failed', 'error', true),

  // -- api keys ----------------------------------------------------------
  APIKEY_RECORD_NOT_FOUND: reg('api_key.record.not_found'),
  APIKEY_SCOPE_UNKNOWN: reg('api_key.scope.unknown'),

  // -- webhook deliveries -----------------------------------------------
  DELIVERY_RECORD_NOT_FOUND: reg('delivery.record.not_found'),

  // -- extension config (GET /api/extension-config, POST /api/extension-config/lookup) --
  EXTENSION_CONFIG_UNAVAILABLE: reg('extension_config.unavailable', 'warning', true),
  EXTENSION_CONFIG_USER_NOT_FOUND: reg('extension_config.user_not_found'),

  // -- catch-all ---------------------------------------------------------
  // Retryable: an unexpected server fault is usually transient, and the frontend showing
  // Retry is better than a dead end.
  INTERNAL_UNEXPECTED: reg('internal.server.unexpected', 'critical', true),
  UPSTREAM_UNAVAILABLE: reg('internal.upstream.unavailable', 'error', true),
} as const;

// ---------------------------------------------------------------------------
// Central code -> HTTP status mapping (ONE table)
// ---------------------------------------------------------------------------
// Matched most-specific-prefix-first, so a new code in a known domain gets a sane status
// without touching this table. A leading "." entry is a suffix test.
const STATUS_BY_PREFIX: [string, number][] = [
  ['auth.token.missing', 401],
  ['auth.token.', 401],
  ['auth.credentials.', 401],
  ['auth.api_key.scope_missing', 403],
  ['auth.api_key.', 401],
  ['access.', 403],
  ['request.route.not_found', 404],
  ['request.method.not_allowed', 405],
  ['request.', 400],
  ['.not_found', 404],
  ['.conflict', 409],
  ['telephony.ami.unavailable', 503],
  ['telephony.monitor.unavailable', 503],
  ['telephony.call.rejected', 502],
  ['telephony.dnd.update_failed', 502],
  ['crm.lookup.unavailable', 503],
  ['internal.upstream.unavailable', 502],
  ['internal.server.', 500],
];

const SUFFIX_STATUS: [string, number][] = [
  ['_not_found', 404],
  ['.not_found', 404],
  ['.conflict', 409],
  ['_failed', 500],
  ['.invalid', 400],
  ['.required', 400],
  ['.missing', 400],
  ['.unsupported', 400],
  ['.undeletable', 400],
  ['.unknown', 400],
  ['.unavailable', 503],
  ['.config_invalid', 400],
];

/** Map an error code to an HTTP status. The single source of truth (status_for). */
export function statusFor(code: string): number {
  for (const [prefix, status] of STATUS_BY_PREFIX) {
    if (code.startsWith(prefix) || (prefix.startsWith('.') && code.endsWith(prefix))) return status;
  }
  for (const [suffix, status] of SUFFIX_STATUS) {
    if (code.endsWith(suffix)) return status;
  }
  return 400;
}

/** Registered (severity, retryable) for a code; unregistered -> error / false (meta_for). */
export function metaFor(code: string): CodeMeta {
  return REGISTRY.get(code) ?? { severity: 'error', retryable: false };
}

export function registeredCodes(): string[] {
  return [...REGISTRY.keys()];
}

/**
 * An error carrying everything the envelope needs. Status, severity and retryability come
 * from `code` unless explicitly overridden, so a handler cannot report the same condition
 * two different ways. Throw it where a specific code matters more than legacy message text.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly severity: Severity;
  readonly retryable: boolean;
  readonly fields: ErrorField[];
  readonly details: Record<string, unknown>;
  readonly params: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  override readonly cause?: unknown;

  constructor(
    code: string,
    message: string,
    opts: {
      fields?: ErrorField[];
      severity?: Severity;
      retryable?: boolean;
      status?: number;
      details?: Record<string, unknown>;
      params?: Record<string, unknown>;
      headers?: Record<string, string>;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'AppError';
    const meta = metaFor(code);
    this.code = code;
    this.fields = opts.fields ?? [];
    this.severity = opts.severity ?? meta.severity;
    this.retryable = opts.retryable ?? meta.retryable;
    this.status = opts.status ?? statusFor(code);
    this.details = opts.details ?? {};
    this.params = opts.params ?? {};
    this.headers = opts.headers;
    this.cause = opts.cause;
  }
}

// ---------------------------------------------------------------------------
// Legacy HttpError -> code mapping
// ---------------------------------------------------------------------------
// The server translating its own message texts exactly once, at the boundary, so the wire
// contract is coded while each raise site keeps the Python's text. Ordered: first match wins,
// case-insensitive (re.I).
const LEGACY_PATTERNS: [RegExp, string][] = (
  [
    ['not authenticated', codes.AUTH_TOKEN_MISSING],
    ['invalid or expired token', codes.AUTH_TOKEN_INVALID],
    ['invalid or expired api key', codes.AUTH_APIKEY_INVALID],
    ['api key missing required scope', codes.AUTH_APIKEY_SCOPE_MISSING],
    ['^api key required$', codes.AUTH_APIKEY_REQUIRED],
    ['invalid extension/username or password', codes.AUTH_CREDENTIALS_INVALID],
    ['admin only', codes.ACCESS_ADMIN_REQUIRED],
    ['supervisor or admin required', codes.ACCESS_SUPERVISOR_REQUIRED],
    ['loopback only', codes.ACCESS_LOOPBACK_REQUIRED],
    ['^(access denied|forbidden)$', codes.ACCESS_ROLE_FORBIDDEN],
    ['not allowed to view this call', codes.ACCESS_CALL_FORBIDDEN],
    ['not allowed to|not permitted to', codes.ACCESS_EXTENSION_FORBIDDEN],
    ['ami not connected', codes.TELEPHONY_AMI_UNAVAILABLE],
    ['ami monitor not available', codes.TELEPHONY_MONITOR_UNAVAILABLE],
    ['asterisk rejected the call', codes.TELEPHONY_CALL_REJECTED],
    ['failed to transfer call', codes.TELEPHONY_TRANSFER_FAILED],
    ['failed to set dnd', codes.TELEPHONY_DND_FAILED],
    ['a valid not-ready reason is required', codes.TELEPHONY_PAUSE_REASON_REQUIRED],
    ['crm lookup module not available', codes.CRM_LOOKUP_UNAVAILABLE],
    ['invalid crm server url', codes.CRM_SERVER_URL_INVALID],
    ['failed to save crm configuration', codes.CRM_CONFIG_SAVE_FAILED],
    ['^lookup_', codes.CRM_LOOKUP_CONFIG_INVALID],
    ['timeout must be between', codes.CRM_TIMEOUT_INVALID],
    ['contact with this phone number already exists', codes.CONTACT_PHONE_CONFLICT],
    ['contact not found', codes.CONTACT_RECORD_NOT_FOUND],
    ['phone must contain digits|^phone is required', codes.CONTACT_PHONE_INVALID],
    ['user not found', codes.USER_RECORD_NOT_FOUND],
    ['failed to delete user', codes.USER_DELETE_FAILED],
    ['username or extension already in use', codes.USER_RECORD_CONFLICT],
    ['(your account has no extension|no extension associated)', codes.USER_EXTENSION_MISSING],
    ['extension not found in users', codes.TELEPHONY_EXTENSION_NOT_FOUND],
    ['no queues are assigned', codes.TELEPHONY_QUEUE_UNASSIGNED],
    ['group name may already exist', codes.GROUP_RECORD_CONFLICT],
    ['group not found', codes.GROUP_RECORD_NOT_FOUND],
    ['recording not found', codes.RECORDING_FILE_NOT_FOUND],
    ['unsupported recording format', codes.RECORDING_FORMAT_UNSUPPORTED],
    ['failed to (enable|disable) call recording', codes.RECORDING_TOGGLE_FAILED],
    ['failed to (enable|disable) qos', codes.CONFIG_QOS_FAILED],
    ['failed to (enable|disable) sip tls', codes.CONFIG_TLS_FAILED],
    ['failed to (enable|disable) mobile wake', codes.CONFIG_MOBILE_WAKE_FAILED],
    ['opdesk_domain is not configured', codes.CONFIG_DOMAIN_MISSING],
    ['notification not found', codes.NOTIFICATION_RECORD_NOT_FOUND],
    ['status_flag must be', codes.NOTIFICATION_STATUS_INVALID],
    ['failed to fetch call notifications', codes.NOTIFICATION_FETCH_FAILED],
    ['invalid token, platform, or token_type', codes.PUSH_TOKEN_INVALID],
    ['failed to register device token', codes.PUSH_TOKEN_STORE_FAILED],
    ['^subscription required', codes.PUSH_SUBSCRIPTION_REQUIRED],
    ['failed to store web push subscription', codes.PUSH_SUBSCRIPTION_STORE_FAILED],
    ['invalid or duplicate pause reason', codes.PAUSE_REASON_INVALID],
    ['cannot delete \\(not found or system reason\\)', codes.PAUSE_REASON_UNDELETABLE],
    ['api key not found', codes.APIKEY_RECORD_NOT_FOUND],
    ['unknown scope', codes.APIKEY_SCOPE_UNKNOWN],
    ['delivery not found', codes.DELIVERY_RECORD_NOT_FOUND],
    ['openpyxl not installed|export is unavailable', codes.ANALYTICS_EXPORT_UNAVAILABLE],
    ['failed to fetch call log', codes.CALL_LOG_FETCH_FAILED],
    ['failed to fetch call journey', codes.CALL_JOURNEY_FETCH_FAILED],
    ['failed to fetch vad data', codes.CALL_VAD_FETCH_FAILED],
    ['failed to get setting', codes.SETTINGS_READ_FAILED],
    ['failed to save settings', codes.SETTINGS_SAVE_FAILED],
    ['openapi spec not found|^not found$', codes.REQUEST_ROUTE_NOT_FOUND],
    ['method not allowed', codes.REQUEST_METHOD_NOT_ALLOWED],
    ['^internal server error$', codes.INTERNAL_UNEXPECTED],
  ] as [string, string][]
).map(([p, c]) => [new RegExp(p, 'i'), c]);

// Status -> code, when no message pattern matched. Anything else (e.g. 429) falls back to
// request.body.invalid, as the Python did.
const STATUS_FALLBACK: Record<number, string> = {
  400: codes.REQUEST_BODY_INVALID,
  401: codes.AUTH_TOKEN_INVALID,
  403: codes.ACCESS_ROLE_FORBIDDEN,
  404: codes.REQUEST_ROUTE_NOT_FOUND,
  405: codes.REQUEST_METHOD_NOT_ALLOWED,
  409: codes.REQUEST_BODY_INVALID,
  500: codes.INTERNAL_UNEXPECTED,
  502: codes.UPSTREAM_UNAVAILABLE,
  503: codes.TELEPHONY_AMI_UNAVAILABLE,
};

/** The code a legacy `HttpError(status, detail)` renders with (code_for_legacy). */
export function codeForLegacy(status: number, detail: string | null | undefined): string {
  const text = (detail || '').trim();
  for (const [rx, code] of LEGACY_PATTERNS) {
    if (rx.test(text)) return code;
  }
  return STATUS_FALLBACK[status] ?? codes.REQUEST_BODY_INVALID;
}

// Errors state what happened and what to do next; server-fault details stay in the log.
export const SAFE_MESSAGES: Record<string, string> = {
  [codes.INTERNAL_UNEXPECTED]: 'Something went wrong on our side. Try again, and quote the trace id if it persists.',
  [codes.UPSTREAM_UNAVAILABLE]: 'An upstream service did not respond. Try again shortly.',
};

/**
 * The message a legacy error ships (_public_message), with one deliberate change: a 500
 * never carries exception text. The Python raised `f"Failed to fetch call log: {e}"`; the
 * part after the first ": " is the exception and stays in the log, the prefix still tells
 * the user what failed.
 */
export function publicMessage(code: string, detail: string, status: number): string {
  if (code in SAFE_MESSAGES) return SAFE_MESSAGES[code];
  if (status >= 500 && !detail) return SAFE_MESSAGES[codes.INTERNAL_UNEXPECTED];
  if (status === 500) {
    const head = detail.split(': ')[0].trim();
    return head || SAFE_MESSAGES[codes.INTERNAL_UNEXPECTED];
  }
  return detail || SAFE_MESSAGES[codes.INTERNAL_UNEXPECTED];
}

/** The `{"error": {...}}` body every failure renders as. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    severity: Severity;
    retryable: boolean;
    trace_id: string;
    params: Record<string, unknown>;
    fields: ErrorField[];
    details: Record<string, unknown>;
  };
}

export function toEnvelope(err: AppError, traceId: string): ErrorEnvelope {
  return {
    error: {
      code: err.code,
      message: err.message,
      severity: err.severity,
      retryable: err.retryable,
      trace_id: traceId,
      params: err.params,
      fields: err.fields.map((f) => ({ path: f.path, code: f.code, message: f.message, params: f.params ?? {} })),
      details: err.details,
    },
  };
}
