/**
 * The one exception a handler or service throws to produce an HTTP error -- the port
 * of FastAPI's HTTPException. The renderer (api/respond.ts) writes it as
 * `{"error": {code, message, severity, retryable, trace_id, params, fields, details}}`.
 *
 * `detail` is a plain message (the common case: the code is derived from the text through
 * api/errors.ts, exactly as the Python middleware did) or an object carrying
 * `code`/`message`/`fields`, which is how a handler opts into a specific machine code:
 *
 *     throw new HttpError(409, { code: 'user.record.conflict', message: 'Username or extension already in use' });
 */

export interface ErrorField {
  path: string;
  code: string;
  message: string;
  params?: Record<string, string | number | boolean>;
}

export interface ErrorDetail {
  code?: string;
  message?: string;
  /** FastAPI handlers sometimes nested the text under `detail`. */
  detail?: string;
  fields?: ErrorField[];
  /** error.details / error.params of the envelope. */
  details?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

export class HttpError extends Error {
  readonly status: number;
  readonly detail: string | ErrorDetail | null;
  readonly headers?: Record<string, string>;

  constructor(status: number, detail: string | ErrorDetail | null = null, headers?: Record<string, string>) {
    super(typeof detail === 'string' ? detail : detail?.message || detail?.detail || `HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}

/** Default reason phrases, used when a handler raised with no detail (FastAPI did the same). */
export const STATUS_PHRASES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  413: 'Request Entity Too Large',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};
