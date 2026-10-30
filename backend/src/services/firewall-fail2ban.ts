/**
 * fail2ban (Settings -> Firewall): the jails, who they have banned, manual ban/unban, and
 * per-jail thresholds.
 *
 * OpDesk owns two files and nothing else:
 *   - jail.d/opdesk.local: the admin's per-jail overrides (enabled, maxretry, findtime,
 *     bantime), the `opdesk` jail itself, and [DEFAULT] ignoreip = the PBX's own list plus
 *     Settings -> Firewall's trusted addresses. jail.d/*.local is read after jail.local, so
 *     these win over the PBX's (FreePBX's sysadmin module rewrites jail.local).
 *   - filter.d/opdesk.conf: matches core/security-log lines (failed OpDesk sign-ins and
 *     rejected API keys).
 * The DB (FIREWALL_F2B_JAILS) is the source of truth; the file is regenerated from it, tested
 * with `fail2ban-client -t`, and put back as it was if the test fails.
 */

import { promises as fsp } from 'fs';
import * as path from 'path';
import { env } from '../core/config';
import { getLogger } from '../core/logger';
import { SECURITY_LOG_FILE } from '../core/security-log';
import * as dbm from '../db/db-manager';
import { subprocessRun } from './dialplan';
import { asRoot, FirewallError } from './firewall-geoip';
import { parseIp } from './firewall-net';

const log = getLogger('services.firewall_fail2ban');

const F2B_DIR = env('FAIL2BAN_DIR', '/etc/fail2ban');
const JAIL_FILE = path.join(F2B_DIR, 'jail.d', 'opdesk.local');
const FILTER_FILE = path.join(F2B_DIR, 'filter.d', 'opdesk.conf');
const LOGROTATE_FILE = env('OPDESK_SECURITY_LOGROTATE', '/etc/logrotate.d/opdesk-security');

export const SETTING_JAILS = 'FIREWALL_F2B_JAILS';
export const OPDESK_JAIL = 'opdesk';
const OPDESK_JAIL_DEFAULTS = { maxretry: 5, findtime: 600, bantime: 3600 };

const JAIL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export interface JailOverride {
  enabled?: boolean;
  maxretry?: number;
  findtime?: number;
  /** Seconds; -1 bans for good. */
  bantime?: number;
}

export interface Jail {
  name: string;
  running: boolean;
  /** Overridden in jail.d/opdesk.local (or the opdesk jail itself). */
  managed: boolean;
  maxretry: number | null;
  findtime: number | null;
  bantime: number | null;
  banned: number;
}

export interface Ban {
  ip: string;
  jail: string;
  banned_at: string | null;
  expires_at: string | null;
}

async function f2b(args: string[], timeout = 30): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const r = await subprocessRun(asRoot(['fail2ban-client', ...args]), { timeout });
    return { ok: r.returncode === 0, out: r.stdout, err: r.stderr.trim() };
  } catch (e) {
    return { ok: false, out: '', err: String((e as Error)?.message || e) };
  }
}

export function validJailName(name: string): boolean {
  return JAIL_NAME.test(name);
}

/** Range-check one override; throws 400. */
export function validateOverride(o: JailOverride): JailOverride {
  const int = (v: unknown, name: string, min: number, max: number, extra?: number) => {
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || ((n < min || n > max) && n !== extra)) {
      throw new FirewallError(400, `${name} must be a whole number from ${min} to ${max}${extra !== undefined ? ` (or ${extra})` : ''}`);
    }
    return n;
  };
  return {
    enabled: o.enabled === undefined || o.enabled === null ? undefined : !!o.enabled,
    maxretry: int(o.maxretry, 'maxretry', 1, 1000),
    findtime: int(o.findtime, 'findtime', 60, 30 * 86400),
    bantime: int(o.bantime, 'bantime', 60, 365 * 86400, -1),
  };
}

