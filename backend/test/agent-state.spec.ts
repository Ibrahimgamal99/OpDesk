/**
 * Agent presence (services/agent-state): transitions, Not-Ready reason validation, acting
 * on the members the agent actually has (any interface form), wrap-up, DND, the daily
 * shift reset, AMI reconciliation and startup hydration.
 *
 * The monitor is the real AMIExtensionsMonitor with its AMI round-trip stubbed: every
 * action answers Success (or what a test scripts) and is recorded.
 */

const mockSegments: unknown[][] = [];
const mockLoginQueues: Record<string, string[]> = { '100': ['800', '801'], '101': ['800'] };
const mockReasons: Record<string, Record<string, unknown>> = {
  lunch: { code: 'lunch', label: 'Lunch', is_active: 1, is_system: 0 },
  old: { code: 'old', label: 'Old', is_active: 0, is_system: 0 },
  __WRAPUP: { code: '__WRAPUP', label: 'Wrap-up', is_active: 1, is_system: 1 },
};
const mockSettings: Record<string, string> = {};

jest.mock('../src/db/db-manager', () => ({
  getAgentLoginQueues: jest.fn(async (ext: string) => mockLoginQueues[ext] ?? []),
  pauseReasonForNotReady: jest.fn(async (code: string) => {
    const r = mockReasons[code];
    return r && r.is_active && !r.is_system ? r : null;
  }),
  pauseReasonList: jest.fn(async () => Object.values(mockReasons)),
  agentActivityTransition: jest.fn(async (ext: string, state: string | null, opts: Record<string, unknown> = {}) => {
    mockSegments.push([ext, state, opts.reasonCode ?? null, opts.source ?? null]);
    return 1;
  }),
  agentActivityCloseAllOpen: jest.fn(async () => 0),
  getSetting: jest.fn(async (k: string, d: string | null) => mockSettings[k] ?? d),
  insertCallNotification: jest.fn(async () => 1),
}));
jest.mock('../src/services/vad-runner', () => ({ schedule: jest.fn() }));

import { AgentStateManager, NOT_READY_REASON_ERROR, shiftDayStart, parseShiftResetTime, formatShiftResetTime, SHIFT_RESET_OFF } from '../src/services/agent-state';
import { AMIExtensionsMonitor } from '../src/services/ami';
import { ShiftResetClock } from '../src/services/background';

const raw = (h: Record<string, string>) => Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n';

function setup() {
  const monitor = new AMIExtensionsMonitor({ host: '127.0.0.1', port: 1 });
  monitor.connected = true;
  monitor.monitored = new Set(['100', '101', '102']);
  const actions: Record<string, unknown>[] = [];
  const fail = new Set<string>();
  monitor.sendAsync = (async (action: string, params: Record<string, unknown> | null) => {
    actions.push({ Action: action, ...(params || {}) });
    const key = `${action}:${params?.Interface ?? params?.Key ?? ''}`;
    if (fail.has(key) || fail.has(action)) return 'Response: Error\r\nMessage: Interface not found';
    return 'Response: Success\r\nMessage: ok';
  }) as never;
  const mgr = new AgentStateManager(monitor);
  return { monitor, mgr, actions, fail };
}

beforeEach(() => {
  mockSegments.length = 0;
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
});

