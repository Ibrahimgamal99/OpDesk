/**
 * db/manager/call-log: the SQL behind Call History (last_channel alias, the outcome leg,
 * any-leg recording, Local-channel agent matching, one predicate for the list and its count,
 * the name search, paging), CEL parsing, IVR steps, notification reason projection and
 * count, per-call leg lookup, the recordings list. The pool is mocked; statements and params
 * are inspected.
 */

jest.mock('../src/db/pool', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  execute: jest.fn(async () => ({ affectedRows: 1, insertId: 7 })),
  keysetPage: jest.fn(async () => ({ items: [], next_cursor: null })),
  placeholders: (n: number) => new Array(n).fill('?').join(', '),
  likeEscape: (t: string) => t.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_'),
}));
jest.mock('../src/db/manager/pbx', () => ({
  getExtensionNamesFromDb: jest.fn(async () => ({ '100': 'Hema', '102': 'Omar Hassan' })),
}));

import * as pool from '../src/db/pool';
import {
  celHangupsByLinkedid,
  celIvrStepsByLinkedid,
  getCallLegs,
  getCallLogCountFromDb,
  getCallLogFromDb,
  getCallNotificationsCountFromDb,
  getCallNotificationsFromDb,
  getRecordingsCountFromDb,
  getRecordingsFromDb,
  insertCallNotification,
  LimitValueError,
  SEARCH_PUSHDOWN_MAX,
} from '../src/db/manager/call-log';

const q = pool.query as jest.Mock;
const q1 = pool.queryOne as jest.Mock;

beforeEach(() => jest.clearAllMocks());

/** The first-leg derived table and the WHERE after it: what the list and the count share. */
const sharedPredicate = (sql: string): string => {
  const from = sql.indexOf('SELECT linkedid, MIN(sequence) AS min_seq');
  const where = sql.indexOf(' WHERE first_leg.');
  const order = sql.indexOf(' ORDER BY');
  const firstLeg = sql.slice(from, sql.indexOf(') first_leg', from));
  const tail = where === -1 ? '' : sql.slice(where, order === -1 ? undefined : order);
  return (firstLeg + '|' + tail).replace(/\s+/g, ' ');
};