export async function loadOverrides(): Promise<Record<string, JailOverride>> {
  try {
    const raw = JSON.parse((await dbm.getSetting(SETTING_JAILS, '{}')) || '{}');
    const out: Record<string, JailOverride> = {};
    for (const [name, o] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (validJailName(name) && o && typeof o === 'object') out[name] = o as JailOverride;
    }
    return out;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function available(): Promise<boolean> {
  const r = await f2b(['ping'], 10);
  return r.ok && /pong/.test(r.out);
}

/** `fail2ban-client -d`: maxretry/findtime/bantime per configured (enabled) jail. */
export function parseDump(out: string): Record<string, Partial<Record<'maxretry' | 'findtime' | 'bantime', number>>> {
  const cfg: ReturnType<typeof parseDump> = {};
  const re = /^\['set', '([^']+)', '(maxretry|findtime|bantime)', '?(-?\d+)'?\]$/;
  for (const line of out.split('\n')) {
    const m = re.exec(line.trim());
    if (m) (cfg[m[1]] ??= {})[m[2] as 'maxretry'] = Number(m[3]);
  }
  return cfg;
}

/** `fail2ban-client banned`: [{'jail': ['ip', ...]}, ...] (a Python repr). */
export function parseBanned(out: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const m of out.matchAll(/\{'([^']+)': \[([^\]]*)\]\}/g)) {
    result[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  return result;
}

/** `get <jail> banip --with-time`: "ip \t2026-10-30 10:36:51 + 604800 = 2026-11-06 10:36:51". */
export function parseBanTimes(out: string): Record<string, { banned_at: string; expires_at: string | null }> {
  const result: ReturnType<typeof parseBanTimes> = {};
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) \+ (-?\d+) = (\S+ \S+)/.exec(line.trim());
    if (m) result[m[1]] = { banned_at: m[2], expires_at: Number(m[3]) < 0 ? null : m[4] };
  }
  return result;
}

