/**
 * Presence (services/agent-state): availability (reachability-driven, every extension:
 * Available / On Call / Break / Wrap-up) and queue login as independent layers; DND as a
 * call-blocking flag that leaves and later rejoins the queues; the daily shift reset; AMI
 * reconciliation and startup hydration.
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
const mockRows: string[][] = [];
const mockSavedBreaks: Record<string, string> = {};

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
  agentActivityOpenBreaks: jest.fn(async () => new Map(Object.entries(mockSavedBreaks))),
  queueLoginOpen: jest.fn(async (ext: string) => { mockRows.push(['queue_login', 'open', ext]); return true; }),
  queueLoginClose: jest.fn(async (ext: string) => { mockRows.push(['queue_login', 'close', ext]); return true; }),
  queueLoginCloseAllOpen: jest.fn(async () => 0),
  dndOpen: jest.fn(async (ext: string) => { mockRows.push(['dnd', 'open', ext]); return true; }),
  dndClose: jest.fn(async (ext: string) => { mockRows.push(['dnd', 'close', ext]); return true; }),
  dndCloseAllOpen: jest.fn(async () => 0),
  getSetting: jest.fn(async (k: string, d: string | null) => mockSettings[k] ?? d),
  insertCallNotification: jest.fn(async () => 1),
}));
jest.mock('../src/services/vad-runner', () => ({ schedule: jest.fn() }));

import { AgentStateManager, NOT_READY_REASON_ERROR, OFFLINE_ERROR, shiftDayStart, parseShiftResetTime, formatShiftResetTime, SHIFT_RESET_OFF } from '../src/services/agent-state';
import { AMIExtensionsMonitor } from '../src/services/ami';
import { ShiftResetClock } from '../src/services/background';
import type { ReachVia } from '../src/services/registration';

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
  const reach = new Map<string, ReachVia>();
  mgr.registration = { viaOf: (e: string) => reach.get(e) ?? null };
  /** The phone registers (or, with via='push', is asleep but wakeable). */
  const online = async (ext: string, via: ReachVia = 'sip') => {
    const prev = reach.get(ext) ?? null;
    reach.set(ext, via);
    await mgr.onReachability(ext, via, 'ami', prev);
  };
  const offline = async (ext: string) => {
    const prev = reach.get(ext) ?? null;
    reach.delete(ext);
    await mgr.onReachability(ext, null, 'ami', prev);
  };
  /** Moves the presence clock forward, past (or inside) the blip and wake windows. */
  let now = 1000;
  mgr.clock = () => now;
  const tick = (secs: number) => { now += secs; };
  /** The device answers / hangs up a call (real channel, as monitor.answeredCh holds it). */
  const answer = async (ext: string, linkedid = '9.9') => {
    const ch = `PJSIP/${ext}-0000000${ext.slice(-1)}`;
    monitor.answeredCh.set(ch, ext);
    monitor.ch2linkedid.set(ch, linkedid);
    await mgr.handleAmiEvent({ Event: 'Newstate', Channel: ch, ChannelStateDesc: 'Up' });
  };
  const hangup = async (ext: string) => {
    const ch = `PJSIP/${ext}-0000000${ext.slice(-1)}`;
    monitor.answeredCh.delete(ch);
    await mgr.handleAmiEvent({ Event: 'Hangup', Channel: ch });
  };
  return { monitor, mgr, actions, fail, reach, online, offline, answer, hangup, tick };
}

beforeEach(() => {
  mockSegments.length = 0;
  mockRows.length = 0;
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  for (const k of Object.keys(mockSavedBreaks)) delete mockSavedBreaks[k];
});

