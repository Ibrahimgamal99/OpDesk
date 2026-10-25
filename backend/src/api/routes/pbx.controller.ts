/**
 * PBX feature toggles: QoS capture (RTP quality into CDR userfield), the PJSIP TLS
 * transport on port 5061 (and whether plain 5060 UDP/TCP is reachable from outside), and
 * the PBX-wide audio codec list.
 *
 * Error messages name no PBX tool: on Issabel there is no fwconsole, and the logs say which
 * command ran (services/dialplan reloadAsteriskSip / pbxApplyCommand).
 */

import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { setRedactedAuditDetail } from '../../core/audit';
import { env } from '../../core/config';
import { getLogger } from '../../core/logger';
import * as dbm from '../../db/db-manager';
import {
  disableQos, disableSipTls, enableQos, enableSipTls, pbxApplyCommand, pbxKind, reloadAsteriskSip, settingOn, TLS_PORT,
} from '../../services/dialplan';
import { codes } from '../errors';
import { HttpError } from '../http-error';
import { respond } from '../respond';
import { Auth, Get, Post, principal, Put } from '../routing';
import { settingTruthy } from '../shared';
import { parseBody, v } from '../validation';

const log = getLogger('api.routes.pbx');

/** Save QoS enabled status to the database. */
export async function saveQosStatusToDb(enabled: boolean): Promise<boolean> {
  try {
    const ok = await dbm.setSetting('QOS_ENABLED', enabled ? 'true' : 'false');
    if (ok) log.info('QoS status saved to database: QOS_ENABLED=%s', enabled ? 'true' : 'false');
    return Boolean(ok);
  } catch (e) {
    log.error('Failed to save QoS status to database: %s', e);
    return false;
  }
}

async function pbxSetting(): Promise<string> {
  return (await dbm.getSetting('PBX', env('PBX', 'FreePBX'))) || env('PBX', 'FreePBX') || 'FreePBX';
}

/**
 * SIP_UDP_TCP_PUBLIC (admin setting, default off): plain 5060 UDP/TCP is reachable from the
 * internet, so /api/extension-config may hand it to apps. Asterisk always binds 5060; this
 * only says whether a client outside the network can get to it.
 */
export async function sipUdpTcpPublic(): Promise<boolean> {
  return settingTruthy(await dbm.getSetting('SIP_UDP_TCP_PUBLIC', 'false'));
}

export interface CodecsOut {
  /** The PBX-wide audio codecs, first = preferred. Every extension without its own list follows it. */
  codecs: string[];
  /** Every codec the list may hold: the current ones in order, then the rest. */
  available: string[];
}

export const CodecsBody = v.strictModel({
  codecs: v.list(v.str()), // first = preferred
});

/** The list lives in FreePBX's Sipsettings kvstore; Issabel keeps codecs per peer, so 404 there. */
async function requireFreepbx(): Promise<void> {
  if (pbxKind(await pbxSetting()) === 'issabel') throw new HttpError(404, 'Codec settings are only available on FreePBX');
}

async function codecsOut(): Promise<CodecsOut> {
  const current = await dbm.getPbxDefaultCodecs();
  if (current === null) throw new HttpError(503, 'Cannot reach the PBX database');
  return { codecs: current, available: [...current, ...dbm.STANDARD_AUDIO_CODECS.filter((c) => !current.includes(c))] };
}

@Controller()
export class PbxController {
  /** {enabled, pbx}: QoS capture state and the PBX flavour. */
  @Get('/api/qos/status')
  @Auth('user')
  async getQosStatus() {
    const enabled = settingOn(await dbm.getSetting('QOS_ENABLED', env('QOS_ENABLED', '')));
    return { enabled, pbx: await pbxSetting() };
  }

  /** Write the QoS hangup handler, reload the dialplan, remember QOS_ENABLED=true. */
  @Post('/api/qos/enable')
  @Auth('admin')
  async enableQosEndpoint(@Req() req: Request) {
    let ok: boolean;
    try {
      ok = await enableQos();
    } catch (e) {
      log.error('Failed to enable QoS: %s', e);
      ok = false;
    }
    if (!ok) throw new HttpError(500, 'Failed to enable QoS configuration. Check server logs for details.');
    await saveQosStatusToDb(true);
    setRedactedAuditDetail(req, { qos: true });
    return { success: true, message: 'QoS configuration enabled successfully. Asterisk dialplan reloaded.' };
  }

  /** Clear the QoS hangup handler, reload the dialplan, remember QOS_ENABLED=false. */
  @Post('/api/qos/disable')
  @Auth('admin')
  async disableQosEndpoint(@Req() req: Request) {
    let ok: boolean;
    try {
      ok = await disableQos();
    } catch (e) {
      log.error('Failed to disable QoS: %s', e);
      ok = false;
    }
    if (!ok) throw new HttpError(500, 'Failed to disable QoS configuration. Check server logs for details.');
    await saveQosStatusToDb(false);
    setRedactedAuditDetail(req, { qos: false });
    return { success: true, message: 'QoS configuration disabled successfully. Asterisk dialplan reloaded.' };
  }

