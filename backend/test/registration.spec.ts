/**
 * Reachability (services/registration): hint-based registration, the push-wake fallback,
 * one extension_registration row per reachable stretch, and the listener calls that drive
 * availability.
 */

const mockRows: string[][] = [];
jest.mock('../src/db/db-manager', () => ({
  registrationOpen: jest.fn(async (ext: string, via: string, source: string) => { mockRows.push(['open', ext, via, source]); return true; }),
  registrationClose: jest.fn(async (ext: string) => { mockRows.push(['close', ext]); return true; }),
  registrationCloseAllOpen: jest.fn(async () => { mockRows.push(['close_all']); return 0; }),
}));
jest.mock('../src/services/vad-runner', () => ({ schedule: jest.fn() }));

import { AMIExtensionsMonitor } from '../src/services/ami';
import { RegistrationTracker, type ReachVia } from '../src/services/registration';

function setup(wakeable: string[] = []) {
  const monitor = new AMIExtensionsMonitor({ host: '127.0.0.1', port: 1 });
  monitor.monitored = new Set(['100', '101']);
  const tracker = new RegistrationTracker(monitor);
  tracker.canWake = async (ext) => wakeable.includes(ext);
  const calls: Array<[string, ReachVia | null]> = [];
  tracker.listener = { onReachability: async (ext, via) => { calls.push([ext, via]); } };
  const hint = async (ext: string, status: string) => {
    monitor.extensions.set(ext, { Event: 'ExtensionStatus', Exten: ext, Status: status });
    await tracker.handleAmiEvent({ Event: 'ExtensionStatus', Exten: ext, Status: status });
  };
  return { monitor, tracker, calls, hint };
}

beforeEach(() => {
  mockRows.length = 0;
});

describe('RegistrationTracker', () => {
  it('hydrate closes stale rows and opens one per registered extension', async () => {
    const { monitor, tracker } = setup(['101']);
    monitor.extensions.set('100', { Status: '0' });
    monitor.extensions.set('101', { Status: '4' });
    await tracker.hydrate();
    expect(mockRows).toEqual([['close_all'], ['open', '100', 'sip', 'system'], ['open', '101', 'push', 'system']]);
    expect(tracker.viaOf('100')).toBe('sip');
    expect(tracker.viaOf('101')).toBe('push');
  });

  it('only a change of reachability writes a row and calls the listener', async () => {
    const { tracker, calls, hint } = setup();
    await hint('100', '0');
    await hint('100', '1'); // in use: still registered
    await hint('100', '2'); // busy (e.g. Custom:DND): still registered
    await hint('100', '4');
    expect(calls).toEqual([['100', 'sip'], ['100', null]]);
    expect(mockRows).toEqual([['open', '100', 'sip', 'ami'], ['close', '100']]);
    expect(tracker.isReachable('100')).toBe(false);
  });

  it('an unregistered but push-wakeable extension stays reachable via push', async () => {
    const { calls, hint } = setup(['100']);
    await hint('100', '0');
    await hint('100', '4');
    expect(calls).toEqual([['100', 'sip'], ['100', 'push']]);
    expect(mockRows).toEqual([['open', '100', 'sip', 'ami'], ['close', '100'], ['open', '100', 'push', 'ami']]);
  });

  it('an unregistered phone on DND is NOT registered, though its hint reads Busy (Custom:DND)', async () => {
    const { monitor, tracker, calls, hint } = setup();
    await tracker.handleAmiEvent({ Event: 'DeviceStateChange', Device: 'PJSIP/100', State: 'UNAVAILABLE' });
    await tracker.handleAmiEvent({ Event: 'DeviceStateChange', Device: 'Custom:DND100', State: 'BUSY' });
    monitor.dnd.add('100');
    await hint('100', '2');
    expect(tracker.isReachable('100')).toBe(false);
    expect(calls).toEqual([]);
  });

  it('the endpoint device state drives registration', async () => {
    const { tracker, calls } = setup();
    await tracker.handleAmiEvent({ Event: 'DeviceStateChange', Device: 'PJSIP/100', State: 'NOT_INUSE' });
    await tracker.handleAmiEvent({ Event: 'DeviceStateChange', Device: 'PJSIP/100', State: 'INUSE' });
    await tracker.handleAmiEvent({ Event: 'DeviceStateChange', Device: 'PJSIP/100', State: 'UNAVAILABLE' });
    expect(calls).toEqual([['100', 'sip'], ['100', null]]);
  });

  it('with no device state yet, a Busy hint plus DND reads as not registered', async () => {
    const { monitor, tracker, hint } = setup();
    monitor.dnd.add('100');
    await hint('100', '2');
    expect(tracker.isReachable('100')).toBe(false);
    monitor.dnd.delete('100');
    await hint('100', '2');
    expect(tracker.isReachable('100')).toBe(true);
  });

  it('startup learns device states from DeviceStateList and PJSIPShowEndpoints', async () => {
    const { monitor, tracker } = setup();
    monitor.extensions.set('100', { Status: '2' }); // hint says Busy (DND)...
    monitor.extensions.set('101', { Status: '4' });
    monitor.sendActionWithEvents = (async (action: string) => action === 'DeviceStateList'
      ? [{ Response: 'Success' }, { Event: 'DeviceStateChange', Device: 'PJSIP/100', State: 'UNAVAILABLE' }, { Event: 'DeviceStateListComplete' }]
      : [{ Response: 'Success' }, { Event: 'EndpointList', ObjectName: '101', DeviceState: 'Not in use' }, { Event: 'EndpointListComplete' }]) as never;
    await tracker.hydrate();
    expect(tracker.viaOf('100')).toBeNull(); // ...but the phone is not registered
    expect(tracker.viaOf('101')).toBe('sip');
  });

  it('ignores extensions that are not monitored', async () => {
    const { calls, hint } = setup();
    await hint('555', '0');
    expect(calls).toEqual([]);
  });
});
