/**
 * request.client.host as uvicorn reported it.
 *
 * uvicorn trusted X-Forwarded-For from 127.0.0.1 (its forwarded_allow_ips default), and
 * nginx on this box sets it, so the host was the real client behind the proxy -- which is
 * what makes the loopback-only check on /api/internal/ refuse requests that merely arrive
 * through nginx. main.ts sets Express's `trust proxy` to 'loopback' for the same rule;
 * this strips the IPv4-mapped prefix Node adds (`::ffff:127.0.0.1`).
 */

import type { Request } from 'express';

export function clientHost(req: Request): string | null {
  const ip = req.ip || req.socket?.remoteAddress || null;
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
