/**
 * Read-only check of Call History against a real CDR/CEL database: every call's status as
 * OpDesk's Python computed it (CDR disposition only) next to the new CEL-based status and
 * "ended by", plus each call's journey and the notifications' projected reasons.
 *
 *   OPDESK_ENV_FILE=/path/to/.env npx tsx test/call-log.live.ts [date_from]
 *
 * SELECT-only: nothing is written. Not a jest spec on purpose: it needs a live database.
 */

import { closePools } from '../src/db/pool';
import * as dbm from '../src/db/db-manager';
import { buildCallJourneyFromCdr, callLog } from '../src/services/call-log';

/** OpDesk's old call_log.map_call_outcome(disposition=..., answered=bool(billsec)). */
function pythonStatus(disposition: string, billsec: number): string {
  if (billsec) return 'ANSWERED';
  return ({ ANSWERED: 'ANSWERED', 'NO ANSWER': 'NO_ANSWER', BUSY: 'BUSY', FAILED: 'FAILURE', CONGESTION: 'FAILURE' } as Record<string, string>)[
    disposition
  ] ?? 'FAILURE';
}

async function main(): Promise<void> {
  const dateFrom = process.argv[2] || '2000-01-01';
  const rows = await callLog({ dateFrom, limit: 500 });
  console.log(`${rows.length} call(s) since ${dateFrom}`);
  for (const r of rows) {
    console.log(
      [r.linkedid, r.calldate instanceof Date ? r.calldate.toISOString() : r.calldate, r.call_type, `${r.src}->${r.dst}`,
        `ext=${r.extension}`, `old=${pythonStatus(r.disposition, Number(r.talk) || 0)}`, `new=${r.status}`,
        `ended_by=${r.ended_by ?? '-'}${r.ended_by_agent ? `(${r.ended_by_agent})` : ''}`, `rec=${r.recording_file ? 'yes' : 'no'}`].join('  '),
    );
    const legs = await dbm.getCdrByLinkedid(String(r.linkedid));
    const journey = await buildCallJourneyFromCdr(legs, await dbm.getSupervisionForTarget(String(r.linkedid)));
    for (const e of journey) console.log('      ', JSON.stringify(e));
  }
  const notes = await dbm.getCallNotificationsFromDb({ limit: 20 });
  console.log(`notifications: ${notes.map((n) => `${n.id}:${n.reason}`).join(', ') || 'none'}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePools());
