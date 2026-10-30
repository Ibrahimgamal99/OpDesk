/**
 * Settings -> Firewall -> Logs: the recent security events, newest first, from two files:
 *   - OpDesk's security log (core/security-log): failed sign-ins and rejected API keys.
 *   - fail2ban's own log: what each jail detected ("Found"), banned and unbanned.
 * Only the tail of each file is read, so a large log costs the same as a small one.
 */

import { promises as fsp } from 'fs';
import { SECURITY_LOG_FILE } from '../core/security-log';
import { subprocessRun } from './dialplan';
import { asRoot } from './firewall-geoip';

const TAIL_BYTES = 512 * 1024;

export type SecurityEventKind = 'login_failed' | 'api_key_failed' | 'detected' | 'banned' | 'unbanned';

export interface SecurityEvent {
  /** Local time, "YYYY-MM-DD HH:MM:SS". */
  time: string;
  kind: SecurityEventKind;
  ip: string;
  /** The jail (fail2ban events) or the username tried (sign-ins). */
  jail: string | null;
  user: string | null;
}

/** The last `bytes` of a file as lines (the first, likely partial, line dropped). */
export async function tailLines(file: string, bytes = TAIL_BYTES): Promise<string[]> {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } catch {
    return [];
  } finally {
    await fh?.close();
  }
}

/** "2026-10-30 10:36:51 opdesk: login failure from 203.0.113.9 (user=admin)" */
export function parseSecurityLine(line: string): SecurityEvent | null {
  const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) opdesk: (login|api-key) failure from (\S+)(?: \(user=([^)]*)\))?$/.exec(line);
  if (!m) return null;
  return { time: m[1], kind: m[2] === 'login' ? 'login_failed' : 'api_key_failed', ip: m[3], jail: null, user: m[4] ?? null };
}

/** "2026-10-30 10:36:51,794 fail2ban.actions [6455]: NOTICE  [recidive] Ban 203.0.113.77" */
export function parseFail2banLine(line: string): SecurityEvent | null {
  const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+ fail2ban\.\w+\s+\[\d+\]:\s+\w+\s+\[([^\]]+)\] (Found|Ban|Unban|Restore Ban) (\S+)/.exec(line);
  if (!m) return null;
  const kind: SecurityEventKind = m[3] === 'Found' ? 'detected' : m[3] === 'Unban' ? 'unbanned' : 'banned';
  return { time: m[1], kind, ip: m[4], jail: m[2], user: null };
}

/** fail2ban's log file, as the running server reports it (null when it logs elsewhere). */
export async function fail2banLogFile(): Promise<string | null> {
  try {
    const r = await subprocessRun(asRoot(['fail2ban-client', 'get', 'logtarget']), { timeout: 10 });
    const file = /(\/\S+)\s*$/.exec(r.stdout.trim())?.[1];
    return r.returncode === 0 && file ? file : null;
  } catch {
    return null;
  }
}

/** The newest `limit` events from both logs. */
export async function recentEvents(limit = 200): Promise<{ events: SecurityEvent[]; files: { security: string; fail2ban: string | null } }> {
  const f2bFile = await fail2banLogFile();
  const [own, f2b] = await Promise.all([tailLines(SECURITY_LOG_FILE), f2bFile ? tailLines(f2bFile) : Promise.resolve([])]);
  const events = [
    ...own.reverse().map(parseSecurityLine),
    ...f2b.reverse().map(parseFail2banLine),
  ].filter((e): e is SecurityEvent => e !== null);
  // Each file reversed first, so the stable sort keeps newest-first within one second.
  events.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  return { events: events.slice(0, limit), files: { security: SECURITY_LOG_FILE, fail2ban: f2bFile } };
}
