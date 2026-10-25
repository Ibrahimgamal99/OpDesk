/**
 * Serve the built React frontend (production). Registered LAST so the catch-all GET never
 * shadows a real route (first match wins, as in FastAPI). /assets/* is served by
 * express.static in main.ts.
 *
 * An /api path that reaches this catch-all is never answered with index.html: it gets the
 * JSON 404, or a 405 with Allow when the path exists under another method
 * (GET /api/calls/transfer -> 405 Allow: POST).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { PROJECT_ROOT } from '../../core/config';
import { HttpError } from '../http-error';
import { apiFallbackError, FileResponse, isApiPath, markSpaInstalled } from '../respond';
import { Auth, Get } from '../routing';

export const FRONTEND_PATH = path.resolve(PROJECT_ROOT, 'frontend', 'dist');

// MIME types Express does not know (otherwise application/octet-stream).
const CONTENT_TYPES: Record<string, string> = { '.webmanifest': 'application/manifest+json' };

export function spaInstalled(): boolean {
  return fs.existsSync(path.join(FRONTEND_PATH, 'index.html'));
}

@Controller()
export class SpaController {
  constructor() {
    if (spaInstalled()) markSpaInstalled();
  }

  /** Deep links (/call-log, /settings, ...) all land here and get index.html; real files are served as-is. */
  @Get('{*full_path}')
  @Auth('public')
  serveFrontend(@Req() req: Request): FileResponse {
    if (isApiPath(req.path)) throw apiFallbackError(req);
    if (!spaInstalled()) throw new HttpError(404, 'Not Found');
    let fullPath: string;
    try {
      fullPath = decodeURIComponent(req.path.replace(/^\/+/, ''));
    } catch {
      throw new HttpError(404, 'Not Found');
    }
    const root = fs.realpathSync(FRONTEND_PATH);
    const resolved = path.resolve(root, fullPath);
    let real: string;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      real = resolved;
    }
    if (real !== root && !real.startsWith(root + path.sep)) throw new HttpError(403, 'Forbidden');
    if (fs.existsSync(real) && fs.statSync(real).isFile()) {
      return new FileResponse(real, { contentType: CONTENT_TYPES[path.extname(real)] });
    }
    return new FileResponse(path.join(root, 'index.html'));
  }
}
