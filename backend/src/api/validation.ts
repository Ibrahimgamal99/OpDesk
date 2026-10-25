/**
 * Request validation with Pydantic's semantics, rendered the way OpDesk's error middleware
 * rendered them.
 *
 * Bodies are zod schemas built from `v.*`, whose scalars coerce the way Pydantic v2's
 * lax mode did ("5" -> 5, "yes" -> true, 5.0 -> 5) and report Pydantic's error types
 * (`missing`, `int_parsing`, `string_type`, ...). Unknown fields are dropped, as a
 * Pydantic model ignored them. Query and path parameters use the qStr/qInt/pInt... helpers, which
 * follow FastAPI's rules (last value wins, `true/1/yes/on` for booleans).
 *
 * Every failure becomes RequestValidationError, which the renderer writes as OpDesk's
 * **400 request.body.invalid** (severity warning, "Some fields need attention.") with
 * `error.fields[]`: paths are the Pydantic `loc` minus its body/query/path prefix, joined as
 * `items[2].quantity` (`_` when empty), and codes are mapped (`missing` -> `value.required`,
 * `int_parsing` -> `value.not_an_integer`, other types -> `value.<type>`).
 *
 *     const NoteBody = v.model({ note_text: v.str().nullish(), template_id: v.int().nullish() });
 *     const body = parseBody(NoteBody, req.body);           // typed as z.output<typeof NoteBody>
 *     const limit = qInt(query, 'limit', 50);
 */

import { z } from 'zod';
import type { ErrorField } from './http-error';

export class RequestValidationError extends Error {
  constructor(readonly fields: ErrorField[]) {
    super(fields.map((f) => f.message).join('; ') || 'The request could not be validated.');
    this.name = 'RequestValidationError';
  }
}

type Ctx = z.core.$RefinementCtx;
type Issue = Parameters<Ctx['addIssue']>[0];

function fail(ctx: Ctx, type: string, message: string, params: Record<string, string | number | boolean> = {}): never {
  ctx.addIssue({ code: 'custom', message, params: { pyType: type, ...params } });
  return z.NEVER as never;
}

// ---------------------------------------------------------------------------
// Scalar coercions (shared by body schemas and the query helpers)
// ---------------------------------------------------------------------------

type Coerced<T> = { ok: true; value: T } | { ok: false; type: string; message: string };

function coerceStr(val: unknown): Coerced<string> {
  if (typeof val === 'string') return { ok: true, value: val };
  return { ok: false, type: 'string_type', message: 'Input should be a valid string' };
}

function coerceInt(val: unknown): Coerced<number> {
  if (typeof val === 'boolean') return { ok: true, value: val ? 1 : 0 };
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return { ok: false, type: 'finite_number', message: 'Input should be a finite number' };
    if (!Number.isInteger(val)) {
      return { ok: false, type: 'int_from_float', message: 'Input should be a valid integer, got a number with a fractional part' };
    }
    return { ok: true, value: val };
  }
  if (typeof val === 'string') {
    const s = val.trim().replace(/_/g, '');
    if (/^[+-]?\d+$/.test(s)) return { ok: true, value: parseInt(s, 10) };
    if (/^[+-]?\d+\.0*$/.test(s)) return { ok: true, value: parseInt(s, 10) };
    return { ok: false, type: 'int_parsing', message: 'Input should be a valid integer, unable to parse string as an integer' };
  }
  return { ok: false, type: 'int_type', message: 'Input should be a valid integer' };
}

function coerceFloat(val: unknown): Coerced<number> {
  if (typeof val === 'boolean') return { ok: true, value: val ? 1 : 0 };
  if (typeof val === 'number') return { ok: true, value: val };
  if (typeof val === 'string') {
    const s = val.trim();
    if (s !== '' && /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return { ok: true, value: Number(s) };
    return { ok: false, type: 'float_parsing', message: 'Input should be a valid number, unable to parse string as a number' };
  }
  return { ok: false, type: 'float_type', message: 'Input should be a valid number' };
}

const TRUE_STRINGS = ['1', 'on', 't', 'true', 'y', 'yes'];
const FALSE_STRINGS = ['0', 'off', 'f', 'false', 'n', 'no'];

function coerceBool(val: unknown): Coerced<boolean> {
  if (typeof val === 'boolean') return { ok: true, value: val };
  if (val === 0 || val === 1) return { ok: true, value: val === 1 };
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (TRUE_STRINGS.includes(s)) return { ok: true, value: true };
    if (FALSE_STRINGS.includes(s)) return { ok: true, value: false };
    return { ok: false, type: 'bool_parsing', message: 'Input should be a valid boolean, unable to interpret input' };
  }
  if (typeof val === 'number') return { ok: false, type: 'bool_parsing', message: 'Input should be a valid boolean, unable to interpret input' };
  return { ok: false, type: 'bool_type', message: 'Input should be a valid boolean' };
}

