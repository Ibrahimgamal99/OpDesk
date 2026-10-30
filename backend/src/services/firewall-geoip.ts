/**
 * GeoIP allow-list (Settings -> Firewall): inbound traffic on every port is dropped unless
 * it comes from an allowed country, a trusted address, a private range, or belongs to a
 * connection the box opened itself.
 *
 * Country data is ipdeny.com's per-country CIDR lists (IPv4 and IPv6), downloaded into
 * OPDESK_DATA_DIR/geoip and refreshed weekly. Enforcement is two ipsets per family
 * (allowed countries, trusted) and one iptables chain, OPDESK-GEO, hooked at the top of
 * INPUT:
 *
 *   -i lo                          RETURN
 *   ESTABLISHED,RELATED            RETURN   replies to trunks, CRM, updates
 *   private ranges                 RETURN
 *   src in opdesk-trust4           RETURN
 *   src in opdesk-geo4             RETURN
 *                                  DROP
 *
 * RETURN, not ACCEPT: fail2ban's chains still see allowed traffic. Rules live in the kernel
 * only, so startup re-applies them and a 5-minute check re-hooks the chain if another tool
 * flushed INPUT. Sets are rebuilt under a temporary name and swapped in, so an update never
 * leaves a moment with an empty allow-list.
 */

import { promises as fsp } from 'fs';
import * as path from 'path';
import { env } from '../core/config';
import { getLogger } from '../core/logger';
import * as dbm from '../db/db-manager';
import { subprocessRun } from './dialplan';
import { type Cidr, type Family, parseCidr, parseIp, isPrivate, PRIVATE_V4, PRIVATE_V6 } from './firewall-net';

const log = getLogger('services.firewall_geoip');

export const DATA_DIR = env('OPDESK_DATA_DIR', '/var/lib/opdesk');
const GEO_DIR = path.join(DATA_DIR, 'geoip');
const CURRENT_DIR = path.join(GEO_DIR, 'current');
const STAMP_FILE = path.join(CURRENT_DIR, 'updated_at');
const ZONE_URLS: Record<Family, string> = {
  4: env('FIREWALL_GEOIP_URL_V4', 'https://www.ipdeny.com/ipblocks/data/countries/all-zones.tar.gz'),
  6: env('FIREWALL_GEOIP_URL_V6', 'https://www.ipdeny.com/ipv6/ipaddresses/blocks/ipv6-all-zones.tar.gz'),
};
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
export const REFRESH_AFTER_MS = 7 * 24 * 3600 * 1000;

export const CHAIN = 'OPDESK-GEO';
const SETS: Record<Family, { geo: string; trust: string; inet: string; ipt: string }> = {
  4: { geo: 'opdesk-geo4', trust: 'opdesk-trust4', inet: 'inet', ipt: 'iptables' },
  6: { geo: 'opdesk-geo6', trust: 'opdesk-trust6', inet: 'inet6', ipt: 'ip6tables' },
};

export const SETTING_ENABLED = 'FIREWALL_GEOIP_ENABLED';
export const SETTING_COUNTRIES = 'FIREWALL_GEOIP_COUNTRIES';
export const SETTING_TRUSTED = 'FIREWALL_TRUSTED';

/** A refusal the route turns into an HTTP error with this status. */
export class FirewallError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'FirewallError';
  }
}

export interface GeoipConfig {
  enabled: boolean;
  /** ISO 3166 alpha-2, upper case. */
  countries: string[];
  /** Addresses and CIDRs, as entered (validated). */
  trusted: string[];
}

/** Run as root: directly when the backend is root, else through sudo. */
export function asRoot(argv: string[]): string[] {
  return process.getuid?.() === 0 ? argv : ['sudo', '-n', ...argv];
}

