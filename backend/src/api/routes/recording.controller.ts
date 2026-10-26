/**
 * Call recording settings: the master switch and format, the per-direction and
 * per-extension policy, local retention, and storage statistics.
 *
 * Recording runs through OpDesk's own [opdesk-record] MixMonitor (mixed file + per-speaker
 * legs for voice activity), started from the PBX's predial hooks. Policy is opt-OUT and
 * lives in the AstDB (opdesk/rec/...): every call records unless its direction or one of
 * its extensions is switched off. Storage is local only.
 *
 * The playback, list and delete routes for individual recordings live in
 * call-history.controller.ts (/api/recordings...).
 */

import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { env } from '../../core/config';
import { setRedactedAuditDetail } from '../../core/audit';
import { getLogger } from '../../core/logger';
import * as dbm from '../../db/db-manager';
import {
  disableRecording,
  enableRecording,
  RECORD_SINGLE_DIR,
  RECORDING_FORMATS,
  recordingHookConflicts,
  type RecordingHookConflict,
  setRecordingDirection,
  setRecordingExtension,
} from '../../services/dialplan';
import {
  boolSetting,
  intSettingOrNone,
  LOCAL_MAX_BYTES_SETTING,
  LOCAL_RETENTION_DAYS_SETTING,
  recordingPolicySnapshot,
  recordingRoot,
  recordingStorageStats,
  runRecordingRetention,
  VAD_DELETE_LEGS_SETTING,
} from '../../services/recording';
import { HttpError } from '../http-error';
import { respond } from '../respond';
import { Auth, Get, Post } from '../routing';
import { parseBody, pStr, v } from '../validation';

const log = getLogger('api.routes.recording');

export const RecordingMasterBody = v.model({
  format: v.str().default('wav'),
});

export const DirectionRecordingBody = v.model({
  enabled: v.bool(),
});

export const ExtensionRecordingBody = v.model({
  recording: v.bool(),
});

export const BulkExtensionRecordingBody = v.model({
  recording: v.bool(),
  extensions: v.list(v.str()).nullish(), // omitted -> all extensions
});

export const RecordingRetentionBody = v.model({
  local_days: v.int().nullish(),
  local_max_bytes: v.int().nullish(),
  vad_delete_legs: v.bool().nullish(),
  root_dir: v.str().nullish(),
});

/** The PBX flavour from the PBX setting, else env (decides the predial hook form). */
async function pbxSetting(): Promise<string> {
  return (await dbm.getSetting('PBX', env('PBX', 'FreePBX'))) || env('PBX', 'FreePBX') || 'FreePBX';
}

/**
 * What an admin is told when another dialplan file keeps the predial hooks: which file, and
 * what to do about it. Asterisk keeps the first definition and only logs "already in use".
 */
export function hookConflictMessage(conflicts: RecordingHookConflict[]): string {
  const files = [...new Set(conflicts.map((c) => c.file).filter((f): f is string => Boolean(f)))];
  if (!files.length) {
    return 'Call recording could not start: the PBX predial hooks did not load. Check extensions_custom.conf and the Asterisk log.';
  }
  return (
    `Call recording could not start: ${files.join(', ')} already defines the PBX predial hooks ` +
    '(another call recorder is installed), so OpDesk\'s recorder would never run. Turn that recorder off ' +
    'or remove its #include from extensions_custom.conf, then enable recording again.'
  );
}

@Controller()
export class RecordingController {
  /** Master on/off + format (+ where the files are). Any signed-in user. */
  @Get('/api/recording/status')
  @Auth('user')
  async getRecordingStatus() {
    const enabled = await boolSetting('RECORDING_ENABLED', env('RECORDING_ENABLED', 'false') || 'false');
    const format = (await dbm.getSetting('RECORDING_FORMAT', env('RECORDING_FORMAT', 'wav') || 'wav')) || 'wav';
    return { enabled, format, engine: 'opdesk', mixed_dir: await recordingRoot(), single_dir: RECORD_SINGLE_DIR };
  }

  /** Full policy: {enabled, format, directions{inbound,outbound,internal}, extensions[{extension,name,recording}]}. */
  @Get('/api/recording/policy')
  @Auth('admin')
  async getRecordingPolicyEndpoint() {
    return recordingPolicySnapshot();
  }

