/**
 * /api/firewall/*: every response is the {data} envelope. lib/api unwraps any body with a
 * top-level `data` key, so a bare GeoIP status (which has its own `data` field) broke the page.
 */

jest.mock('../src/services/firewall-geoip', () => ({
  FirewallError: class extends Error {},
  loadConfig: jest.fn(async () => ({ enabled: false, countries: ['EG'], trusted: [] })),
  detectTools: jest.fn(async () => ({ ipset: true, iptables: true, ip6tables: true })),
  dataUpdatedAt: jest.fn(async () => '2026-10-30T00:00:00Z'),
  availableCountries: jest.fn(async () => ['EG', 'US']),
  isApplied: jest.fn(async () => false),
  droppedPackets: jest.fn(async () => 0),
  conflicts: jest.fn(async () => []),
  lastApplyError: jest.fn(() => null),
  wouldBlock: jest.fn(async () => ({ blocked: false, country: 'EG' })),
  countryOf: jest.fn(async () => 'US'),
}));
jest.mock('../src/services/firewall-fail2ban', () => ({
  status: jest.fn(async () => ({ available: true, jails: [], bans: [{ ip: '8.8.8.8', jail: 'sshd', banned_at: null, expires_at: null }] })),
}));

import { FirewallController } from '../src/api/routes/firewall.controller';

const ctl = new FirewallController();
const req = { ip: '41.32.0.1', socket: {}, headers: {}, params: {}, query: {}, body: {} } as never;

test('GET /api/firewall/geoip is enveloped, its own `data` field intact', async () => {
  const res = (await ctl.getGeoip(req)) as { data: { data: { countries: string[] }; client: { country: string } } };
  expect(res.data.data.countries).toEqual(['EG', 'US']);
  expect(res.data.client.country).toBe('EG');
});

test('GET /api/firewall/fail2ban is enveloped, bans carry a country', async () => {
  const res = (await ctl.getFail2ban()) as { data: { bans: { country: string }[] } };
  expect(res.data.bans[0].country).toBe('US');
});
