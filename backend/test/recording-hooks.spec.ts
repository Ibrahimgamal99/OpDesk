/**
 * Recording is only "on" when Asterisk actually runs [opdesk-record] from the predial hooks.
 * Duplicate contexts are first-wins, so another recorder #included earlier (Echo on a shared
 * box) keeps the hooks and OpDesk's file loses silently. recordingHookConflicts reads back
 * what was loaded; the enable route refuses (409) and rolls back when the hooks are taken.
 *
 * child_process is mocked: `dialplan show` answers come from the fixtures below, captured
 * from a real FreePBX box with Echo installed.
 */

const mockCli: Record<string, string> = {};
jest.mock('child_process', () => ({
  execFile: jest.fn((_file: string, args: string[], _opts: unknown, cb: (e: unknown, out: Buffer, err: Buffer) => void) => {
    const cmd = args[args.length - 1];
    cb(null, Buffer.from(mockCli[cmd] ?? ''), Buffer.from(''));
    return { stdin: { on: () => undefined, end: () => undefined } };
  }),
}));
jest.mock('../src/db/db-manager', () => ({
  getSetting: jest.fn(async (_k: string, d: unknown) => d),
  setSetting: jest.fn(async () => true),
}));
jest.mock('../src/core/audit', () => ({ setRedactedAuditDetail: jest.fn() }));

import * as dbm from '../src/db/db-manager';
import * as dialplan from '../src/services/dialplan';
import { hookConflictMessage, RecordingController } from '../src/api/routes/recording.controller';

const ONE = 'dialplan show s@macro-dialout-one-predial-hook';
const TRUNK = 'dialplan show s@macro-dialout-trunk-predial-hook';

const ECHO_ONE = `[ Context 'macro-dialout-one-predial-hook' created by 'pbx_config' ]
  's' =>            1. GosubIf($["\${ECHO_REC}"=""]?echo-record,s,1) [extensions_echo_record.conf:17]
                    2. Return()                                   [extensions_echo_record.conf:19]
`;
const ECHO_TRUNK = ECHO_ONE.replace('one-predial', 'trunk-predial');
const OURS_ONE = `[ Context 'macro-dialout-one-predial-hook' created by 'pbx_config' ]
  's' =>            1. GosubIf($["\${OPDESK_REC}"=""]?opdesk-record,s,1) [extensions_opdesk_record.conf:19]
                    2. Return()                                   [extensions_opdesk_record.conf:20]
`;
// The trunk hook a site defined in extensions_custom.conf, with our line chained in.
const CHAINED_TRUNK = `[ Context 'macro-dialout-trunk-predial-hook' created by 'pbx_config' ]
  's' =>            1. NoOp(site hook)                            [extensions_custom.conf:80]
                    2. GosubIf($["\${OPDESK_REC}"=""]?opdesk-record,s,1) [extensions_custom.conf:81]
`;

beforeEach(() => {
  for (const k of Object.keys(mockCli)) delete mockCli[k];
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('recordingHookConflicts', () => {
  test('both hooks ours (or chained into a site hook): no conflict', async () => {
    mockCli[ONE] = OURS_ONE;
    mockCli[TRUNK] = CHAINED_TRUNK;
    expect(await dialplan.recordingHookConflicts()).toEqual([]);
  });

  test("another recorder's file kept the hooks: named per hook", async () => {
    mockCli[ONE] = ECHO_ONE;
    mockCli[TRUNK] = ECHO_TRUNK;
    expect(await dialplan.recordingHookConflicts()).toEqual([
      { context: 'macro-dialout-one-predial-hook', file: 'extensions_echo_record.conf' },
      { context: 'macro-dialout-trunk-predial-hook', file: 'extensions_echo_record.conf' },
    ]);
  });

  test('a hook that did not load at all has no owning file', async () => {
    mockCli[ONE] = OURS_ONE;
    mockCli[TRUNK] = "There is no existence of 's@macro-dialout-trunk-predial-hook' extension\n";
    expect(await dialplan.recordingHookConflicts()).toEqual([{ context: 'macro-dialout-trunk-predial-hook', file: null }]);
  });
});

describe('hookConflictMessage', () => {
  test('names each owning file once and says what to do', () => {
    const msg = hookConflictMessage([
      { context: 'a', file: 'extensions_echo_record.conf' },
      { context: 'b', file: 'extensions_echo_record.conf' },
    ]);
    expect(msg).toContain('extensions_echo_record.conf already defines the PBX predial hooks');
    expect(msg.match(/extensions_echo_record\.conf/g)).toHaveLength(1);
    expect(msg).toContain('#include');
  });

  test('no file: the hooks did not load', () => {
    expect(hookConflictMessage([{ context: 'a', file: null }])).toMatch(/did not load/);
  });
});

describe('POST /api/recording/enable', () => {
  const ctl = new RecordingController();
  const req = { body: { format: 'wav' } } as never;

  test('hooks taken by another file: 409, rolled back, switch stays off', async () => {
    jest.spyOn(dialplan, 'enableRecording').mockResolvedValue(true);
    const disable = jest.spyOn(dialplan, 'disableRecording').mockResolvedValue(true);
    jest.spyOn(dialplan, 'recordingHookConflicts').mockResolvedValue([
      { context: 'macro-dialout-one-predial-hook', file: 'extensions_echo_record.conf' },
    ]);
    await expect(ctl.enableRecordingEndpoint(req)).rejects.toMatchObject({ status: 409 });
    expect(disable).toHaveBeenCalledTimes(1);
    expect(dbm.setSetting).toHaveBeenCalledWith('RECORDING_ENABLED', 'false');
    expect(dbm.setSetting).not.toHaveBeenCalledWith('RECORDING_ENABLED', 'true');
  });

  test('hooks wired: enabled', async () => {
    jest.spyOn(dialplan, 'enableRecording').mockResolvedValue(true);
    const disable = jest.spyOn(dialplan, 'disableRecording').mockResolvedValue(true);
    jest.spyOn(dialplan, 'recordingHookConflicts').mockResolvedValue([]);
    await ctl.enableRecordingEndpoint(req);
    expect(disable).not.toHaveBeenCalled();
    expect(dbm.setSetting).toHaveBeenCalledWith('RECORDING_ENABLED', 'true');
  });

  test('Asterisk could not be asked (null): not treated as a conflict', async () => {
    jest.spyOn(dialplan, 'enableRecording').mockResolvedValue(true);
    jest.spyOn(dialplan, 'recordingHookConflicts').mockResolvedValue(null);
    await ctl.enableRecordingEndpoint(req);
    expect(dbm.setSetting).toHaveBeenCalledWith('RECORDING_ENABLED', 'true');
  });
});