  /** Turn the recorder on (installs [opdesk-record] with VAD in the predial hooks). Body {format}. */
  @Post('/api/recording/enable')
  @Auth('admin')
  async enableRecordingEndpoint(@Req() req: Request) {
    // No body at all is the default {format: 'wav'}.
    const body = parseBody(RecordingMasterBody, req.body === undefined || req.body === null ? {} : req.body);
    const fmt = (body.format || 'wav').trim().toLowerCase();
    if (!RECORDING_FORMATS.includes(fmt)) throw new HttpError(400, `Unsupported recording format: ${fmt}`);
    let ok: boolean;
    try {
      ok = await enableRecording({ mixFormat: fmt, vad: true, pbx: await pbxSetting() });
    } catch (e) {
      log.error('Failed to enable call recording: %s', e);
      throw new HttpError(500, 'Internal server error');
    }
    if (!ok) throw new HttpError(500, 'Failed to enable call recording. Check server logs.');
    // The reload succeeding does not mean our hooks won: read back what Asterisk loaded.
    const conflicts = await recordingHookConflicts();
    if (conflicts && conflicts.length) {
      log.warning('Call recording not wired: %s', JSON.stringify(conflicts));
      // Leave the hooks as no-ops, so the recorder does not silently start later (once the
      // other file goes) with the switch showing off.
      await disableRecording(await pbxSetting());
      await dbm.setSetting('RECORDING_ENABLED', 'false');
      throw new HttpError(409, hookConflictMessage(conflicts));
    }
    await dbm.setSetting('RECORDING_ENABLED', 'true');
    await dbm.setSetting('RECORDING_FORMAT', fmt);
    setRedactedAuditDetail(req, { recording: true, format: fmt });
    return respond({ message: `Call recording enabled (format=${fmt}). Asterisk dialplan reloaded.` });
  }

  /** Turn the recorder off (the predial hooks become no-ops). */
  @Post('/api/recording/disable')
  @Auth('admin')
  async disableRecordingEndpoint(@Req() req: Request) {
    let ok: boolean;
    try {
      ok = await disableRecording(await pbxSetting());
    } catch (e) {
      log.error('Failed to disable call recording: %s', e);
      throw new HttpError(500, 'Internal server error');
    }
    if (!ok) throw new HttpError(500, 'Failed to disable call recording. Check server logs.');
    await dbm.setSetting('RECORDING_ENABLED', 'false');
    setRedactedAuditDetail(req, { recording: false });
    return respond({ message: 'Call recording disabled. Asterisk dialplan reloaded.' });
  }

  /** Record (or not) one call direction: inbound / outbound / internal. Body {enabled}. */
  @Post('/api/recording/direction/:direction')
  @Auth('admin')
  async setDirectionRecordingEndpoint(@Req() req: Request) {
    const direction = pStr(req.params.direction);
    const body = parseBody(DirectionRecordingBody, req.body);
    if (!['inbound', 'outbound', 'internal'].includes(direction)) {
      throw new HttpError(400, 'direction must be inbound, outbound or internal');
    }
    if (await setRecordingDirection(direction, body.enabled)) {
      setRedactedAuditDetail(req, { direction, enabled: body.enabled });
      return { direction, enabled: body.enabled };
    }
    throw new HttpError(500, 'Failed to update direction recording');
  }

