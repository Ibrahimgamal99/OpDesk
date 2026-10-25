/**
 * Optional encryption at rest for secrets stored in the OpDesk database (OpDesk_settings
 * values such as CRM credentials and push keys).
 *
 * OpDesk has always stored settings in plaintext, and the Python server (and any rollback to
 * it) reads the same table, so writing ciphertext by default would break a mixed or rolled-back
 * install. The contract is therefore:
 *   - read:  decryptValue() decrypts a value carrying the `enc:v1:` prefix and passes any other
 *            value through unchanged (plaintext rows keep working);
 *   - write: encryptValue() encrypts only when SETTINGS_ENCRYPT_AT_REST is true; otherwise it
 *            returns the value unchanged.
 *
 * The format is Fernet, implemented with node:crypto so a value written here also decrypts
 * with Python's cryptography.fernet:
 *   token = base64url( 0x80 | ts(8, big-endian) | iv(16) | AES-128-CBC(ciphertext) | HMAC-SHA256(32) )
 *   key   = base64url( signing key(16) | encryption key(16) )
 *
 * Key resolution order:
 *   1. SETTINGS_ENCRYPTION_KEY env var (a urlsafe-base64 Fernet key).
 *   2. A key file (SETTINGS_ENCRYPTION_KEY_FILE, default /opt/OpDesk/secrets/settings_encryption.key),
 *      generated on first use (only when encryption is switched on or an encrypted value is read).
 *
 * The key never lives in the OpDesk database itself: that would put the lock and the key
 * in the same box a DB-only leak already opens.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../core/logger';

const log = getLogger('secrets_crypto');

// Prefix marks a value as encrypted so legacy plaintext rows still read back
// correctly -- they pass through decryptValue() unchanged and are encrypted on next save.
const ENC_PREFIX = 'enc:v1:';
const DEFAULT_KEY_FILE = '/opt/OpDesk/secrets/settings_encryption.key';

export class InvalidToken extends Error {
  constructor() {
    super('Invalid Fernet token');
    this.name = 'InvalidToken';
  }
}

function b64urlDecode(s: string): Buffer {
  // Python's urlsafe_b64decode accepts padded input; Node's base64url accepts both.
  return Buffer.from(s.trim(), 'base64url');
}

function b64urlEncode(b: Buffer): string {
  // Fernet tokens and keys are padded urlsafe base64.
  const s = b.toString('base64url');
  return s + '='.repeat((4 - (s.length % 4)) % 4);
}

export class Fernet {
  private readonly signingKey: Buffer;
  private readonly encryptionKey: Buffer;

  constructor(key: string | Buffer) {
    const raw = b64urlDecode(typeof key === 'string' ? key : key.toString('utf8'));
    if (raw.length !== 32) throw new Error('Fernet key must be 32 url-safe base64-encoded bytes.');
    this.signingKey = raw.subarray(0, 16);
    this.encryptionKey = raw.subarray(16);
  }

  static generateKey(): string {
    return b64urlEncode(crypto.randomBytes(32));
  }

  encrypt(data: Buffer, now = Math.floor(Date.now() / 1000), iv = crypto.randomBytes(16)): string {
    const cipher = crypto.createCipheriv('aes-128-cbc', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const ts = Buffer.alloc(8);
    ts.writeBigUInt64BE(BigInt(now));
    const basic = Buffer.concat([Buffer.from([0x80]), ts, iv, ciphertext]);
    const hmac = crypto.createHmac('sha256', this.signingKey).update(basic).digest();
    return b64urlEncode(Buffer.concat([basic, hmac]));
  }

  /** Decrypts without a TTL, as Fernet.decrypt(token) did. Throws InvalidToken. */
  decrypt(token: string): Buffer {
    let data: Buffer;
    try {
      data = b64urlDecode(token);
    } catch {
      throw new InvalidToken();
    }
    if (data.length < 1 + 8 + 16 + 32 || data[0] !== 0x80) throw new InvalidToken();
    const basic = data.subarray(0, data.length - 32);
    const mac = data.subarray(data.length - 32);
    const expected = crypto.createHmac('sha256', this.signingKey).update(basic).digest();
    if (!crypto.timingSafeEqual(mac, expected)) throw new InvalidToken();
    const iv = basic.subarray(9, 25);
    const ciphertext = basic.subarray(25);
    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', this.encryptionKey, iv);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new InvalidToken();
    }
  }
}

let fernet: Fernet | null = null;

function loadOrCreateKey(): string {
  const envKey = (process.env.SETTINGS_ENCRYPTION_KEY || '').trim();
  if (envKey) return envKey;

  const keyPath = (process.env.SETTINGS_ENCRYPTION_KEY_FILE || '').trim() || DEFAULT_KEY_FILE;
  try {
    if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath, 'utf8').trim();
    const key = Fernet.generateKey();
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    fs.chmodSync(keyPath, 0o600);
    log.warning(
      'SETTINGS_ENCRYPTION_KEY not set; generated a new key and stored it at %s. Set ' +
        'SETTINGS_ENCRYPTION_KEY explicitly and back this file up separately from DB backups ' +
        '-- a DB-only restore is unable to decrypt stored secrets without it.',
      keyPath,
    );
    return key;
  } catch (e) {
    log.error(
      'Could not persist a generated encryption key at %s (%s); using an in-memory key for ' +
        'this process only. Stored secrets will not be decryptable after restart -- set ' +
        'SETTINGS_ENCRYPTION_KEY explicitly.',
      keyPath,
      e,
      e,
    );
    return Fernet.generateKey();
  }
}

function getFernet(): Fernet {
  if (fernet === null) fernet = new Fernet(loadOrCreateKey());
  return fernet;
}

/** True when new writes are encrypted (SETTINGS_ENCRYPT_AT_REST, default off: plaintext, as OpDesk always stored). */
export function encryptionAtRestEnabled(): boolean {
  return ['true', '1', 'yes', 'on'].includes((process.env.SETTINGS_ENCRYPT_AT_REST || '').trim().toLowerCase());
}

/** Encrypt a value for storage when encryption at rest is on. null/empty pass through unchanged. */
export function encryptValue<T extends string | null | undefined>(value: T): T {
  if (!value || !encryptionAtRestEnabled()) return value;
  if (value.startsWith(ENC_PREFIX)) return value;
  return (ENC_PREFIX + getFernet().encrypt(Buffer.from(value, 'utf8'))) as T;
}

/**
 * Decrypt a stored value. Legacy plaintext (no prefix) passes through unchanged, so
 * rows written before encryption was added keep working until they are next saved.
 */
export function decryptValue<T extends string | null | undefined>(value: T): T {
  if (!value || !value.startsWith(ENC_PREFIX)) return value;
  const token = value.slice(ENC_PREFIX.length);
  try {
    return getFernet().decrypt(token).toString('utf8') as T;
  } catch (e) {
    log.error('Failed to decrypt a stored value -- wrong or rotated SETTINGS_ENCRYPTION_KEY?', e);
    return value;
  }
}

/** Tests only: drop the cached key so a changed env is picked up. */
export function resetForTests(): void {
  fernet = null;
}
