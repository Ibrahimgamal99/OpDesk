/** Envelopes, the error renderer, legacy code mapping, the /api 404/405 fallback and trace ids. */

import request from 'supertest';
import { Controller, INestApplication, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AppError, codeForLegacy, codes, metaFor, publicMessage, statusFor } from '../src/api/errors';
import { HttpError } from '../src/api/http-error';
import {
  csvResponse,
  csvText,
  decodePageCursor,
  encodePageCursor,
  parsePage,
  respond,
  respondList,
  RawResponse,
  spreadsheetSafe,
  toJsonable,
} from '../src/api/respond';
import { Auth, Get, Post } from '../src/api/routing';
import { SpaController } from '../src/api/routes/spa.controller';
import { parseBody, qInt, v } from '../src/api/validation';
import type { QueryParams } from '../src/api/validation';
import { nestApp } from './helpers/nest-app';

const Body = v.model({ name: v.str(), items: v.list(v.model({ qty: v.int() })).optional() });

@Controller()
class ProbeController {
  @Get('/api/probe/bare')
  @Auth('public')
  bare() {
    return { a: 1, when: new Date(2026, 9, 25, 14, 3, 11), missing: undefined };
  }

  @Get('/api/probe/enveloped')
  @Auth('public')
  enveloped() {
    return respond({ message: 'ok' });
  }

  @Get('/api/probe/list')
  @Auth('public')
  list() {
    return respondList([1, 2], { limit: 2, nextCursor: encodePageCursor({ id: 9 }) });
  }

  @Post('/api/probe/body')
  @Auth('public')
  body(@Req() req: Request) {
    return parseBody(Body, req.body);
  }

  @Get('/api/probe/query')
  @Auth('public')
  query(@Req() req: Request) {
    return { n: qInt(req.query as QueryParams, 'n', 1) };
  }

  @Get('/api/probe/legacy')
  @Auth('public')
  legacy() {
    throw new HttpError(403, 'Admin only');
  }

  @Get('/api/probe/limited')
  @Auth('public')
  limited() {
    throw new HttpError(429, 'Too many failed login attempts. Try again in 42s.', { 'Retry-After': '42' });
  }

  @Get('/api/probe/leak')
  @Auth('public')
  leak() {
    throw new HttpError(500, 'Failed to fetch call log: ER_ACCESS_DENIED for user root@10.0.0.5');
  }

  @Get('/api/probe/crash')
  @Auth('public')
  crash() {
    throw new Error('connect ECONNREFUSED 10.0.0.5:3306 password=hunter2');
  }

  @Get('/api/probe/coded')
  @Auth('public')
  coded() {
    throw new HttpError(409, { code: 'user.record.conflict', message: 'Username or extension already in use' });
  }

  @Get('/api/probe/cursor')
  @Auth('public')
  cursor(@Req() req: Request) {
    return decodePageCursor(String(req.query.cursor ?? ''));
  }

  @Get('/api/probe/user')
  @Auth('user')
  user() {
    return { never: true };
  }

  @Post('/api/probe/only-post')
  @Auth('public')
  onlyPost() {
    return { ok: true };
  }

  @Get('/api/probe/csv')
  @Auth('public')
  csv(): RawResponse {
    return csvResponse('calls', ['a', 'b'], [[1, 'x"y']]);
  }
}

