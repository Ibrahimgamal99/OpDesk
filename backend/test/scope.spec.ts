/** Visibility rules: history vs live scope per role, call visibility, live state filtering, WS broadcast filtering. */

import { HttpError } from '../src/api/http-error';
import {
  analyticsScope,
  assertCallVisible,
  canSeeExtensionHistory,
  canSeeExtensionLive,
  canSeeQueueLive,
  channelExtension,
  filterLiveState,
  historyExtensions,
  historyQueues,
  liveExtensions,
} from '../src/core/scope';
import type { Principal } from '../src/core/security';
import { ConnectionManager, scopeFromPrincipal } from '../src/core/ws-manager';

function principal(over: Partial<Principal>): Principal {
  return {
    id: 1, username: 'u', name: null, role: 'agent', extension: '101', monitor_modes: ['listen'],
    allowed_agent_extensions: ['101'], allowed_queue_names: [], live_agent_extensions: ['101', '102'], live_queue_names: ['600'],
    ...over,
  };
}

const admin = principal({ role: 'admin', extension: null, allowed_agent_extensions: null, allowed_queue_names: null, live_agent_extensions: null, live_queue_names: null });
const agent = principal({});
const supervisor = principal({
  role: 'supervisor', extension: '200', allowed_agent_extensions: ['101', '102'], allowed_queue_names: ['600'],
  live_agent_extensions: ['101', '102'], live_queue_names: ['600'],
});
const apiKey = principal({ role: 'admin', api_key: true, id: null, allowed_agent_extensions: null, allowed_queue_names: null, live_agent_extensions: null, live_queue_names: null });

describe('history scope', () => {
  it('admin and API keys are unrestricted', () => {
    expect(historyExtensions(admin)).toBeNull();
    expect(historyExtensions(apiKey)).toBeNull();
    expect(historyQueues(admin)).toBeNull();
  });

  it('an agent sees only their own extension, whatever their groups', () => {
    expect(historyExtensions(agent)).toEqual(['101']);
    expect(historyExtensions(principal({ allowed_agent_extensions: ['101', '102', '103'] }))).toEqual(['101']);
    expect(historyExtensions(principal({ extension: null }))).toEqual([]);
    expect(historyQueues(agent)).toEqual([]);
    expect(canSeeExtensionHistory(agent, '102')).toBe(false);
  });

  it('a supervisor sees their groups', () => {
    expect(historyExtensions(supervisor)).toEqual(['101', '102']);
    expect(historyQueues(supervisor)).toEqual(['600']);
  });

  it('a scope with nothing loaded denies rather than allows', () => {
    expect(historyExtensions({ role: 'supervisor' })).toEqual([]);
  });

  it('analytics: agents 403, admin unfiltered, supervisor their lists', () => {
    expect(() => analyticsScope(agent)).toThrow(HttpError);
    expect(analyticsScope(admin)).toEqual([null, null]);
    expect(analyticsScope(supervisor)).toEqual([['600'], ['101', '102']]);
  });
});

describe('call visibility', () => {
  const legs = [
    { src: '01001234567', dst: '600', channel: 'PJSIP/trunk-00000001', dstchannel: 'Local/102@from-queue-0000;1' },
    { src: '01001234567', dst: '102', channel: 'Local/102@from-queue-0000;2', dstchannel: 'PJSIP/102-00000002' },
  ];

  it('extracts extensions from channel names', () => {
    expect(channelExtension('PJSIP/101-0000002a')).toBe('101');
    expect(channelExtension('SIP/205-00000001')).toBe('205');
    expect(channelExtension('Local/101@from-queue-0001;1')).toBe('101');
    expect(channelExtension('')).toBeNull();
    expect(channelExtension('garbage')).toBeNull();
  });

  it('passes when a leg touches the history scope, 403 otherwise', () => {
    expect(() => assertCallVisible(admin, [])).not.toThrow();
    expect(() => assertCallVisible(supervisor, legs)).not.toThrow();
    expect(() => assertCallVisible(principal({ extension: '102', allowed_agent_extensions: ['102'] }), legs)).not.toThrow();
    let err: unknown;
    try {
      assertCallVisible(agent, legs);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).detail).toBe('Not allowed to view this call');
    // A call that was not found is a denial, not a pass.
    expect(() => assertCallVisible(supervisor, [])).toThrow(HttpError);
  });
});

describe('live scope', () => {
  it('an agent sees their group live but not in history', () => {
    expect(liveExtensions(agent)).toEqual(['101', '102']);
    expect(canSeeExtensionLive(agent, '102')).toBe(true);
    expect(canSeeExtensionLive(agent, 103)).toBe(false);
    expect(canSeeQueueLive(agent, '600')).toBe(true);
    expect(canSeeQueueLive(agent, '601')).toBe(false);
    expect(canSeeExtensionLive(admin, 'anything')).toBe(true);
  });

  it('falls back to the history lists when no live list was loaded', () => {
    expect(liveExtensions({ role: 'supervisor', allowed_agent_extensions: ['7'] })).toEqual(['7']);
  });

  it('filters a state snapshot and recomputes stats', () => {
    const state = {
      extensions: { '101': { status: 'idle' }, '102': { status: 'in_call' }, '103': { status: 'idle' } },
      active_calls: { '102': { state: 'Up' }, '103': { state: 'Up' } },
      queues: { '600': { calls_waiting: 2 }, '601': { calls_waiting: 5 } },
      queue_members: { a: { queue: '600' }, b: { queue: '601' } },
      queue_entries: { u1: { queue: '601' } },
      stats: { total_extensions: 3, active_calls_count: 2, total_queues: 2, total_waiting: 7 },
      other: 1,
    };
    const out = filterLiveState(agent, state);
    expect(Object.keys(out.extensions)).toEqual(['101', '102']);
    expect(Object.keys(out.active_calls)).toEqual(['102']);
    expect(Object.keys(out.queues)).toEqual(['600']);
    expect(Object.keys(out.queue_members)).toEqual(['a']);
    expect(out.queue_entries).toEqual({});
    expect(out.stats).toEqual({ total_extensions: 2, active_calls_count: 1, total_queues: 1, total_waiting: 2 });
    expect(out.other).toBe(1);
    expect(filterLiveState(admin, state)).toBe(state);
  });
});

describe('ConnectionManager broadcast filtering', () => {
  function fakeSocket() {
    const sent: string[] = [];
    return { sent, ws: { readyState: 1, send: (d: string, cb: (e?: Error) => void) => { sent.push(d); cb(); } } };
  }

  it('narrows state frames per connection and routes extension frames by live scope', async () => {
    const m = new ConnectionManager();
    const a = fakeSocket();
    const s = fakeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await m.connect(a.ws as any, scopeFromPrincipal(agent));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await m.connect(s.ws as any, scopeFromPrincipal(admin));
    await m.broadcast({ type: 'state_update', data: { extensions: { '101': {}, '999': {} } }, timestamp: 't' });
    expect(Object.keys(JSON.parse(a.sent[0]).data.extensions)).toEqual(['101']);
    expect(Object.keys(JSON.parse(s.sent[0]).data.extensions)).toEqual(['101', '999']);
    await m.broadcast({ type: 'call_notification_new', extension: '999' });
    expect(a.sent).toHaveLength(1);
    expect(s.sent).toHaveLength(2);
    await m.broadcast({ type: 'hello' });
    expect(a.sent).toHaveLength(2);
    await m.sendToExtension('101', { type: 'mine' });
    expect(JSON.parse(a.sent[2]).type).toBe('mine');
    expect(s.sent).toHaveLength(3);
  });
});
