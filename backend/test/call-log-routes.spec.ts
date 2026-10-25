/**
 * Call history routes: history scope on the list and the export, server-side paging and
 * filters, the CSV itself (BOM, filters, filename), 403 for journey / VAD / recording audio
 * outside the caller's scope, supervision hidden from agents, the notifications scope and
 * total, and the recording audio route's sandbox answers. Handlers are called directly with
 * a fake request; the database and the recording files are mocked.
 */

jest.mock('../src/core/security', () => ({ principalOf: (req: { principal?: unknown }) => req.principal ?? null }));
jest.mock('../src/db/db-manager', () => ({
  getCdrByLinkedid: jest.fn(async () => []),
  getSupervisionForTarget: jest.fn(async () => []),
  getCallLegs: jest.fn(async () => []),
  getCallVadFromDb: jest.fn(async () => null),
  getCallLogCountFromDb: jest.fn(async () => 0),
  getCallNotificationsFromDb: jest.fn(async () => []),
  getCallNotificationsCountFromDb: jest.fn(async () => 0),
  LimitValueError: class LimitValueError extends Error {},
  getCallNotificationById: jest.fn(async () => null),
  updateCallNotificationStatus: jest.fn(async () => true),
  getRecordingsFromDb: jest.fn(async () => ({ items: [], next_cursor: null })),
  getRecordingsCountFromDb: jest.fn(async () => 0),
}));
jest.mock('../src/services/call-log', () => ({
  callLog: jest.fn(async () => []),
  callLogPage: jest.fn(async () => ({ calls: [], total: 0 })),
  buildCallJourneyFromCdr: jest.fn(async () => [{ event: 'OUTBOUND' }]),
  callStatus: jest.requireActual('../src/services/call-outcomes').callStatus,
  matchesCallLogFilters: jest.requireActual('../src/services/call-log').matchesCallLogFilters,
}));
jest.mock('../src/services/recording', () => ({
  resolveRecordingRequest: jest.fn(),
  deleteRecordingByUniqueid: jest.fn(),
  getRecordingPath: jest.fn(async () => null),
  pyBasename: (p: string) => p.slice(p.lastIndexOf('/') + 1),
  recordingContentType: () => 'audio/x-wav',
}));

import * as dbm from '../src/db/db-manager';
import { CallHistoryController, csvCell } from '../src/api/routes/call-history.controller';
import { FileResponse, RawResponse } from '../src/api/respond';
import { callLog, callLogPage } from '../src/services/call-log';
import { resolveRecordingRequest } from '../src/services/recording';

const ctl = new CallHistoryController();
const mocked = (fn: unknown) => fn as jest.Mock;
const ADMIN = { id: 1, role: 'admin', extension: null, allowed_agent_extensions: null };
const AGENT = { id: 2, role: 'agent', extension: '100', allowed_agent_extensions: ['100', '101'] };
const SUPERVISOR = { id: 3, role: 'supervisor', extension: null, allowed_agent_extensions: ['100', '101'] };
const req = (principal: unknown, over: Record<string, unknown> = {}) => ({ params: {}, query: {}, body: {}, principal, ...over }) as never;
const LEG_100 = { linkedid: 'L', src: '199', dst: '100', channel: 'Local/100@from-internal-1;2', dstchannel: 'PJSIP/100-1' };
const LEG_200 = { linkedid: 'M', src: '300', dst: '200', channel: 'PJSIP/300-1', dstchannel: 'PJSIP/200-1' };

beforeEach(() => jest.clearAllMocks());

