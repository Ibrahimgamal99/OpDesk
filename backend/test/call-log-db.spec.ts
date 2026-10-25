/**
 * db/manager/call-log: the SQL behind Call History (last_channel alias, any-leg recording,
 * Local-channel agent matching), CEL parsing, IVR steps, notification reason projection,
 * per-call leg lookup. The pool is mocked; statements and params are inspected.
 */

jest.mock('../src/db/pool', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  execute: jest.fn(async () => ({ affectedRows: 1, insertId: 7 })),
  keysetPage: jest.fn(async () => ({ items: [], next_cursor: null })),
  placeholders: (n: number) => new Array(n).fill('?').join(', '),
}));

import * as pool from '../src/db/pool';
import {
  celHangupsByLinkedid,
  celIvrStepsByLinkedid,
  getCallLegs,
  getCallLogCountFromDb,
  getCallLogFromDb,
  getCallNotificationsFromDb,
  getRecordingsFromDb,
  insertCallNotification,
  LimitValueError,
} from '../src/db/manager/call-log';

const q = pool.query as jest.Mock;
const q1 = pool.queryOne as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('getCallLogFromDb', () => {
  it('keeps the last leg channel apart and takes the recording from any leg', async () => {
    await getCallLogFromDb({ dateFrom: '2026-10-01', dateTo: '2026-10-17', limit: 100 });
    const [sql, params, target] = q.mock.calls[0];
    expect(target).toBe('cdr');
    expect(sql).toContain('last_leg.channel       AS last_channel');
    expect(sql).not.toMatch(/last_leg\.channel\s+AS channel\b/);
    expect(sql).toContain("MAX(NULLIF(recordingfile, '')) AS recordingfile");
    expect(sql).toContain('rec.recordingfile');
    expect(sql).not.toContain('first_leg.recordingfile');
    // 4 GROUP BY subqueries x 2 date params, then the outer bounds, then the limit
    expect(params).toEqual([
      ...Array(4).fill(['2026-10-01', '2026-10-17']).flat(),
      '2026-10-01', '2026-10-17', 100,
    ]);
  });

  it('matches agents on Local/<ext>@context legs too, and [] means nothing', async () => {
    await getCallLogFromDb({ allowedExtensions: ['101'] });
    const [sql, params] = q.mock.calls[0];
    expect(sql).toContain("SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(dstchannel, '@', 1), '-', 1), '/', -1) IN (?)");
    expect(params).toEqual(['101', '101', '101']);
    await getCallLogFromDb({ allowedExtensions: [] });
    expect(q.mock.calls[1][0]).toContain('1 = 0');
  });

  it('a non-positive limit is a ValueError, not a DB error', async () => {
    await expect(getCallLogFromDb({ limit: -1 })).rejects.toBeInstanceOf(LimitValueError);
  });

  it('a DB error yields []', async () => {
    q.mockRejectedValueOnce(new Error('gone'));
    expect(await getCallLogFromDb({})).toEqual([]);
  });

  it('count: widened to the call, 0 for an empty scope', async () => {
    q1.mockResolvedValueOnce({ cnt: 3 });
    expect(await getCallLogCountFromDb({ allowedExtensions: ['100'], search: '199' })).toBe(3);
    expect(q1.mock.calls[0][0]).toContain('COUNT(DISTINCT linkedid)');
    expect(q1.mock.calls[0][0]).toContain('linkedid IN (SELECT linkedid FROM cdr WHERE');
    expect(await getCallLogCountFromDb({ allowedExtensions: [] })).toBe(0);
  });
});