describe('login / logout', () => {
  it('login joins the assigned queues with the device driver and goes Ready', async () => {
    const { monitor, mgr, actions } = setup();
    monitor.techByExt.set('100', 'SIP');
    expect(await mgr.login('100')).toEqual([true, 'Logged in to 2 queue(s)']);
    expect(actions.filter((a) => a.Action === 'QueueAdd').map((a) => [a.Queue, a.Interface])).toEqual([
      ['800', 'SIP/100'],
      ['801', 'SIP/100'],
    ]);
    expect(mgr.stateOf('100')).toBe('ready');
    expect(mockSegments).toEqual([['100', 'ready', null, 'ui']]);
    // DND was cleared on the way in.
    expect(actions[0]).toMatchObject({ Action: 'DBDel', Family: 'DND', Key: '100' });
  });

  it('reuses an existing member (feature-code login) instead of adding a duplicate', async () => {
    const { monitor, mgr, actions } = setup();
    await monitor.dispatchAsync(raw({ Event: 'QueueMemberAdded', Queue: '800', Interface: 'Local/100@from-queue/n', Paused: '1', PausedReason: 'lunch' }));
    await mgr.login('100');
    const adds = actions.filter((a) => a.Action === 'QueueAdd').map((a) => a.Queue);
    expect(adds).toEqual(['801']);
    expect(actions.find((a) => a.Action === 'QueuePause')).toMatchObject({ Queue: '800', Interface: 'Local/100@from-queue/n', Paused: '0' });
  });

  it('logout removes every live member in any form and closes the segment', async () => {
    const { monitor, mgr, actions } = setup();
    await mgr.login('100');
    await monitor.dispatchAsync(raw({ Event: 'QueueMemberAdded', Queue: '802', Interface: 'Local/100@from-internal', Paused: '0' }));
    actions.length = 0;
    expect(await mgr.logout('100')).toEqual([true, 'Logged out']);
    expect(actions.filter((a) => a.Action === 'QueueRemove').map((a) => [a.Queue, a.Interface]).sort()).toEqual([
      ['800', 'PJSIP/100'],
      ['801', 'PJSIP/100'],
      ['802', 'Local/100@from-internal'],
    ]);
    expect(mgr.stateOf('100')).toBe('logged_out');
    expect(mockSegments[mockSegments.length - 1]).toEqual(['100', null, null, 'ui']);
  });

  it('login fails without assigned queues', async () => {
    const { mgr } = setup();
    expect((await mgr.login('102'))[0]).toBe(false);
  });
});

describe('Not Ready', () => {
  it('requires an active, non-system reason', async () => {
    const { mgr } = setup();
    await mgr.login('101');
    for (const code of ['', 'nope', 'old', '__WRAPUP']) {
      expect(await mgr.setNotReady('101', code)).toEqual([false, NOT_READY_REASON_ERROR]);
    }
    expect(mgr.stateOf('101')).toBe('ready');
  });

  it('pauses the live members with the code and records it', async () => {
    const { monitor, mgr, actions } = setup();
    await mgr.login('101');
    actions.length = 0;
    expect(await mgr.setNotReady('101', 'lunch')).toEqual([true, 'Not Ready — Lunch']);
    expect(actions).toEqual([{ Action: 'QueuePause', Queue: '800', Interface: 'PJSIP/101', Paused: '1', Reason: 'lunch' }]);
    expect(monitor.queueMembers.get('800:PJSIP/101')).toMatchObject({ paused: true, pause_reason: 'lunch' });
    expect(mgr.snapshot()['101']).toMatchObject({ state: 'not_ready', reason_code: 'lunch', is_agent: true });
    expect(mockSegments[mockSegments.length - 1]).toEqual(['101', 'not_ready', 'lunch', 'ui']);
  });

  it('reports failure (and keeps the state) when no member could be paused', async () => {
    const { mgr, fail } = setup();
    await mgr.login('101');
    fail.add('QueuePause');
    expect((await mgr.setNotReady('101', 'lunch'))[0]).toBe(false);
    expect(mgr.stateOf('101')).toBe('ready');
  });

  it('back to Ready unpauses and clears the reason', async () => {
    const { monitor, mgr } = setup();
    await mgr.login('101');
    await mgr.setNotReady('101', 'lunch');
    expect(await mgr.setReady('101')).toEqual([true, 'Ready']);
    expect(monitor.queueMembers.get('800:PJSIP/101')!.pause_reason).toBeUndefined();
    expect(mgr.snapshot()['101'].reason_code).toBeNull();
  });

  it('a reasonless pause reflected from AMI keeps the known reason', async () => {
    const { monitor, mgr } = setup();
    await mgr.login('101');
    await mgr.setNotReady('101', 'lunch');
    const before = mockSegments.length;
    await mgr.handleAmiEvent({ Event: 'QueueMemberPause', Queue: '800', Interface: 'PJSIP/101', Paused: '1' });
    expect(mgr.snapshot()['101'].reason_code).toBe('lunch');
    expect(mockSegments.length).toBe(before);
    void monitor;
  });
});

