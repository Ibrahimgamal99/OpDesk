/**
 * PBX feature toggles: QoS capture (RTP quality into CDR userfield) and the PJSIP TLS
 * transport on port 5061.
 *
 * Error messages name no PBX tool: on Issabel there is no fwconsole, and the logs say which
 * command ran (services/dialplan reloadAsteriskSip / pbxApplyCommand).
 */

import { Controller } from '@nestjs/common';
import { env } from '../../core/config';
import { getLogger } from '../../core/logger';
import * as dbm from '../../db/db-manager';
import { disableQos, disableSipTls, enableQos, enableSipTls, settingOn, TLS_PORT } from '../../services/dialplan';
import { HttpError } from '../http-error';
import { respond } from '../respond';
import { Auth, Get, Post } from '../routing';

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
  async enableQosEndpoint() {
    let ok: boolean;
    try {
      ok = await enableQos();
    } catch (e) {
      log.error('Failed to enable QoS: %s', e);
      ok = false;
    }
    if (!ok) throw new HttpError(500, 'Failed to enable QoS configuration. Check server logs for details.');
    await saveQosStatusToDb(true);
    return { success: true, message: 'QoS configuration enabled successfully. Asterisk dialplan reloaded.' };
  }

  /** Clear the QoS hangup handler, reload the dialplan, remember QOS_ENABLED=false. */
  @Post('/api/qos/disable')
  @Auth('admin')
  async disableQosEndpoint() {
    let ok: boolean;
    try {
      ok = await disableQos();
    } catch (e) {
      log.error('Failed to disable QoS: %s', e);
      ok = false;
    }
    if (!ok) throw new HttpError(500, 'Failed to disable QoS configuration. Check server logs for details.');
    await saveQosStatusToDb(false);
    return { success: true, message: 'QoS configuration disabled successfully. Asterisk dialplan reloaded.' };
  }

  /** {enabled, domain, port}. */
  @Get('/api/sip-tls/status')
  @Auth('user')
  async getSipTlsStatus() {
    const enabled = settingOn(await dbm.getSetting('SIP_TLS_ENABLED', 'false'));
    const domain = (await dbm.getSetting('OPDESK_DOMAIN', env('OPDESK_DOMAIN', ''))) || '';
    return { enabled, domain, port: TLS_PORT };
  }

  /** Enable the TLS transport with the Let's Encrypt cert of OPDESK_DOMAIN (restarts Asterisk). */
  @Post('/api/sip-tls/enable')
  @Auth('admin')
  async enableSipTlsEndpoint() {
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
    return respond({ message: `SIP TLS enabled on port ${TLS_PORT} for ${domain}` });
  }

  /** Remove OpDesk's TLS transport (restarts Asterisk). */
  @Post('/api/sip-tls/disable')
  @Auth('admin')
  async disableSipTlsEndpoint() {
    let ok: boolean;
    try {
      ok = await disableSipTls(await pbxSetting());
    } catch (e) {
      log.error('Failed to disable SIP TLS: %s', e);
      throw new HttpError(500, 'Internal server error');
    }
    if (!ok) throw new HttpError(500, 'Failed to disable SIP TLS. Check server logs.');
    await dbm.setSetting('SIP_TLS_ENABLED', 'false');
    return respond({ message: `SIP TLS disabled. Port ${TLS_PORT} closed.` });
  }
}