describe('error registry and legacy mapping', () => {
  it('maps the Python message texts onto codes, first match wins', () => {
    expect(codeForLegacy(401, 'Not authenticated')).toBe('auth.token.missing');
    expect(codeForLegacy(401, 'Invalid or expired token')).toBe('auth.token.invalid');
    expect(codeForLegacy(403, 'API key missing required scope: cdr:read')).toBe('auth.api_key.scope_missing');
    expect(codeForLegacy(401, 'Invalid extension/username or password')).toBe('auth.credentials.invalid');
    expect(codeForLegacy(403, 'Admin only')).toBe('access.role.admin_required');
    expect(codeForLegacy(403, 'Forbidden')).toBe('access.role.forbidden');
    expect(codeForLegacy(403, 'Not permitted to originate calls from this extension')).toBe('access.extension.forbidden');
    expect(codeForLegacy(403, 'Not allowed to view this call')).toBe('access.call.forbidden');
    // The click-to-call pattern collision the Python had is kept.
    expect(codeForLegacy(400, 'timeout must be between 5 and 120 seconds')).toBe('crm.timeout.invalid');
    expect(codeForLegacy(400, 'lookup_url is required')).toBe('crm.lookup.config_invalid');
    expect(codeForLegacy(409, 'Username or extension already in use')).toBe('user.record.conflict');
    expect(codeForLegacy(404, 'Not Found')).toBe('request.route.not_found');
  });

  it('falls back by status, and 429 lands on request.body.invalid as in the Python', () => {
    expect(codeForLegacy(400, 'Login and password required')).toBe('request.body.invalid');
    expect(codeForLegacy(401, 'nope')).toBe('auth.token.invalid');
    expect(codeForLegacy(503, 'CRM connector is not configured')).toBe('telephony.ami.unavailable');
    expect(codeForLegacy(429, 'Too many failed login attempts. Try again in 5s.')).toBe('request.body.invalid');
    expect(codeForLegacy(418, '')).toBe('request.body.invalid');
  });

  it('derives status and meta from the code', () => {
    expect(statusFor('auth.api_key.scope_missing')).toBe(403);
    expect(statusFor('auth.api_key.invalid')).toBe(401);
    expect(statusFor('contact.record.not_found')).toBe(404);
    expect(statusFor('group.record.conflict')).toBe(409);
    expect(statusFor('telephony.transfer.failed')).toBe(400); // the "request."-less 400 quirk
    expect(statusFor('crm.lookup.unavailable')).toBe(503);
    expect(statusFor('extension_config.user_not_found')).toBe(404);
    expect(metaFor('telephony.ami.unavailable')).toEqual({ severity: 'critical', retryable: true });
    expect(metaFor('no.such.code')).toEqual({ severity: 'error', retryable: false });
    expect(new AppError(codes.CRM_LOOKUP_UNAVAILABLE, 'x').status).toBe(503);
  });

  it('never ships exception text on a 500', () => {
    expect(publicMessage('call_log.list.fetch_failed', 'Failed to fetch call log: boom', 500)).toBe('Failed to fetch call log');
    expect(publicMessage('internal.server.unexpected', 'anything', 500)).toMatch(/^Something went wrong on our side/);
    expect(publicMessage('telephony.call.rejected', 'Asterisk rejected the call: busy', 502)).toBe('Asterisk rejected the call: busy');
  });
});

describe('envelopes and encoding', () => {
  it('respond / respondList shapes', () => {
    expect(respond(null)).toEqual({ data: null });
    expect(respondList(['a'], { limit: 10, cursor: null, nextCursor: 'n' })).toEqual({
      data: ['a'],
      page: { cursor: null, next_cursor: 'n', limit: 10 },
    });
    expect(respondList([], { limit: 1, total: 7 }).page.total).toBe(7);
  });

  it('cursor is base64url compact sorted-key JSON', () => {
    expect(encodePageCursor({ id: 123 })).toBe('eyJpZCI6MTIzfQ');
    expect(decodePageCursor('eyJpZCI6MTIzfQ')).toEqual({ id: 123 });
    expect(() => decodePageCursor('!!!')).toThrow(AppError);
    expect(parsePage(null, 5000).limit).toBe(200);
    expect(parsePage(null, 0).limit).toBe(1);
    expect(parsePage().limit).toBe(50);
  });

  it('toJsonable writes naive ISO datetimes and keeps undefined keys as null', () => {
    expect(toJsonable({ d: new Date(2026, 0, 2, 3, 4, 5), u: undefined })).toEqual({ d: '2026-01-02T03:04:05', u: null });
  });

  it('csv: BOM, every cell quoted, CRLF', () => {
    expect(csvText(['a', 'b'], [[1, null], [true, 'q"']])).toBe('﻿"a","b"\r\n"1",""\r\n"True","q"""\r\n');
  });

  it('a text cell a spreadsheet would run as a formula is written as text', () => {
    for (const s of ['=1+1', '+cmd|x', '-2+3+cmd|x', '@SUM(A1)', '\tx', '\rx', '+1-1']) expect(spreadsheetSafe(s)).toBe(`'${s}`);
    for (const s of ['+201012345678', '-15', '3.5', '-0.25', 'Mona', '', '0101']) expect(spreadsheetSafe(s)).toBe(s);
    expect(csvText(['h'], [['=HYPERLINK("x")'], [-5]], { bom: false })).toBe('"h"\r\n"\'=HYPERLINK(""x"")"\r\n"-5"\r\n');
  });
});