async function run(argv: string[], input?: string): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const r = await subprocessRun(asRoot(argv), { timeout: 60, input: input ?? null });
    return { ok: r.returncode === 0, out: r.stdout, err: r.stderr.trim() };
  } catch (e) {
    return { ok: false, out: '', err: String((e as Error)?.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function splitList(raw: string | null | undefined): string[] {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function loadConfig(): Promise<GeoipConfig> {
  return {
    enabled: (await dbm.getSetting(SETTING_ENABLED, 'false')) === 'true',
    countries: splitList(await dbm.getSetting(SETTING_COUNTRIES, '')).map((c) => c.toUpperCase()),
    trusted: splitList(await dbm.getSetting(SETTING_TRUSTED, '')),
  };
}

export async function saveConfig(cfg: GeoipConfig): Promise<void> {
  const ok = await dbm.setSettings({
    [SETTING_ENABLED]: cfg.enabled ? 'true' : 'false',
    [SETTING_COUNTRIES]: cfg.countries.join(','),
    [SETTING_TRUSTED]: cfg.trusted.join(','),
  });
  if (!ok) throw new FirewallError(500, 'Failed to save firewall settings');
}

/** Each trusted entry parsed; throws 400 naming the first bad one. */
export function parseTrusted(entries: string[]): Cidr[] {
  return entries.map((e) => {
    const c = parseCidr(e);
    if (!c) throw new FirewallError(400, `Not an IP address or CIDR: ${e}`);
    return c;
  });
}

// ---------------------------------------------------------------------------
// Country data
// ---------------------------------------------------------------------------

interface Range {
  start: bigint;
  end: bigint;
  cc: string;
}

let index: { 4: Range[]; 6: Range[]; countries: string[]; stamp: string } | null = null;

/** Every CIDR in a zone file, validated: the file came from the internet. */
function parseZone(text: string, family: Family): Cidr[] {
  const out: Cidr[] = [];
  for (const line of text.split('\n')) {
    const c = parseCidr(line);
    if (c && c.family === family) out.push(c);
  }
  return out;
}

async function zoneFiles(family: Family): Promise<string[]> {
  try {
    return (await fsp.readdir(path.join(CURRENT_DIR, `v${family}`))).filter((f) => /^[a-z]{2}\.zone$/.test(f)).sort();
  } catch {
    return [];
  }
}

async function readZone(cc: string, family: Family): Promise<Cidr[]> {
  try {
    return parseZone(await fsp.readFile(path.join(CURRENT_DIR, `v${family}`, `${cc.toLowerCase()}.zone`), 'utf8'), family);
  } catch {
    return [];
  }
}

/** When the data was downloaded (ISO), or null when there is none. */
export async function dataUpdatedAt(): Promise<string | null> {
  try {
    return (await fsp.readFile(STAMP_FILE, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

async function loadIndex(): Promise<NonNullable<typeof index>> {
  const stamp = (await dataUpdatedAt()) || '';
  if (index && index.stamp === stamp) return index;
  const next: NonNullable<typeof index> = { 4: [], 6: [], countries: [], stamp };
  const countries = new Set<string>();
  for (const family of [4, 6] as Family[]) {
    for (const file of await zoneFiles(family)) {
      const cc = file.slice(0, 2).toUpperCase();
      countries.add(cc);
      for (const c of await readZone(cc, family)) next[family].push({ start: c.start, end: c.end, cc });
    }
    next[family].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  }
  next.countries = [...countries].sort();
  index = next;
  return next;
}

/** Country codes the data covers (empty before the first download). */
export async function availableCountries(): Promise<string[]> {
  return (await loadIndex()).countries;
}

/** An address's country (ISO alpha-2), or null when private, unknown or no data. */
export async function countryOf(ip: string): Promise<string | null> {
  const p = parseIp(ip);
  if (!p) return null;
  const ranges = (await loadIndex())[p.family];
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].start <= p.value) lo = mid + 1;
    else hi = mid - 1;
  }
  const r = ranges[hi];
  return r && r.end >= p.value ? r.cc : null;
}

/** Download both tarballs, unpack them beside the current data, then switch over. */
export async function updateData(): Promise<string> {
  await fsp.mkdir(GEO_DIR, { recursive: true });
  const work = await fsp.mkdtemp(path.join(GEO_DIR, '.new-'));
  try {
    for (const family of [4, 6] as Family[]) {
      const res = await fetch(ZONE_URLS[family], { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new FirewallError(502, `GeoIP download failed: HTTP ${res.status} from ${ZONE_URLS[family]}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_DOWNLOAD_BYTES) throw new FirewallError(502, 'GeoIP download is unexpectedly large');
      const tgz = path.join(work, `v${family}.tar.gz`);
      const dir = path.join(work, `v${family}`);
      await fsp.writeFile(tgz, body);
      await fsp.mkdir(dir);
      const r = await subprocessRun(['tar', '-xzf', tgz, '-C', dir, '--no-same-owner', '--no-same-permissions'], { timeout: 60 });
      if (r.returncode !== 0) throw new FirewallError(502, `GeoIP archive could not be unpacked: ${r.stderr.trim()}`);
      await fsp.rm(tgz);
    }
    const v4 = (await fsp.readdir(path.join(work, 'v4'))).filter((f) => /^[a-z]{2}\.zone$/.test(f));
    if (v4.length < 100) throw new FirewallError(502, `GeoIP download looks incomplete (${v4.length} countries)`);
    const stamp = new Date().toISOString();
    await fsp.writeFile(path.join(work, 'updated_at'), stamp);
    const old = `${CURRENT_DIR}.old`;
    await fsp.rm(old, { recursive: true, force: true });
    await fsp.rename(CURRENT_DIR, old).catch(() => undefined);
    await fsp.rename(work, CURRENT_DIR);
    await fsp.rm(old, { recursive: true, force: true });
    log.info('GeoIP data updated: %s countries', v4.length);
    return stamp;
  } catch (e) {
    await fsp.rm(work, { recursive: true, force: true });
    if (e instanceof FirewallError) throw e;
    throw new FirewallError(502, `GeoIP download failed: ${(e as Error)?.message || e}`);
  }
}

// ---------------------------------------------------------------------------
// Lockout guard
// ---------------------------------------------------------------------------

/** Would `cfg` drop new connections from `ip`? (Unknown country counts as dropped.) */
export async function wouldBlock(ip: string | null, cfg: GeoipConfig): Promise<{ blocked: boolean; country: string | null }> {
  if (!ip || !parseIp(ip)) return { blocked: false, country: null };
  const country = await countryOf(ip);
  if (!cfg.enabled || isPrivate(ip)) return { blocked: false, country };
  const p = parseIp(ip)!;
  if (parseTrusted(cfg.trusted).some((c) => c.family === p.family && p.value >= c.start && p.value <= c.end)) {
    return { blocked: false, country };
  }
  return { blocked: !country || !cfg.countries.includes(country), country };
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

export interface Tools {
  ipset: boolean;
  iptables: boolean;
  ip6tables: boolean;
}

export async function detectTools(): Promise<Tools> {
  const has = async (argv: string[]) => (await run(argv)).ok;
  const [ipset, iptables, ip6tables] = await Promise.all([
    has(['ipset', 'version']),
    has(['iptables', '-V']),
    has(['ip6tables', '-V']),
  ]);
  return { ipset, iptables, ip6tables };
}

function setScript(name: string, inet: string, entries: Cidr[]): string {
  const tmp = `${name}-tmp`;
  const opts = `hash:net family ${inet} hashsize 4096 maxelem 1048576`;
  return [
    `create ${tmp} ${opts}`,
    `flush ${tmp}`,
    ...entries.map((c) => `add ${tmp} ${c.text}`),
    `create ${name} ${opts}`,
    `swap ${tmp} ${name}`,
    `destroy ${tmp}`,
    '',
  ].join('\n');
}

function chainScript(family: Family): string {
  const s = SETS[family];
  const priv = family === 4 ? PRIVATE_V4 : PRIVATE_V6;
  return [
    '*filter',
    `:${CHAIN} - [0:0]`,
    `-F ${CHAIN}`,
    `-A ${CHAIN} -i lo -j RETURN`,
    `-A ${CHAIN} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN`,
    ...priv.map((c) => `-A ${CHAIN} -s ${c} -j RETURN`),
    `-A ${CHAIN} -m set --match-set ${s.trust} src -j RETURN`,
    `-A ${CHAIN} -m set --match-set ${s.geo} src -j RETURN`,
    `-A ${CHAIN} -j DROP`,
    'COMMIT',
    '',
  ].join('\n');
}

async function hook(ipt: string): Promise<void> {
  if (!(await run([ipt, '-w', '-C', 'INPUT', '-j', CHAIN])).ok) {
    const r = await run([ipt, '-w', '-I', 'INPUT', '1', '-j', CHAIN]);
    if (!r.ok) throw new FirewallError(500, `${ipt}: could not hook ${CHAIN} into INPUT: ${r.err}`);
  }
}

async function unhook(family: Family): Promise<void> {
  const { ipt, geo, trust } = SETS[family];
  for (let i = 0; i < 10 && (await run([ipt, '-w', '-D', 'INPUT', '-j', CHAIN])).ok; i++);
  await run([ipt, '-w', '-F', CHAIN]);
  await run([ipt, '-w', '-X', CHAIN]);
  await run(['ipset', 'destroy', geo]);
  await run(['ipset', 'destroy', trust]);
}

let lastError: string | null = null;

export function lastApplyError(): string | null {
  return lastError;
}

/** Make the kernel match `cfg`: install or refresh the sets and chain, or remove them. */
export async function apply(cfg: GeoipConfig): Promise<void> {
  try {
    if (!cfg.enabled) {
      await unhook(4);
      await unhook(6);
      lastError = null;
      return;
    }
    const tools = await detectTools();
    if (!tools.ipset || !tools.iptables) {
      throw new FirewallError(500, `GeoIP needs ${!tools.ipset ? 'ipset' : 'iptables'}, which is not installed`);
    }
    const trusted = parseTrusted(cfg.trusted);
    const families: Family[] = tools.ip6tables ? [4, 6] : [4];
    for (const family of families) {
      const s = SETS[family];
      const allowed: Cidr[] = [];
      for (const cc of cfg.countries) allowed.push(...(await readZone(cc, family)));
      let r = await run(['ipset', 'restore', '-exist'], setScript(s.geo, s.inet, allowed));
      if (r.ok) r = await run(['ipset', 'restore', '-exist'], setScript(s.trust, s.inet, trusted.filter((c) => c.family === family)));
      if (!r.ok) throw new FirewallError(500, `ipset: ${r.err}`);
      r = await run([`${s.ipt}-restore`, '-w', '--noflush'], chainScript(family));
      if (!r.ok) throw new FirewallError(500, `${s.ipt}-restore: ${r.err}`);
      await hook(s.ipt);
    }
    lastError = null;
    log.info('GeoIP firewall applied: countries=%s trusted=%s', cfg.countries.join(','), cfg.trusted.length);
  } catch (e) {
    lastError = (e as Error)?.message || String(e);
    throw e;
  }
}

/** True when the chain is hooked into INPUT and the IPv4 allow set exists. */
export async function isApplied(): Promise<boolean> {
  const [hooked, set] = await Promise.all([
    run(['iptables', '-w', '-C', 'INPUT', '-j', CHAIN]),
    run(['ipset', 'list', '-n', SETS[4].geo]),
  ]);
  return hooked.ok && set.ok;
}

/** Packets the final DROP rule has matched since the last apply (both families). */
export async function droppedPackets(): Promise<number> {
  let total = 0;
  for (const family of [4, 6] as Family[]) {
    const r = await run([SETS[family].ipt, '-w', '-n', '-v', '-x', '-L', CHAIN]);
    if (!r.ok) continue;
    for (const line of r.out.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols[2] === 'DROP' && /^\d+$/.test(cols[0])) total += Number(cols[0]);
    }
  }
  return total;
}

/** Other firewalls that may reset INPUT under us. */
export async function conflicts(): Promise<string[]> {
  const found: string[] = [];
  const rules = await run(['iptables', '-w', '-S']);
  if (/fpbxfirewall/.test(rules.out)) found.push('FreePBX Firewall');
  if ((await run(['systemctl', 'is-active', '--quiet', 'firewalld'])).ok) found.push('firewalld');
  return found;
}

// ---------------------------------------------------------------------------
// Background: re-apply at startup, re-hook if flushed, refresh weekly
// ---------------------------------------------------------------------------

const CHECK_EVERY_MS = 5 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let lastRefreshAttempt = 0;

async function tick(startup = false): Promise<void> {
  const cfg = await loadConfig();
  const stamp = await dataUpdatedAt();
  // With GeoIP off, still fetch the data once so Settings has countries to pick from;
  // with it on, keep the data fresh.
  const stale = !stamp || (cfg.enabled && Date.now() - Date.parse(stamp) > REFRESH_AFTER_MS);
  // One refresh attempt a day at most: a dead mirror must not be hit every 5 minutes.
  if (stale && Date.now() - lastRefreshAttempt > 24 * 3600 * 1000) {
    lastRefreshAttempt = Date.now();
    try {
      await updateData();
      if (cfg.enabled) await apply(cfg);
      return;
    } catch (e) {
      log.warning('GeoIP data download failed (keeping the current data): %s', (e as Error)?.message || e);
    }
  }
  if (!cfg.enabled) return;
  if (startup || !(await isApplied())) {
    if (!startup) log.warning('GeoIP firewall chain was missing (flushed by another tool?); re-applying');
    await apply(cfg);
  }
}

export async function start(): Promise<void> {
  // Not awaited: a first download can take a while and must not hold up startup. The timer
  // starts even when this first apply fails: the next tick retries it.
  void tick(true).catch((e) => log.warning('GeoIP firewall not applied at startup: %s', (e as Error)?.message || e));
  timer = setInterval(() => {
    tick().catch((e) => log.warning('GeoIP check failed: %s', (e as Error)?.message || e));
  }, CHECK_EVERY_MS);
  timer.unref();
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
