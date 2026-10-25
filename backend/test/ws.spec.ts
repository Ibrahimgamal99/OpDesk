/**
 * /ws (api/routes/ws.ts) and the state bridge (core/event-bridge.ts): handshake (?token=,
 * first-frame {token}, 4001), live-scope filtering of the state frames, the control rules
 * (agents control only themselves; queue members only their own), action_result shapes
 * (`success` + `message`), and the scoped notification frames.
 *
 * A real HTTP server on 127.0.0.1 and a `ws` client; the AMI monitor is offline (its AMI
 * round-trip is stubbed) and the DB is mocked.
 */

const PRINCIPALS: Record<string, Record<string, unknown>> = {
  admin: { id: 1, username: 'admin', name: null, role: 'admin', extension: null, monitor_modes: ['listen'],
    allowed_agent_extensions: null, allowed_queue_names: null, live_agent_extensions: null, live_queue_names: null },
  admin2: { id: 4, username: 'admin2', name: null, role: 'admin', extension: '100', monitor_modes: ['listen', 'whisper', 'barge'],
    allowed_agent_extensions: null, allowed_queue_names: null, live_agent_extensions: null, live_queue_names: null },
  sup: { id: 2, username: 'sup', name: null, role: 'supervisor', extension: '200', monitor_modes: ['listen'],
    allowed_agent_extensions: ['101', '102'], allowed_queue_names: ['800'], live_agent_extensions: ['101', '102'], live_queue_names: ['800'] },
  agent: { id: 3, username: 'a101', name: null, role: 'agent', extension: '101', monitor_modes: [],
    allowed_agent_extensions: ['101'], allowed_queue_names: [], live_agent_extensions: ['101', '102'], live_queue_names: ['800'] },
};

jest.mock('../src/core/security', () => ({
  authenticateWsToken: jest.fn(async (t: string) => PRINCIPALS[t] ?? null),
}));
jest.mock('../src/db/db-manager', () => ({
  getExtensionNamesFromDb: jest.fn(async () => ({ '101': 'Alice', '102': 'Bob', '103': 'Carol' })),
  getQueuesList: jest.fn(async () => [{ extension: '800', queue_name: 'Sales' }, { extension: '900', queue_name: 'Support' }]),
  getAgentLoginQueues: jest.fn(async () => ['800']),
  pauseReasonForNotReady: jest.fn(async (c: string) => (c === 'lunch' ? { code: 'lunch', label: 'Lunch', is_active: 1, is_system: 0 } : null)),
  agentActivityTransition: jest.fn(async () => 1),
  getSetting: jest.fn(async (_k: string, d: string) => d),
  insertCallNotification: jest.fn(async () => 1),
  recordSupervision: jest.fn(async () => true),
}));
jest.mock('../src/services/vad-runner', () => ({ schedule: jest.fn() }));
jest.mock('../src/services/analytics', () => ({
  ...jest.requireActual('../src/services/analytics'),
  getSlaThresholds: jest.fn(async () => ({ '800': 30 })),
  getSlaDefaultSecs: jest.fn(async () => 20),
}));

import * as http from 'http';
import { WebSocket } from 'ws';
import { AMIEventBridge, setBridge } from '../src/core/event-bridge';
import { runtime } from '../src/core/runtime';
import {
  attachWebSocket,
  closeWebSockets,
  isExtensionInterface,
  scopeCanControlExtension,
  scopeCanControlQueueMember,
  transferSourceOwner,
} from '../src/api/routes/ws';
import { AgentStateManager } from '../src/services/agent-state';
import { AMIExtensionsMonitor } from '../src/services/ami';
import { sendCallNotificationNew, sendToOwnExtension } from '../src/services/realtime';

const raw = (h: Record<string, string>) => Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n';

let server: http.Server;
let port = 0;
const monitor = new AMIExtensionsMonitor({ host: '127.0.0.1', port: 1 });
const actions: Record<string, unknown>[] = [];