describe('AMI reconciliation', () => {
  it('AgentConnect without a session is ignored (no phantom adherence)', async () => {
    const { mgr } = setup();
    await mgr.handleAmiEvent({ Event: 'AgentConnect', Queue: '800', Interface: 'PJSIP/100', Linkedid: '1.1' });
    expect(mgr.stateOf('100')).toBe('logged_out');
    expect(mockSegments).toEqual([]);
  });

  it('a call goes on_call, then wrap-up (__WRAPUP pause), then auto-Ready at the max', async () => {
    jest.useFakeTimers();
    try {
      const { mgr, actions } = setup();
      mockSettings.WRAPUP_MAX_SECS = '30';
      await mgr.login('101');
      await mgr.handleAmiEvent({ Event: 'AgentConnect', Queue: '800', Interface: 'PJSIP/101', Linkedid: '1.1' });
      expect(mgr.snapshot()['101']).toMatchObject({ state: 'on_call', linkedid: '1.1' });
      actions.length = 0;
      await mgr.handleAmiEvent({ Event: 'AgentComplete', Queue: '800', Interface: 'PJSIP/101', Linkedid: '1.1' });
      expect(mgr.snapshot()['101']).toMatchObject({ state: 'wrap_up', reason_code: '__WRAPUP' });
      expect(actions).toEqual([{ Action: 'QueuePause', Queue: '800', Interface: 'PJSIP/101', Paused: '1', Reason: '__WRAPUP' }]);
      // Our own pause repeating back must not open a second segment.
      const n = mockSegments.length;
      await mgr.handleAmiEvent({ Event: 'QueueMemberPause', Queue: '800', Interface: 'PJSIP/101', Paused: '1', PausedReason: '__WRAPUP' });
      expect(mockSegments.length).toBe(n);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(mgr.stateOf('101')).toBe('ready');
    } finally {
      jest.useRealTimers();
    }
  });

  it('finishWrapup returns to Ready; only valid in wrap-up', async () => {
    const { mgr } = setup();
    mockSettings.WRAPUP_MAX_SECS = '0';
    await mgr.login('101');
    expect((await mgr.finishWrapup('101'))[0]).toBe(false);
    await mgr.enterWrapup('101', { linkedid: '2.2' });
    expect(await mgr.finishWrapup('101')).toEqual([true, 'Ready']);
  });

  it('a feature-code login starts a session; removal from every queue ends it', async () => {
    const { monitor, mgr } = setup();
    await monitor.dispatchAsync(raw({ Event: 'QueueMemberAdded', Queue: '800', Interface: 'Local/100@from-queue/n', Paused: '1', PausedReason: 'lunch' }));
    await mgr.handleAmiEvent({ Event: 'QueueMemberAdded', Queue: '800', Interface: 'Local/100@from-queue/n', Paused: '1', PausedReason: 'lunch' });
    expect(mgr.snapshot()['100']).toMatchObject({ state: 'not_ready', reason_code: 'lunch' });
    await monitor.dispatchAsync(raw({ Event: 'QueueMemberRemoved', Queue: '800', Interface: 'Local/100@from-queue/n' }));
    await mgr.handleAmiEvent({ Event: 'QueueMemberRemoved', Queue: '800', Interface: 'Local/100@from-queue/n' });
    expect(mgr.stateOf('100')).toBe('logged_out');
  });
});

