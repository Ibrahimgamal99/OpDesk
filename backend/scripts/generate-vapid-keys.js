#!/usr/bin/env node
/**
 * Generate a VAPID key pair for browser Web Push and print the .env lines to add.
 *
 * The easier way is Settings -> Mobile Wake -> Web push -> Create keys, which stores the
 * keys in the OpDesk DB (they take precedence over .env). This script is for setups
 * that keep the keys in .env.
 *
 * Usage:
 *     node backend/scripts/generate-vapid-keys.js
 *
 * Then paste the printed VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT lines
 * into backend/.env and restart OpDesk. Web Push stays disabled until these are set.
 *
 * Only Node's own crypto is used, so the script runs before `npm install` too.
 */
'use strict';

const crypto = require('crypto');

/** Left-pad a big-endian integer to `n` bytes (JWK coordinates drop leading zero bytes). */
function pad(buf, n) {
  return buf.length >= n ? buf : Buffer.concat([Buffer.alloc(n - buf.length), buf]);
}

function main() {
  // VAPID uses an ECDSA P-256 key pair.
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });

  // Private key: raw 32-byte scalar, base64url (the form the web-push library accepts).
  const vapidPrivate = pad(Buffer.from(jwk.d, 'base64url'), 32).toString('base64url');

  // Public key: uncompressed point (0x04 || X || Y), base64url -- the applicationServerKey.
  const vapidPublic = Buffer.concat([
    Buffer.from([4]),
    pad(Buffer.from(jwk.x, 'base64url'), 32),
    pad(Buffer.from(jwk.y, 'base64url'), 32),
  ]).toString('base64url');

  console.log('# Add these to backend/.env, then restart OpDesk:');
  console.log(`VAPID_PUBLIC_KEY=${vapidPublic}`);
  console.log(`VAPID_PRIVATE_KEY=${vapidPrivate}`);
  console.log('VAPID_SUBJECT=mailto:admin@example.com');
}

main();