describe('availability follows reachability', () => {
  it('a plain extension registers -> Available, unregisters -> offline, persisted', async () => {
    const { mgr, online, offline } = setup();
    await online('102');
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'ready', is_agent: false, queue_logged_in: false, reachable_via: 'sip' });
    await offline('102');
    expect(mgr.stateOf('102')).toBe('logged_out');
    expect(mockSegments).toEqual([['102', 'ready', null, 'ami'], ['102', null, null, 'ami']]);
  });

  it('any answered call is On Call, hang-up is Available again', async () => {
    const { mgr, online, answer, hangup } = setup();
    await online('102');
    await answer('102', '5.5');
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'on_call', linkedid: '5.5' });
    await hangup('102');
    expect(mgr.stateOf('102')).toBe('ready');
  });

  it('a Busy hint with no channel (Custom:DND from *78) is not a call', async () => {
    const { monitor, mgr, online } = setup();
    await online('102');
    await monitor.dispatchAsync(raw({ Event: 'ExtensionStatus', Exten: '102', Status: '2' }));
    await mgr.handleAmiEvent({ Event: 'ExtensionStatus', Exten: '102', Status: '2' });
    expect(mgr.stateOf('102')).toBe('ready');
  });

  it('registering while already on a call opens On Call', async () => {
    const { monitor, mgr, online } = setup();
    monitor.answeredCh.set('PJSIP/102-00000002', '102');
    await online('102');
    expect(mgr.stateOf('102')).toBe('on_call');
  });
});