describe('DND, hydrate, shift reset', () => {
  it('DND leaves the queues and sets the AstDB flag; plain extensions are not persisted', async () => {
    const { monitor, mgr, actions } = setup();
    await mgr.login('101');
    actions.length = 0;
    expect(await mgr.setDnd('101')).toEqual([true, 'Do Not Disturb']);
    expect(actions.map((a) => a.Action)).toEqual(['QueueRemove', 'DBPut']);
    expect(monitor.dnd.has('101')).toBe(true);
    const n = mockSegments.length;
    await mgr.setAvailable('102'); // not an agent: presence only
    expect(mgr.stateOf('102')).toBe('available');
    expect(mockSegments.length).toBe(n);
  });

  it('hydrate restores Not Ready with its reason, wrap-up, Ready and DND', async () => {
    const { monitor, mgr } = setup();
    monitor.queues.set('800', { members: {}, calls_waiting: 0 });
    monitor.addQueueMember({ queue: '800', interface: 'PJSIP/100', membership: 'dynamic', status: '1', paused: true, pause_reason: 'lunch' });
    monitor.addQueueMember({ queue: '800', interface: 'SIP/101', membership: 'dynamic', status: '1', paused: true, pause_reason: '__WRAPUP' });
    monitor.addQueueMember({ queue: '800', interface: 'PJSIP/102', membership: 'static', status: '1', paused: false });
    monitor.dnd = new Set(['102']);
    mockSettings.WRAPUP_MAX_SECS = '0';
    await mgr.hydrate();
    const snap = mgr.snapshot();
    expect(snap['100']).toMatchObject({ state: 'not_ready', reason_code: 'lunch' });
    expect(snap['101']).toMatchObject({ state: 'wrap_up', reason_code: '__WRAPUP' });
    expect(snap['102']).toMatchObject({ state: 'dnd' });
    expect(snap['100'].since).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?[+-]\d\d:\d\d$/);
  });

  it('daily reset logs out, defers on-call agents and leaves DND alone', async () => {
    const { mgr } = setup();
    await mgr.login('100');
    await mgr.login('101');
    await mgr.handleAmiEvent({ Event: 'AgentConnect', Queue: '800', Interface: 'PJSIP/101', Linkedid: '3.3' });
    const out = await mgr.dailyReset();
    expect(out).toEqual({ logged_out: ['100'], deferred: ['101'], skipped_dnd: [] });
    await mgr.handleAmiEvent({ Event: 'AgentComplete', Queue: '800', Interface: 'PJSIP/101', Linkedid: '3.3' });
    expect(mgr.stateOf('101')).toBe('logged_out');
  });

  it('snapshot filters by extension list', async () => {
    const { mgr } = setup();
    await mgr.login('100');
    await mgr.login('101');
    expect(Object.keys(mgr.snapshot(['101']))).toEqual(['101']);
  });

  it('shift reset time parsing and the boundary clock', () => {
    expect(parseShiftResetTime('06:30')).toBe(390);
    expect(parseShiftResetTime('')).toBeNull();
    expect(parseShiftResetTime('25:00')).toBeNull();
    expect(formatShiftResetTime(390)).toBe('06:30');
    const d = shiftDayStart(new Date(2026, 9, 25, 5, 0), 390);
    expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([24, 6, 30]);
    const clock = new ShiftResetClock(390, new Date(2026, 9, 25, 9, 0));
    expect(clock.due(390, new Date(2026, 9, 25, 23, 0))).toBe(false);
    expect(clock.due(390, new Date(2026, 9, 26, 6, 31))).toBe(true);
    expect(clock.due(390, new Date(2026, 9, 26, 7, 0))).toBe(false);
  });

  it('a new reset time re-anchors the clock instead of firing', () => {
    const clock = new ShiftResetClock(0, new Date(2026, 9, 25, 9, 0));
    // 00:00 -> 15:00 at 14:00: no reset now; the next one is today's 15:00.
    expect(clock.due(900, new Date(2026, 9, 25, 14, 0))).toBe(false);
    expect(clock.due(900, new Date(2026, 9, 25, 14, 55))).toBe(false);
    expect(clock.due(900, new Date(2026, 9, 25, 15, 1))).toBe(true);
    // Off, then on again: re-armed, no burst.
    expect(clock.due(null, new Date(2026, 9, 25, 16, 0))).toBe(false);
    expect(clock.due(900, new Date(2026, 9, 26, 16, 0))).toBe(false);
    expect(clock.due(900, new Date(2026, 9, 27, 15, 1))).toBe(true);
  });

  it("'off' is how the turned-off reset is stored and read", () => {
    expect(parseShiftResetTime(SHIFT_RESET_OFF)).toBeNull();
  });
});
