/**
 * The security log: one line per failed sign-in or rejected API key, for the `opdesk`
 * fail2ban jail (Settings -> Firewall) to read.
 *
 *   2026-10-30 10:36:01 opdesk: login failure from 203.0.113.7 (user=admin)
 *
 * The client address comes before anything the client typed, and the typed part is reduced
 * to a safe alphabet, so a crafted username cannot plant someone else's address in the line.
 * Times are local: fail2ban reads them as local time.
 */

import { promises as fsp } from 'fs';
import * as path from 'path';
import { env } from './config';
import { getLogger } from './logger';
import { parseIp } from '../services/firewall-net';

const log = getLogger('core.security_log');

export const SECURITY_LOG_FILE = env('OPDESK_SECURITY_LOG', '/var/log/opdesk/security.log');

export type AuthFailureKind = 'login' | 'api-key';

let warned = false;

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The line for one failure, or null when `ip` is not an address (nothing to ban). */
export function securityLogLine(kind: AuthFailureKind, ip: string | null, detail = '', now = new Date()): string | null {
  if (!ip || !parseIp(ip)) return null;
  const clean = detail.replace(/[^\w.@+-]/g, '?').slice(0, 64);
  return `${stamp(now)} opdesk: ${kind} failure from ${ip}${clean ? ` (user=${clean})` : ''}\n`;
}

/** Append one failure. Never throws: a full disk must not turn a 401 into a 500. */
export async function logAuthFailure(kind: AuthFailureKind, ip: string | null, detail = ''): Promise<void> {
  const line = securityLogLine(kind, ip, detail);
  if (!line) return;
  try {
    await fsp.mkdir(path.dirname(SECURITY_LOG_FILE), { recursive: true });
    await fsp.appendFile(SECURITY_LOG_FILE, line, { mode: 0o640 });
  } catch (e) {
    if (!warned) log.warning('Security log %s not written: %s', SECURITY_LOG_FILE, e);
    warned = true;
  }
}
