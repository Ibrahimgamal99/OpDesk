/**
 * Process-wide paths and environment.
 *
 * Importing this module loads the .env file, so import it before anything that
 * reads process.env at import time (main.ts does, first).
 */

import * as path from 'path';
import * as dotenv from 'dotenv';

// backend/, the directory the server runs from. Compiled files live in
// dist/ below it, so paths to docs/ and frontend/ are built from here, not from __dirname.
export const BACKEND_DIR = path.resolve(__dirname, '..', '..');

// The repository root (/opt/OpDesk): frontend/, docs/, secrets/ hang off it.
export const PROJECT_ROOT = path.resolve(BACKEND_DIR, '..');

// backend/.env, written by install.sh. OPDESK_ENV_FILE overrides it.
function envFile(): string {
  return process.env.OPDESK_ENV_FILE || path.join(BACKEND_DIR, '.env');
}

dotenv.config({ path: envFile(), quiet: true });

/** os.getenv(name, default): unset reads as the default, set-but-empty stays empty. */
export function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined ? fallback : v;
}

/** True when the env var is one of the truthy spellings the Python code accepted. */
export function envFlag(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase());
}