describe('break (Not Ready) for every extension', () => {
  it('requires an active, non-system reason', async () => {
    const { mgr, online } = setup();
    await online('101');
    for (const code of ['', 'nope', 'old', '__WRAPUP']) {
      expect(await mgr.setNotReady('101', code)).toEqual([false, NOT_READY_REASON_ERROR]);
    }
    expect(mgr.stateOf('101')).toBe('ready');
  });

  it('offline during a break: held (break_offline row); back push-only it resumes', async () => {
    const { mgr, online, offline, tick } = setup();
    await online('102');
    await mgr.setNotReady('102', 'lunch');
    await offline('102');
    expect(mockSegments[mockSegments.length - 1]).toEqual(['102', 'break_offline', 'lunch', 'ami']);
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'logged_out', held_break: 'lunch' });
    tick(2 * 3600); // laptop closed for two hours
    await online('102', 'push');
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'not_ready', reason_code: 'lunch', held_break: null });
  });

  it('registering again after a held break is Available (the break ends)', async () => {
    const { mgr, online, offline, tick } = setup();
    await online('102');
    await mgr.setNotReady('102', 'lunch');
    await offline('102');
    tick(3600);
    await online('102');
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'ready', held_break: null });
  });

  it('Available while offline on a break ends the hold (a supervisor can end it)', async () => {
    const { mgr, online, offline } = setup();
    await online('102');
    await mgr.setNotReady('102', 'lunch');
    await offline('102');
    expect(await mgr.setReady('102', 'supervisor')).toEqual([true, 'Break ended (the phone is offline)']);
    expect(mockSegments[mockSegments.length - 1]).toEqual(['102', null, null, 'supervisor']);
    await online('102');
    expect(mgr.stateOf('102')).toBe('ready');
  });

  it('DND while offline on a break ends the hold too', async () => {
    const { mgr, online, offline } = setup();
    await online('102');
    await mgr.setNotReady('102', 'lunch');
    await offline('102');
    await mgr.setDnd('102', true);
    expect(mgr.snapshot()['102']).toMatchObject({ held_break: null, dnd: true });
    await online('102');
    expect(mgr.stateOf('102')).toBe('ready');
  });

  it('going offline while Available holds nothing', async () => {
    const { mgr, online, offline } = setup();
    await online('102');
    await offline('102');
    expect(mockSegments[mockSegments.length - 1]).toEqual(['102', null, null, 'ami']);
    expect(mgr.snapshot()['102']).toBeUndefined();
  });

  it('a restart while offline on a break keeps holding it', async () => {
    const { mgr } = setup();
    mockSavedBreaks['102'] = 'lunch';
    await mgr.hydrate();
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'logged_out', held_break: 'lunch' });
    expect(mockSegments[mockSegments.length - 1]).toEqual(['102', 'break_offline', 'lunch', 'system']);
  });

  it('an offline extension cannot take a break', async () => {
    const { mgr } = setup();
    expect(await mgr.setNotReady('102', 'lunch')).toEqual([false, OFFLINE_ERROR]);
  });

  it('a plain extension takes a break without any queue action, and calls do not end it', async () => {
    const { mgr, actions, online, answer, hangup } = setup();
    await online('102');
    actions.length = 0;
    expect(await mgr.setNotReady('102', 'lunch')).toEqual([true, 'Not Ready — Lunch']);
    expect(actions).toEqual([]);
    expect(mockSegments[mockSegments.length - 1]).toEqual(['102', 'not_ready', 'lunch', 'ui']);
    await answer('102');
    await hangup('102');
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'not_ready', reason_code: 'lunch' });
    expect(await mgr.setReady('102')).toEqual([true, 'Available']);
    expect(mgr.stateOf('102')).toBe('ready');
  });

  it('in the queues, a break pauses the live members with the code; Available unpauses', async () => {
    const { monitor, mgr, actions, online } = setup();
    await online('101');
    await mgr.queueLogin('101');
    actions.length = 0;
    expect(await mgr.setNotReady('101', 'lunch')).toEqual([true, 'Not Ready — Lunch']);
    expect(actions).toEqual([{ Action: 'QueuePause', Queue: '800', Interface: 'PJSIP/101', Paused: '1', Reason: 'lunch' }]);
    expect(monitor.queueMembers.get('800:PJSIP/101')).toMatchObject({ paused: true, pause_reason: 'lunch' });
    expect(await mgr.setReady('101')).toEqual([true, 'Available']);
    expect(monitor.queueMembers.get('800:PJSIP/101')!.paused).toBe(false);
  });

  it.each(['event first', 'event second'])('Available + the PBX Unpause event write ONE row (%s)', async (order) => {
    const { monitor, mgr, online } = setup();
    await online('101');
    await mgr.queueLogin('101');
    await mgr.setNotReady('101', 'lunch');
    const unpauseEvent = () => mgr.handleAmiEvent({ Event: 'QueueMemberUnpause', Queue: '800', Interface: 'PJSIP/101', Paused: '0' });
    const send = monitor.sendAsync as (a: string, p: Record<string, unknown> | null) => Promise<string>;
    let pending: Promise<void> | null = null;
    monitor.sendAsync = (async (action: string, params: Record<string, unknown> | null) => {
      const r = await send(action, params);
      if (action === 'QueuePause' && params?.Paused === '0' && order === 'event first') {
        // The member is already unpaused locally when the event lands mid-setReady.
        monitor.queueMembers.get('800:PJSIP/101')!.paused = false;
        pending = unpauseEvent();
      }
      return r;
    }) as never;
    const before = mockSegments.length;
    await mgr.setReady('101');
    if (order === 'event second') await unpauseEvent();
    if (pending) await pending;
    const rows = mockSegments.slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0].slice(0, 3)).toEqual(['101', 'ready', null]);
  });

  it('reports failure (and keeps the state) when no member could be paused', async () => {
    const { mgr, fail, online } = setup();
    await online('101');
    await mgr.queueLogin('101');
    fail.add('QueuePause');
    expect((await mgr.setNotReady('101', 'lunch'))[0]).toBe(false);
    expect(mgr.stateOf('101')).toBe('ready');
  });

  it('a reasonless pause reflected from AMI keeps the known reason', async () => {
    const { mgr, online } = setup();
    await online('101');
    await mgr.queueLogin('101');
    await mgr.setNotReady('101', 'lunch');
    const before = mockSegments.length;
    await mgr.handleAmiEvent({ Event: 'QueueMemberPause', Queue: '800', Interface: 'PJSIP/101', Paused: '1' });
    expect(mgr.snapshot()['101'].reason_code).toBe('lunch');
    expect(mockSegments.length).toBe(before);
  });
});

