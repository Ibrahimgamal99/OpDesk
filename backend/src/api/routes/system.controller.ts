/**
 * Health check, the hand-written OpenAPI spec, and the generated route list with its
 * explorers (/openapi.json, /docs, /redoc -- FastAPI served these unauthenticated).
 */

import { promises as fsp } from 'fs';
import * as path from 'path';
import { Controller } from '@nestjs/common';
import { PROJECT_ROOT } from '../../core/config';
import { runtime } from '../../core/runtime';
import { HttpError } from '../http-error';
import { OpenApiBuilder, OpenApiDocument } from '../openapi';
import { FileResponse, RawResponse } from '../respond';
import { Auth, Get } from '../routing';

const TITLE = 'OpDesk';
const ALL_ROUTES_URL = '/openapi.json';
const INTEGRATION_URL = '/api/openapi.yaml';

/** <repo>/docs/api/openapi.yaml */
export const OPENAPI_SPEC_PATH = path.join(PROJECT_ROOT, 'docs', 'api', 'openapi.yaml');

const SWAGGER_HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link type="text/css" rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css">
<title>${TITLE} - Swagger UI</title>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-standalone-preset.js"></script>
<script>
const ui = SwaggerUIBundle({
  urls: [
    { url: '${INTEGRATION_URL}', name: 'Integration API (schemas)' },
    { url: '${ALL_ROUTES_URL}', name: 'All routes' },
  ],
  dom_id: '#swagger-ui',
  layout: 'StandaloneLayout',
  deepLinking: true,
  presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
});
</script>
</body>
</html>
`;

const REDOC_HTML = `<!DOCTYPE html>
<html>
<head>
<title>${TITLE} - ReDoc</title>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body { margin: 0; padding: 0; }</style>
</head>
<body>
<redoc spec-url="${INTEGRATION_URL}"></redoc>
<script src="https://cdn.jsdelivr.net/npm/redoc@2.1.5/bundles/redoc.standalone.js"></script>
</body>
</html>
`;

@Controller()
export class SystemController {
  constructor(private readonly openapi: OpenApiBuilder) {}

  /** Public health endpoint for load balancers and monitoring. */
  @Get('/health')
  @Auth('public')
  async healthCheck() {
    const monitor = runtime.monitor as unknown as { connected?: boolean } | null;
    return { status: 'ok', ami_connected: Boolean(monitor && (monitor.connected ?? false)) };
  }

  /** The hand-written OpenAPI 3 spec of the public integration API (docs/api/openapi.yaml). */
  @Get('/api/openapi.yaml')
  @Auth('public')
  async serveOpenapiSpec() {
    try {
      await fsp.access(OPENAPI_SPEC_PATH);
    } catch {
      throw new HttpError(404, 'OpenAPI spec not found');
    }
    return new FileResponse(OPENAPI_SPEC_PATH, { contentType: 'application/yaml', filename: 'openapi.yaml' });
  }

  /** Every route of the running server (paths, methods, auth policy). */
  @Get('/openapi.json')
  @Auth('public')
  spec(): OpenApiDocument {
    return this.openapi.document();
  }

  @Get('/docs')
  @Auth('public')
  swagger(): RawResponse {
    return new RawResponse(SWAGGER_HTML, { contentType: 'text/html; charset=utf-8' });
  }

  @Get('/redoc')
  @Auth('public')
  redoc(): RawResponse {
    return new RawResponse(REDOC_HTML, { contentType: 'text/html; charset=utf-8' });
  }
}
