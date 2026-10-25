/**
 * Behaviour parity of the AMI event handlers with OpDesk's Python monitor.
 *
 * fixtures/ami-replay.json was produced by replaying a scripted AMI stream (internal call
 * answered, caller gives up while it rings, busy, queue members with pause reasons, an
 * inbound queue call answered by an agent, a queue abandon, a recorded outbound call
 * nobody answered) through backend/ami.py's AMIExtensionsMonitor, recording after every
 * event its live state and the CRM pushes it made. The generator lives in the port's
 * scratchpad (rt/py/gen.py); only the boundaries were stubbed.
 *
 * Compared step by step: active_calls, ch2ext, ch_callerid, destch2ext, queues,
 * queue_members (without `pause_reason`, whose handling is a deliberate fix tested in
 * ami-helpers.spec.ts), queue_entries, dynamic_members, ch2uniqueid, ch2linkedid,
 * linkedid2channels, linkedid_crm_sent, extensions, the CRM payloads (without the
 * time-dependent fields and call_status, whose vocabulary changed) and VAD scheduling.
 * The missed-call bell is asserted separately below (its rules changed on purpose).
 */

const mockNotifications: Array<Record<string, unknown>> = [];
const mockVad: unknown[][] = [];

jest.mock('../src/db/db-manager', () => ({
  insertCallNotification: jest.fn(async (extension: string, opts: Record<string, unknown> = {}) => {
    mockNotifications.push({ extension, ...opts });
    return 1;
  }),
  getAgentNameByExtension: jest.fn(async () => null),
  insertWebhookDelivery: jest.fn(async () => 1),
  recordSupervision: jest.fn(async () => true),
}));
jest.mock('../src/services/call-log', () => ({
  ...jest.requireActual('../src/services/call-log'),
  crmIdentityFromCdr: jest.fn(async () => ({})),
}));
jest.mock('../src/services/vad-runner', () => ({
  schedule: jest.fn((base: string, uid: string, deleteUnanswered = false) => {
    mockVad.push([base, uid, deleteUnanswered]);
  }),
}));

import * as fs from 'fs';
import * as path from 'path';
import { CRMSyncConfig } from '../src/integrations/crm';
import { AMIExtensionsMonitor } from '../src/services/ami';

interface Step {
  raw: string;
  crm: Record<string, unknown>[];
  vad: unknown[][];
  state: Record<string, unknown>;
}

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ami-replay.json'), 'utf8')) as {
  monitored: string[];
  steps: Step[];
};

/** Maps/objects -> plain objects, Sets -> sorted lists, Dates -> '<dt>' (the fixture's norm()). */
function norm(v: unknown): unknown {
  if (v instanceof Date) return '<dt>';
  if (v instanceof Set) return [...v].map(norm).sort();
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), norm(x)]));
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, norm(x)]));
  return v === undefined ? null : v;
}

function stripMember(members: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, m] of Object.entries(members)) {
    const { last_update: _lu, pause_reason: _pr, ...rest } = m;
    out[k] = rest;
  }
  return out;
}

function snapshot(m: AMIExtensionsMonitor): Record<string, unknown> {
  return norm({
    active_calls: m.activeCalls,
    ch2ext: m.ch2ext,
    ch_callerid: m.chCallerid,
    destch2ext: m.destch2ext,
    queues: m.queues,
    queue_members: m.queueMembers,
    queue_entries: m.queueEntries,
    dynamic_members: m.dynamicMembers,
    ch2uniqueid: m.ch2uniqueid,
    ch2linkedid: m.ch2linkedid,
    linkedid2channels: m.linkedid2channels,
    linkedid_crm_sent: m.linkedidCrmSent,
    extensions: m.extensions,
  }) as Record<string, unknown>;
}

const drain = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

describe('AMI replay parity with backend/ami.py', () => {
  const sent: Record<string, unknown>[] = [];
  const monitor = new AMIExtensionsMonitor({
    host: '127.0.0.1',
    port: 1,
    crmConnector: {
      serverUrl: 'http://crm.test',
      endpointPath: '/api/calls',
      sendCallData: async (data: Record<string, unknown>) => {
        sent.push({ ...data });
        return { success: true, status_code: 200, data: null };
      },
    } as never,
    crmSyncConfig: new CRMSyncConfig({ enabled: true, fields: [] }),
  });
  monitor.monitored = new Set(fixture.monitored);
  const outcomes: unknown[][] = [];
  monitor.setCallOutcomeCallback((ext, status, linkedid) => {
    outcomes.push([ext, status, linkedid]);
  });

  fixture.steps.forEach((step, i) => {
    it(`step ${i}: ${step.raw.split('\r\n').slice(0, 2).join(' / ')}`, async () => {
      const crm0 = sent.length;
      const vad0 = mockVad.length;
      await monitor.dispatchAsync(step.raw);
      await drain();
      const got = snapshot(monitor);
      const want = { ...step.state };
      got.queue_members = stripMember(got.queue_members as Record<string, Record<string, unknown>>);
      want.queue_members = stripMember(want.queue_members as Record<string, Record<string, unknown>>);
      expect(got).toEqual(want);

      const crm = sent.slice(crm0).map((c) => {
        const { call_status: _s, ...rest } = c;
        return { ...rest, datetime: '<dt>', duration: '<dur>', talk_time: '<dur>' };
      });
      expect(crm).toEqual(step.crm);
      expect(mockVad.slice(vad0).map((v) => v.slice(0, 2))).toEqual(step.vad);
    });
  });

  it('notifies only the party that was rung, with the canonical status as reason', () => {
    // 1001 -> 1002 cancelled while ringing: 1002 missed it (MISSED, the new rule); 1001,
    // who placed it, gets nothing. 1003 -> 1002 busy: only 1002. The queue member that
    // answered, the queue caller who hung up (keyed by the queue number) and the recorded
    // outbound call nobody answered notify nobody else.
    const byExt = mockNotifications.map((n) => [n.extension, n.callerFrom, n.reason]);
    expect(byExt).toEqual([
      ['1002', '1001', 'MISSED'],
      ['1002', '1003', 'BUSY'],
    ]);
  });

  it('pushes the outcome to every extension that took part in a connected call', () => {
    expect(outcomes).toEqual([
      ['1002', 'ANSWERED', '1000.1'],
      ['1001', 'ANSWERED', '1000.1'],
      ['1001', 'ANSWERED', '1003.1'],
    ]);
  });

  it('asks the VAD runner to delete the ring-only recording of the unanswered call', () => {
    expect(mockVad).toEqual([['out-1003-0791112222-1005.1', '1005.1', true]]);
  });
});