describe('HTTP rendering', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await nestApp([ProbeController, SpaController]);
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
  });

  it('success bodies are bare unless the handler enveloped them, with X-Trace-Id', async () => {
    const r = await request(http).get('/api/probe/bare').expect(200);
    expect(r.body).toEqual({ a: 1, when: '2026-10-25T14:03:11', missing: null });
    expect(r.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
    expect((await request(http).get('/api/probe/enveloped')).body).toEqual({ data: { message: 'ok' } });
    expect((await request(http).get('/api/probe/list')).body.page).toEqual({ cursor: null, next_cursor: 'eyJpZCI6OX0', limit: 2 });
  });

  it('honours a well-formed inbound trace id and repeats it in errors', async () => {
    const r = await request(http).get('/api/probe/legacy').set('X-Trace-Id', 'abc-12345.xyz').expect(403);
    expect(r.headers['x-trace-id']).toBe('abc-12345.xyz');
    expect(r.body).toEqual({
      error: {
        code: 'access.role.admin_required',
        message: 'Admin only',
        severity: 'error',
        retryable: false,
        trace_id: 'abc-12345.xyz',
        params: {},
        fields: [],
        details: {},
      },
    });
    const bad = await request(http).get('/api/probe/legacy').set('X-Trace-Id', 'no spaces allowed');
    expect(bad.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('keeps Retry-After on a 429', async () => {
    const r = await request(http).get('/api/probe/limited').expect(429);
    expect(r.headers['retry-after']).toBe('42');
    expect(r.body.error.code).toBe('request.body.invalid');
  });

  it('a 500 keeps the real trace id and never the exception text', async () => {
    const r = await request(http).get('/api/probe/leak').expect(500);
    expect(r.body.error.code).toBe('call_log.list.fetch_failed');
    expect(r.body.error.message).toBe('Failed to fetch call log');
    expect(r.body.error.retryable).toBe(true);
    const c = await request(http).get('/api/probe/crash').expect(500);
    expect(c.body.error.code).toBe('internal.server.unexpected');
    expect(c.body.error.severity).toBe('critical');
    expect(JSON.stringify(c.body)).not.toMatch(/hunter2|ECONNREFUSED/);
    expect(c.body.error.trace_id).toBe(c.headers['x-trace-id']);
    expect(c.body.error.trace_id).not.toBe('-');
  });

  it('an explicit code wins over the message table', async () => {
    const r = await request(http).get('/api/probe/coded').expect(409);
    expect(r.body.error.code).toBe('user.record.conflict');
  });

  it('a malformed cursor is a coded 400 with details.reason', async () => {
    const r = await request(http).get('/api/probe/cursor?cursor=%25%25').expect(400);
    expect(r.body.error.code).toBe('request.cursor.invalid');
    expect(r.body.error.details.reason).toBeTruthy();
  });

  it('validation errors are 400 request.body.invalid with OpDesk field paths and codes', async () => {
    const r = await request(http).post('/api/probe/body').send({ items: [{ qty: 1 }, { qty: 'x' }] }).expect(400);
    expect(r.body.error.code).toBe('request.body.invalid');
    expect(r.body.error.severity).toBe('warning');
    expect(r.body.error.message).toBe('Some fields need attention.');
    expect(r.body.error.fields).toEqual([
      { path: 'name', code: 'value.required', message: 'Field required', params: {} },
      { path: 'items[1].qty', code: 'value.not_an_integer', message: 'Input should be a valid integer, unable to parse string as an integer', params: {} },
    ]);
    const missing = await request(http).post('/api/probe/body').expect(400);
    expect(missing.body.error.fields).toEqual([{ path: '_', code: 'value.required', message: 'Field required', params: {} }]);
    const q = await request(http).get('/api/probe/query?n=abc').expect(400);
    expect(q.body.error.fields[0].path).toBe('n');
    expect(q.body.error.fields[0].code).toBe('value.not_an_integer');
  });

  it('malformed JSON reports where json.loads stopped', async () => {
    const r = await request(http).post('/api/probe/body').set('Content-Type', 'application/json').send('{bad').expect(400);
    expect(r.body.error.fields).toEqual([
      { path: '[1]', code: 'value.json_invalid', message: 'JSON decode error', params: { error: 'Expecting property name enclosed in double quotes' } },
    ]);
  });

  it('a user route without a token is 401 auth.token.missing', async () => {
    const r = await request(http).get('/api/probe/user').expect(401);
    expect(r.body.error.code).toBe('auth.token.missing');
    expect(r.body.error.message).toBe('Not authenticated');
  });

  it('unknown /api paths are JSON 404s, known paths with another method 405 + Allow', async () => {
    const nf = await request(http).get('/api/typo').expect(404);
    expect(nf.body.error.code).toBe('request.route.not_found');
    expect(nf.headers['content-type']).toMatch(/application\/json/);
    const post404 = await request(http).post('/api/typo').expect(404);
    expect(post404.body.error.message).toBe('Not Found');
    const m = await request(http).get('/api/probe/only-post').expect(405);
    expect(m.headers.allow).toBe('POST');
    expect(m.body.error.code).toBe('request.method.not_allowed');
    const d = await request(http).delete('/api/probe/bare').expect(405);
    expect(d.headers.allow).toBe('GET');
    expect(d.headers['x-trace-id']).toBeTruthy();
  });

  it('csvResponse is an attachment', async () => {
    const r = await request(http).get('/api/probe/csv').expect(200);
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(r.headers['content-disposition']).toBe('attachment; filename="calls.csv"');
    expect(r.text).toBe('﻿"a","b"\r\n"1","x""y"\r\n');
  });
});