beforeAll(async () => {
  monitor.connected = true;
  monitor.monitored = new Set(['101', '102', '103']);
  monitor.sendAsync = (async (action: string, params: Record<string, unknown> | null) => {
    actions.push({ Action: action, ...(params || {}) });
    return 'Response: Success\r\nMessage: ok';
  }) as never;
  monitor.syncActiveCalls = (async () => monitor.activeCalls) as never;
  runtime.monitor = monitor;
  runtime.agentState = new AgentStateManager(monitor);
  const bridge = new AMIEventBridge(monitor);
  bridge.extensionNames = { '101': 'Alice', '102': 'Bob', '103': 'Carol' };
  setBridge(bridge);
  for (const h of <Record<string, string>[]>[
    { Event: 'ExtensionStatus', Exten: '101', Status: '0' },
    { Event: 'ExtensionStatus', Exten: '103', Status: '4' },
    { Event: 'QueueMemberAdded', Queue: '800', Interface: 'PJSIP/101', Paused: '0', Status: '1' },
    { Event: 'QueueMemberAdded', Queue: '800', Interface: 'PJSIP/102', Paused: '1', PausedReason: 'lunch', Status: '1' },
    { Event: 'QueueMemberAdded', Queue: '900', Interface: 'PJSIP/103', Paused: '0', Status: '1' },
    { Event: 'QueueMemberAdded', Queue: 'default', Interface: 'PJSIP/103', Paused: '0', Status: '1' },
  ]) await monitor.dispatchAsync(raw(h));
  monitor.dnd.add('102');
  await runtime.agentState.login('101');

  server = http.createServer();
  attachWebSocket(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  closeWebSockets();
  await new Promise<void>((r) => server.close(() => r()));
  setBridge(null);
  runtime.monitor = null;
  runtime.agentState = null;
});

/** Open a socket; collects frames; resolves once open. */
async function open(path: string): Promise<{ ws: WebSocket; frames: Record<string, any>[]; closed: Promise<number>; next: (type: string) => Promise<Record<string, any>> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const frames: Record<string, any>[] = [];
  const unread: Record<string, any>[] = [];
  const waiters: Array<[string, (f: Record<string, any>) => void]> = [];
  ws.on('message', (d) => {
    const f = JSON.parse(d.toString());
    frames.push(f);
    const w = waiters.find((x) => x[0] === f.type);
    if (w) {
      waiters.splice(waiters.indexOf(w), 1);
      w[1](f);
    } else unread.push(f);
  });
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  await new Promise<void>((r, j) => {
    ws.once('open', () => r());
    ws.once('error', j);
  });
  /** The next not-yet-consumed frame of this type. */
  const next = (type: string) =>
    new Promise<Record<string, any>>((r) => {
      const i = unread.findIndex((f) => f.type === type);
      if (i !== -1) r(unread.splice(i, 1)[0]);
      else waiters.push([type, r]);
    });
  return { ws, frames, closed, next };
}

describe('handshake', () => {
  it('accepts ?token= and sends initial_state', async () => {
    const c = await open('/ws?token=admin');
    const init = await c.next('initial_state');
    expect(Object.keys(init.data.extensions).sort()).toEqual(['101', '102', '103']);
    expect(init.timestamp).toMatch(/^\d{4}-\d\d-\d\dT/);
    c.ws.close();
  });

  it('accepts the token as the first frame (what the web UI sends)', async () => {
    const c = await open('/ws');
    c.ws.send(JSON.stringify({ token: 'agent' }));
    const init = await c.next('initial_state');
    expect(init.data.extensions['101'].name).toBe('Alice');
    c.ws.close();
  });

  it('closes 4001 for a bad ?token=, a bad first frame and garbage', async () => {
    expect(await (await open('/ws?token=nope')).closed).toBe(4001);
    const c = await open('/ws');
    c.ws.send(JSON.stringify({ token: 'nope' }));
    expect(await c.closed).toBe(4001);
    const d = await open('/ws');
    d.ws.send('not json');
    expect(await d.closed).toBe(4001);
  });
});

describe('state frames are filtered by LIVE scope', () => {
  it('agent: own extension + group agents and queues; dnd, pause_reason and agent_states present', async () => {
    const c = await open('/ws?token=agent');
    const s = (await c.next('initial_state')).data;
    expect(Object.keys(s.extensions).sort()).toEqual(['101', '102']);
    expect(s.extensions['102'].dnd).toBe(true);
    expect(s.extensions['101']).toMatchObject({ extension: '101', status: 'idle', status_code: '0', dnd: false, call_info: null });
    expect(Object.keys(s.queues)).toEqual(['800']);
    expect(s.queues['800'].name).toBe('Sales');
    // The queue's service-level target rides along for the Dashboard's past-target alert.
    expect(s.queues['800'].sla_secs).toBe(30);
    expect(Object.values(s.queue_members).map((m: any) => [m.interface, m.paused, m.pause_reason]).sort()).toEqual([
      ['PJSIP/101', false, ''],
      ['PJSIP/102', true, 'lunch'],
    ]);
    expect(Object.keys(s.agent_states)).toEqual(['101']);
    expect(s.agent_states['101']).toMatchObject({ extension: '101', state: 'ready', reason_code: null, is_agent: true });
    expect(s.stats).toMatchObject({ total_extensions: 2, total_queues: 1 });
    c.ws.close();
  });

  it('admin sees everything except the default queue', async () => {
    const c = await open('/ws?token=admin');
    c.ws.send(JSON.stringify({ action: 'get_state' }));
    const s = (await c.next('state_update')).data;
    expect(Object.keys(s.queues).sort()).toEqual(['800', '900']);
    expect(Object.values(s.queue_members).some((m: any) => m.queue === 'default')).toBe(false);
    c.ws.close();
  });
});

describe('actions', () => {
  it('unknown action / bad JSON / auth frames after auth', async () => {
    const c = await open('/ws?token=admin');
    await c.next('initial_state');
    c.ws.send('{bad');
    expect((await c.next('error')).message).toBe('Invalid JSON');
    c.ws.send(JSON.stringify({ token: 'admin' })); // ignored
    c.ws.send(JSON.stringify({ action: 'ping' }));
    expect((await c.next('error')).message).toBe('Unknown action: ping');
    c.ws.close();
  });

  it('an agent may not pause a colleague, but may pause themselves with a reason', async () => {
    const c = await open('/ws?token=agent');
    await c.next('initial_state');
    c.ws.send(JSON.stringify({ action: 'queue_pause', queue: '800', interface: 'PJSIP/102', reason: 'lunch' }));
    expect(await c.next('action_result')).toEqual({ type: 'action_result', action: 'queue_pause', success: false, message: 'Not allowed to manage this queue' });
    c.ws.send(JSON.stringify({ action: 'queue_pause', queue: '800', interface: '101', reason: 'lunch' }));
    const r = await c.next('action_result');
    expect(r).toMatchObject({ action: 'queue_pause', success: true });
    expect(actions[actions.length - 1]).toMatchObject({ Action: 'QueuePause', Queue: '800', Interface: 'PJSIP/101', Reason: 'lunch' });
    c.ws.send(JSON.stringify({ action: 'queue_unpause', queue: '800', interface: 'PJSIP/101' }));
    expect(await c.next('action_result')).toMatchObject({ action: 'queue_unpause', success: true });
    c.ws.close();
  });

  it('agent_set_status: invalid reason -> success:false with a message; valid -> not_ready', async () => {
    const c = await open('/ws?token=agent');
    await c.next('initial_state');
    c.ws.send(JSON.stringify({ action: 'agent_set_status', status: 'not_ready', reason_code: 'bogus' }));
    expect(await c.next('action_result')).toEqual({
      type: 'action_result', action: 'agent_set_status', success: false, message: 'A valid Not-Ready reason is required',
    });
    c.ws.send(JSON.stringify({ action: 'agent_set_status', status: 'not_ready', reason_code: 'lunch' }));
    expect(await c.next('action_result')).toMatchObject({ success: true, message: 'Not Ready — Lunch' });
    expect(runtime.agentState!.snapshot()['101']).toMatchObject({ state: 'not_ready', reason_code: 'lunch' });
    // Agents cannot act on another agent.
    c.ws.send(JSON.stringify({ action: 'agent_logout', agent: '102' }));
    expect(await c.next('action_result')).toMatchObject({ success: false, message: 'Not allowed to control this agent' });
    c.ws.send(JSON.stringify({ action: 'agent_set_status', status: 'ready' }));
    expect(await c.next('action_result')).toMatchObject({ success: true, message: 'Ready' });
    c.ws.close();
  });

  it('a supervisor may force an agent in scope, not one outside it', async () => {
    const c = await open('/ws?token=sup');
    await c.next('initial_state');
    c.ws.send(JSON.stringify({ action: 'hangup', target: '103' }));
    expect(await c.next('action_result')).toEqual({ type: 'action_result', action: 'hangup', success: false, message: 'Not allowed to control this extension' });
    c.ws.send(JSON.stringify({ action: 'transfer', source: '101' }));
    expect(await c.next('action_result')).toMatchObject({ success: false, message: 'Source and destination required' });
    c.ws.close();
  });
});

describe('scope rules', () => {
  const agent = PRINCIPALS.agent as never;
  const sup = PRINCIPALS.sup as never;
  it('control', () => {
    expect(scopeCanControlExtension(agent, '101')).toBe(true);
    expect(scopeCanControlExtension(agent, '102')).toBe(false); // visible, not controllable
    expect(scopeCanControlExtension(sup, '102')).toBe(true);
    expect(scopeCanControlExtension(sup, '103')).toBe(false);
    expect(scopeCanControlQueueMember(agent, '800', 'Local/101@from-queue/n')).toBe(true);
    expect(scopeCanControlQueueMember(agent, '800', 'PJSIP/1011')).toBe(false);
    expect(scopeCanControlQueueMember(agent, '900', 'PJSIP/101')).toBe(false);
    expect(scopeCanControlQueueMember(sup, '800', 'PJSIP/102')).toBe(true);
    expect(scopeCanControlQueueMember(sup, '900', 'PJSIP/103')).toBe(false);
  });
});

describe('notification frames', () => {
  it('call_notification_new reaches the HISTORY scope only; call_outcome only the own extension', async () => {
    const a = await open('/ws?token=admin');
    const s = await open('/ws?token=sup');
    const g = await open('/ws?token=agent');
    await Promise.all([a.next('initial_state'), s.next('initial_state'), g.next('initial_state')]);
    await sendCallNotificationNew('102');
    await sendToOwnExtension('101', { type: 'call_outcome', extension: '101', status: 'ANSWERED', linkedid: '1.1' });
    await new Promise((r) => setTimeout(r, 100));
    const kinds = (c: { frames: Record<string, any>[] }) => c.frames.filter((f) => f.type.startsWith('call_')).map((f) => [f.type, f.extension]);
    expect(kinds(a)).toEqual([['call_notification_new', '102']]);
    expect(kinds(s)).toEqual([['call_notification_new', '102']]);
    // The agent's history is their own extension only; the outcome is theirs.
    expect(kinds(g)).toEqual([['call_outcome', '101']]);
    for (const c of [a, s, g]) c.ws.close();
  });
});

describe('supervisor controls on a live call', () => {
  // 101 talks to an outside caller on a trunk leg; 103 (outside the supervisor's scope)
  // talks to the same number on another call.
  beforeAll(() => {
    monitor.activeCalls.set('101', { channel: 'PJSIP/101-00000001', caller: '0791234567', linkedid: 'L1', state: 'Up', start_time: new Date() });
    monitor.ch2ext.set('PJSIP/101-00000001', '101');
    monitor.ch2linkedid.set('PJSIP/101-00000001', 'L1');
    monitor.linkedid2channels.set('L1', new Set(['PJSIP/101-00000001', 'PJSIP/trunk-00000002']));
    monitor.activeCalls.set('103', { channel: 'PJSIP/103-00000003', caller: '0791234567', linkedid: 'L3', state: 'Up' });
    monitor.ch2linkedid.set('PJSIP/103-00000003', 'L3');
    monitor.linkedid2channels.set('L3', new Set(['PJSIP/103-00000003', 'PJSIP/trunk-00000004']));
  });
  afterAll(() => {
    for (const ext of ['101', '103']) monitor.activeCalls.delete(ext);
    monitor.ch2ext.delete('PJSIP/101-00000001');
    monitor.linkedid2channels.clear();
    monitor.ch2linkedid.clear();
  });

  const lastRedirect = () => [...actions].reverse().find((a) => a.Action === 'Redirect');

  it('take over / transfer the outside caller of an in-scope extension', async () => {
    const c = await open('/ws?token=sup');
    await c.next('initial_state');
    c.ws.send(JSON.stringify({ action: 'take_over', source: '0791234567', ext: '101' }));
    expect(await c.next('action_result')).toMatchObject({ action: 'take_over', success: true });
    // The caller's own leg of 101's call moves to the supervisor's extension.
    expect(lastRedirect()).toMatchObject({ Channel: 'PJSIP/trunk-00000002', Exten: '200', Priority: '1' });

    c.ws.send(JSON.stringify({ action: 'transfer', source: '0791234567', ext: '101', destination: '102' }));
    expect(await c.next('action_result')).toMatchObject({ action: 'transfer', success: true });
    expect(lastRedirect()).toMatchObject({ Channel: 'PJSIP/trunk-00000002', Exten: '102' });

    // Without `ext` the server finds the in-scope extension the caller is talking to.
    c.ws.send(JSON.stringify({ action: 'transfer', source: '0791234567', destination: '102' }));
    expect(await c.next('action_result')).toMatchObject({ action: 'transfer', success: true });
    expect(lastRedirect()).toMatchObject({ Channel: 'PJSIP/trunk-00000002' });
    c.ws.close();
  });

  it('refuses a source the named extension is not talking to, or an extension out of scope', async () => {
    const c = await open('/ws?token=sup');
    await c.next('initial_state');
    const before = actions.length;
    c.ws.send(JSON.stringify({ action: 'take_over', source: '0790000000', ext: '101' }));
    expect(await c.next('action_result')).toMatchObject({ success: false, message: 'Not allowed to control this extension' });
    c.ws.send(JSON.stringify({ action: 'transfer', source: '0791234567', ext: '103', destination: '102' }));
    expect(await c.next('action_result')).toMatchObject({ success: false, message: 'Not allowed to control this extension' });
    c.ws.send(JSON.stringify({ action: 'transfer', source: '103', destination: '102' }));
    expect(await c.next('action_result')).toMatchObject({ success: false, message: 'Not allowed to control this extension' });
    expect(actions.slice(before).some((a) => a.Action === 'Redirect')).toBe(false);
    c.ws.close();
  });

  it('a transfer lands only in a PBX dial context, at a numeric priority', async () => {
    const c = await open('/ws?token=sup');
    await c.next('initial_state');
    c.ws.send(JSON.stringify({ action: 'transfer', source: '101', destination: '102', context: 'macro-dial' }));
    expect(await c.next('action_result')).toMatchObject({ success: false, message: 'Transfer context not allowed' });
    c.ws.send(JSON.stringify({ action: 'transfer', source: '101', destination: '102', priority: 'hangup' }));
    expect(await c.next('action_result')).toMatchObject({ success: false, message: 'Transfer context not allowed' });
    c.ws.send(JSON.stringify({ action: 'transfer', source: '101', destination: '102', context: 'from-internal', priority: '2' }));
    expect(await c.next('action_result')).toMatchObject({ success: true });
    expect(lastRedirect()).toMatchObject({ Channel: 'PJSIP/101-00000001', Context: 'from-internal', Priority: '2' });
    c.ws.close();
  });

  it('supervision: granted modes only, from your own extension, never as an agent', async () => {
    const before = actions.length;
    const g = await open('/ws?token=agent');
    await g.next('initial_state');
    g.ws.send(JSON.stringify({ action: 'listen', supervisor: '101', target: '101' }));
    expect(await g.next('action_result')).toMatchObject({ action: 'listen', success: false, message: 'Agents cannot supervise calls' });
    g.ws.close();

    const c = await open('/ws?token=sup');
    await c.next('initial_state');
    c.ws.send(JSON.stringify({ action: 'barge', supervisor: '200', target: '101' }));
    expect(await c.next('action_result')).toMatchObject({ success: false, message: 'Not allowed to barge' });
    c.ws.send(JSON.stringify({ action: 'listen', supervisor: '102', target: '101' }));
    expect(await c.next('action_result')).toMatchObject({ success: false, message: 'Supervise from your own extension' });
    c.ws.send(JSON.stringify({ action: 'listen', supervisor: 'PJSIP/200', target: '101' }));
    expect(await c.next('action_result')).toMatchObject({ success: false, message: 'Your extension must be a number' });
    c.ws.send(JSON.stringify({ action: 'listen', supervisor: '200', target: '103' }));
    expect(await c.next('action_result')).toMatchObject({ success: false, message: 'Not allowed to monitor this extension' });
    expect(actions.slice(before).some((a) => a.Action === 'Originate')).toBe(false);

    c.ws.send(JSON.stringify({ action: 'listen', supervisor: '200', target: '101' }));
    expect(await c.next('action_result')).toMatchObject({ success: true });
    expect(actions[actions.length - 1]).toMatchObject({ Action: 'Originate', Channel: 'PJSIP/200', Application: 'ChanSpy', Data: 'PJSIP/101-00000001,qsE' });
    c.ws.close();

    // An admin may ring another extension of the PBX, not an arbitrary number.
    const a = await open('/ws?token=admin2');
    await a.next('initial_state');
    a.ws.send(JSON.stringify({ action: 'whisper', supervisor: '102', target: '101' }));
    expect(await a.next('action_result')).toMatchObject({ success: true });
    a.ws.send(JSON.stringify({ action: 'barge', supervisor: '999', target: '101' }));
    expect(await a.next('action_result')).toMatchObject({ success: false, message: 'Supervise from your own extension' });
    a.ws.close();
  });

  it('owner resolution', () => {
    const sup = PRINCIPALS.sup as never;
    expect(transferSourceOwner(sup, monitor, '101')).toBe('101');
    expect(transferSourceOwner(sup, monitor, '0791234567', '101')).toBe('101');
    expect(transferSourceOwner(sup, monitor, '791234567', '101')).toBe('101'); // national zero
    expect(transferSourceOwner(sup, monitor, '0791234567')).toBe('101');
    expect(transferSourceOwner(sup, monitor, '0791234567', '103')).toBeNull();
    expect(transferSourceOwner(sup, monitor, '102', '101')).toBeNull();
  });
});

describe('agent board: a supervisor forces presence for agents in scope', () => {
  it('Not Ready with a reason pauses the agent in every queue; out of scope is refused', async () => {
    const c = await open('/ws?token=sup');
    await c.next('initial_state');
    c.ws.send(JSON.stringify({ action: 'agent_set_status', status: 'not_ready', reason_code: 'lunch', agent: '102' }));
    expect(await c.next('action_result')).toMatchObject({ action: 'agent_set_status', success: true });
    expect(actions[actions.length - 1]).toMatchObject({ Action: 'QueuePause', Queue: '800', Interface: 'PJSIP/102', Reason: 'lunch' });
    expect(runtime.agentState!.snapshot()['102']).toMatchObject({ state: 'not_ready', reason_code: 'lunch' });

    c.ws.send(JSON.stringify({ action: 'agent_set_status', status: 'ready', agent: '102' }));
    expect(await c.next('action_result')).toMatchObject({ success: true, message: 'Ready' });

    const before = actions.length;
    c.ws.send(JSON.stringify({ action: 'agent_set_status', status: 'not_ready', reason_code: 'lunch', agent: '103' }));
    expect(await c.next('action_result')).toMatchObject({ success: false, message: 'Not allowed to control this agent' });
    c.ws.send(JSON.stringify({ action: 'agent_logout', target: '103' }));
    expect(await c.next('action_result')).toMatchObject({ success: false, message: 'Not allowed to control this agent' });
    expect(actions.length).toBe(before);
    c.ws.close();
  });
});

describe('admin-only sync and queue member shape', () => {
  it('a full sync (it writes the agents and queues tables) is an admin action', async () => {
    const c = await open('/ws?token=sup');
    await c.next('initial_state');
    c.ws.send(JSON.stringify({ action: 'sync' }));
    expect(await c.next('action_result')).toEqual({ type: 'action_result', action: 'sync', success: false, message: 'Only an admin can run a full sync' });
    c.ws.close();
  });

  it('queue_add takes only an extension interface the connection can see', async () => {
    const c = await open('/ws?token=sup');
    await c.next('initial_state');
    for (const iface of ['PJSIP/trunk', 'Local/0791234567@from-internal', 'Local/102@from-queue/n;1', 'PJSIP/103']) {
      c.ws.send(JSON.stringify({ action: 'queue_add', queue: '800', interface: iface }));
      expect(await c.next('action_result')).toMatchObject({ action: 'queue_add', success: false });
    }
    expect(actions.some((a) => a.Action === 'QueueAdd')).toBe(false);
    c.ws.send(JSON.stringify({ action: 'queue_add', queue: '800', interface: '102' }));
    expect(await c.next('action_result')).toMatchObject({ action: 'queue_add', success: true });
    expect(actions[actions.length - 1]).toMatchObject({ Action: 'QueueAdd', Queue: '800', Interface: 'PJSIP/102' });
    c.ws.close();
  });

  it('extension interfaces', () => {
    expect(isExtensionInterface('PJSIP/101')).toBe(true);
    expect(isExtensionInterface('SIP/2001')).toBe(true);
    expect(isExtensionInterface('Local/101@from-queue/n')).toBe(true);
    expect(isExtensionInterface('PJSIP/101-00000001')).toBe(false);
    expect(isExtensionInterface('PJSIP/trunk')).toBe(false);
    expect(isExtensionInterface('Local/101@from-queue/n,x')).toBe(false);
  });
});