describe('getCallLogFromDb', () => {
  it('keeps the outcome leg channel apart and takes the recording from any leg', async () => {
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

  it('reads the outcome from the last ANSWERED leg, duration over the whole call', async () => {
    await getCallLogFromDb({});
    const sql: string = q.mock.calls[0][0];
    // A call answered by 1001 then blind-transferred to an unanswered 1002 is 1001's.
    expect(sql).toContain("COALESCE(MAX(CASE WHEN billsec > 0 AND dstchannel <> '' THEN sequence END),");
    expect(sql).toContain('c.sequence = x.out_seq');
    expect(sql).toContain('TIMESTAMPDIFF(SECOND, first_leg.calldate, leg_count.ended_at)');
    expect(sql).toContain('leg_count.party_answered');
    expect(sql).toContain('leg_count.queue_legs');
  });

  it('pages by keyset, never OFFSET: newest first with a stable tie-break, or oldest first', async () => {
    await getCallLogFromDb({ limit: 25, after: ['2026-10-17T17:31:55', '1792247515.0'] });
    const [sql, params] = q.mock.calls[0];
    expect(sql).toContain('(first_leg.calldate, first_leg.linkedid) < (?, ?) ORDER BY first_leg.calldate DESC, first_leg.linkedid DESC LIMIT ?');
    expect(params.slice(-3)).toEqual(['2026-10-17T17:31:55', '1792247515.0', 25]);
    expect(sql).not.toContain('OFFSET');
    await getCallLogFromDb({ limit: 25, order: 'asc', after: ['2026-10-17T17:31:55', 'L'] });
    expect(q.mock.calls[1][0]).toContain('(first_leg.calldate, first_leg.linkedid) > (?, ?) ORDER BY first_leg.calldate ASC, first_leg.linkedid ASC LIMIT ?');
  });

  it('matches agents on Local/<ext>@context legs too, and [] means nothing', async () => {
    await getCallLogFromDb({ allowedExtensions: ['101'] });
    const [sql, params] = q.mock.calls[0];
    expect(sql).toContain("SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(dstchannel, '@', 1), '-', 1), '/', -1) IN (?)");
    expect(params).toEqual(['101', '101', '101']);
    expect(await getCallLogFromDb({ allowedExtensions: [] })).toEqual([]);
    expect(q).toHaveBeenCalledTimes(1); // an empty scope never reaches the database
  });

  it('a non-positive limit is a ValueError, not a DB error', async () => {
    await expect(getCallLogFromDb({ limit: -1 })).rejects.toBeInstanceOf(LimitValueError);
    await expect(getCallLogFromDb({ limit: 1.5 })).rejects.toBeInstanceOf(LimitValueError);
  });

  it('a DB error yields []', async () => {
    q.mockRejectedValueOnce(new Error('gone'));
    expect(await getCallLogFromDb({})).toEqual([]);
  });

  it('excludeSupervision drops ChanSpy calls in the list and the count alike', async () => {
    await getCallLogFromDb({ excludeSupervision: true, limit: 10 });
    await getCallLogCountFromDb({ excludeSupervision: true });
    const cond = "NOT (first_leg.linkedid LIKE 'spy-%' OR first_leg.lastapp = 'ChanSpy')";
    expect(q.mock.calls[0][0]).toContain(cond);
    expect(q1.mock.calls[0][0]).toContain(cond);
  });
});

describe('search', () => {
  /** query() as the database would answer the search's own lookups. */
  const answer = (matched: string[]) =>
    q.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT extension FROM users')) return [{ extension: '101' }];
      if (sql.startsWith('SELECT phone_key FROM contacts')) return [{ phone_key: '201001234567' }, { phone_key: '123' }];
      if (sql.startsWith('SELECT DISTINCT linkedid FROM cdr')) return matched.map((linkedid) => ({ linkedid }));
      return [];
    });

  it('a name becomes the extensions and numbers it stands for, matched on ANY leg', async () => {
    answer(['L1', 'L2']);
    await getCallLogFromDb({ search: 'omar', limit: 10 });
    const scan = q.mock.calls.find((c) => String(c[0]).startsWith('SELECT DISTINCT linkedid FROM cdr'))!;
    // Call ID, uniqueid, numbers and caller-ID name; the agent (OpDesk user 101, PBX name
    // "Omar Hassan" on 102) on any channel; the contact's number by its last 9 digits.
    expect(scan[0]).toContain('linkedid LIKE ? OR uniqueid LIKE ? OR src LIKE ? OR dst LIKE ? OR cnam LIKE ?');
    expect(scan[1].slice(0, 5)).toEqual(Array(5).fill('%omar%'));
    expect(scan[1]).toEqual(expect.arrayContaining(['101', '102', '%001234567']));
    expect(scan[1]).not.toContain('%123'); // too short to be an outside number
    expect(scan[1][scan[1].length - 1]).toBe(SEARCH_PUSHDOWN_MAX + 1);
    expect(scan[2]).toBe('cdr');
    // The matched calls are pushed into every GROUP BY subquery: whole calls, every leg.
    const list = q.mock.calls[q.mock.calls.length - 1];
    expect(list[0].match(/linkedid IN \(\?, \?\)/g)).toHaveLength(4);
    expect(list[1].filter((v: unknown) => v === 'L1')).toHaveLength(4);
  });

  it('the list and the count use one predicate: an agent-leg uniqueid finds its call in both', async () => {
    answer(['1792247515.0']);
    q1.mockResolvedValueOnce({ cnt: 1 });
    await getCallLogFromDb({ search: '1792247515.1', allowedExtensions: ['100'], dateFrom: '2026-10-01', limit: 10 });
    expect(await getCallLogCountFromDb({ search: '1792247515.1', allowedExtensions: ['100'], dateFrom: '2026-10-01' })).toBe(1);
    const list = q.mock.calls.find((c) => String(c[0]).includes('first_leg.calldate,'))!;
    const [countSql, countParams] = q1.mock.calls[0];
    expect(countSql).toContain('SELECT COUNT(*) AS cnt FROM');
    expect(sharedPredicate(countSql)).toBe(sharedPredicate(list[0]));
    expect(sharedPredicate(countSql)).toContain('WHERE first_leg.calldate >= ? AND first_leg.linkedid IN (SELECT linkedid');
    // Same params apart from the list's extra subqueries and its limit.
    const sub = ['2026-10-01', '1792247515.0'];
    expect(list[1]).toEqual([...sub, ...sub, ...sub, ...sub, ...countParams.slice(sub.length), 10]);
    // The scan is narrowed by the caller's scope.
    const scan = q.mock.calls.find((c) => String(c[0]).startsWith('SELECT DISTINCT linkedid FROM cdr'))!;
    expect(scan[0]).toContain('AND linkedid IN (SELECT linkedid FROM cdr WHERE');
  });

  it('no match: no main query, [] and 0', async () => {
    answer([]);
    expect(await getCallLogFromDb({ search: 'nobody', limit: 10 })).toEqual([]);
    expect(await getCallLogCountFromDb({ search: 'nobody' })).toBe(0);
    expect(q1).not.toHaveBeenCalled();
    expect(q.mock.calls.every((c) => !String(c[0]).includes('first_leg'))).toBe(true);
  });

  it('LIKE metacharacters in the term match literally', async () => {
    answer([]);
    await getCallLogFromDb({ search: '10%_', limit: 10 });
    const scan = q.mock.calls.find((c) => String(c[0]).startsWith('SELECT DISTINCT linkedid FROM cdr'))!;
    expect(scan[1][0]).toBe('%10\\%\\_%');
  });

  it('count: 0 for an empty scope, never fatal', async () => {
    expect(await getCallLogCountFromDb({ allowedExtensions: [] })).toBe(0);
    expect(q1).not.toHaveBeenCalled();
    q1.mockRejectedValueOnce(new Error('gone'));
    expect(await getCallLogCountFromDb({})).toBe(0);
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
    expect(await getCallNotificationsCountFromDb({ extensions: [] })).toBe(0);
    expect(q).not.toHaveBeenCalled();
    expect(q1).not.toHaveBeenCalled();
  });

  it('the count has the list filters and no limit', async () => {
    q1.mockResolvedValueOnce({ cnt: 312 });
    expect(await getCallNotificationsCountFromDb({ extensions: ['100', '101'], statusFlag: 'new' })).toBe(312);
    expect(q1.mock.calls[0][0]).toBe('SELECT COUNT(*) AS cnt FROM call_notifications WHERE extension IN (?, ?) AND status_flag = ?');
    expect(q1.mock.calls[0][1]).toEqual(['100', '101', 'new']);
  });

  it('insert', async () => {
    expect(await insertCallNotification('100', { callerFrom: '199', reason: 'BUSY', callId: 'L' })).toBe(7);
    expect((pool.execute as jest.Mock).mock.calls[0][1]).toEqual(['100', '199', null, 'L', 'BUSY']);
  });
});