describe('CEL', () => {
  it('parses HANGUP extra JSON per channel and skips what is not JSON', async () => {
    q.mockResolvedValueOnce([
      { id: 4, linkedid: 'L', channame: 'PJSIP/100-0', extra: '{"hangupcause":17,"hangupsource":"PJSIP/100-0","dialstatus":""}', cid_rdnis: '' },
      { id: 6, linkedid: 'L', channame: 'Local/100@from-internal-0;1', extra: '{"hangupcause":0,"hangupsource":"","dialstatus":"BUSY"}', cid_rdnis: '' },
      { id: 9, linkedid: 'L', channame: 'X', extra: 'not json', cid_rdnis: '' },
    ]);
    expect(await celHangupsByLinkedid(['L', 'L', null])).toEqual({
      L: {
        'PJSIP/100-0': { cause: '17', source: 'PJSIP/100-0', dialstatus: '', forwarded: false, seq: 4 },
        'Local/100@from-internal-0;1': { cause: '0', source: '', dialstatus: 'BUSY', forwarded: false, seq: 6 },
      },
    });
    expect(q.mock.calls[0][1]).toEqual(['L']);
    expect(q.mock.calls[0][2]).toBe('cdr');
  });

  it('never fatal', async () => {
    q.mockRejectedValueOnce(new Error('no cel table'));
    expect(await celHangupsByLinkedid(['L'])).toEqual({});
  });

  it('IVR steps: one per menu entered, with the digit extension as the selection', async () => {
    const t = (s: number) => new Date(2026, 9, 17, 10, 0, s);
    q.mockResolvedValueOnce([
      { id: 1, eventtime: t(1), context: 'ivr-2', exten: 's' },
      { id: 2, eventtime: t(2), context: 'ivr-2', exten: 's' },
      { id: 3, eventtime: t(6), context: 'ivr-2', exten: '3' },
      { id: 4, eventtime: t(7), context: 'ivr-5', exten: 's' },
      { id: 5, eventtime: t(9), context: 'ivr-5', exten: 't' },
    ]);
    expect(await celIvrStepsByLinkedid('L')).toEqual([
      { context: 'ivr-2', eventtime: t(1), selection: '3' },
      { context: 'ivr-5', eventtime: t(7), selection: null },
    ]);
  });
});

describe('call notifications', () => {
  it("projects the bell's old lowercase reasons to call statuses, keeps others", async () => {
    q.mockResolvedValueOnce([
      { id: 1, extension: '100', reason: 'busy', event_time: new Date(2026, 9, 17, 17, 32, 0) },
      { id: 2, extension: '100', reason: 'switched_off', event_time: null },
      { id: 3, extension: '100', reason: 'callback_due', event_time: null },
      { id: 4, extension: '100', reason: 'MISSED', event_time: null },
    ]);
    const rows = await getCallNotificationsFromDb({ extensions: ['100', '101'], statusFlag: 'new' });
    expect(rows.map((r) => r.reason)).toEqual(['BUSY', 'UNREACHABLE', 'callback_due', 'MISSED']);
    expect(rows[0].event_time).toBe('2026-10-17T17:32:00');
    expect(q.mock.calls[0][0]).toContain('extension IN (?, ?)');
    expect(q.mock.calls[0][1]).toEqual(['100', '101', 'new', 200]);
  });

  it('an empty extension scope reads nothing', async () => {
    expect(await getCallNotificationsFromDb({ extensions: [] })).toEqual([]);
    expect(q).not.toHaveBeenCalled();
  });

  it('insert', async () => {
    expect(await insertCallNotification('100', { callerFrom: '199', reason: 'BUSY', callId: 'L' })).toBe(7);
    expect((pool.execute as jest.Mock).mock.calls[0][1]).toEqual(['100', '199', null, 'L', 'BUSY']);
  });
});

describe('getCallLegs', () => {
  it('by recording basename, also matching a stored path', async () => {
    q1.mockResolvedValueOnce({ linkedid: 'L' });
    q.mockResolvedValueOnce([{ linkedid: 'L', src: '199' }]);
    expect(await getCallLegs({ recordingfile: '2026/10/17/a-b.wav' })).toEqual([{ linkedid: 'L', src: '199' }]);
    expect(q1.mock.calls[0][1]).toEqual(['a-b.wav', 'a-b.wav']);
    expect(q1.mock.calls[0][0]).toContain("LIKE CONCAT('%/', ?)");
  });

  it('unknown call: []', async () => {
    expect(await getCallLegs({ uniqueid: 'nope' })).toEqual([]);
    expect(await getCallLegs({})).toEqual([]);
  });
});

describe('recordings list', () => {
  it('is keyset-paged, newest first', async () => {
    await getRecordingsFromDb({ limit: 10, cursor: 'abc', search: '199' });
    const args = (pool.keysetPage as jest.Mock).mock.calls[0];
    expect(args[0]).toBe('cdr');
    expect(args[3][0]).toContain("recordingfile != ''");
    expect(args[4]).toEqual(['%199%', '%199%', '%199%', '%199%']);
    expect(args[6]).toEqual(['calldate', 'uniqueid', 'sequence']);
    expect(args.slice(7)).toEqual([10, 'abc', true]);
  });
});
