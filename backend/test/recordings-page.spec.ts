/**
 * The admin Recordings page's routes: the keyset-paged list (filters, cursor, resolved path
 * and size, the total under the same filters), the delete, and the recordings directory --
 * fixed to where the dialplan records, shown but never moved from Settings. Handlers are
 * called directly; the database, the files and the recording service are mocked.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opdesk-recpage-'));

jest.mock('../src/core/security', () => ({ principalOf: (req: { principal?: unknown }) => req.principal ?? null }));
jest.mock('../src/db/db-manager', () => ({
  getRecordingsFromDb: jest.fn(async () => ({ items: [], next_cursor: null })),
  getRecordingsCountFromDb: jest.fn(async () => 0),
  getSetting: jest.fn(async (_k: string, d: unknown) => d),
  setSetting: jest.fn(async () => true),
  LimitValueError: class LimitValueError extends Error {},
}));
jest.mock('../src/services/call-log', () => ({}));
jest.mock('../src/services/dialplan', () => ({ RECORD_SINGLE_DIR: '/var/spool/asterisk/single', RECORDING_FORMATS: ['wav'] }));
jest.mock('../src/services/recording', () => ({
  deleteRecordingByUniqueid: jest.fn(),
  getRecordingPath: jest.fn(async (f: string | null) => (f === 'gone.wav' ? null : `${mockTmp}/${f}`)),
  pyBasename: (p: string) => p.slice(p.lastIndexOf('/') + 1),
  recordingContentType: () => 'audio/x-wav',
  resolveRecordingRequest: jest.fn(),
  boolSetting: jest.fn(async () => true),
  intSettingOrNone: jest.fn(async () => null),
  LOCAL_MAX_BYTES_SETTING: 'RECORDING_LOCAL_MAX_SIZE_BYTES',
  LOCAL_RETENTION_DAYS_SETTING: 'RECORDING_LOCAL_RETENTION_DAYS',
  VAD_DELETE_LEGS_SETTING: 'VAD_DELETE_SINGLE_LEGS_ENABLED',
  recordingPolicySnapshot: jest.fn(),
  recordingRoot: jest.fn(async () => '/var/spool/asterisk/monitor'),
  recordingStorageStats: jest.fn(),
  runRecordingRetention: jest.fn(),
}));

import * as dbm from '../src/db/db-manager';
import { CallHistoryController } from '../src/api/routes/call-history.controller';
import { RecordingController } from '../src/api/routes/recording.controller';
import { deleteRecordingByUniqueid } from '../src/services/recording';

const history = new CallHistoryController();
const settings = new RecordingController();
const mocked = (fn: unknown) => fn as jest.Mock;
const ADMIN = { id: 1, role: 'admin', extension: null, allowed_agent_extensions: null };
const req = (over: Record<string, unknown> = {}) => ({ params: {}, query: {}, body: {}, principal: ADMIN, ...over }) as never;

beforeEach(() => jest.clearAllMocks());
afterAll(() => fs.rmSync(mockTmp, { recursive: true, force: true }));

describe('GET /api/recordings', () => {
  it('passes the filters and cursor, adds the resolved path and size, totals under the same filters', async () => {
    fs.writeFileSync(`${mockTmp}/a.wav`, Buffer.alloc(1234));
    mocked(dbm.getRecordingsFromDb).mockResolvedValue({
      items: [
        { calldate: new Date(2026, 9, 17), recordingfile: 'a.wav', uniqueid: 'U1', sequence: 3 },
        { calldate: new Date(2026, 9, 16), recordingfile: 'gone.wav', uniqueid: 'U2', sequence: 2 },
      ],
      next_cursor: 'next',
    });
    mocked(dbm.getRecordingsCountFromDb).mockResolvedValue(41);
    const res = await history.listRecordingsEndpoint(req({
      query: { limit: '2', cursor: 'abc', search: ' 199 ', date_from: '2026-10-01', date_to: '2026-10-17' },
    }));
    const filter = { search: '199', dateFrom: '2026-10-01', dateTo: '2026-10-17' };
    expect(mocked(dbm.getRecordingsFromDb).mock.calls[0][0]).toEqual({ ...filter, limit: 2, cursor: 'abc' });
    expect(mocked(dbm.getRecordingsCountFromDb).mock.calls[0][0]).toEqual(filter);
    expect(res).toEqual({
      recordings: [
        { calldate: new Date(2026, 9, 17), recordingfile: 'a.wav', uniqueid: 'U1', recording_path: `${mockTmp}/a.wav`, size_bytes: 1234 },
        { calldate: new Date(2026, 9, 16), recordingfile: 'gone.wav', uniqueid: 'U2', recording_path: null, size_bytes: null },
      ],
      total: 41,
      next_cursor: 'next',
    });
  });
});

describe('DELETE /api/recordings/:uniqueid', () => {
  it('answers the service result, or its error as an HTTP error', async () => {
    mocked(deleteRecordingByUniqueid).mockResolvedValueOnce({ deleted: '/x/a.wav', deleted_legs: [] });
    expect(await history.deleteRecordingEndpoint(req({ params: { uniqueid: 'U1' } }))).toEqual({ deleted: '/x/a.wav', deleted_legs: [] });
    mocked(deleteRecordingByUniqueid).mockResolvedValueOnce({ error: 404, message: 'Recording not found' });
    await expect(history.deleteRecordingEndpoint(req({ params: { uniqueid: 'U9' } }))).rejects.toMatchObject({
      status: 404, message: 'Recording not found',
    });
  });
});

describe('the recordings directory is fixed', () => {
  it('GET shows where the dialplan records', async () => {
    expect(await settings.getRecordingRetention()).toMatchObject({ root_dir: '/var/spool/asterisk/monitor' });
  });

  it('re-sending the same directory (with or without a slash) is accepted; another one is a 400', async () => {
    await settings.setRecordingRetention(req({ body: { root_dir: '/var/spool/asterisk/monitor/', local_days: 30 } }));
    await settings.setRecordingRetention(req({ body: { root_dir: '/var/spool/asterisk/monitor' } }));
    expect(dbm.setSetting).toHaveBeenCalledWith('RECORDING_LOCAL_RETENTION_DAYS', '30');
    await expect(settings.setRecordingRetention(req({ body: { root_dir: '/srv/other' } }))).rejects.toMatchObject({ status: 400 });
    // Never stored: lookup and retention stay on the directory the recorder writes.
    expect(mocked(dbm.setSetting).mock.calls.map((c) => c[0])).not.toContain('RECORDING_ROOT_DIR');
  });
});
