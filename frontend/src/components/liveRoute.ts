import type { TFunction } from 'i18next';
import type { CallInfo, LiveRoute } from '../types';
import type { BadgeTone } from './ui';

/** The side a call in progress counts on: the prefix of its route. */
export type RouteGroup = 'inbound' | 'outbound' | 'internal';

export function routeGroup(route: LiveRoute): RouteGroup {
  return route.split('_')[0] as RouteGroup;
}

/** One tone per side, so the Active Calls badge and the Dashboard split read alike. */
export const ROUTE_TONE: Record<RouteGroup, BadgeTone> = { inbound: 'info', outbound: 'purple', internal: 'neutral' };

/** "Inbound · Queue", "Inbound · Direct", "Outbound", "Internal". */
export function routeLabel(t: TFunction, route: LiveRoute): string {
  return t(`activeCalls.route.${route}`);
}

/** Calls in progress by side. */
export interface LiveDirections { inbound: number; inQueue: number; outbound: number; internal: number }

/**
 * Split the calls in progress by their route. A row is one extension's leg, so a call
 * between two extensions is two rows: the pair is counted once, the way the call is one.
 * A call the backend could not place yet (route null) stays in the total only.
 */
export function splitByDirection(calls: CallInfo[]): LiveDirections {
  const s: LiveDirections = { inbound: 0, inQueue: 0, outbound: 0, internal: 0 };
  const byExt = new Map(calls.map((c) => [c.extension, c]));
  for (const c of calls) {
    if (!c.route) continue;
    const group = routeGroup(c.route);
    if (group === 'inbound') {
      s.inbound++;
      if (c.route === 'inbound_queue') s.inQueue++;
    } else if (group === 'outbound') {
      s.outbound++;
    } else {
      const peer = byExt.get(c.talking_to);
      // The second leg of an extension pair, already counted from the first.
      if (peer?.talking_to === c.extension && peer.route && c.extension > peer.extension) continue;
      s.internal++;
    }
  }
  return s;
}
