/**
 * Settings -> Firewall: IP/CIDR parsing, the security-log line fail2ban reads, the parsers
 * for fail2ban-client output, the managed jail file, and the GeoIP lockout guard.
 */

// No country data: every public address has an unknown country.
process.env.OPDESK_DATA_DIR = '/nonexistent/opdesk-test';

jest.mock('../src/db/db-manager', () => ({ getSetting: jest.fn(), setSetting: jest.fn(), setSettings: jest.fn() }));

import { securityLogLine } from '../src/core/security-log';
import {
  defaultIgnoreIp, parseBanned, parseBanTimes, parseDump, renderJailFile, validateOverride,
} from '../src/services/firewall-fail2ban';
import { FirewallError, parseTrusted, splitList, wouldBlock } from '../src/services/firewall-geoip';
import { formatIp, isPrivate, parseCidr, parseIp } from '../src/services/firewall-net';

describe('firewall-net', () => {
  test('IPv4 and IPv6 addresses parse; junk does not', () => {
    expect(parseIp('203.0.113.9')).toEqual({ family: 4, value: 0xcb007109n });
    expect(parseIp('::ffff:203.0.113.9')).toEqual({ family: 4, value: 0xcb007109n });
    expect(parseIp('2001:db8::1')?.family).toBe(6);
    expect(parseIp('2001:db8::1')?.value).toBe((0x20010db8n << 96n) | 1n);
    for (const bad of ['', '1.2.3', '1.2.3.256', '1.2.3.4.5', 'evil', '2001:db8:::1']) expect(parseIp(bad)).toBeNull();
  });

  test('CIDRs normalise to their network address', () => {
    expect(parseCidr('192.168.1.77/24')?.text).toBe('192.168.1.0/24');
    expect(parseCidr('8.8.8.8')?.text).toBe('8.8.8.8/32');
    expect(parseCidr('2001:db8:0:0:1::/32')?.text).toBe('2001:db8::/32');
    expect(parseCidr('1.2.3.4/33')).toBeNull();
    expect(parseCidr('1.2.3.4/24/1')).toBeNull();
    expect(parseCidr('1.2.3.4/x')).toBeNull();
  });

  test('IPv6 formatting compresses the longest zero run', () => {
    expect(formatIp(6, 1n)).toBe('::1');
    expect(formatIp(6, 0n)).toBe('::');
    expect(formatIp(6, (0x20010db8n << 96n) | (1n << 64n) | 1n)).toBe('2001:db8:0:1::1');
    expect(formatIp(6, 0xfe800000000000000000000000000001n)).toBe('fe80::1');
  });

  test('private ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.100.200', '100.64.1.1', '::1', 'fe80::1', 'fd00::5']) {
      expect(isPrivate(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1']) expect(isPrivate(ip)).toBe(false);
  });
});

describe('security log', () => {
  const at = new Date(2026, 9, 30, 9, 5, 7);

  test('one line per failure, local time first', () => {
    expect(securityLogLine('login', '203.0.113.9', 'admin', at)).toBe('2026-10-30 09:05:07 opdesk: login failure from 203.0.113.9 (user=admin)\n');
    expect(securityLogLine('api-key', '2001:db8::5', '', at)).toBe('2026-10-30 09:05:07 opdesk: api-key failure from 2001:db8::5\n');
  });

  test('a crafted username cannot plant another address', () => {
    const line = securityLogLine('login', '198.51.100.4', 'x) from 1.1.1.1 (\nopdesk: login failure from 9.9.9.9', at)!;
    expect(line.split('\n')).toHaveLength(2);
    expect(line).not.toMatch(/[ ()\n]9\.9\.9\.9|from 1\.1\.1\.1/);
  });

  test('nothing to ban without a real address', () => {
    expect(securityLogLine('login', null)).toBeNull();
    expect(securityLogLine('login', 'unknown')).toBeNull();
  });
});