  /** Record (true) or don't record (false) calls involving one extension. Body {recording}. */
  @Post('/api/recording/extension/:ext')
  @Auth('admin')
  async setExtensionRecordingEndpoint(@Req() req: Request) {
    const ext = pStr(req.params.ext);
    const body = parseBody(ExtensionRecordingBody, req.body);
    if (!/^[0-9A-Za-z_*#+.-]{1,40}$/.test(ext)) throw new HttpError(400, 'Invalid extension');
    if (await setRecordingExtension(ext, body.recording)) {
      setRedactedAuditDetail(req, { extension: ext, recording: body.recording });
      return { extension: ext, recording: body.recording };
    }
    throw new HttpError(500, 'Failed to update extension recording');
  }

  /** Record on/off for many extensions at once (all extensions when the list is omitted). */
  @Post('/api/recording/extensions/bulk')
  @Auth('admin')
  async bulkSetRecordingEndpoint(@Req() req: Request) {
    const body = parseBody(BulkExtensionRecordingBody, req.body);
    let targets: string[] = body.extensions ?? [];
    if (!targets.length) targets = (await dbm.getExtensionsFromDb()) ?? [];
    if (!targets.length) throw new HttpError(400, 'No extensions to update');
    const failed: string[] = [];
    for (const e of targets) {
      if (!(await setRecordingExtension(e, body.recording))) failed.push(String(e));
    }
    if (failed.length) throw new HttpError(500, `Failed to update: ${failed.join(', ')}`);
    setRedactedAuditDetail(req, { recording: body.recording, extensions: targets.map(String) });
    return { updated: targets.map(String) };
  }

  /**
   * Local retention: {local_days, local_max_bytes, vad_delete_legs, root_dir} (null / 0 =
   * off). root_dir is informational: where the dialplan records (services/recording.recordingRoot).
   */
  @Get('/api/recording/retention')
  @Auth('admin')
  async getRecordingRetention() {
    return {
      local_days: await intSettingOrNone(LOCAL_RETENTION_DAYS_SETTING),
      local_max_bytes: await intSettingOrNone(LOCAL_MAX_BYTES_SETTING),
      vad_delete_legs: await boolSetting(VAD_DELETE_LEGS_SETTING, 'true'),
      root_dir: await recordingRoot(),
    };
  }

  /**
   * Save retention settings; each field only when sent. root_dir cannot be changed: the
   * recorder always writes to the PBX's monitor directory, so another directory would only
   * hide every recording and aim retention at a tree OpDesk does not write. Sending the
   * current directory is accepted (an older client re-saving the form); any other is a 400.
   */
  @Post('/api/recording/retention')
  @Auth('admin')
  async setRecordingRetention(@Req() req: Request) {
    const body = parseBody(RecordingRetentionBody, req.body);
    for (const [field, value] of [
      ['local_days', body.local_days],
      ['local_max_bytes', body.local_max_bytes],
    ] as const) {
      if (value !== null && value !== undefined && value < 0) throw new HttpError(400, `${field} must not be negative`);
    }
    if (body.root_dir !== null && body.root_dir !== undefined) {
      // Compare without trailing slashes: the unchanged directory is not a change.
      const norm = (p: string): string => p.trim().replace(/\/+$/, '') || '/';
      const root = await recordingRoot();
      if (norm(body.root_dir) !== norm(root)) {
        throw new HttpError(400, `The recordings directory is where the PBX records (${root}) and cannot be changed`);
      }
    }
    if (body.local_days !== null && body.local_days !== undefined) {
      await dbm.setSetting(LOCAL_RETENTION_DAYS_SETTING, String(body.local_days));
    }
    if (body.local_max_bytes !== null && body.local_max_bytes !== undefined) {
      await dbm.setSetting(LOCAL_MAX_BYTES_SETTING, String(body.local_max_bytes));
    }
    if (body.vad_delete_legs !== null && body.vad_delete_legs !== undefined) {
      await dbm.setSetting(VAD_DELETE_LEGS_SETTING, body.vad_delete_legs ? 'true' : 'false');
    }
    setRedactedAuditDetail(req, {
      local_days: body.local_days ?? null,
      local_max_bytes: body.local_max_bytes ?? null,
      vad_delete_legs: body.vad_delete_legs ?? null,
    });
    return {};
  }

  /** "Clean up now": the sweep the daily background job runs. {local_deleted, remote_deleted}. */
  @Post('/api/recording/retention/run')
  @Auth('admin')
  async runRecordingRetentionEndpoint(@Req() req: Request) {
    const result = await runRecordingRetention();
    setRedactedAuditDetail(req, result);
    return result;
  }

  /** {total_recordings, local{used_bytes, disk_free_bytes, disk_total_bytes, ...}}. */
  @Get('/api/recording/storage-stats')
  @Auth('admin')
  async getRecordingStorageStats() {
    return recordingStorageStats();
  }
}
