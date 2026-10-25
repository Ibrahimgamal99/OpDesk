/**
 * Call history routes, who sees what and how it pages: server-side paging, filters and
 * order handed to the service; a search reaching all history; a bad limit is a 400;
 * supervision (ChanSpy calls, LISTEN/WHISPER/BARGE) hidden from the monitored agent and
 * kept for supervisors; the missed-call bell for a supervisor whose own extension is not
 * one of their groups' agents, and its real total. Handlers are called directly with a
 * fake request; the database and the services are mocked.
 */

jest.mock('../src/core/security', () => ({ principalOf: (req: { principal?: unknown }) => req.principal ?? null }));
jest.mock('../src/db/db-manager', () => ({
  getCdrByLinkedid: jest.fn(async () => []),
  getSupervisionForTarget: jest.fn(async () => [{ mode: 'listen' }]),
  getCallLegs: jest.fn(async () => []),
  getCallVadFromDb: jest.fn(async () => ({ uniqueid: 'u' })),
  getCallNotificationsFromDb: jest.fn(async () => [{ id: 1 }, { id: 2 }]),
  getCallNotificationsCountFromDb: jest.fn(async () => 250),
  getCallNotificationById: jest.fn(async () => null),
  updateCallNotificationStatus: jest.fn(async () => true),
  LimitValueError: class LimitValueError extends Error {},
}));
jest.mock('../src/services/call-log', () => ({
  callLog: jest.fn(async () => []),
  callLogPage: jest.fn(async () => ({ calls: [{ linkedid: 'L' }], total: 321, next_cursor: 'n' })),
  buildCallJourneyFromCdr: jest.fn(async () => [{ event: 'HANGUP' }]),
  callStatus: jest.requireActual('../src/services/call-outcomes').callStatus,
  matchesCallLogFilters: jest.requireActual('../src/services/call-log').matchesCallLogFilters,
}));
jest.mock('../src/services/recording', () => ({
  resolveRecordingRequest: jest.fn(async () => ({ path: '/var/spool/asterisk/monitor/2026/10/17/spy.wav' })),
  deleteRecordingByUniqueid: jest.fn(),
  getRecordingPath: jest.fn(async () => null),
  pyBasename: (p: string) => p.slice(p.lastIndexOf('/') + 1),
  recordingContentType: () => 'audio/x-wav',
}));

import * as dbm from '../src/db/db-manager';
import { CallHistoryController, hidesSupervision, isSupervisionCall, notificationExtensions } from '../src/api/routes/call-history.controller';
import { buildCallJourneyFromCdr, callLog, callLogPage } from '../src/services/call-log';

const ctl = new CallHistoryController();
const mocked = (fn: unknown) => fn as jest.Mock;
const ADMIN = { id: 1, role: 'admin', extension: '100', allowed_agent_extensions: null };
const API_KEY = { id: null, role: 'admin', extension: null, api_key: true, allowed_agent_extensions: null };
const AGENT = { id: 2, role: 'agent', extension: '100', allowed_agent_extensions: ['100', '101'] };
// A supervisor's own extension is usually not one of their groups' agents.
const SUPERVISOR = { id: 3, role: 'supervisor', extension: '300', allowed_agent_extensions: ['100', '101'] };
const req = (principal: unknown, over: Record<string, unknown> = {}) => ({ params: {}, query: {}, body: {}, principal, ...over }) as never;

// Supervisor 300 listening to agent 100: the spy originate's CallerID is "Listen <100>", so
// the ChanSpy leg's src is the AGENT's extension.
const SPY_LEG = { linkedid: 'spy-300-100-1792247515000', uniqueid: 'spy-300-100-1792247515000', src: '100', dst: 's',
  channel: 'PJSIP/300-00000009', dstchannel: '', lastapp: 'ChanSpy' };
const CALL_LEG = { linkedid: 'L', uniqueid: 'L', src: '199', dst: '100', channel: 'PJSIP/trunk-1', dstchannel: 'PJSIP/100-1', lastapp: 'Dial' };

beforeEach(() => jest.clearAllMocks());

