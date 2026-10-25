/**
 * core/system-logs and the logs routes: the AMI event buffer (off by default, summary, filters,
 * capacity), the SIP tracer tailing a temp file (block reassembly, rotation-safe start
 * failure), the client-log beacon (always 204), the System Logs toggles, the audit log, and
 * the CRM delivery log (keyset cursor, status counts and facets, detail, retry, resend).
 *
 * No database, no Asterisk: the db layer, the dialplan's PJSIP logger toggle and the CRM push
 * are mocked; the tracer reads a file this spec writes.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const runtimeMock = { crmConnector: null as unknown, monitor: null as unknown, preWoken: new Map() };

jest.mock(
  '../src/db/db-manager',
  () => ({
    getSetting: jest.fn(async (_k: string, fallback: string | null = null) => fallback),
    WEBHOOK_DELIVERY_STATUSES: ['pending', 'delivered', 'failed', 'abandoned'],
    listWebhookDeliveries: jest.fn(),
    getWebhookDelivery: jest.fn(),
    webhookDeliveryCounts: jest.fn(async () => ({ pending: 1, delivered: 5, failed: 2, abandoned: 0 })),
    webhookDeliveryFacets: jest.fn(async () => ({ status: { failed: 2 }, call_type: { inbound: 2 } })),
    requeueWebhookDelivery: jest.fn(),
    listAuditLog: jest.fn(async () => ({ entries: [{ id: 9, action: 'update' }], next_before_id: 9 })),
    auditLogFacets: jest.fn(async () => ({ action: { update: 1 }, entity_type: { settings: 1 } })),
  }));
jest.mock('../src/core/runtime', () => ({ runtime: runtimeMock }));
jest.mock('../src/core/security', () => ({ principalOf: (req: { principal?: unknown }) => req.principal ?? null }));
jest.mock('../src/services/dialplan', () => ({ setPjsipLogger: jest.fn(async () => true) }));
jest.mock('../src/integrations/crm', () => ({
  loadCrmSyncConfig: jest.fn(async () => ({ method: 'PUT', endpoint: '/sync' })),
}));
jest.mock('../src/integrations/crm-delivery', () => ({
  sendCrmDataAsync: jest.fn(async () => ({ success: true })),
  sweepCrmDeliveries: jest.fn(async () => 1),
}));

import * as dbm from '../src/db/db-manager';
import { AMIEventBuffer, amiEventBuffer, SipTracer, sipTracer } from '../src/core/system-logs';
import { setPjsipLogger } from '../src/services/dialplan';
import { sendCrmDataAsync, sweepCrmDeliveries } from '../src/integrations/crm-delivery';
import { clientLog, LogsController } from '../src/api/routes/logs.controller';
import { RawResponse } from '../src/api/respond';

const mocked = (fn: unknown) => fn as jest.Mock;
const ADMIN = { id: 1, username: 'admin', role: 'admin', extension: null };

describe('AMIEventBuffer', () => {
  test('off by default; summary skips plumbing; filters; capacity', () => {
    const b = new AMIEventBuffer(3);
    b.add({ Event: 'Newchannel', Channel: 'PJSIP/100-1' });
    expect(b.snapshot()).toEqual([]);
    b.enabled = true;
    b.add({ Event: 'Newchannel', Privilege: 'call,all', Channel: 'PJSIP/100-1', Empty: '' });
    b.add({ Channel: 'no event name' });
    b.add({ Event: 'Hangup', Channel: 'PJSIP/101-2', Cause: '16' });
    const rows = b.snapshot();
    expect(rows.map((r) => [r.seq, r.event, r.summary])).toEqual([
      [1, 'Newchannel', 'Channel=PJSIP/100-1'],
      [2, 'Hangup', 'Channel=PJSIP/101-2 Cause=16'],
    ]);
    expect(rows[0].fields).toEqual({ Privilege: 'call,all', Channel: 'PJSIP/100-1', Empty: '' });
    expect(b.snapshot({ since: 1 }).map((r) => r.seq)).toEqual([2]);
    expect(b.snapshot({ event: 'hang' }).map((r) => r.seq)).toEqual([2]);
    expect(b.snapshot({ q: '100-1' }).map((r) => r.seq)).toEqual([1]);
    b.addSip('INVITE', 'raw');
    b.add({ Event: 'Newstate' });
    expect(b.snapshot().map((r) => r.seq)).toEqual([2, 3, 4]);
    expect(b.eventNames()).toEqual(['Hangup', 'Newstate', 'SIP']);
    expect(b.snapshot({ limit: 1 }).map((r) => r.seq)).toEqual([4]);
  });
});

describe('SipTracer', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opdesk-siptrace-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('an unreadable log is reported, not raised', async () => {
    const t = new SipTracer(new AMIEventBuffer(), path.join(dir, 'missing'));
    expect(await t.start()).toBe(false);
    expect(t.enabled).toBe(false);
    expect(t.lastError).toBe(`Cannot read ${path.join(dir, 'missing')}: No such file or directory`);
  });

  test('tails appended SIP blocks into SIP entries (old content is skipped)', async () => {
    const file = path.join(dir, 'full');
    await fs.writeFile(file, '[old] <--- Received SIP request (1 bytes) from UDP:1.1.1.1:5060 --->\nOLD\n<------------->\n');
    const buf = new AMIEventBuffer();
    const t = new SipTracer(buf, file);
    expect(await t.start()).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    await fs.appendFile(
      file,
      '[2026-10-25 10:00:00] VERBOSE[1] res_pjsip_logger.c: <--- Transmitting SIP request (500 bytes) to UDP:10.0.0.5:5060 --->\n' +
        'INVITE sip:100@10.0.0.5 SIP/2.0\r\n' +
        'Via: SIP/2.0/UDP 10.0.0.1\n' +
        '<------------>\n' +
        'unrelated line\n',
    );
    const until = Date.now() + 3000;
    while (!buf.buf.length && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    t.stop();
    expect(buf.buf).toHaveLength(1);
    expect(buf.buf[0]).toMatchObject({
      event: 'SIP',
      summary: 'Transmitting SIP request (500 bytes) to UDP:10.0.0.5:5060',
    });
    expect(String(buf.buf[0].fields.Message).split('\n')).toEqual([
      '[2026-10-25 10:00:00] VERBOSE[1] res_pjsip_logger.c: <--- Transmitting SIP request (500 bytes) to UDP:10.0.0.5:5060 --->',
      'INVITE sip:100@10.0.0.5 SIP/2.0',
      'Via: SIP/2.0/UDP 10.0.0.1',
    ]);
    await t.loop;
  });
});

describe('logs routes', () => {
  const ctl = new LogsController();
  const req = (over: Record<string, unknown> = {}) =>
    ({ params: {}, query: {}, body: undefined, principal: ADMIN, complete: true, readable: false, ...over }) as never;

  beforeEach(() => {
    jest.clearAllMocks();
    amiEventBuffer.enabled = false;
    runtimeMock.crmConnector = null;
    runtimeMock.monitor = null;
  });

  test('client-log: logs the entries and always answers 204', async () => {
    const spy = jest.spyOn(clientLog, 'info').mockImplementation(() => undefined);
    const res = (await ctl.clientLogEndpoint(
      req({
        body: {
          session: 'abc',
          entries: [
            { tag: 'sip', msg: 'registered', data: { ok: true } },
            { tag: 't', msg: 'm', data: {} },
            'not an entry',
          ],
        },
      }),
    )) as RawResponse;
    expect(res.init.status).toBe(204);
    expect(res.body).toBe('');
    expect(spy.mock.calls).toEqual([
      ['CLIENT[%s] %s: %s%s', 'abc', 'sip', 'registered', ' | {"ok": true}'],
      ['CLIENT[%s] %s: %s%s', 'abc', 't', 'm', ''],
    ]);
    spy.mockRestore();
  });

  test('client-log: an unparsed text/plain body that is not JSON is still a 204', async () => {
    const { Readable } = await import('stream');
    const stream = Readable.from([Buffer.from('not json')]) as unknown as Record<string, unknown>;
    Object.assign(stream, { body: undefined, complete: false, principal: null });
    const res = (await ctl.clientLogEndpoint(stream as never)) as RawResponse;
    expect(res.init.status).toBe(204);
  });

  test('GET /api/logs and the AMI toggle are bare', async () => {
    expect(await ctl.apiGetAmiLogging()).toEqual({ enabled: false });
    expect(await ctl.apiSetAmiLogging(req({ body: { enabled: true } }))).toEqual({ enabled: true });
    amiEventBuffer.add({ Event: 'PeerStatus', Peer: 'PJSIP/100' });
    const lines = (await ctl.apiLogs(req({ query: { since: '0', event: 'peer' } }))) as { lines: Array<{ event: string }> };
    expect(lines.lines.map((l) => l.event)).toEqual(['PeerStatus']);
    expect(await ctl.apiLogEventNames()).toEqual({ events: expect.arrayContaining(['PeerStatus']) });
    await expect(ctl.apiSetAmiLogging(req({ body: {} }))).rejects.toThrow();
  });

  test('POST /api/logs/siptrace: a failed tailer start is a 500 and the logger is not touched', async () => {
    sipTracer.logPath = '/nonexistent/asterisk/full';
    await expect(ctl.apiSetSipTrace(req({ body: { enabled: true } }))).rejects.toMatchObject({ status: 500 });
    expect(setPjsipLogger).not.toHaveBeenCalled();
    expect(await ctl.apiGetSipTrace()).toEqual({
      enabled: false,
      error: 'Cannot read /nonexistent/asterisk/full: No such file or directory',
    });
    expect(await ctl.apiSetSipTrace(req({ body: { enabled: false } }))).toEqual({
      enabled: false,
      error: 'Cannot read /nonexistent/asterisk/full: No such file or directory',
    });
    expect(setPjsipLogger).toHaveBeenCalledWith(false);
  });

  test('GET /api/logs/deliveries: respond_list with a keyset cursor and the status counts', async () => {
    mocked(dbm.listWebhookDeliveries).mockResolvedValueOnce([[{ id: 50 }, { id: 49 }], true]);
    const res = await ctl.listDeliveries(req({ query: { limit: '2', success: 'false', search: '0100' } }));
    expect(res).toEqual({
      data: [{ id: 50 }, { id: 49 }],
      page: { cursor: null, next_cursor: 'eyJpZCI6NDl9', limit: 2 },
      counts: { pending: 1, delivered: 5, failed: 2, abandoned: 0 },
    });
    expect(dbm.webhookDeliveryFacets).not.toHaveBeenCalled();
    expect(dbm.listWebhookDeliveries).toHaveBeenCalledWith({
      success: false,
      status: null,
      callId: null,
      callType: null,
      search: '0100',
      dateFrom: null,
      dateTo: null,
      limit: 2,
      afterId: null,
    });
    mocked(dbm.listWebhookDeliveries).mockResolvedValueOnce([[{ id: 48 }], false]);
    const next = await ctl.listDeliveries(req({ query: { cursor: 'eyJpZCI6NDl9' } }));
    expect(next.page).toEqual({ cursor: 'eyJpZCI6NDl9', next_cursor: null, limit: 50 });
    expect(mocked(dbm.listWebhookDeliveries).mock.calls[1][0].afterId).toBe(49);
    await expect(ctl.listDeliveries(req({ query: { cursor: '!!' } }))).rejects.toMatchObject({ code: 'request.cursor.invalid' });
  });

  test('GET /api/logs/deliveries: status filter, facets on request, unknown status is a 400', async () => {
    mocked(dbm.listWebhookDeliveries).mockResolvedValueOnce([[{ id: 9, status: 'failed' }], false]);
    const res = await ctl.listDeliveries(req({ query: { status: 'unresolved', call_type: 'inbound', facets: '1' } }));
    expect(res).toMatchObject({ facets: { status: { failed: 2 }, call_type: { inbound: 2 } } });
    expect(mocked(dbm.listWebhookDeliveries).mock.calls[0][0]).toMatchObject({ status: 'unresolved', callType: 'inbound' });
    // The facets see the same filters as the list (each facet drops its own in the DB layer).
    expect(mocked(dbm.webhookDeliveryFacets).mock.calls[0][0]).toMatchObject({ status: 'unresolved', callType: 'inbound' });
    await expect(ctl.listDeliveries(req({ query: { status: 'sent' } }))).rejects.toMatchObject({
      status: 400,
      message: "Unknown status 'sent'; allowed: abandoned, delivered, failed, pending, unresolved",
    });
  });

  test('retry: requeues the same delivery and sweeps at once; 404 when it cannot be requeued', async () => {
    mocked(dbm.requeueWebhookDelivery).mockResolvedValueOnce(false);
    await expect(ctl.retryDelivery(req({ params: { delivery_id: '7' } }))).rejects.toMatchObject({ status: 404 });
    expect(sweepCrmDeliveries).not.toHaveBeenCalled();
    mocked(dbm.requeueWebhookDelivery).mockResolvedValueOnce(true);
    mocked(dbm.getWebhookDelivery).mockResolvedValueOnce({ id: 7, status: 'delivered' });
    expect(await ctl.retryDelivery(req({ params: { delivery_id: '7' } }))).toEqual({ ok: true, delivery: { id: 7, status: 'delivered' } });
    expect(dbm.requeueWebhookDelivery).toHaveBeenLastCalledWith(7);
    expect(sweepCrmDeliveries).toHaveBeenCalledTimes(1);
  });

  test('GET /api/logs/deliveries/:id is bare, 404 when missing', async () => {
    mocked(dbm.getWebhookDelivery).mockResolvedValueOnce({ id: 3, request_body: '{}' });
    expect(await ctl.getDelivery(req({ params: { delivery_id: '3' } }))).toEqual({ id: 3, request_body: '{}' });
    mocked(dbm.getWebhookDelivery).mockResolvedValueOnce(null);
    await expect(ctl.getDelivery(req({ params: { delivery_id: '4' } }))).rejects.toMatchObject({ status: 404, message: 'Delivery not found' });
  });

  test('resend: refusals in the Python order, then a background replay with the lineage', async () => {
    const row = {
      id: 7,
      created_at: '2026-10-25T10:00:00',
      call_id: 'L1',
      uniqueid: 'U1',
      caller: '100',
      destination: '200',
      call_type: 'inbound',
      call_status: 'ANSWERED',
      request_body: '{"caller": "100"}',
      attempt: 1,
      truncated: false,
    };
    const id = { params: { delivery_id: '7' } };
    mocked(dbm.getWebhookDelivery).mockResolvedValue({ ...row, truncated: true });
    await expect(ctl.resendDelivery(req(id))).rejects.toMatchObject({
      status: 400,
      message: 'Request body was truncated when logged and cannot be replayed safely.',
    });
    mocked(dbm.getWebhookDelivery).mockResolvedValue({ ...row, request_body: '[1]' });
    await expect(ctl.resendDelivery(req(id))).rejects.toMatchObject({ message: 'Stored request body is not a JSON object' });
    mocked(dbm.getWebhookDelivery).mockResolvedValue({ ...row, request_body: '{' });
    await expect(ctl.resendDelivery(req(id))).rejects.toMatchObject({ message: 'Stored request body is not valid JSON' });
    mocked(dbm.getWebhookDelivery).mockResolvedValue({ ...row });
    await expect(ctl.resendDelivery(req(id))).rejects.toMatchObject({ status: 503, message: 'CRM connector is not configured' });
    runtimeMock.crmConnector = { serverUrl: 'https://crm' };
    await expect(ctl.resendDelivery(req(id))).rejects.toMatchObject({ status: 503, message: 'AMI monitor unavailable' });
    runtimeMock.monitor = {};
    expect(await ctl.resendDelivery(req(id))).toEqual({ accepted: true, delivery_id: 7, original_created_at: '2026-10-25T10:00:00' });
    expect(sendCrmDataAsync).toHaveBeenCalledWith(runtimeMock.crmConnector, { caller: '100' }, {
      method: 'PUT',
      endpointPath: '/sync',
      syncCfg: { method: 'PUT', endpoint: '/sync' },
      trigger: 'resend',
      meta: {
        call_id: 'L1',
        uniqueid: 'U1',
        caller: '100',
        destination: '200',
        call_type: 'inbound',
        call_status: 'ANSWERED',
        attempt: 2,
        parent_id: 7,
        resent_by: 1,
      },
    });
  });
});