describe('/api/call-log', () => {
  it('an agent reads only their own extension (not their group), admin everything', async () => {
    await ctl.getCallLogEndpoint(req(AGENT, { query: { date_from: '2026-10-01' } }));
    expect(mocked(callLogPage).mock.calls[0][0]).toMatchObject({
      allowedExtensions: ['100'], dateFrom: '2026-10-01', limit: 100, cursor: null,
    });
    await ctl.getCallLogEndpoint(req(ADMIN));
    expect(mocked(callLogPage).mock.calls[1][0].allowedExtensions).toBeNull();
    // no date: the last 30 days
    expect(mocked(callLogPage).mock.calls[1][0].dateFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await ctl.getCallLogEndpoint(req(SUPERVISOR));
    expect(mocked(callLogPage).mock.calls[2][0].allowedExtensions).toEqual(['100', '101']);
  });

  it('a failure is a 500 that does not leak the exception text', async () => {
    mocked(callLogPage).mockRejectedValueOnce(new Error('ER_ACCESS_DENIED secret detail'));
    await expect(ctl.getCallLogEndpoint(req(ADMIN))).rejects.toMatchObject({ status: 500, message: 'Failed to fetch call log' });
  });
});

describe('/api/call-log/export', () => {
  const rows = [
    { calldate: new Date(2026, 9, 17, 17, 31, 55), call_type: 'INTERNAL', src: '199', dst: '100', customer_name: 'Ahmed, "A"',
      extension: '100', app: 'direct', duration: 4, talk: 0, status: 'BUSY', ended_by: 'agent', ended_by_agent: '100',
      recording_file: null, linkedid: 'L' },
    { calldate: new Date(2026, 9, 17, 18, 0, 0), call_type: 'IN', src: '+201001234567', dst: '400', customer_name: '=cmd()',
      extension: '101', app: 'queue', duration: 60, talk: 50, status: 'ANSWERED', ended_by: 'customer', ended_by_agent: null,
      recording_file: 'x.wav', linkedid: 'N' },
    { calldate: new Date(2026, 9, 17, 18, 1, 0), call_type: 'INTERNAL', src: '101', dst: 's', extension: null, app: 'direct',
      status: 'ANSWERED', linkedid: 'spy-101-100-1', route: 'internal_supervision' },
  ];

  it('UTF-8 BOM, attachment filename, the table columns, supervision legs hidden', async () => {
    mocked(callLog).mockResolvedValueOnce(rows);
    const res = (await ctl.exportCallLogEndpoint(
      req(SUPERVISOR, { query: { date_from: '2026-10-01', date_to: '2026-10-17' } }),
    )) as unknown as RawResponse;
    expect(res).toBeInstanceOf(RawResponse);
    expect(res.init.contentType).toBe('text/csv; charset=utf-8');
    expect(res.init.headers).toEqual({ 'Content-Disposition': 'attachment; filename="call_history_2026-10-01_2026-10-17.csv"' });
    const body = res.body as Buffer;
    expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = body.subarray(3).toString('utf8').trimEnd().split('\r\n');
    expect(lines[0]).toBe('Date,Direction,From,To,Contact,Agent,Route,Queue,Duration (s),Talk (s),Status,Ended by,Recording,Call ID');
    expect(lines[1]).toBe('2026-10-17 17:31:55,Internal,199,100,"Ahmed, ""A""",100,direct,,4,0,BUSY,Agent (100),No,L');
    expect(lines[2]).toBe("2026-10-17 18:00:00,Inbound,+201001234567,400,'=cmd(),101,queue,400,60,50,ANSWERED,Customer,Yes,N");
    expect(lines).toHaveLength(3);
    expect(mocked(callLog).mock.calls[0][0]).toMatchObject({
      limit: 50000, allowedExtensions: ['100', '101'], enrich: false, outcomes: true, supervision: false,
      excludeSupervision: true,
    });
  });

  it('applies the table filters: status (any spelling), call_type, app, include_supervision', async () => {
    mocked(callLog).mockResolvedValue(rows);
    const lineCount = async (query: Record<string, unknown>) => {
      const res = (await ctl.exportCallLogEndpoint(req(ADMIN, { query }))) as unknown as RawResponse;
      return (res.body as Buffer).subarray(3).toString('utf8').trimEnd().split('\r\n').length - 1;
    };
    expect(await lineCount({ status: 'busy' })).toBe(1);
    expect(await lineCount({ status: 'BUSY,ANSWERED' })).toBe(2);
    expect(await lineCount({ call_type: 'IN' })).toBe(1);
    expect(await lineCount({ app: 'queue' })).toBe(1);
    expect(await lineCount({ include_supervision: 'true' })).toBe(3);
  });

  it('csvCell', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('+201001234567')).toBe('+201001234567');
    expect(csvCell('-15')).toBe('-15');
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });
});

