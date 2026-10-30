/**
 * IP and CIDR parsing for the firewall: trusted-list validation, the private ranges GeoIP
 * never filters, and the in-memory country lookup. Addresses are bigints so IPv4 and IPv6
 * share one code path.
 */

import { isIP } from 'net';

export type Family = 4 | 6;

export interface Cidr {
  family: Family;
  start: bigint;
  end: bigint;
  /** Normalised text, as ipset and iptables take it. */
  text: string;
}

function parseV4(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = (n << 8n) | BigInt(Number(p));
  }
  return n;
}

function parseV6(ip: string): bigint | null {
  if (isIP(ip) !== 6) return null;
  let text = ip.split('%')[0];
  // An embedded dotted quad (::ffff:1.2.3.4) becomes two hextets.
  const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (quad) {
    const v4 = parseV4(quad[1]);
    if (v4 === null) return null;
    text = text.slice(0, -quad[1].length) + `${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(parseInt(g || '0', 16));
  return n;
}

/** An address -> its family and value; IPv4-mapped IPv6 (::ffff:a.b.c.d) counts as IPv4. */
export function parseIp(ip: string): { family: Family; value: bigint } | null {
  const s = String(ip || '').trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  const v4 = parseV4(mapped ? mapped[1] : s);
  if (v4 !== null) return { family: 4, value: v4 };
  const v6 = parseV6(s);
  return v6 === null ? null : { family: 6, value: v6 };
}

/** "1.2.3.4", "1.2.3.0/24", "2001:db8::/32" -> the range; null when malformed. */
export function parseCidr(input: string): Cidr | null {
  const [addr, bits, extra] = String(input || '').trim().split('/');
  if (extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const width = ip.family === 4 ? 32 : 128;
  let prefix = width;
  if (bits !== undefined) {
    if (!/^\d{1,3}$/.test(bits) || Number(bits) > width) return null;
    prefix = Number(bits);
  }
  const host = (1n << BigInt(width - prefix)) - 1n;
  const start = ip.value & ~host & ((1n << BigInt(width)) - 1n);
  return { family: ip.family, start, end: start | host, text: `${formatIp(ip.family, start)}/${prefix}` };
}

export function formatIp(family: Family, value: bigint): string {
  if (family === 4) return [24n, 16n, 8n, 0n].map((s) => String((value >> s) & 0xffn)).join('.');
  const groups: string[] = [];
  for (let s = 112n; s >= 0n; s -= 16n) groups.push(((value >> s) & 0xffffn).toString(16));
  // RFC 5952: the longest run of two or more zero groups becomes "::".
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > bestLen) [best, bestLen] = [i, j - i];
    i = j > i ? j : i + 1;
  }
  if (best < 0) return groups.join(':');
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + bestLen).join(':')}`;
}

export function contains(range: Cidr, family: Family, value: bigint): boolean {
  return range.family === family && value >= range.start && value <= range.end;
}

/** Loopback, RFC 1918, CGNAT, link-local and ULA: never geo-filtered. */
export const PRIVATE_V4 = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16'];
export const PRIVATE_V6 = ['::1/128', 'fe80::/10', 'fc00::/7'];
const PRIVATE = [...PRIVATE_V4, ...PRIVATE_V6].map((c) => parseCidr(c) as Cidr);

export function isPrivate(ip: string): boolean {
  const p = parseIp(ip);
  return !!p && PRIVATE.some((r) => contains(r, p.family, p.value));
}