describe('queue login is independent of availability', () => {
  it('login joins the assigned queues with the device driver; availability unchanged', async () => {
    const { monitor, mgr, actions, online } = setup();
    monitor.techByExt.set('100', 'SIP');
    await online('100');
    const segs = mockSegments.length;
    expect(await mgr.queueLogin('100')).toEqual([true, 'Logged in to 2 queue(s)']);
    expect(actions.filter((a) => a.Action === 'QueueAdd').map((a) => [a.Queue, a.Interface])).toEqual([
      ['800', 'SIP/100'],
      ['801', 'SIP/100'],
    ]);
    expect(mgr.snapshot()['100']).toMatchObject({ state: 'ready', queue_logged_in: true, queues: ['800', '801'] });
    expect(mockSegments.length).toBe(segs);
    expect(mockRows).toEqual([['queue_login', 'open', '100']]);
  });

  it('logging in on a break joins paused with the break reason', async () => {
    const { mgr, actions, online } = setup();
    await online('101');
    await mgr.setNotReady('101', 'lunch');
    actions.length = 0;
    await mgr.queueLogin('101');
    expect(actions.map((a) => [a.Action, a.Paused ?? '', a.Reason ?? ''])).toEqual([
      ['QueueAdd', '1', ''],
      ['QueuePause', '1', 'lunch'],
    ]);
  });

  it('reuses an existing member (feature-code login) instead of adding a duplicate', async () => {
    const { monitor, mgr, actions } = setup();
    await monitor.dispatchAsync(raw({ Event: 'QueueMemberAdded', Queue: '800', Interface: 'Local/100@from-queue/n', Paused: '1', PausedReason: 'lunch' }));
    await mgr.queueLogin('100');
    const adds = actions.filter((a) => a.Action === 'QueueAdd').map((a) => a.Queue);
    expect(adds).toEqual(['801']);
    expect(actions.find((a) => a.Action === 'QueuePause')).toMatchObject({ Queue: '800', Interface: 'Local/100@from-queue/n', Paused: '0' });
  });

  it('logout removes every live member in any form; availability stays', async () => {
    const { monitor, mgr, actions, online } = setup();
    await online('100');
    await mgr.queueLogin('100');
    await monitor.dispatchAsync(raw({ Event: 'QueueMemberAdded', Queue: '802', Interface: 'Local/100@from-internal', Paused: '0' }));
    actions.length = 0;
    expect((await mgr.queueLogout('100'))[0]).toBe(true);
    expect(actions.filter((a) => a.Action === 'QueueRemove').map((a) => [a.Queue, a.Interface]).sort()).toEqual([
      ['800', 'PJSIP/100'],
      ['801', 'PJSIP/100'],
      ['802', 'Local/100@from-internal'],
    ]);
    expect(mgr.snapshot()['100']).toMatchObject({ state: 'ready', queue_logged_in: false });
    expect(mockRows[mockRows.length - 1]).toEqual(['queue_login', 'close', '100']);
  });

  it('login fails without assigned queues', async () => {
    const { mgr } = setup();
    expect((await mgr.queueLogin('102'))[0]).toBe(false);
  });

  it('a feature-code login opens a queue session; removal from every queue ends it', async () => {
    const { monitor, mgr, online } = setup();
    await online('100');
    await monitor.dispatchAsync(raw({ Event: 'QueueMemberAdded', Queue: '800', Interface: 'Local/100@from-queue/n', Paused: '1', PausedReason: 'lunch' }));
    await mgr.handleAmiEvent({ Event: 'QueueMemberAdded', Queue: '800', Interface: 'Local/100@from-queue/n', Paused: '1', PausedReason: 'lunch' });
    expect(mgr.snapshot()['100']).toMatchObject({ state: 'not_ready', reason_code: 'lunch', queue_logged_in: true });
    await monitor.dispatchAsync(raw({ Event: 'QueueMemberRemoved', Queue: '800', Interface: 'Local/100@from-queue/n' }));
    await mgr.handleAmiEvent({ Event: 'QueueMemberRemoved', Queue: '800', Interface: 'Local/100@from-queue/n' });
    expect(mgr.snapshot()['100']).toMatchObject({ state: 'not_ready', queue_logged_in: false });
  });

  it('offline, however long: stays in the queues (only logout, DND or the reset end it)', async () => {
    jest.useFakeTimers();
    try {
      const { mgr, online, offline } = setup();
      await online('101');
      await mgr.queueLogin('101');
      await offline('101');
      await jest.advanceTimersByTimeAsync(3600_000);
      expect(mgr.snapshot()['101']).toMatchObject({ state: 'logged_out', queue_logged_in: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it('asleep but push-wakeable: still Available and in the queues', async () => {
    const { mgr, online } = setup();
    await online('101');
    await mgr.queueLogin('101');
    await online('101', 'push'); // the hint went Unavailable; the tracker says push
    expect(mgr.snapshot()['101']).toMatchObject({ state: 'ready', queue_logged_in: true, reachable_via: 'push' });
  });
});

describe('ACD calls', () => {
  it('AgentConnect while offline is ignored (no phantom adherence)', async () => {
    const { mgr } = setup();
    await mgr.handleAmiEvent({ Event: 'AgentConnect', Queue: '800', Interface: 'PJSIP/100', Linkedid: '1.1' });
    expect(mgr.stateOf('100')).toBe('logged_out');
    expect(mockSegments).toEqual([]);
  });

  it('a call goes on_call, then wrap-up (__WRAPUP pause), then auto-Available at the max', async () => {
    jest.useFakeTimers();
    try {
      const { mgr, actions, online } = setup();
      mockSettings.WRAPUP_MAX_SECS = '30';
      await online('101');
      await mgr.queueLogin('101');
      await mgr.handleAmiEvent({ Event: 'AgentConnect', Queue: '800', Interface: 'PJSIP/101', Linkedid: '1.1' });
      expect(mgr.snapshot()['101']).toMatchObject({ state: 'on_call', linkedid: '1.1' });
      actions.length = 0;
      await mgr.handleAmiEvent({ Event: 'AgentComplete', Queue: '800', Interface: 'PJSIP/101', Linkedid: '1.1' });
      expect(mgr.snapshot()['101']).toMatchObject({ state: 'wrap_up', reason_code: '__WRAPUP' });
      expect(actions).toEqual([{ Action: 'QueuePause', Queue: '800', Interface: 'PJSIP/101', Paused: '1', Reason: '__WRAPUP' }]);
      const n = mockSegments.length;
      await mgr.handleAmiEvent({ Event: 'QueueMemberPause', Queue: '800', Interface: 'PJSIP/101', Paused: '1', PausedReason: '__WRAPUP' });
      expect(mockSegments.length).toBe(n);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(mgr.stateOf('101')).toBe('ready');
    } finally {
      jest.useRealTimers();
    }
  });

  it('the device call and the ACD call are one On Call segment; hang-up waits for AgentComplete', async () => {
    const { mgr, online, answer, hangup } = setup();
    mockSettings.WRAPUP_MAX_SECS = '0';
    await online('101');
    await mgr.queueLogin('101');
    await answer('101', '7.7');
    const n = mockSegments.length;
    await mgr.handleAmiEvent({ Event: 'AgentConnect', Queue: '800', Interface: 'PJSIP/101', Linkedid: '7.7' });
    expect(mockSegments.length).toBe(n);
    await hangup('101');
    expect(mgr.stateOf('101')).toBe('on_call');
    await mgr.handleAmiEvent({ Event: 'AgentComplete', Queue: '800', Interface: 'PJSIP/101', Linkedid: '7.7' });
    expect(mgr.stateOf('101')).toBe('wrap_up');
  });

  it('finishWrapup returns to Available; only valid in wrap-up', async () => {
    const { mgr, online } = setup();
    mockSettings.WRAPUP_MAX_SECS = '0';
    await online('101');
    await mgr.queueLogin('101');
    expect((await mgr.finishWrapup('101'))[0]).toBe(false);
    await mgr.enterWrapup('101', { linkedid: '2.2' });
    expect(await mgr.finishWrapup('101')).toEqual([true, 'Available']);
  });
});

describe('DND', () => {
  it('DND on leaves the queues (remembered), DND off rejoins them; availability untouched', async () => {
    const { monitor, mgr, actions, online } = setup();
    await online('101');
    await mgr.queueLogin('101');
    actions.length = 0;
    expect(await mgr.setDnd('101', true)).toEqual([true, 'Do Not Disturb']);
    expect(actions.map((a) => [a.Action, a.Family ?? a.Queue])).toEqual([
      ['DBPut', 'DND'],
      ['DBPut', 'OPDESK_DNDQ'],
      ['QueueRemove', '800'],
    ]);
    expect(monitor.dnd.has('101')).toBe(true);
    expect(mgr.snapshot()['101']).toMatchObject({ state: 'ready', dnd: true, queue_logged_in: false });
    actions.length = 0;
    expect((await mgr.setDnd('101', false))[0]).toBe(true);
    expect(actions.map((a) => [a.Action, a.Family ?? a.Queue])).toEqual([
      ['DBDel', 'DND'],
      ['DBDel', 'OPDESK_DNDQ'],
      ['QueueAdd', '800'],
    ]);
    expect(mgr.snapshot()['101']).toMatchObject({ state: 'ready', dnd: false, queue_logged_in: true });
    expect(mockRows.filter((r) => r[0] === 'dnd')).toEqual([['dnd', 'open', '101'], ['dnd', 'close', '101']]);
  });

  it('on DND an outbound call is still On Call, then Available', async () => {
    const { mgr, online, answer, hangup } = setup();
    await online('102');
    await mgr.setDnd('102', true);
    await answer('102');
    expect(mgr.stateOf('102')).toBe('on_call');
    await hangup('102');
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'ready', dnd: true });
  });

  it('a *78 found by the reconcile sweep applies the same side effects', async () => {
    const { monitor, mgr, actions, online } = setup();
    await online('101');
    await mgr.queueLogin('101');
    monitor.dbGetFamily = (async () => ({ '101': 'YES' })) as never;
    actions.length = 0;
    await mgr.reconcileDnd();
    expect(actions.map((a) => a.Action)).toEqual(['DBPut', 'QueueRemove']);
    expect(mgr.snapshot()['101']).toMatchObject({ dnd: true, queue_logged_in: false });
  });

  it('DND overrides a break: the break ends and the state is Available (Idle on DND)', async () => {
    const { mgr, online } = setup();
    await online('102');
    await mgr.setNotReady('102', 'lunch');
    await mgr.setDnd('102', true);
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'ready', reason_code: null, dnd: true });
    expect(mockSegments[mockSegments.length - 1]).toEqual(['102', 'ready', null, 'ui']);
    await mgr.setDnd('102', false);
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'ready', dnd: false });
  });

  it('DND overrides wrap-up too', async () => {
    const { mgr, online } = setup();
    mockSettings.WRAPUP_MAX_SECS = '0';
    await online('101');
    await mgr.queueLogin('101');
    await mgr.enterWrapup('101', { linkedid: '4.4' });
    await mgr.setDnd('101', true);
    expect(mgr.snapshot()['101']).toMatchObject({ state: 'ready', dnd: true, queue_logged_in: false });
  });

  it('taking a break turns DND off (and rejoins the queues, paused with the reason)', async () => {
    const { monitor, mgr, online } = setup();
    await online('101');
    await mgr.queueLogin('101');
    await mgr.setDnd('101', true);
    expect(await mgr.setNotReady('101', 'lunch')).toEqual([true, 'Not Ready — Lunch']);
    expect(monitor.dnd.has('101')).toBe(false);
    expect(mgr.snapshot()['101']).toMatchObject({ state: 'not_ready', reason_code: 'lunch', dnd: false, queue_logged_in: true });
    expect(monitor.queueMembers.get('800:PJSIP/101')).toMatchObject({ paused: true, pause_reason: 'lunch' });
  });

  it('a short drop while on DND does not bring back an old break', async () => {
    const { mgr, online, offline } = setup();
    await online('102');
    await mgr.setNotReady('102', 'lunch');
    await mgr.setDnd('102', true);
    await offline('102');
    await online('102');
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'ready', dnd: true });
  });

  it('queue login clears DND', async () => {
    const { monitor, mgr, online } = setup();
    await online('101');
    await mgr.setDnd('101', true);
    await mgr.queueLogin('101');
    expect(monitor.dnd.has('101')).toBe(false);
    expect(mgr.snapshot()['101']).toMatchObject({ dnd: false, queue_logged_in: true });
  });
});

