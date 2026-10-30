/**
 * Settings -> Firewall (admin only): the GeoIP allow-list and fail2ban.
 *
 * Every change that could cut the admin off is checked against the address the request
 * came from: saving a GeoIP config that would drop it is refused (409) until it is trusted
 * or its country allowed, and an admin cannot ban their own address.
 */

import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { setRedactedAuditDetail } from '../../core/audit';
import { getLogger } from '../../core/logger';
import * as f2b from '../../services/firewall-fail2ban';
import * as geo from '../../services/firewall-geoip';
import { parseIp } from '../../services/firewall-net';
import { HttpError } from '../http-error';
import { respond } from '../respond';
import { Auth, clientHost, Get, Post, Put, principal } from '../routing';
import { parseBody, pStr, v } from '../validation';

export const log = getLogger('api.routes.firewall');

export const GeoipBody = v.model({
  enabled: v.bool(),
  countries: v.list(),
  trusted: v.list(),
});

export const JailBody = v.model({
  enabled: v.bool().nullish(),
  maxretry: v.int().nullish(),
  findtime: v.int().nullish(),
  bantime: v.int().nullish(),
});

export const BanBody = v.model({
  ip: v.str(),
  jail: v.str().nullish(),
});

/** Run `fn`, turning a FirewallError into the HTTP error it names. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof geo.FirewallError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

/** Jails and current bans, each ban with its country. */
async function fail2banStatus() {
  const st = await f2b.status();
  const bans = await Promise.all(st.bans.map(async (b) => ({ ...b, country: await geo.countryOf(b.ip) })));
  return { ...st, bans };
}

async function geoipStatus(req: Request) {
  const cfg = await geo.loadConfig();
  const [tools, updatedAt, countries, applied, dropped, conflicts] = await Promise.all([
    geo.detectTools(),
    geo.dataUpdatedAt(),
    geo.availableCountries(),
    geo.isApplied(),
    geo.droppedPackets(),
    geo.conflicts(),
  ]);
  const ip = clientHost(req);
  // Whether the caller would get through with GeoIP on and the saved countries/trusted list.
  const you = await geo.wouldBlock(ip, { ...cfg, enabled: true });
  return {
    ...cfg,
    tools,
    data: { updated_at: updatedAt, countries },
    applied: cfg.enabled && applied,
    dropped_packets: dropped,
    conflicts,
    last_error: geo.lastApplyError(),
    client: { ip, country: you.country, allowed: !you.blocked },
  };
}

@Controller()
export class FirewallController {
  /** GeoIP config, data freshness, and whether the caller's own address would pass. */
  @Get('/api/firewall/geoip')
  @Auth('admin')
  async getGeoip(@Req() req: Request) {
    return respond(await geoipStatus(req));
  }

  /**
   * Save and apply the GeoIP config. Downloads the country data first when there is none.
   * 409 when the caller's own address would be dropped.
   */
  @Put('/api/firewall/geoip')
  @Auth('admin')
  async putGeoip(@Req() req: Request) {
    const body = parseBody(GeoipBody, req.body);
    return guarded(async () => {
      const countries = [...new Set((body.countries || []).map((c) => String(c).trim().toUpperCase()).filter(Boolean))];
      const trusted = [...new Set((body.trusted || []).map((c) => String(c).trim()).filter(Boolean))];
      geo.parseTrusted(trusted);
      const next: geo.GeoipConfig = { enabled: body.enabled, countries, trusted };
      const prev = await geo.loadConfig();

      if (next.enabled) {
        if (!countries.length) throw new HttpError(400, 'Pick at least one allowed country');
        if (!(await geo.dataUpdatedAt())) await geo.updateData();
        const known = await geo.availableCountries();
        const unknown = countries.filter((c) => !known.includes(c));
        if (unknown.length) throw new HttpError(400, `Unknown country code(s): ${unknown.join(', ')}`);
        const ip = clientHost(req);
        const you = await geo.wouldBlock(ip, next);
        if (you.blocked) {
          throw new HttpError(
            409,
            `This would block your own connection from ${ip}${you.country ? ` (${you.country})` : ''}. ` +
              'Allow that country or add the address to the trusted list first.',
          );
        }
      }

      await geo.saveConfig(next);
      try {
        await geo.apply(next);
      } catch (e) {
        await geo.saveConfig(prev);
        await geo.apply(prev).catch(() => undefined);
        throw e;
      }
      // The trusted list doubles as fail2ban's ignoreip.
      if (trusted.join(',') !== prev.trusted.join(',') && (await f2b.available())) {
        await f2b.writeConfig(await f2b.loadOverrides(), trusted);
      }
      setRedactedAuditDetail(req, next);
      log.info('GeoIP firewall %s by %s (countries=%s)', next.enabled ? 'enabled' : 'disabled', principal(req).username, countries.join(','));
      return respond(await geoipStatus(req));
    });
  }

  /** Download fresh country data now and re-apply. */
  @Post('/api/firewall/geoip/update')
  @Auth('admin')
  async updateGeoip(@Req() req: Request) {
    return guarded(async () => {
      await geo.updateData();
      const cfg = await geo.loadConfig();
      if (cfg.enabled) await geo.apply(cfg);
      return respond(await geoipStatus(req));
    });
  }

  /** Jails, their thresholds, and every current ban with its country. */
  @Get('/api/firewall/fail2ban')
  @Auth('admin')
  async getFail2ban() {
    return respond(await fail2banStatus());
  }

  /** Change one jail's enabled flag or thresholds (persisted in jail.d/opdesk.local). */
  @Put('/api/firewall/fail2ban/jails/:jail')
  @Auth('admin')
  async putJail(@Req() req: Request) {
    const jail = pStr(req.params.jail);
    const body = parseBody(JailBody, req.body);
    return guarded(async () => {
      await f2b.updateJail(jail, {
        enabled: body.enabled ?? undefined,
        maxretry: body.maxretry ?? undefined,
        findtime: body.findtime ?? undefined,
        bantime: body.bantime ?? undefined,
      }, (await geo.loadConfig()).trusted);
      setRedactedAuditDetail(req, { jail, ...body });
      return respond(await fail2banStatus());
    });
  }

  /** Ban an address by hand. Refused for the caller's own address. */
  @Post('/api/firewall/fail2ban/ban')
  @Auth('admin')
  async banIp(@Req() req: Request) {
    const body = parseBody(BanBody, req.body);
    const ip = (body.ip || '').trim();
    const jail = (body.jail || f2b.OPDESK_JAIL).trim();
    const own = clientHost(req);
    const p = parseIp(ip);
    const mine = own ? parseIp(own) : null;
    if (p && mine && p.family === mine.family && p.value === mine.value) {
      throw new HttpError(400, 'That is your own address');
    }
    return guarded(async () => {
      await f2b.ban(ip, jail);
      setRedactedAuditDetail(req, { ip, jail });
      return respond(await fail2banStatus());
    });
  }

  /** Unban an address from one jail, or from all when `jail` is omitted. */
  @Post('/api/firewall/fail2ban/unban')
  @Auth('admin')
  async unbanIp(@Req() req: Request) {
    const body = parseBody(BanBody, req.body);
    const ip = (body.ip || '').trim();
    return guarded(async () => {
      await f2b.unban(ip, body.jail || null);
      setRedactedAuditDetail(req, { ip, jail: body.jail || null });
      return respond(await fail2banStatus());
    });
  }
}
