/**
 * Extension card status vs. registration: the hint ORs the phone with Custom:DND<ext>, so
 * after DND has been toggled once an unregistered phone reads Idle there. The card must
 * follow the phone's real registration (found in a live test on FreePBX).
 */
jest.mock('../src/db/db-manager', () => ({ getSetting: jest.fn(async (_k: string, d: unknown) => d) }));
jest.mock('../src/services/vad-runner', () => ({ schedule: jest.fn() }));

import { AMIEventBridge } from '../src/core/event-bridge';
import { runtime } from '../src/core/runtime';
import { AMIExtensionsMonitor } from '../src/services/ami';
import type { RegistrationTracker } from '../src/services/registration';

function stateFor(hint: string, registered: boolean | null): unknown {
  const monitor = new AMIExtensionsMonitor({ host: '127.0.0.1', port: 1 });
  monitor.monitored = new Set(['100']);
  monitor.extensions.set('100', { Exten: '100', Status: hint });
  runtime.registration = registered === null ? null : ({ registered: () => registered } as unknown as RegistrationTracker);
  const bridge = new AMIEventBridge(monitor);
  const s = bridge.buildState(null, null) as { extensions: Record<string, { status: string }> };
  return s.extensions['100'].status;
}

afterEach(() => {
  runtime.registration = null;
});

describe('extension card status', () => {
  it('an Idle hint with the phone unregistered (Custom:DND NOT_INUSE) is Offline', () => {
    expect(stateFor('0', false)).toBe('unavailable');
  });
  it('a Busy hint with the phone unregistered (DND on) is Offline', () => {
    expect(stateFor('2', false)).toBe('unavailable');
  });
  it('a registered phone keeps the hint', () => {
    expect(stateFor('0', true)).toBe('idle');
    expect(stateFor('1', true)).toBe('in_call');
  });
  it('without the tracker (tests, older wiring) the hint is used as before', () => {
    expect(stateFor('0', null)).toBe('idle');
  });
});