describe('single-call routes: 403 outside the history scope', () => {
  it('journey', async () => {
    mocked(dbm.getCdrByLinkedid).mockResolvedValue([LEG_200]);
    await expect(ctl.getCallJourneyEndpoint(req(AGENT, { query: { linkedid: 'M' } }))).rejects.toMatchObject({
      status: 403, message: 'Not allowed to view this call',
    });
    mocked(dbm.getCdrByLinkedid).mockResolvedValue([LEG_100]);
    expect(await ctl.getCallJourneyEndpoint(req(SUPERVISOR, { query: { linkedid: 'L' } }))).toEqual({ journey: [{ event: 'OUTBOUND' }] });
    expect(dbm.getSupervisionForTarget).toHaveBeenCalledWith('L');
  });

  it('journey: an unknown call is 403 for an agent, [] for an admin', async () => {
    mocked(dbm.getCdrByLinkedid).mockResolvedValue([]);
    await expect(ctl.getCallJourneyEndpoint(req(AGENT, { query: { linkedid: 'X' } }))).rejects.toMatchObject({ status: 403 });
    expect(await ctl.getCallJourneyEndpoint(req(ADMIN, { query: { linkedid: 'X' } }))).toEqual({ journey: [] });
    await expect(ctl.getCallJourneyEndpoint(req(ADMIN, { query: { linkedid: ' ' } }))).rejects.toMatchObject({ status: 400 });
  });

  it('VAD', async () => {
    mocked(dbm.getCallLegs).mockResolvedValue([LEG_200]);
    await expect(ctl.getCallVadEndpoint(req(AGENT, { params: { uniqueid: 'M.1' } }))).rejects.toMatchObject({ status: 403 });
    mocked(dbm.getCallLegs).mockResolvedValue([LEG_100]);
    mocked(dbm.getCallVadFromDb).mockResolvedValue({ uniqueid: 'L.1', segments: '{"sp1": []}', created_at: new Date() });
    expect(await ctl.getCallVadEndpoint(req(AGENT, { params: { uniqueid: 'L.1' } }))).toEqual({ uniqueid: 'L.1', segments: { sp1: [] } });
    mocked(dbm.getCallVadFromDb).mockResolvedValue(null);
    await expect(ctl.getCallVadEndpoint(req(ADMIN, { params: { uniqueid: 'L.1' } }))).rejects.toMatchObject({ status: 404 });
  });

  it('recording audio: sandbox answers, scope on the resolved file, admin skips the lookup', async () => {
    mocked(resolveRecordingRequest).mockResolvedValueOnce({ status: 403 });
    await expect(ctl.serveRecording(req(ADMIN, { params: { file_path: ['..', '..', 'etc', 'passwd'] } }))).rejects.toMatchObject({
      status: 403, message: 'Access denied',
    });
    mocked(resolveRecordingRequest).mockResolvedValueOnce({ status: 404 });
    await expect(ctl.serveRecording(req(ADMIN, { params: { file_path: 'nope.wav' } }))).rejects.toMatchObject({
      status: 404, message: 'Recording not found',
    });

    mocked(resolveRecordingRequest).mockResolvedValue({ path: '/var/spool/asterisk/monitor/2026/10/17/m.wav' });
    mocked(dbm.getCallLegs).mockResolvedValueOnce([LEG_200]);
    await expect(ctl.serveRecording(req(AGENT, { params: { file_path: 'm.wav' } }))).rejects.toMatchObject({ status: 403 });
    expect(dbm.getCallLegs).toHaveBeenCalledWith({ recordingfile: 'm.wav' });

    const res = (await ctl.serveRecording(req(ADMIN, { params: { file_path: ['2026', '10', '17', 'm.wav'] } }))) as unknown as FileResponse;
    expect(res).toBeInstanceOf(FileResponse);
    expect(res.path).toBe('/var/spool/asterisk/monitor/2026/10/17/m.wav');
    expect(res.init).toMatchObject({ contentType: 'audio/x-wav', filename: 'm.wav' });
    expect(resolveRecordingRequest).toHaveBeenLastCalledWith('2026/10/17/m.wav');
    expect(dbm.getCallLegs).toHaveBeenCalledTimes(1); // admin: no lookup
  });
});

describe('/api/call-notifications', () => {
  it('an agent sees their own; a supervisor their scope in SQL', async () => {
    await ctl.getCallNotificationsEndpoint(req(AGENT, { query: { extension: '101' } }));
    expect(mocked(dbm.getCallNotificationsFromDb).mock.calls[0][0]).toMatchObject({ extension: '100', extensions: null });
    await ctl.getCallNotificationsEndpoint(req(SUPERVISOR));
    expect(mocked(dbm.getCallNotificationsFromDb).mock.calls[1][0]).toMatchObject({ extension: null, extensions: ['100', '101'] });
    await expect(ctl.getCallNotificationsEndpoint(req(SUPERVISOR, { query: { extension: '200' } }))).rejects.toMatchObject({
      status: 403, message: 'Not allowed to view this extension',
    });
    await expect(ctl.getCallNotificationsEndpoint(req(ADMIN, { query: { status: 'bogus' } }))).rejects.toMatchObject({ status: 400 });
  });

  it('PATCH only within scope', async () => {
    mocked(dbm.getCallNotificationById).mockResolvedValue({ id: 5, extension: '101' });
    await expect(
      ctl.updateCallNotificationEndpoint(req(AGENT, { params: { notification_id: '5' }, body: { status_flag: 'read' } })),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await ctl.updateCallNotificationEndpoint(req(SUPERVISOR, { params: { notification_id: '5' }, body: { status_flag: 'read' } })),
    ).toEqual({ ok: true, id: 5, status_flag: 'read' });
  });
});