describe('/api/call-log: paging, filters, search', () => {
  it('hands paging, order and the table filters to the service; returns its page and total', async () => {
    const res = await ctl.getCallLogEndpoint(req(ADMIN, {
      query: { limit: '25', cursor: 'abc', order: 'asc', status: 'busy,MISSED', route: 'inbound', call_type: 'in', app: 'Queue',
        date_from: '2026-10-01', date_to: '2026-10-17' },
    }));
    expect(res).toEqual({ calls: [{ linkedid: 'L' }], total: 321, next_cursor: 'n' });
    const opts = mocked(callLogPage).mock.calls[0][0];
    expect(opts).toMatchObject({ limit: 25, cursor: 'abc', order: 'asc', dateFrom: '2026-10-01', dateTo: '2026-10-17',
      excludeSupervision: false, supervision: true });
    expect([...opts.filters.status]).toEqual(['BUSY', 'MISSED']);
    expect([...opts.filters.route]).toEqual(['inbound']);
    expect([...opts.filters.callType]).toEqual(['IN']);
    expect([...opts.filters.app]).toEqual(['queue']);
  });

  it('a search reaches all history: no default 30-day window', async () => {
    await ctl.getCallLogEndpoint(req(ADMIN, { query: { search: ' 1792247515.1 ' } }));
    expect(mocked(callLogPage).mock.calls[0][0]).toMatchObject({ search: '1792247515.1', dateFrom: null, dateTo: null, date: null });
    await ctl.getCallLogEndpoint(req(ADMIN, { query: {} }));
    expect(mocked(callLogPage).mock.calls[1][0].dateFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('limit <= 0 is a 400, not a 500', async () => {
    await expect(ctl.getCallLogEndpoint(req(ADMIN, { query: { limit: '0' } }))).rejects.toMatchObject({ status: 400 });
    await expect(ctl.getCallLogEndpoint(req(ADMIN, { query: { limit: '-5' } }))).rejects.toMatchObject({ status: 400 });
    expect(callLogPage).not.toHaveBeenCalled();
    mocked(callLogPage).mockRejectedValueOnce(new dbm.LimitValueError('limit must be a positive integer'));
    await expect(ctl.getCallLogEndpoint(req(ADMIN))).rejects.toMatchObject({ status: 400, message: 'limit must be a positive integer' });
  });
});

describe('supervision is hidden from the monitored agent', () => {
  it('role helpers', () => {
    expect(hidesSupervision(AGENT)).toBe(true);
    expect(hidesSupervision(SUPERVISOR)).toBe(false);
    expect(hidesSupervision(ADMIN)).toBe(false);
    expect(hidesSupervision({ ...AGENT, api_key: true })).toBe(false);
    expect(isSupervisionCall([CALL_LEG])).toBe(false);
    expect(isSupervisionCall([SPY_LEG])).toBe(true);
    expect(isSupervisionCall([{ ...SPY_LEG, linkedid: '1792.9' }])).toBe(true); // a feature-code ChanSpy
  });

  it('the list: an agent never gets ChanSpy calls, even asking; supervisors may', async () => {
    await ctl.getCallLogEndpoint(req(AGENT, { query: { include_supervision: 'true' } }));
    expect(mocked(callLogPage).mock.calls[0][0]).toMatchObject({ excludeSupervision: true, supervision: false });
    await ctl.getCallLogEndpoint(req(SUPERVISOR));
    expect(mocked(callLogPage).mock.calls[1][0]).toMatchObject({ excludeSupervision: false, supervision: true });
    await ctl.getCallLogEndpoint(req(SUPERVISOR, { query: { include_supervision: 'false' } }));
    expect(mocked(callLogPage).mock.calls[2][0]).toMatchObject({ excludeSupervision: true });
  });

  it('the export: never for an agent', async () => {
    await ctl.exportCallLogEndpoint(req(AGENT, { query: { include_supervision: 'true' } }));
    expect(mocked(callLog).mock.calls[0][0]).toMatchObject({ excludeSupervision: true });
    await ctl.exportCallLogEndpoint(req(SUPERVISOR, { query: { include_supervision: 'true', search: 'omar' } }));
    expect(mocked(callLog).mock.calls[1][0]).toMatchObject({ excludeSupervision: false, search: 'omar', dateFrom: null });
  });

  it('the journey: the Listen call itself is 403 for the agent; supervision events only for supervisors', async () => {
    mocked(dbm.getCdrByLinkedid).mockResolvedValue([SPY_LEG]);
    await expect(ctl.getCallJourneyEndpoint(req(AGENT, { query: { linkedid: SPY_LEG.linkedid } }))).rejects.toMatchObject({
      status: 403, message: 'Not allowed to view this call',
    });
    // The supervisor (300) took part in the spy call through its channel.
    expect(await ctl.getCallJourneyEndpoint(req({ ...SUPERVISOR, allowed_agent_extensions: ['100', '300'] }, {
      query: { linkedid: SPY_LEG.linkedid } }))).toEqual({ journey: [{ event: 'HANGUP' }] });

    mocked(dbm.getCdrByLinkedid).mockResolvedValue([CALL_LEG]);
    mocked(dbm.getSupervisionForTarget).mockClear();
    await ctl.getCallJourneyEndpoint(req(AGENT, { query: { linkedid: 'L' } }));
    expect(dbm.getSupervisionForTarget).not.toHaveBeenCalled();
    expect(mocked(buildCallJourneyFromCdr).mock.calls.pop()).toEqual([[CALL_LEG], []]);
    await ctl.getCallJourneyEndpoint(req(SUPERVISOR, { query: { linkedid: 'L' } }));
    expect(dbm.getSupervisionForTarget).toHaveBeenCalledWith('L');
    expect(mocked(buildCallJourneyFromCdr).mock.calls.pop()).toEqual([[CALL_LEG], [{ mode: 'listen' }]]);
  });

  it('VAD and recording audio of a ChanSpy call are 403 for the agent', async () => {
    mocked(dbm.getCallLegs).mockResolvedValue([SPY_LEG]);
    await expect(ctl.getCallVadEndpoint(req(AGENT, { params: { uniqueid: SPY_LEG.uniqueid } }))).rejects.toMatchObject({ status: 403 });
    await expect(ctl.serveRecording(req(AGENT, { params: { file_path: 'spy.wav' } }))).rejects.toMatchObject({ status: 403 });
    expect(await ctl.getCallVadEndpoint(req({ ...SUPERVISOR, allowed_agent_extensions: ['100'] }, { params: { uniqueid: 'x' } })))
      .toEqual({ uniqueid: 'u' });
  });
});

describe('/api/call-notifications', () => {
  it('notificationExtensions: own for an agent, scope + own for a supervisor, all for admin', () => {
    expect(notificationExtensions(AGENT)).toEqual(['100']);
    expect(notificationExtensions(SUPERVISOR)).toEqual(['100', '101', '300']);
    expect(notificationExtensions({ ...SUPERVISOR, extension: '101' })).toEqual(['100', '101']);
    expect(notificationExtensions({ ...SUPERVISOR, extension: null })).toEqual(['100', '101']);
    expect(notificationExtensions(ADMIN)).toBeNull();
    expect(notificationExtensions(API_KEY)).toBeNull();
  });

  it('a supervisor reads their own bell and their agents’, no 403; total is the real total', async () => {
    const res = await ctl.getCallNotificationsEndpoint(req(SUPERVISOR, { query: { status: 'new', limit: '2' } }));
    expect(res).toEqual({ notifications: [{ id: 1 }, { id: 2 }], total: 250 });
    const filter = { extension: null, extensions: ['100', '101', '300'], statusFlag: 'new' };
    expect(mocked(dbm.getCallNotificationsFromDb).mock.calls[0][0]).toEqual({ ...filter, limit: 2 });
    expect(mocked(dbm.getCallNotificationsCountFromDb).mock.calls[0][0]).toEqual(filter);
    await ctl.getCallNotificationsEndpoint(req(SUPERVISOR, { query: { extension: '300' } }));
    expect(mocked(dbm.getCallNotificationsFromDb).mock.calls[1][0]).toMatchObject({ extension: '300', extensions: null });
    await expect(ctl.getCallNotificationsEndpoint(req(SUPERVISOR, { query: { extension: '200' } }))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('an agent always reads their own; an admin their own by default, any on request; an API key all', async () => {
    await ctl.getCallNotificationsEndpoint(req(AGENT, { query: { extension: '101' } }));
    expect(mocked(dbm.getCallNotificationsFromDb).mock.calls[0][0]).toMatchObject({ extension: '100', extensions: null });
    await ctl.getCallNotificationsEndpoint(req(ADMIN));
    expect(mocked(dbm.getCallNotificationsFromDb).mock.calls[1][0]).toMatchObject({ extension: '100', extensions: null });
    await ctl.getCallNotificationsEndpoint(req(ADMIN, { query: { extension: '101' } }));
    expect(mocked(dbm.getCallNotificationsFromDb).mock.calls[2][0]).toMatchObject({ extension: '101' });
    await ctl.getCallNotificationsEndpoint(req(API_KEY));
    expect(mocked(dbm.getCallNotificationsFromDb).mock.calls[3][0]).toMatchObject({ extension: null, extensions: null });
    await expect(ctl.getCallNotificationsEndpoint(req(AGENT, { query: { limit: '0' } }))).rejects.toMatchObject({ status: 400 });
  });

  it('PATCH: a supervisor may mark their own notification read; an agent only their own', async () => {
    mocked(dbm.getCallNotificationById).mockResolvedValue({ id: 9, extension: '300' });
    expect(
      await ctl.updateCallNotificationEndpoint(req(SUPERVISOR, { params: { notification_id: '9' }, body: { status_flag: 'read' } })),
    ).toEqual({ ok: true, id: 9, status_flag: 'read' });
    await expect(
      ctl.updateCallNotificationEndpoint(req(AGENT, { params: { notification_id: '9' }, body: { status_flag: 'read' } })),
    ).rejects.toMatchObject({ status: 403 });
  });
});
