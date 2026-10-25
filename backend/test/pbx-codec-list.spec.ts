/**
 * The db half of the PBX settings: the PBX-wide audio codec list (parseCodecList,
 * get/setPbxDefaultCodecs) and per-extension max_contacts (get/setExtensionMaxContacts).
 * The routes are test/pbx-settings-routes.spec.ts.
 *
 * No database and no reload: the pool's statement functions are mocked, and the SIP
 * reloader is replaced through setSipReloader, so nothing here can run on the host.
 */

jest.mock('../src/db/pool', () => ({
  ...jest.requireActual('../src/db/pool'),
  query: jest.fn(),
  queryOne: jest.fn(),
  execute: jest.fn(),
}));
jest.mock('../src/services/dialplan', () => ({ reloadAsteriskSip: jest.fn() }));

import * as pool from '../src/db/pool';
import * as dbm from '../src/db/manager/pbx';

const queryOne = pool.queryOne as jest.Mock;
const execute = pool.execute as jest.Mock;
const reload = jest.fn(async () => true);

/** What mysql2 raises for a missing table. */
function dbError(errno: number, message: string): Error {
  return Object.assign(new Error(message), { errno, code: 'ER_NO_SUCH_TABLE', sqlState: '42S02' });
}

beforeEach(() => {
  jest.resetAllMocks();
  reload.mockResolvedValue(true);
  dbm.setSipReloader(reload);
});

afterAll(() => dbm.setSipReloader(null));

describe('codecs', () => {
  test('parseCodecList accepts both separators, lowercases and de-duplicates', () => {
    expect(dbm.parseCodecList('opus, ulaw&alaw,')).toEqual(['opus', 'ulaw', 'alaw']);
    expect(dbm.parseCodecList('G722,ulaw,g722')).toEqual(['g722', 'ulaw']);
    expect(dbm.parseCodecList('')).toEqual([]);
    expect(dbm.parseCodecList(null)).toEqual([]);
  });

  test('the PBX default codecs come back sorted by priority', async () => {
    queryOne.mockResolvedValue({ val: '{"ulaw":2,"opus":3,"alaw":1}' });
    expect(await dbm.getPbxDefaultCodecs()).toEqual(['alaw', 'ulaw', 'opus']);
  });

  test('Issabel (no kvstore table) is an empty list, not an error; an outage is null', async () => {
    queryOne.mockRejectedValue(dbError(1146, "Table 'asterisk.kvstore_Sipsettings' doesn't exist"));
    expect(await dbm.getPbxDefaultCodecs()).toEqual([]);
    queryOne.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    expect(await dbm.getPbxDefaultCodecs()).toBeNull();
  });

  test('setPbxDefaultCodecs stores the FreePBX shape in one statement', async () => {
    execute.mockResolvedValue({ affectedRows: 1, insertId: 0 });
    expect(await dbm.setPbxDefaultCodecs(['opus', 'ulaw', 'alaw'])).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params, db] = execute.mock.calls[0];
    expect(sql).toContain('kvstore_Sipsettings');
    expect(sql).toContain('voicecodecs');
    expect(JSON.parse(params[0])).toEqual({ opus: 1, ulaw: 2, alaw: 3 });
    expect(db).toBe('pbx');
    execute.mockRejectedValue(new Error('boom'));
    expect(await dbm.setPbxDefaultCodecs(['opus'])).toBe(false);
  });

  test('the standard list holds the codecs FreePBX offers', () => {
    expect(dbm.STANDARD_AUDIO_CODECS).toEqual(['opus', 'ulaw', 'alaw', 'g722', 'gsm', 'g726', 'ilbc']);
  });
});

describe('max_contacts', () => {
  test('a stored value is read; no row is the Asterisk default of 1; junk or an outage is null', async () => {
    queryOne.mockResolvedValueOnce({ data: '2' });
    expect(await dbm.getExtensionMaxContacts('100')).toBe(2);
    queryOne.mockResolvedValueOnce(null);
    expect(await dbm.getExtensionMaxContacts('100')).toBe(1);
    queryOne.mockResolvedValueOnce({ data: 'many' });
    expect(await dbm.getExtensionMaxContacts('100')).toBeNull();
    queryOne.mockRejectedValueOnce(new Error('down'));
    expect(await dbm.getExtensionMaxContacts('100')).toBeNull();
    expect(queryOne.mock.calls[0][1]).toEqual(['100']);
  });

  test('set writes the sip keyword and reloads with the PBX flavour', async () => {
    execute.mockResolvedValue({ affectedRows: 1 });
    expect(await dbm.setExtensionMaxContacts('100', 2, { pbx: 'Issabel' })).toBe(true);
    expect(execute.mock.calls[0][1]).toEqual(['100', 'max_contacts', '2']);
    expect(reload).toHaveBeenCalledWith('Issabel');
  });

  test('reload: false leaves the reload to the caller', async () => {
    execute.mockResolvedValue({ affectedRows: 1 });
    expect(await dbm.setExtensionMaxContacts('100', 1, { reload: false })).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  test.each([[0], [3], ['x']])('%p is refused without a write', async (value) => {
    expect(await dbm.setExtensionMaxContacts('100', value as number)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  test('a failed write is false and does not reload', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await dbm.setExtensionMaxContacts('100', 2)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