export async function status(): Promise<{ available: boolean; jails: Jail[]; bans: Ban[] }> {
  if (!(await available())) return { available: false, jails: [], bans: [] };
  const [st, dump, banned, overrides] = await Promise.all([f2b(['status']), f2b(['-d']), f2b(['banned']), loadOverrides()]);
  const running = (/Jail list:\s*(.*)$/m.exec(st.out)?.[1] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const cfg = parseDump(dump.out);
  const bannedBy = parseBanned(banned.out);
  const names = new Set([...running, ...Object.keys(overrides), OPDESK_JAIL]);
  const jails: Jail[] = [...names].sort().map((name) => {
    const c = cfg[name] || {};
    const o = overrides[name] || {};
    const fallback = name === OPDESK_JAIL ? OPDESK_JAIL_DEFAULTS : {};
    const pick = (k: 'maxretry' | 'findtime' | 'bantime') => c[k] ?? o[k] ?? (fallback as JailOverride)[k] ?? null;
    return {
      name,
      running: running.includes(name),
      managed: name === OPDESK_JAIL || name in overrides,
      maxretry: pick('maxretry'),
      findtime: pick('findtime'),
      bantime: pick('bantime'),
      banned: (bannedBy[name] || []).length,
    };
  });
  const bans: Ban[] = [];
  for (const [jail, ips] of Object.entries(bannedBy)) {
    if (!ips.length) continue;
    const times = parseBanTimes((await f2b(['get', jail, 'banip', '--with-time'])).out);
    for (const ip of ips) bans.push({ ip, jail, banned_at: times[ip]?.banned_at ?? null, expires_at: times[ip]?.expires_at ?? null });
  }
  bans.sort((a, b) => String(b.banned_at).localeCompare(String(a.banned_at)));
  return { available: true, jails, bans };
}

// ---------------------------------------------------------------------------
// Ban / unban
// ---------------------------------------------------------------------------

async function requireRunning(jail: string): Promise<void> {
  if (!validJailName(jail)) throw new FirewallError(400, 'Invalid jail name');
  const st = await f2b(['status', jail]);
  if (!st.ok) throw new FirewallError(404, `Jail ${jail} is not running`);
}

export async function ban(ip: string, jail: string): Promise<void> {
  if (!parseIp(ip)) throw new FirewallError(400, `Not an IP address: ${ip}`);
  await requireRunning(jail);
  const r = await f2b(['set', jail, 'banip', ip]);
  if (!r.ok) throw new FirewallError(500, `fail2ban refused the ban: ${r.err || r.out.trim()}`);
  log.info('fail2ban: %s banned in %s', ip, jail);
}

/** Unban from one jail, or from every jail when `jail` is empty. */
export async function unban(ip: string, jail?: string | null): Promise<void> {
  if (!parseIp(ip)) throw new FirewallError(400, `Not an IP address: ${ip}`);
  if (jail) await requireRunning(jail);
  const r = jail ? await f2b(['set', jail, 'unbanip', ip]) : await f2b(['unban', ip]);
  if (!r.ok) throw new FirewallError(500, `fail2ban refused the unban: ${r.err || r.out.trim()}`);
  log.info('fail2ban: %s unbanned from %s', ip, jail || 'all jails');
}

// ---------------------------------------------------------------------------
// Config files
// ---------------------------------------------------------------------------

/**
 * [DEFAULT] ignoreip as the PBX's own files set it (jail.conf, jail.d/*.conf, jail.local,
 * jail.d/*.local, last wins), ours excluded: the trusted list is added to it, not put in
 * its place.
 */
export async function baseIgnoreIp(): Promise<string> {
  const files = [path.join(F2B_DIR, 'jail.conf')];
  const dir = path.join(F2B_DIR, 'jail.d');
  const listed = await fsp.readdir(dir).catch(() => [] as string[]);
  files.push(...listed.filter((f) => f.endsWith('.conf')).sort().map((f) => path.join(dir, f)));
  files.push(path.join(F2B_DIR, 'jail.local'));
  files.push(...listed.filter((f) => f.endsWith('.local') && f !== path.basename(JAIL_FILE)).sort().map((f) => path.join(dir, f)));
  let value = '127.0.0.1/8 ::1';
  for (const file of files) {
    const text = await fsp.readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;
    const found = defaultIgnoreIp(text);
    if (found !== null) value = found;
  }
  return value;
}

/** The [DEFAULT] ignoreip of one INI file (continuation lines joined), or null. */
export function defaultIgnoreIp(text: string): string | null {
  let section = '';
  let found: string | null = null;
  let collecting = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s[#;].*$/, '');
    const sec = /^\s*\[([^\]]+)\]/.exec(line);
    if (sec) {
      section = sec[1].trim();
      collecting = false;
      continue;
    }
    if (/^\s*[#;]/.test(raw)) continue;
    if (collecting && /^\s+\S/.test(line)) {
      found = `${found} ${line.trim()}`.trim();
      continue;
    }
    collecting = false;
    const kv = /^ignoreip\s*[=:]\s*(.*)$/.exec(line);
    if (section === 'DEFAULT' && kv) {
      found = kv[1].trim();
      collecting = true;
    }
  }
  return found;
}

export function renderJailFile(overrides: Record<string, JailOverride>, ignoreip: string): string {
  const lines = [
    '# Managed by OpDesk (Settings -> Firewall). Changes made here are overwritten.',
    '',
    '[DEFAULT]',
    `ignoreip = ${ignoreip}`,
    '',
  ];
  const opdesk = { enabled: false, ...OPDESK_JAIL_DEFAULTS, ...(overrides[OPDESK_JAIL] || {}) };
  lines.push(
    `[${OPDESK_JAIL}]`,
    `enabled = ${opdesk.enabled ? 'true' : 'false'}`,
    `filter = ${OPDESK_JAIL}`,
    `logpath = ${SECURITY_LOG_FILE}`,
    'backend = auto',
    'action = iptables-allports[name=OpDesk, protocol=all]',
    `maxretry = ${opdesk.maxretry}`,
    `findtime = ${opdesk.findtime}`,
    `bantime = ${opdesk.bantime}`,
    '',
  );
  for (const [name, o] of Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b))) {
    if (name === OPDESK_JAIL) continue;
    const keys = (['enabled', 'maxretry', 'findtime', 'bantime'] as const).filter((k) => o[k] !== undefined);
    if (!keys.length) continue;
    lines.push(`[${name}]`, ...keys.map((k) => `${k} = ${k === 'enabled' ? (o[k] ? 'true' : 'false') : o[k]}`), '');
  }
  return lines.join('\n');
}