function scalar<T>(coerce: (val: unknown) => Coerced<T>) {
  return z.unknown().transform((val, ctx): T => {
    if (val === undefined) return fail(ctx, 'missing', 'Field required');
    const r = coerce(val);
    if (!r.ok) return fail(ctx, r.type, r.message);
    return r.value;
  });
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val) && !(val instanceof Date);
}

// ---------------------------------------------------------------------------
// v: Pydantic field types
// ---------------------------------------------------------------------------

/** An open JSON object (a `dict` field), named so "open here" is a visible decision. */
export type JsonObject = Record<string, unknown>;

/** A Pydantic model: unknown keys are ignored, a non-object is model_attributes_type. */
const model = <S extends z.ZodRawShape>(shape: S) => {
    const obj = z.object(shape);
    return z.unknown().transform((val, ctx): z.output<typeof obj> => {
      if (val === undefined) return fail(ctx, 'missing', 'Field required');
      if (!isPlainObject(val)) {
        return fail(ctx, 'model_attributes_type', 'Input should be a valid dictionary or object to extract fields from');
      }
      const r = obj.safeParse(val);
      if (r.success) return r.data;
      for (const iss of r.error.issues) ctx.addIssue(iss as Issue);
      return z.NEVER as never;
    });
  };

export const v = {
  /** str */
  str: () => scalar(coerceStr),
  /** int (lax: "5", 5.0, true) */
  int: () => scalar(coerceInt),
  /** float */
  float: () => scalar(coerceFloat),
  /** bool (lax: 1/0, "yes"/"no", "on"/"off", "t"/"f") */
  bool: () => scalar(coerceBool),
  /** Any (required unless wrapped in .optional()/.nullish()) */
  any: () =>
    z.unknown().transform((val, ctx) => {
      if (val === undefined) return fail(ctx, 'missing', 'Field required');
      return val;
    }),
  /** list / List[T] */
  list: <T extends z.ZodType = z.ZodUnknown>(item?: T) =>
    z.unknown().transform((val, ctx): z.output<T>[] => {
      if (val === undefined) return fail(ctx, 'missing', 'Field required');
      if (!Array.isArray(val)) return fail(ctx, 'list_type', 'Input should be a valid list');
      if (!item) return val as z.output<T>[];
      const out: z.output<T>[] = [];
      val.forEach((el, i) => {
        const r = item.safeParse(el);
        if (r.success) out.push(r.data);
        else for (const iss of r.error.issues) ctx.addIssue({ ...iss, path: [i, ...iss.path] } as Issue);
      });
      return out;
    }),
  /** an open dict field */
  dict: () =>
    z.unknown().transform((val, ctx): JsonObject => {
      if (val === undefined) return fail(ctx, 'missing', 'Field required');
      if (!isPlainObject(val)) return fail(ctx, 'dict_type', 'Input should be a valid dictionary');
      return val;
    }),
  /** Literal['a', 'b'] */
  literal: <const T extends readonly (string | number | boolean)[]>(...values: T) =>
    z.unknown().transform((val, ctx): T[number] => {
      if (val === undefined) return fail(ctx, 'missing', 'Field required');
      if (!values.includes(val as T[number])) {
        const expected = values.map((x) => (typeof x === 'string' ? `'${x}'` : String(x)));
        const text = expected.length > 1 ? `${expected.slice(0, -1).join(', ')} or ${expected[expected.length - 1]}` : expected[0];
        return fail(ctx, 'literal_error', `Input should be ${text}`, { expected: text });
      }
      return val as T[number];
    }),
  /** A Pydantic model with model_config extra="forbid": each unknown key is an extra_forbidden error. */
  strictModel: <S extends z.ZodRawShape>(shape: S) => {
    const inner = model(shape);
    return z.unknown().transform((val, ctx): z.output<typeof inner> => {
      const r = inner.safeParse(val);
      if (!r.success) for (const iss of r.error.issues) ctx.addIssue(iss as Issue);
      if (isPlainObject(val)) {
        for (const key of Object.keys(val)) {
          if (!(key in shape)) {
            ctx.addIssue({ code: 'custom', path: [key], message: 'Extra inputs are not permitted', params: { pyType: 'extra_forbidden' } });
          }
        }
      }
      return r.success ? r.data : (z.NEVER as never);
    });
  },
  /** Field(max_length=n) on a str: counts code points, as Python's len() does. */
  maxLen: <S extends z.ZodType<string | null | undefined>>(schema: S, n: number) =>
    schema.superRefine((s, ctx) => {
      if (typeof s === 'string' && [...s].length > n) {
        ctx.addIssue({
          code: 'custom',
          message: `String should have at most ${n} character${n === 1 ? '' : 's'}`,
          params: { pyType: 'string_too_long', max_length: n },
        });
      }
    }),
  /** A Pydantic model: unknown keys are ignored, a non-object is model_attributes_type. */
  model,
};

// ---------------------------------------------------------------------------
// Parsing entry points
// ---------------------------------------------------------------------------