describe('fail2ban-client output', () => {
  test('-d dump: thresholds per jail, other lines ignored', () => {
    const out = [
      "['add', 'sshd', 'auto']",
      "['set', 'sshd', 'maxretry', 5]",
      "['set', 'sshd', 'findtime', '600']",
      "['set', 'sshd', 'bantime', '-1']",
      "['multi-set', 'sshd', 'addfailregex', ['^x\\'s']]",
      "['set', 'pbx-gui', 'maxretry', 3]",
    ].join('\n');
    expect(parseDump(out)).toEqual({ sshd: { maxretry: 5, findtime: 600, bantime: -1 }, 'pbx-gui': { maxretry: 3 } });
  });

  test('banned', () => {
    expect(parseBanned("[{'sshd': []}, {'recidive': ['203.0.113.77', '2001:db8::1']}]")).toEqual({
      sshd: [],
      recidive: ['203.0.113.77', '2001:db8::1'],
    });
  });

  test('banip --with-time', () => {
    const out = '203.0.113.77 \t2026-10-30 10:36:51 + 604800 = 2026-11-06 10:36:51\n198.51.100.1 \t2026-10-30 10:00:00 + -1 = 9999-12-31 23:59:59\n';
    expect(parseBanTimes(out)).toEqual({
      '203.0.113.77': { banned_at: '2026-10-30 10:36:51', expires_at: '2026-11-06 10:36:51' },
      '198.51.100.1': { banned_at: '2026-10-30 10:00:00', expires_at: null },
    });
  });
});

describe('managed jail file', () => {
  test('[DEFAULT] ignoreip, continuation lines and comments', () => {
    const ini = '[DEFAULT]\nignoreip = 127.0.0.1 ; local\n   10.0.0.0/8\nbantime = 1\n[sshd]\nignoreip = 1.1.1.1\n';
    expect(defaultIgnoreIp(ini)).toBe('127.0.0.1 10.0.0.0/8');
    expect(defaultIgnoreIp('[sshd]\nignoreip = 1.1.1.1\n')).toBeNull();
  });

  test('the opdesk jail is always defined; other jails only carry what was changed', () => {
    const text = renderJailFile({ 'pbx-gui': { maxretry: 3 }, recidive: { enabled: false }, opdesk: { enabled: true, bantime: -1 } }, '127.0.0.1 203.0.113.0/24');
    expect(text).toContain('[DEFAULT]\nignoreip = 127.0.0.1 203.0.113.0/24\n');
    expect(text).toMatch(/\[opdesk\]\nenabled = true\nfilter = opdesk\n/);
    expect(text).toContain('bantime = -1');
    expect(text).toContain('[pbx-gui]\nmaxretry = 3\n');
    expect(text).toContain('[recidive]\nenabled = false\n');
    expect(renderJailFile({}, '127.0.0.1')).toMatch(/\[opdesk\]\nenabled = false/);
  });

  test('overrides are range-checked', () => {
    expect(validateOverride({ maxretry: 3, bantime: -1 })).toEqual({ enabled: undefined, maxretry: 3, findtime: undefined, bantime: -1 });
    expect(() => validateOverride({ maxretry: 0 })).toThrow(FirewallError);
    expect(() => validateOverride({ findtime: 10 })).toThrow(/findtime/);
    expect(() => validateOverride({ bantime: -2 })).toThrow(/bantime/);
    expect(() => validateOverride({ maxretry: 2.5 })).toThrow(/maxretry/);
  });
});

describe('GeoIP config', () => {
  test('lists split on commas, whitespace and newlines', () => {
    expect(splitList('EG, ae\nSA;;')).toEqual(['EG', 'ae', 'SA']);
    expect(splitList(null)).toEqual([]);
  });

  test('trusted entries are validated', () => {
    expect(parseTrusted(['203.0.113.0/24', '2001:db8::1']).map((c) => c.text)).toEqual(['203.0.113.0/24', '2001:db8::1/128']);
    expect(() => parseTrusted(['203.0.113.0/24', 'nope'])).toThrow('Not an IP address or CIDR: nope');
  });

  test('lockout guard: private and trusted pass, an unknown country does not', async () => {
    const cfg = { enabled: true, countries: ['EG'], trusted: ['203.0.113.0/24'] };
    expect((await wouldBlock('192.168.100.5', cfg)).blocked).toBe(false);
    expect((await wouldBlock('203.0.113.50', cfg)).blocked).toBe(false);
    expect(await wouldBlock('198.51.100.7', cfg)).toEqual({ blocked: true, country: null });
    expect((await wouldBlock('198.51.100.7', { ...cfg, enabled: false })).blocked).toBe(false);
    expect((await wouldBlock(null, cfg)).blocked).toBe(false);
  });
});