describe('hydrate, shift reset', () => {
  it('hydrate restores breaks (queue reason or saved), wrap-up, Available, queue sessions and DND', async () => {
    const { monitor, mgr, reach } = setup();
    monitor.queues.set('800', { members: {}, calls_waiting: 0 });
    monitor.addQueueMember({ queue: '800', interface: 'PJSIP/100', membership: 'dynamic', status: '1', paused: true, pause_reason: 'lunch' });
    monitor.addQueueMember({ queue: '800', interface: 'SIP/101', membership: 'dynamic', status: '1', paused: true, pause_reason: '__WRAPUP' });
    monitor.dnd = new Set(['102']);
    mockSavedBreaks['102'] = 'lunch';
    for (const e of ['100', '101', '102']) reach.set(e, 'sip');
    mockSettings.WRAPUP_MAX_SECS = '0';
    await mgr.hydrate();
    const snap = mgr.snapshot();
    expect(snap['100']).toMatchObject({ state: 'not_ready', reason_code: 'lunch', queue_logged_in: true });
    expect(snap['101']).toMatchObject({ state: 'wrap_up', reason_code: '__WRAPUP', queue_logged_in: true });
    // DND overrides the saved break: Available (Idle on DND).
    expect(snap['102']).toMatchObject({ state: 'ready', reason_code: null, dnd: true, queue_logged_in: false });
    expect(snap['100'].since).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?[+-]\d\d:\d\d$/);
  });

  it('hydrate leaves unreachable extensions offline', async () => {
    const { mgr } = setup();
    await mgr.hydrate();
    expect(mgr.snapshot()).toEqual({});
  });

  it('daily reset: nobody leaves a queue; idle signs off, a call signs off when it ends', async () => {
    const { mgr, online } = setup();
    await online('100');
    await online('101');
    await mgr.queueLogin('100');
    await mgr.queueLogin('101');
    await mgr.handleAmiEvent({ Event: 'AgentConnect', Queue: '800', Interface: 'PJSIP/101', Linkedid: '3.3' });
    const out = await mgr.dailyReset();
    expect(out).toEqual({ counters_reset: ['101'], signed_off: ['100'], sign_off_after_call: ['101'] });
    expect(mgr.snapshot()['100']).toMatchObject({ state: 'logged_out', signed_off: true, queue_logged_in: true });
    await mgr.handleAmiEvent({ Event: 'AgentComplete', Queue: '800', Interface: 'PJSIP/101', Linkedid: '3.3' });
    expect(mgr.snapshot()['101']).toMatchObject({ state: 'logged_out', signed_off: true, queue_logged_in: true });
  });

  it('daily reset restarts a break timer and splits its row; the break goes on', async () => {
    const { mgr, online } = setup();
    await online('102');
    await mgr.setNotReady('102', 'lunch');
    mockSegments.length = 0;
    const out = await mgr.dailyReset();
    expect(out).toEqual({ counters_reset: ['102'], signed_off: [], sign_off_after_call: [] });
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'not_ready', reason_code: 'lunch', signed_off: false });
    expect(mockSegments).toEqual([['102', 'not_ready', 'lunch', 'system']]);
  });

  it('snapshot filters by extension list', async () => {
    const { mgr, online } = setup();
    await online('100');
    await online('101');
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

describe('a phone that registers', () => {
  it('ends a break still on its queue members: unpaused, Available', async () => {
    const { mgr, online, offline, actions, tick } = setup();
    await online('101');
    await mgr.queueLogin('101');
    await mgr.setNotReady('101', 'lunch');
    await online('101', 'push');
    await offline('101');
    tick(600);
    actions.length = 0;
    await online('101');
    expect(actions.some((a) => a.Action === 'QueuePause' && a.Paused === '0')).toBe(true);
    expect(mgr.snapshot()['101']).toMatchObject({ state: 'ready', queue_logged_in: true });
  });

  it('a network blip keeps a break, through push or through offline', async () => {
    const { mgr, online, offline, tick } = setup();
    await online('102');
    await mgr.setNotReady('102', 'lunch');
    await online('102', 'push');
    tick(30);
    await online('102');
    expect(mgr.stateOf('102')).toBe('not_ready');
    await offline('102');
    tick(30);
    await online('102');
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'not_ready', reason_code: 'lunch' });
  });

  it('a mobile woken for a call keeps its break; a wake long ago does not count', async () => {
    const { mgr, online, tick } = setup();
    let woken: number | null = null;
    mgr.wokenAt = () => woken;
    await online('102', 'push');
    await mgr.setNotReady('102', 'lunch');
    woken = mgr.clock();
    await online('102');
    expect(mgr.stateOf('102')).toBe('not_ready');
    await online('102', 'push');
    tick(300);
    await online('102');
    expect(mgr.stateOf('102')).toBe('ready');
  });

  it('leaves DND on and a live call alone', async () => {
    const { mgr, online, answer, tick } = setup();
    await online('102', 'push');
    await answer('102');
    tick(300);
    await online('102');
    expect(mgr.stateOf('102')).toBe('on_call');
    await online('101', 'push');
    await mgr.setDnd('101', true);
    tick(300);
    await online('101');
    expect(mgr.snapshot()['101']).toMatchObject({ state: 'ready', dnd: true });
  });
});