describe('getCallLegs', () => {
  it('by recording basename, also matching a stored path; lastapp tells a ChanSpy leg', async () => {
    q1.mockResolvedValueOnce({ linkedid: 'L' });
    q.mockResolvedValueOnce([{ linkedid: 'L', src: '199' }]);
    expect(await getCallLegs({ recordingfile: '2026/10/17/a-b.wav' })).toEqual([{ linkedid: 'L', src: '199' }]);
    expect(q1.mock.calls[0][1]).toEqual(['a-b.wav', 'a-b.wav']);
    expect(q1.mock.calls[0][0]).toContain("LIKE CONCAT('%/', ?)");
    expect(q.mock.calls[0][0]).toContain('lastapp');
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

  it('filters by an inclusive date range, the count alike', async () => {
    await getRecordingsFromDb({ dateFrom: '2026-10-01', dateTo: '2026-10-17' });
    const args = (pool.keysetPage as jest.Mock).mock.calls[0];
    expect(args[3][0]).toContain('calldate >= ? AND calldate < DATE_ADD(?, INTERVAL 1 DAY)');
    expect(args[4]).toEqual(['2026-10-01', '2026-10-17']);
    q1.mockResolvedValueOnce({ cnt: 4 });
    expect(await getRecordingsCountFromDb({ search: '199', dateFrom: '2026-10-01' })).toBe(4);
    expect(q1.mock.calls[0][1]).toEqual(['%199%', '%199%', '%199%', '%199%', '2026-10-01']);
  });
});
