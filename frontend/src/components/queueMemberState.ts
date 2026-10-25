import type { QueueMember } from '../types';

/**
 * A queue member's live availability, from what Asterisk reports about their device.
 *
 * The one implementation. It lived twice -- once in QueuesPanel as a CSS modifier and once
 * in the Dashboard as a bucket name -- and the two had already started to differ in what
 * they returned for an idle member, which is the bucket every count is built on.
 *
 * Asterisk gives the status either as a name ("In Use") or as a numeric device-state code,
 * depending on which AMI event carried it, so both spellings are tested.
 */
export type QueueMemberState = 'paused' | 'unavailable' | 'unknown' | 'busy' | 'ringing' | 'on_hold' | 'available';

/**
 * Only an idle device ("Not in use", code 1) is available. A phone that is ringing or holding
 * a call cannot take the next caller, and an Unknown device state proves nothing either way,
 * so none of them reads as Ready.
 */
export function memberState(member: QueueMember): QueueMemberState {
  // Paused first: a paused member takes no calls whatever their phone is doing.
  if (member.paused) return 'paused';
  const s = (member.status || '').toLowerCase();
  if (s === 'unavailable' || s === 'invalid' || member.status === '4' || member.status === '5') {
    return 'unavailable';
  }
  if (s === 'in use' || s === 'busy' || s === 'ring+in use'
      || member.status === '2' || member.status === '3' || member.status === '7') {
    return 'busy';
  }
  if (s === 'ringing' || member.status === '6') return 'ringing';
  if (s === 'on hold' || member.status === '8') return 'on_hold';
  if (s === 'not in use' || member.status === '1') return 'available';
  return 'unknown';
}

/** The four buckets the Dashboard's queue board counts: a ringing or held phone is busy, and
 *  an unknown one is not counted on. */
export type QueueMemberBucket = 'available' | 'busy' | 'paused' | 'unavailable';

export function memberBucket(member: QueueMember): QueueMemberBucket {
  const state = memberState(member);
  if (state === 'ringing' || state === 'on_hold') return 'busy';
  if (state === 'unknown') return 'unavailable';
  return state;
}

/**
 * The same thing as a CSS modifier, where 'available' is the unmodified default and so
 * carries no class of its own. Kept beside the state rather than in the styles, so a caller
 * that needs the class and a caller that needs the bucket cannot drift apart.
 */
export function memberStateClass(member: QueueMember): string {
  const state = memberState(member);
  return state === 'available' ? '' : state.replace('_', '-');
}

/**
 * Bare extension number for a member interface. Covers both forms a queue member may take:
 * "Local/100@from-queue/n" -> "100" and "PJSIP/100" -> "100". Shared by the Queues page
 * (Add Member picker) and the Agents board (queue filter), which both key members by it.
 */
export function memberExtension(iface: string): string {
  return (iface.includes('/') ? iface.split('/')[1].split('@')[0] : iface) || iface;
}
