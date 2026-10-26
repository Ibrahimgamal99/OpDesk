/**
 * services/recording on a throwaway directory tree: the recordings root (where the dialplan
 * records, or the deployment's env; never the retired DB setting), the audio route's sandbox
 * (traversal, symlinks out, bare basenames), retention (age and size, audio files only),
 * ring-only cleanup, delete by
 * uniqueid, and the VAD runner's ring-only path. The PBX's real spool is never touched:
 * the dialplan's spool constants point into the temp tree.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opdesk-rec-'));
const mockSettings: Record<string, string> = {};

jest.mock('../src/services/dialplan', () => ({
  RECORD_MIX_DIR: `${mockTmp}/monitor`,
  RECORD_SINGLE_DIR: `${mockTmp}/single`,
  getRecordingPolicy: jest.fn(async () => ({
    directions: { inbound: true, outbound: false, internal: true },
    extensions_opted_out: ['101'],
  })),
  recordingHookConflicts: jest.fn(async () => []),
}));
jest.mock('../src/db/db-manager', () => ({
  getSetting: jest.fn(async (k: string, d: unknown) => (k in mockSettings ? mockSettings[k] : d)),
  getExtensionsFromDb: jest.fn(async () => ['100', '101']),
  getExtensionNamesFromDb: jest.fn(async () => ({ '100': 'Ibrahim', '101': 'Sara' })),
  getCdrRecordingfile: jest.fn(async () => null),
  getRecordingsCountFromDb: jest.fn(async () => 2),
  upsertCallVad: jest.fn(async () => true),
}));

import * as dbm from '../src/db/db-manager';
import {
  deleteRecordingByUniqueid,
  deleteRingOnlyRecording,
  getRecordingPath,
  invalidateRecordingIndex,
  recordingContentType,
  recordingPolicySnapshot,
  recordingRoot,
  recordingStorageStats,
  resolveRecordingRequest,
  runRecordingRetention,
} from '../src/services/recording';
import { waitAndAnalyze } from '../src/services/vad-runner';

const MIX = `${mockTmp}/monitor`;
const SINGLE = `${mockTmp}/single`;
const write = (p: string, bytes = 44, ageDays = 0) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
  if (ageDays) {
    const t = Date.now() / 1000 - ageDays * 86400;
    fs.utimesSync(p, t, t);
  }
};

beforeEach(async () => {
  fs.rmSync(mockTmp, { recursive: true, force: true });
  fs.mkdirSync(MIX, { recursive: true });
  fs.mkdirSync(SINGLE, { recursive: true });
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  await invalidateRecordingIndex();
  delete process.env.ASTERISK_RECORDING_ROOT_DIR;
});
afterAll(() => fs.rmSync(mockTmp, { recursive: true, force: true }));

describe('recordingRoot', () => {
  it('where the dialplan records, else the deployment env; the old Settings value is ignored', async () => {
    // A directory an earlier version let an admin save: lookup and retention stay put.
    mockSettings.RECORDING_ROOT_DIR = `${mockTmp}/elsewhere/`;
    expect(await recordingRoot()).toBe(MIX);
    process.env.ASTERISK_RECORDING_ROOT_DIR = '/srv/rec//';
    expect(await recordingRoot()).toBe('/srv/rec');
    // Never a filesystem root, nor a relative path: retention deletes from this tree.
    for (const bad of ['/', '/var/', 'monitor']) {
      process.env.ASTERISK_RECORDING_ROOT_DIR = bad;
      expect(await recordingRoot()).toBe(MIX);
    }
    delete process.env.ASTERISK_RECORDING_ROOT_DIR;
    expect(await recordingRoot()).toBe(MIX);
  });
});

describe('audio sandbox', () => {
  beforeEach(() => {
    write(`${MIX}/2026/10/17/20261017-173155-199-100-1792247515.1.wav`, 1000);
    write(`${mockTmp}/secret.wav`, 10);
    fs.symlinkSync(`${mockTmp}/secret.wav`, `${MIX}/link.wav`);
  });

  it('relative and absolute paths inside the root resolve', async () => {
    const want = `${MIX}/2026/10/17/20261017-173155-199-100-1792247515.1.wav`;
    expect(await resolveRecordingRequest('2026/10/17/20261017-173155-199-100-1792247515.1.wav')).toEqual({ path: want });
    expect(await resolveRecordingRequest(want)).toEqual({ path: want });
  });

  it('a bare basename resolves through the index (the CDR stores only the basename)', async () => {
    expect(await resolveRecordingRequest('20261017-173155-199-100-1792247515.1.wav')).toEqual({
      path: `${MIX}/2026/10/17/20261017-173155-199-100-1792247515.1.wav`,
    });
  });

  it('traversal, absolute paths outside, and symlinks out of the tree are 403', async () => {
    expect(await resolveRecordingRequest('../secret.wav')).toEqual({ status: 403 });
    expect(await resolveRecordingRequest('2026/../../secret.wav')).toEqual({ status: 403 });
    expect(await resolveRecordingRequest('/etc/passwd')).toEqual({ status: 403 });
    expect(await resolveRecordingRequest('link.wav')).toEqual({ status: 403 });
    expect(await resolveRecordingRequest('')).toEqual({ status: 403 }); // the root itself
  });

  it('missing is 404', async () => {
    expect(await resolveRecordingRequest('2026/10/17/nope.wav')).toEqual({ status: 404 });
    expect(await resolveRecordingRequest('nope.wav')).toEqual({ status: 404 });
  });

  it('getRecordingPath accepts a stored YYYY/MM/DD path', async () => {
    expect(await getRecordingPath('2026/10/17/20261017-173155-199-100-1792247515.1.wav')).toBe(
      `${MIX}/2026/10/17/20261017-173155-199-100-1792247515.1.wav`,
    );
  });

  it('content types', () => {
    expect(recordingContentType('a.wav')).toBe('audio/x-wav');
    expect(recordingContentType('a.WAV')).toBe('audio/x-wav');
    expect(recordingContentType('a.gsm')).toBe('audio/x-gsm');
    expect(recordingContentType('a')).toBe('audio/wav');
  });
});

describe('retention', () => {
  it('does nothing until a limit is set', async () => {
    write(`${MIX}/2025/01/01/old.wav`, 100, 400);
    expect(await runRecordingRetention()).toEqual({ local_deleted: 0, remote_deleted: 0 });
    expect(fs.existsSync(`${MIX}/2025/01/01/old.wav`)).toBe(true);
  });

  it('by age: old audio in both trees goes, new audio and non-audio files stay', async () => {
    mockSettings.RECORDING_LOCAL_RETENTION_DAYS = '30';
    write(`${MIX}/2025/01/01/old.wav`, 100, 400);
    write(`${SINGLE}/2025/01/01/old-sp1.wav`, 100, 400);
    write(`${MIX}/2025/01/01/notes.txt`, 100, 400);
    write(`${MIX}/2026/10/17/new.wav`, 100);
    expect(await runRecordingRetention()).toEqual({ local_deleted: 2, remote_deleted: 0 });
    expect(fs.existsSync(`${MIX}/2025/01/01/notes.txt`)).toBe(true);
    expect(fs.existsSync(`${MIX}/2026/10/17/new.wav`)).toBe(true);
  });

  it('by size: oldest first until under quota', async () => {
    mockSettings.RECORDING_LOCAL_MAX_SIZE_BYTES = '250';
    write(`${MIX}/a.wav`, 100, 3);
    write(`${MIX}/b.wav`, 100, 2);
    write(`${MIX}/c.wav`, 100, 1);
    expect((await runRecordingRetention()).local_deleted).toBe(1);
    expect(fs.existsSync(`${MIX}/a.wav`)).toBe(false);
    expect(fs.existsSync(`${MIX}/b.wav`)).toBe(true);
  });

  it('storage stats', async () => {
    write(`${MIX}/a.wav`, 100);
    write(`${SINGLE}/a-sp1.wav`, 30);
    const s = await recordingStorageStats();
    expect(s.total_recordings).toBe(2);
    expect(s.local).toMatchObject({ used_bytes: 130, mixed_bytes: 100, legs_bytes: 30, file_count: 2 });
    expect(typeof s.local.disk_free_bytes).toBe('number');
  });
});

describe('deletes', () => {
  it('ring-only cleanup removes the mixed file and both legs of a base', async () => {
    write(`${MIX}/2026/10/17/b.wav`);
    write(`${SINGLE}/2026/10/17/b-sp1.wav`);
    write(`${SINGLE}/2026/10/17/b-sp2.wav`);
    write(`${SINGLE}/2026/10/17/other-sp1.wav`);
    expect(await deleteRingOnlyRecording(`${SINGLE}/2026/10/17/b`)).toBe(3);
    expect(fs.readdirSync(`${SINGLE}/2026/10/17`)).toEqual(['other-sp1.wav']);
    expect(fs.existsSync(`${MIX}/2026/10/17/b.wav`)).toBe(false);
  });

  it('the VAD runner deletes instead of analysing an unanswered call', async () => {
    write(`${MIX}/2026/10/17/u.wav`);
    write(`${SINGLE}/2026/10/17/u-sp1.wav`);
    write(`${SINGLE}/2026/10/17/u-sp2.wav`);
    expect(await waitAndAnalyze(`${SINGLE}/2026/10/17/u`, true)).toBeNull();
    expect(fs.existsSync(`${SINGLE}/2026/10/17/u-sp1.wav`)).toBe(false);
    expect(fs.existsSync(`${MIX}/2026/10/17/u.wav`)).toBe(false);
  });

  it('delete by uniqueid removes the mixed file and its leftover legs', async () => {
    write(`${MIX}/2026/10/17/d.wav`, 500);
    write(`${SINGLE}/2026/10/17/d-sp2.wav`);
    (dbm.getCdrRecordingfile as jest.Mock).mockResolvedValueOnce('d.wav');
    expect(await deleteRecordingByUniqueid('1.1')).toEqual({
      deleted: `${MIX}/2026/10/17/d.wav`,
      deleted_legs: [`${SINGLE}/2026/10/17/d-sp2.wav`],
    });
    expect(await deleteRecordingByUniqueid('1.2')).toEqual({ error: 404, message: 'Recording not found' });
  });
});

describe('policy snapshot', () => {
  it('master switch, format, directions and per-extension state', async () => {
    mockSettings.RECORDING_ENABLED = 'true';
    mockSettings.RECORDING_FORMAT = 'wav';
    expect(await recordingPolicySnapshot()).toEqual({
      engine: 'opdesk',
      enabled: true,
      format: 'wav',
      mixed_dir: MIX,
      single_dir: SINGLE,
      directions: { inbound: true, outbound: false, internal: true },
      hook_conflicts: [],
      extensions: [
        { extension: '100', name: 'Ibrahim', recording: true },
        { extension: '101', name: 'Sara', recording: false },
      ],
    });
  });
});