// Pydantic error type -> OpDesk field code (_PYDANTIC_CODE_MAP); anything else is value.<type>.
const PYDANTIC_CODE_MAP: Record<string, string> = {
  missing: 'value.required',
  string_too_short: 'value.too_short',
  string_too_long: 'value.too_long',
  greater_than: 'value.below_min',
  greater_than_equal: 'value.below_min',
  less_than: 'value.above_max',
  less_than_equal: 'value.above_max',
  int_parsing: 'value.not_an_integer',
  float_parsing: 'value.not_a_number',
  bool_parsing: 'value.not_a_boolean',
  value_error: 'value.invalid',
  enum: 'value.not_allowed',
};

/** A Pydantic error type as OpDesk's `fields[].code`. */
export function fieldCode(pyType: string): string {
  if (pyType.startsWith('value.')) return pyType;
  return PYDANTIC_CODE_MAP[pyType] ?? `value.${pyType}`;
}

/** Pydantic `loc` (without body/query/path) -> `items[2].quantity`, `_` when empty (_loc_to_path). */
export function locToPath(loc: readonly PropertyKey[]): string {
  let out = '';
  for (const p of loc) {
    if (typeof p === 'number') out += `[${p}]`;
    else out = out ? `${out}.${String(p)}` : String(p);
  }
  return out || '_';
}

function toFields(error: z.ZodError, prefix: (string | number)[]): ErrorField[] {
  return error.issues.map((iss) => {
    const params = (iss as { params?: Record<string, unknown> }).params || {};
    const { pyType, ...rest } = params;
    const clean: Record<string, string | number | boolean> = {};
    for (const [k, val] of Object.entries(rest)) {
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') clean[k] = val;
    }
    const type = typeof pyType === 'string' ? pyType : iss.code === 'invalid_type' ? 'value_error' : iss.code;
    return {
      path: locToPath([...prefix, ...(iss.path as PropertyKey[])]),
      code: fieldCode(type),
      message: iss.message,
      params: clean,
    };
  });
}

/** Validate a JSON body against a v.model(...) schema, or throw the 400. */
export function parseBody<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  throw new RequestValidationError(toFields(r.error, []));
}

/** model_dump(exclude_none=True): the fields the client actually sent with a value. */
export function modelDict<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, val] of Object.entries(obj)) {
    if (val !== null && val !== undefined) (out as Record<string, unknown>)[k] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Query and path parameters (FastAPI's rules)
// ---------------------------------------------------------------------------

/** Express's parsed query string. */
export type QueryParams = Record<string, unknown>;

/** Marks a parameter as required (FastAPI: no default). */
export const REQUIRED: unique symbol = Symbol('required');
type Fallback<T> = T | typeof REQUIRED;

function lastValue(raw: unknown): unknown {
  return Array.isArray(raw) ? raw[raw.length - 1] : raw;
}

function param<T, D>(_where: 'query' | 'path', name: string, raw: unknown, fallback: Fallback<D>, coerce: (val: unknown) => Coerced<T>): T | D {
  const val = lastValue(raw);
  if (val === undefined) {
    if (fallback === REQUIRED) {
      throw new RequestValidationError([{ path: name, code: fieldCode('missing'), message: 'Field required', params: {} }]);
    }
    return fallback;
  }
  const r = coerce(val);
  // OpDesk paths drop the query./path. prefix (the loc's first element), like body fields.
  if (!r.ok) throw new RequestValidationError([{ path: name, code: fieldCode(r.type), message: r.message, params: {} }]);
  return r.value;
}

/** `name: str = fallback` */
export function qStr<D = string>(q: QueryParams, name: string, fallback: Fallback<D>): string | D {
  return param('query', name, q[name], fallback, coerceStr);
}

/** `name: int = fallback` */
export function qInt<D = number>(q: QueryParams, name: string, fallback: Fallback<D>): number | D {
  return param('query', name, q[name], fallback, coerceInt);
}

/** `name: float = fallback` */
export function qFloat<D = number>(q: QueryParams, name: string, fallback: Fallback<D>): number | D {
  return param('query', name, q[name], fallback, coerceFloat);
}

/** `name: bool = fallback` */
export function qBool<D = boolean>(q: QueryParams, name: string, fallback: Fallback<D>): boolean | D {
  return param('query', name, q[name], fallback, coerceBool);
}

/** `name: List[str] = Query(None)`: every repeated value, or the fallback when absent. */
export function qList<D = string[]>(q: QueryParams, name: string, fallback: D): string[] | D {
  const raw = q[name];
  if (raw === undefined) return fallback;
  return (Array.isArray(raw) ? raw : [raw]).map(String);
}

/** A typed path parameter (`{camp_id}` declared `camp_id: int`). */
export function pInt(value: unknown, name: string): number {
  return param('path', name, value, REQUIRED, coerceInt) as number;
}

/** A str path parameter (always present when the route matched). */
export function pStr(value: unknown): string {
  return String(lastValue(value) ?? '');
}
