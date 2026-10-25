/**
 * Shadow mode (OPDESK_SHADOW=1): a second OpDesk instance run beside the live one, against
 * a copy of the app database, to compare the two on real PBX traffic.
 *
 * It must watch the PBX without changing it: two servers acting on the same Asterisk would
 * pause agents twice, rewrite each other's dialplan files and delete recordings the live
 * instance still lists. So in shadow mode every way out of the process that could change
 * something is filtered here, in one place, instead of trusting each caller to check:
 *
 *   - AMI actions: only the read-only ones below reach Asterisk.
 *   - Child processes: only `asterisk -rx "<read-only CLI command>"`.
 *   - File deletes and config writes: none.
 *
 * Refused calls look like a failed call to the code that made them (null AMI reply,
 * non-zero exit), which every caller already handles.
 */

import { envFlag } from './config';
import { getLogger } from './logger';

const log = getLogger('core.shadow');

/** True when this instance must not change the PBX, its config files or its recordings. */
export function shadowMode(): boolean {
  return envFlag('OPDESK_SHADOW', false);
}

// Actions that only read state. Login/Logoff/Events/Ping manage the session itself.
const READ_ONLY_AMI_ACTIONS = new Set(
  [
    'Login', 'Logoff', 'Challenge', 'Events', 'Ping', 'ListCommands', 'CoreSettings', 'CoreStatus',
    'CoreShowChannels', 'Status', 'ExtensionState', 'ExtensionStateList', 'DeviceStateList',
    'PresenceStateList', 'QueueStatus', 'QueueSummary', 'DBGet', 'DBGetTree', 'Getvar',
    'PJSIPShowEndpoints', 'PJSIPShowEndpoint', 'PJSIPShowContacts', 'PJSIPShowAors',
    'PJSIPShowRegistrationsInbound', 'PJSIPShowRegistrationsOutbound', 'SIPpeers', 'SIPshowpeer',
    'SIPshowregistry', 'IAXpeers', 'BridgeList', 'BridgeInfo', 'MailboxCount', 'MailboxStatus',
    'ParkedCalls', 'Agents', 'ConfbridgeList', 'ConfbridgeListRooms', 'ShowDialPlan',
  ].map((a) => a.toLowerCase()),
);

// CLI commands that only print. Anything else (reload, originate, database put/del, …) is refused.
const READ_ONLY_CLI = /^\s*(core show|database show|database get|pjsip show|sip show|queue show|dialplan show|manager show|module show|iax2 show|bridge show|confbridge list)\b/i;

/** True when `action` (with `params`) may be sent to Asterisk in shadow mode. */
export function amiActionAllowed(action: string, params: Record<string, unknown> | null): boolean {
  if (!shadowMode()) return true;
  const name = String(action || '').toLowerCase();
  if (name === 'command') return READ_ONLY_CLI.test(String(params?.Command ?? params?.command ?? ''));
  return READ_ONLY_AMI_ACTIONS.has(name);
}

/** True when the child process `argv` may run in shadow mode. */
export function commandAllowed(argv: string[]): boolean {
  if (!shadowMode()) return true;
  let args = [...argv];
  if (args[0] === 'sudo') args = args.slice(1).filter((a, i) => !(i === 0 && a === '-n'));
  const prog = (args[0] || '').split('/').pop();
  return prog === 'asterisk' && args[1] === '-rx' && READ_ONLY_CLI.test(args[2] || '');
}

/** Log one refused side effect (the caller then behaves as if it failed). */
export function refused(what: string): void {
  log.info('Shadow mode: refused %s', what);
}
