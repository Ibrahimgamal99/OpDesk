/**
 * Settings management: read and write raw OpDesk_settings keys (admin only).
 *
 * The three routes are a generic key/value window onto the settings table. The Settings UI
 * uses the dedicated config routes instead (CRM, push, recording, ...); these stay for
 * scripts and ops.
 *
 * Route order matters: `/api/settings/:key` matches any single segment, so this controller
 * must be registered AFTER every controller that serves a literal `/api/settings/<word>`
 * route (users, agents, queues, groups). FastAPI had the same rule: the literal routes were
 * declared first and shadowed the catch-all.
 */

import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { setRedactedAuditDetail } from '../../core/audit';
import { getLogger } from '../../core/logger';
import * as dbm from '../../db/db-manager';
import { HttpError } from '../http-error';
import { isMasked, isSecretKey, SECRET_MASK } from '../shared';
import { Auth, Get, Post } from '../routing';
import { parseBody, pStr, v } from '../validation';

export const log = getLogger('api.routes.settings');

// ---------------------------------------------------------------------------
// Secret masking
// ---------------------------------------------------------------------------
//
// The FastAPI server returned every row in clear text, JWT_SECRET and CRM credentials
// included. Now a secret's value is replaced with SECRET_MASK on every read, and a write
// that sends SECRET_MASK back means "keep what is stored", so a client can POST a blob it
// just read without wiping the secrets it was never shown. Any other value, blank
// included, overwrites as before (blank is how a secret is cleared).
//
// One definition of "secret" for the whole app: api/shared's isSecretKey (JWT_SECRET, CRM
// credentials, VAPID private key, APNs auth key, FCM service account, anything named
// *SECRET*/*PASSWORD*/*TOKEN*/*PRIVATE_KEY*/*API_KEY*), widened here to every APNs/FCM key.
// A few harmless keys are masked too (PUSH_APNS_TEAM_ID); /api/push/config shows those,
// and the keep-on-mask write rule makes the round trip safe.

export { SECRET_MASK };

const PUSH_PROVIDER_KEY = /apns|fcm/i;

/** True when a setting's value must be masked on read and kept on a masked write. */
export function isSecretSetting(key: string | null | undefined): boolean {
  const k = String(key ?? '');
  return isSecretKey(k) || PUSH_PROVIDER_KEY.test(k);
}

/**
 * The value a client may see. An unset or empty secret stays as it is (null / ""), so the
 * client can still tell "not configured" from "configured, hidden".
 */
export function maskSetting(key: string, value: string | null | undefined): string | null {
  if (value === undefined) return null;
  return isSecretSetting(key) && value ? SECRET_MASK : value;
}

/**
 * str(value) for a JSON value the client sent, as the FastAPI handler stored it:
 * True/False for booleans, Python's repr for lists and dicts.
 *
 * NOTE(port): a JSON float with no fraction (`1.0`) arrives as the number 1 and is stored
 * as "1"; Python stored "1.0".
 */