  /**
   * {enabled, domain, port, udp_tcp_public}. udp_tcp_public is the SIP_UDP_TCP_PUBLIC setting
   * (the Settings UI writes it through POST /api/settings).
   */
  @Get('/api/sip-tls/status')
  @Auth('user')
  async getSipTlsStatus() {
    const enabled = settingOn(await dbm.getSetting('SIP_TLS_ENABLED', 'false'));
    const domain = (await dbm.getSetting('OPDESK_DOMAIN', env('OPDESK_DOMAIN', ''))) || '';
    return { enabled, domain, port: TLS_PORT, udp_tcp_public: await sipUdpTcpPublic() };
  }

  /** Enable the TLS transport with the Let's Encrypt cert of OPDESK_DOMAIN (restarts Asterisk). */
  @Post('/api/sip-tls/enable')
  @Auth('admin')
  async enableSipTlsEndpoint(@Req() req: Request) {
    const domain = ((await dbm.getSetting('OPDESK_DOMAIN', env('OPDESK_DOMAIN', ''))) || '').trim();
    if (!domain) throw new HttpError(400, 'OPDESK_DOMAIN is not configured. Set it in your .env file.');
    let ok: boolean;
    try {
      ok = await enableSipTls(domain, await pbxSetting());
    } catch (e) {
      log.error('Failed to enable SIP TLS: %s', e);
      throw new HttpError(500, 'Internal server error');
    }
    if (!ok) throw new HttpError(500, 'Failed to enable SIP TLS. Check server logs.');
    await dbm.setSetting('SIP_TLS_ENABLED', 'true');
    setRedactedAuditDetail(req, { sip_tls: true, domain });
    return respond({ message: `SIP TLS enabled on port ${TLS_PORT} for ${domain}` });
  }

  /** Remove OpDesk's TLS transport (restarts Asterisk). */
  @Post('/api/sip-tls/disable')
  @Auth('admin')
  async disableSipTlsEndpoint(@Req() req: Request) {
    let ok: boolean;
    try {
      ok = await disableSipTls(await pbxSetting());
    } catch (e) {
      log.error('Failed to disable SIP TLS: %s', e);
      throw new HttpError(500, 'Internal server error');
    }
    if (!ok) throw new HttpError(500, 'Failed to disable SIP TLS. Check server logs.');
    await dbm.setSetting('SIP_TLS_ENABLED', 'false');
    setRedactedAuditDetail(req, { sip_tls: false });
    return respond({ message: `SIP TLS disabled. Port ${TLS_PORT} closed.` });
  }

  /** The PBX-wide audio codec list, first = preferred (admin only, FreePBX only). */
  @Get('/api/codecs')
  @Auth('admin')
  async getCodecs() {
    await requireFreepbx();
    return respond(await codecsOut());
  }

  /**
   * Set the PBX-wide audio codec list, first = preferred, and apply the PBX config (admin
   * only, FreePBX only): the same list FreePBX's Settings → Asterisk SIP Settings edits. Only
   * codecs from `available` are accepted (a typo fails silently in Asterisk); an unchanged
   * list skips the write and the reload. Returns the same shape as the GET.
   */
  @Put('/api/codecs')
  @Auth('admin')
  async setCodecs(@Req() req: Request) {
    const body = parseBody(CodecsBody, req.body);
    await requireFreepbx();
    const current = await codecsOut();
    const wanted = body.codecs.map((c) => c.trim().toLowerCase());
    if (!wanted.length) throw new HttpError(400, 'Keep at least one codec');
    if (new Set(wanted).size !== wanted.length) throw new HttpError(400, 'Each codec may appear only once');
    const unknown = wanted.filter((c) => !current.available.includes(c));
    if (unknown.length) throw new HttpError(400, `Unknown codec: ${unknown.join(', ')}`);
    if (wanted.length === current.codecs.length && wanted.every((c, i) => c === current.codecs[i])) return respond(current);

    if (!(await dbm.setPbxDefaultCodecs(wanted))) {
      throw new HttpError(502, { code: codes.CONFIG_CODECS_FAILED, message: 'Could not update the codecs in the PBX' });
    }
    setRedactedAuditDetail(req, { codecs: wanted, previous: current.codecs });
    // Said out loud: an unchanged list skips the reload, so a silent failure here could
    // never be fixed by saving again.
    const pbx = await pbxSetting();
    if (!(await reloadAsteriskSip(pbx))) {
      throw new HttpError(502, { code: codes.CONFIG_CODECS_FAILED, message: `Codecs saved, but the PBX reload failed. Run '${pbxApplyCommand(pbx)}'.` });
    }
    log.info('PBX codecs set to %s by user %s', wanted.join(','), principal(req).id ?? null);
    return respond({ codecs: wanted, available: [...wanted, ...current.available.filter((c) => !wanted.includes(c))] });
  }
}