describe('shift-end sign-off', () => {
  const signedOff = async () => {
    const s = setup();
    await s.online('102');
    await s.mgr.dailyReset();
    return s;
  };

  it('closes the idle row, shows signed_off and is kept in AstDB', async () => {
    const { mgr, actions } = await signedOff();
    expect(mockSegments[mockSegments.length - 1]).toEqual(['102', null, null, 'system']);
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'logged_out', signed_off: true, reachable_via: 'sip' });
    expect(actions.some((a) => a.Action === 'DBPut' && a.Family === 'OPDESK_SIGNOFF' && a.Key === '102')).toBe(true);
  });

  it('a flap or a blip keeps it; a real registration ends it', async () => {
    const { mgr, online, tick } = await signedOff();
    await online('102', 'push');
    tick(30);
    await online('102');
    expect(mgr.snapshot()['102'].signed_off).toBe(true);
    await online('102', 'push');
    tick(300);
    await online('102');
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'ready', signed_off: false });
  });

  it('Available, a break, DND off or an answered call bring it back', async () => {
    const a = await signedOff();
    await a.mgr.setReady('102');
    expect(a.mgr.snapshot()['102']).toMatchObject({ state: 'ready', signed_off: false });
    const b = await signedOff();
    await b.mgr.setNotReady('102', 'lunch');
    expect(b.mgr.snapshot()['102']).toMatchObject({ state: 'not_ready', signed_off: false });
    const c = await signedOff();
    await c.mgr.setDnd('102', true);
    await c.mgr.setDnd('102', false);
    expect(c.mgr.snapshot()['102']).toMatchObject({ state: 'ready', signed_off: false });
    const d = await signedOff();
    await d.answer('102');
    expect(d.mgr.snapshot()['102']).toMatchObject({ state: 'on_call', signed_off: false });
  });

  it('going really offline clears it', async () => {
    const { mgr, offline, online, tick } = await signedOff();
    await offline('102');
    expect(mgr.snapshot()['102']).toBeUndefined();
    tick(300);
    await online('102');
    expect(mgr.stateOf('102')).toBe('ready');
  });

  it('a break interrupted by a call at the boundary goes on', async () => {
    const { mgr, online, answer, hangup } = setup();
    await online('102');
    await mgr.setNotReady('102', 'lunch');
    await answer('102');
    await mgr.dailyReset();
    await hangup('102');
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'not_ready', reason_code: 'lunch', signed_off: false });
  });

  it('holds across a restart while reachable and idle', async () => {
    const { monitor, mgr, reach } = setup();
    reach.set('102', 'sip');
    monitor.dbGetFamily = (async () => ({ 102: '1' })) as never;
    await mgr.hydrate();
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'logged_out', signed_off: true });
  });
});

describe('a call on a break or in wrap-up', () => {
  it('on a break: On Call while talking, the same break after hang-up', async () => {
    const { mgr, online, answer, hangup } = setup();
    await online('102');
    await mgr.setNotReady('102', 'lunch');
    await answer('102');
    expect(mgr.stateOf('102')).toBe('on_call');
    await hangup('102');
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'not_ready', reason_code: 'lunch' });
  });

  it('break ended elsewhere during the call: Available after hang-up', async () => {
    const { monitor, mgr, online, answer, hangup } = setup();
    await online('101');
    await mgr.queueLogin('101');
    await mgr.setNotReady('101', 'lunch');
    await answer('101');
    for (const m of monitor.memberInterfacesFor('101')) m.paused = false;
    await hangup('101');
    expect(mgr.stateOf('101')).toBe('ready');
  });

  it('going offline during that call still holds the break', async () => {
    const { mgr, online, offline, answer } = setup();
    await online('102');
    await mgr.setNotReady('102', 'lunch');
    await answer('102');
    await offline('102');
    expect(mgr.snapshot()['102']).toMatchObject({ state: 'logged_out', held_break: 'lunch' });
  });
});
