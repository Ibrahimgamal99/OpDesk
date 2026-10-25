/** GET /api/audit-log: the audit trail of API mutations (admin only). */

import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { auditLogFacets, listAuditLog } from '../../db/manager/audit';
import { decodePageCursor, encodePageCursor } from '../respond';
import { Auth, Get } from '../routing';
import { qBool, qInt, qStr } from '../validation';
import type { QueryParams } from '../validation';

@Controller()
export class AuditController {
  /**
   * Recent audit-log entries, newest first. Bare body:
   *   { entries: [...], next_cursor: str|null, facets?: { action: {..}, entity_type: {..} } }
   *
   * Rows: id, created_at, actor (display name / username / key label), actor_user_id, actor_ext,
   * action, entity_type, entity_id, summary, ip, detail.
   * Query: action, entity_type (alias entity), actor (stored label, username or name),
   * from / to ('YYYY-MM-DD' or ISO; `to` includes that whole day), limit (default 200,
   * max 1000), cursor (the previous page's next_cursor), facets=1 for per-value counts under
   * the same filters (each facet ignoring its own selection).
   */
  @Get('/api/audit-log')
  @Auth('admin')
  async auditLog(@Req() req: Request) {
    const q = req.query as QueryParams;
    const filter = {
      action: qStr(q, 'action', '') || null,
      entityType: qStr(q, 'entity_type', '') || qStr(q, 'entity', '') || null,
      actor: qStr(q, 'actor', '') || null,
      from: qStr(q, 'from', '') || null,
      to: qStr(q, 'to', '') || null,
    };
    const limit = qInt(q, 'limit', 200);
    const cursor = qStr(q, 'cursor', '') || null;
    const keyset = decodePageCursor(cursor);
    const beforeId = typeof keyset.id === 'number' ? keyset.id : null;
    const wantFacets = qBool(q, 'facets', false);
    const [page, facets] = await Promise.all([
      listAuditLog({ ...filter, limit, beforeId }),
      wantFacets ? auditLogFacets(filter) : Promise.resolve(null),
    ]);
    const body: Record<string, unknown> = {
      entries: page.entries,
      next_cursor: page.next_before_id === null ? null : encodePageCursor({ id: page.next_before_id }),
    };
    if (wantFacets) body.facets = facets;
    return body;
  }
}