export const FILTER_CONF = `# Managed by OpDesk: failed sign-ins and rejected API keys (${SECURITY_LOG_FILE}).
[Definition]
failregex = ^\\s*opdesk: (?:login|api-key) failure from <HOST>(?: \\(user=[^)]*\\))?$
ignoreregex =
`;

const LOGROTATE_CONF = `${SECURITY_LOG_FILE} {
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
`;

/** Regenerate the managed files, test the whole config, and reload fail2ban. */
export async function writeConfig(overrides: Record<string, JailOverride>, trusted: string[]): Promise<void> {
  const ignoreip = [...new Set([...(await baseIgnoreIp()).split(/\s+/), ...trusted])].filter(Boolean).join(' ');
  const previous = await fsp.readFile(JAIL_FILE, 'utf8').catch(() => null);
  // fail2ban refuses to start a jail whose log file does not exist.
  await fsp.mkdir(path.dirname(SECURITY_LOG_FILE), { recursive: true });
  await fsp.appendFile(SECURITY_LOG_FILE, '', { mode: 0o640 });
  await fsp.writeFile(FILTER_FILE, FILTER_CONF, { mode: 0o644 });
  await fsp.writeFile(LOGROTATE_FILE, LOGROTATE_CONF, { mode: 0o644 }).catch(() => undefined);
  await fsp.writeFile(JAIL_FILE, renderJailFile(overrides, ignoreip), { mode: 0o644 });
  const test = await f2b(['-t']);
  if (!test.ok) {
    if (previous === null) await fsp.rm(JAIL_FILE, { force: true });
    else await fsp.writeFile(JAIL_FILE, previous);
    const why = (test.out + '\n' + test.err).split('\n').find((l) => /ERROR/.test(l)) || 'configuration test failed';
    throw new FirewallError(400, `fail2ban rejected the change: ${why.trim()}`);
  }
  const r = await f2b(['reload'], 60);
  if (!r.ok) throw new FirewallError(500, `fail2ban reload failed: ${r.err || r.out.trim()}`);
}

/** Merge one jail's override, persist it, and apply it. */
export async function updateJail(name: string, change: JailOverride, trusted: string[]): Promise<void> {
  if (!validJailName(name)) throw new FirewallError(400, 'Invalid jail name');
  const known = await status();
  if (!known.available) throw new FirewallError(503, 'fail2ban is not running');
  if (!known.jails.some((j) => j.name === name)) throw new FirewallError(404, `Unknown jail: ${name}`);
  const overrides = await loadOverrides();
  const merged = { ...(overrides[name] || {}) };
  for (const [k, v] of Object.entries(validateOverride(change)) as [keyof JailOverride, never][]) {
    if (v !== undefined) merged[k] = v;
  }
  const next = { ...overrides, [name]: merged };
  await writeConfig(next, trusted);
  if (!(await dbm.setSetting(SETTING_JAILS, JSON.stringify(next)))) throw new FirewallError(500, 'Failed to save fail2ban settings');
  log.info('fail2ban: jail %s updated %s', name, JSON.stringify(change));
}