export function pyStrValue(value: unknown): string {
  const repr = (x: unknown): string => {
    if (x === null || x === undefined) return 'None';
    if (typeof x === 'boolean') return x ? 'True' : 'False';
    if (typeof x === 'string') {
      // repr(str): single quotes unless the text holds a single quote and no double quote.
      const q = x.includes("'") && !x.includes('"') ? '"' : "'";
      const body = x
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(q === "'" ? /'/g : /"/g, `\\${q}`);
      return `${q}${body}${q}`;
    }
    if (Array.isArray(x)) return `[${x.map(repr).join(', ')}]`;
    if (typeof x === 'object') {
      return `{${Object.entries(x as Record<string, unknown>)
        .map(([k, val]) => `${repr(k)}: ${repr(val)}`)
        .join(', ')}}`;
    }
    return String(x);
  };
  if (typeof value === 'string') return value;
  return repr(value);
}

/** `settings_data: dict` (a bare dict body). */
const SettingsDataBody = v.dict();

/** A settings key as the app writes them: upper-case words joined by underscores. */
const SETTING_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Keys this generic route must never write. JWT_SECRET in the DB overrides the installer's
 * .env secret, so writing it here let any value (even one character) sign every session;
 * the VAPID pair is replaced only as a pair by POST /api/push/vapid/rotate.
 */
const PROTECTED_SETTING_KEYS = new Set(['JWT_SECRET', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY']);

/**
 * The keys of a settings body this route refuses: malformed ones, and protected ones sent
 * with a value. A protected key sent back as SECRET_MASK is the read-modify-write round trip
 * ("keep what is stored") and stays allowed.
 */
export function refusedSettingKeys(body: Record<string, unknown>): string[] {
  return Object.entries(body)
    .filter(([k, value]) => !SETTING_KEY_RE.test(k) || (PROTECTED_SETTING_KEYS.has(k) && !isMasked(value)))
    .map(([k]) => k);
}

@Controller()
export class SettingsController {
  /**
   * Save settings to the database: every key of the body is upserted as str(value)
   * (null -> ""). A secret sent back as SECRET_MASK is left untouched and reported in
   * `kept`.
   */
  @Post('/api/settings')
  @Auth('admin')
  async saveSettings(@Req() req: Request) {
    const settingsData = parseBody(SettingsDataBody, req.body);
    // All or nothing: one refused key rejects the body before anything is written.
    const refused = refusedSettingKeys(settingsData);
    if (refused.length) throw new HttpError(400, `These settings cannot be changed here: ${refused.join(', ')}`);
    try {
      const saved: string[] = [];
      const failed: string[] = [];
      const kept: string[] = [];

      for (const [key, value] of Object.entries(settingsData)) {
        // Convert value to string if it's not already
        const valueStr = value !== null && value !== undefined ? pyStrValue(value) : '';
        if (isSecretSetting(key) && isMasked(valueStr)) {
          kept.push(key);
          continue;
        }
        if (await dbm.setSetting(key, valueStr)) saved.push(key);
        else failed.push(key);
      }

      if (failed.length) log.warning('Failed to save some settings: %s', failed);
      // Saved values as a read shows them: secrets masked (maskSetting covers the
      // APNs/FCM keys too), so the audit row never holds a credential.
      setRedactedAuditDetail(req, {
        saved: Object.fromEntries(
          saved.map((k) => {
            const value = settingsData[k];
            return [k, maskSetting(k, value !== null && value !== undefined ? pyStrValue(value) : '')];
          }),
        ),
        kept,
        failed,
      });

      return {
        success: failed.length === 0,
        saved,
        failed,
        kept,
        message: `Saved ${saved.length} setting(s)` + (failed.length ? `, ${failed.length} failed` : ''),
      };
    } catch (e) {
      // The exception text stays in the log: a 500 body never carries it.
      log.error('Failed to save settings: %s', e);
      throw new HttpError(500, 'Failed to save settings');
    }
  }

  /** Get all settings from the database, secrets masked. */
  @Get('/api/settings')
  @Auth('admin')
  async getSettings() {
    try {
      const all = (await dbm.getAllSettings()) as Record<string, string | null>;
      const settings: Record<string, string | null> = {};
      for (const [k, val] of Object.entries(all)) settings[k] = maskSetting(k, val);
      return { success: true, settings };
    } catch (e) {
      log.error('Failed to get settings: %s', e);
      throw new HttpError(500, 'Failed to get settings');
    }
  }

  /** Get one setting by key (null when unset), masked when it is a secret. */
  @Get('/api/settings/:key')
  @Auth('admin')
  async getSettingByKey(@Req() req: Request) {
    const key = pStr(req.params.key);
    try {
      const value = await dbm.getSetting(key);
      return { success: true, key, value: maskSetting(key, value ?? null) };
    } catch (e) {
      log.error('Failed to get setting %s: %s', key, e);
      throw new HttpError(500, 'Failed to get setting');
    }
  }
}
