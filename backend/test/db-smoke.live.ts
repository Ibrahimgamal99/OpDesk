/**
 * Read-only smoke run of the db-manager sections against a real database.
 *
 *   OPDESK_ENV_FILE=/path/to/.env npx tsx test/db-smoke.live.ts
 *
 * Calls every SELECT-only function of pbx / users / groups / platform / ops (and the
 * migration's missingTables) and prints the shape of what came back: row counts, keys
 * and value types. Writers are never called -- not even authenticateUser or
 * lookupApiKey, which stamp last_login_at / last_used_at. Secrets (SIP secrets,
 * password hashes, setting values) are never printed. Not a jest spec on purpose: it
 * needs a live database.
 */

import { closePools } from '../src/db/pool';
import * as pbx from '../src/db/manager/pbx';
import * as users from '../src/db/manager/users';
import * as groups from '../src/db/manager/groups';
import * as platform from '../src/db/manager/platform';
import * as ops from '../src/db/manager/ops';
import { missingTables } from '../src/db/migrate';

const SECRET_KEYS = /secret|password|hash|token|pn_prid|key$/i;

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (v instanceof Date) return 'Date';
  if (Array.isArray(v)) return `array(${v.length})`;
  return typeof v;
}

/** A short description of a value: types per key, never the secret values themselves. */
function shape(v: unknown): string {
  if (Array.isArray(v)) {
    if (!v.length) return '[] (0 rows)';
    const first = v[0];
    if (Array.isArray(first)) return `${v.length} tuples of [${first.map(typeOf).join(', ')}]`;
    if (first && typeof first === 'object' && !(first instanceof Date)) {
      return `${v.length} rows {${Object.entries(first).map(([k, x]) => `${k}:${typeOf(x)}`).join(', ')}}`;
    }
    return `[${v.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : typeOf(x))).join(', ')}]`;
  }
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return `{${Object.entries(v)
      .map(([k, x]) => `${k}:${SECRET_KEYS.test(k) ? `<${typeOf(x)} hidden>` : Array.isArray(x) ? shape(x) : typeOf(x)}`)
      .join(', ')}}`;
  }
  return typeOf(v);
}

async function run(name: string, fn: () => Promise<unknown>, show: (v: unknown) => string = shape): Promise<unknown> {
  try {
    const v = await fn();
    process.stdout.write(`OK   ${name}: ${show(v)}\n`);
    return v;
  } catch (e) {
    process.stdout.write(`FAIL ${name}: ${(e as Error).message}\n`);
    return undefined;
  }
}

const keysOnly = (v: unknown) => (v && typeof v === 'object' ? `${Object.keys(v).length} keys [${Object.keys(v).sort().join(', ')}]` : typeOf(v));

async function main(): Promise<void> {
  // migration status (information_schema only)
  await run('migrate.missingTables', () => missingTables());

  // pbx
  const exts = (await run('getExtensionsFromDb', () => pbx.getExtensionsFromDb())) as string[] | null;
  const ext = exts && exts.length ? exts[0] : '0';
  await run(`extensionExistsInPbx(${ext})`, () => pbx.extensionExistsInPbx(ext));
  await run('extensionExistsInPbx(nonexistent)', () => pbx.extensionExistsInPbx('99999999'));
  await run('getExtensionNamesFromDb', () => pbx.getExtensionNamesFromDb());
  await run('getQueueNamesFromDb', () => pbx.getQueueNamesFromDb());
  await run('getQueuesWithRecording', () => pbx.getQueuesWithRecording());
  await run('getOutboundRoutesRecording', () => pbx.getOutboundRoutesRecording());
  await run(`getExtensionSecretFromDb(${ext})`, () => pbx.getExtensionSecretFromDb(ext), (v) => (v ? `<string(${String(v).length}) hidden>` : typeOf(v)));
  await run(`getExtensionSipProfile(${ext})`, () => pbx.getExtensionSipProfile(ext), (v) => (v ? `keys [${Object.keys(v).join(', ')}]` : typeOf(v)));
  await run('getPbxDefaultCodecs', () => pbx.getPbxDefaultCodecs());
  await run('getExtensionsWithWebrtcFromUsers', () => pbx.getExtensionsWithWebrtcFromUsers());

  // users
  const all = (await run('getAllUsers', () => users.getAllUsers())) as users.UserWithModes[] | undefined;
  const u = all && all.length ? all[0] : null;
  const uid = u ? u.id : 0;
  const uext = all?.find((x) => x.extension)?.extension ?? ext;
  await run('getUserByUsername(admin)', () => users.getUserByUsername('admin'));
  await run(`getUserByExtension(${uext})`, () => users.getUserByExtension(uext));
  await run(`getUserById(${uid})`, () => users.getUserById(uid));
  await run(`getUserMonitorModes(${uid})`, () => users.getUserMonitorModes(uid));
  await run(`getUserWebrtcCredentials(${uid})`, () => users.getUserWebrtcCredentials(uid));
  await run(`getAgentNameByExtension(${uext})`, () => users.getAgentNameByExtension(uext));
  await run(`getUserGroupIds(${uid})`, () => users.getUserGroupIds(uid));
  await run(`getUserAgentsAndQueues(${uid})`, () => users.getUserAgentsAndQueues(uid), (v) => JSON.stringify(v));
  await run(`getGroupIdsForAgent(${uext})`, () => users.getGroupIdsForAgent(uext));
  await run(`getAgentGroupScope(${uext})`, () => users.getAgentGroupScope(uext), (v) => JSON.stringify(v));
  await run(`getAgentLoginQueues(${uext})`, () => users.getAgentLoginQueues(uext));
  for (const x of all || []) await run(`getUserLiveScope(${x.id})`, () => users.getUserLiveScope(x.id), (v) => JSON.stringify(v));
  await run('verifyUserPassword(bad hash)', () => users.verifyUserPassword('not-a-hash', 'x'));

  // groups
  const gl = (await run('getGroupsList', () => groups.getGroupsList())) as groups.Group[] | undefined;
  await run('getGroup(first or 0)', () => groups.getGroup(gl && gl.length ? gl[0].id : 0));
  await run('groupNameExists(__none__)', () => groups.groupNameExists('__none__'));

  // platform
  await run('getSetting(SLA_DEFAULT_SECS)', () => platform.getSetting('SLA_DEFAULT_SECS'));
  await run('getSetting(__missing__, fallback)', () => platform.getSetting('__missing__', 'fb'));
  await run('getAllSettings', () => platform.getAllSettings(true), keysOnly);
  await run(`getDeviceTokensForExtension(${uext})`, () => platform.getDeviceTokensForExtension(uext));
  await run(`extensionHasMobileToken(${uext})`, () => platform.extensionHasMobileToken(uext));
  await run('listSipPushBindings()', () => platform.listSipPushBindings());
  await run(`listSipPushBindings(${uext})`, () => platform.listSipPushBindings(uext));
  await run(`extensionHasSipPushBinding(${uext})`, () => platform.extensionHasSipPushBinding(uext));
  const keys = (await run('listApiKeys', () => platform.listApiKeys())) as { id: number }[] | undefined;
  await run('getApiKey(first or 0)', () => platform.getApiKey(keys && keys.length ? keys[0].id : 0));
  const deliveries = (await run('listWebhookDeliveries({limit:5})', () => platform.listWebhookDeliveries({ limit: 5 }), (v) => {
    const [rows, more] = v as [unknown[], boolean];
    return `has_more=${more} ${shape(rows)}`;
  })) as [{ id: number }[], boolean] | undefined;
  await run('getWebhookDelivery(first or 0)', () => platform.getWebhookDelivery(deliveries && deliveries[0].length ? deliveries[0][0].id : 0));
  await run('listContacts', () => platform.listContacts());
  await run('getContactsForResolver', () => platform.getContactsForResolver());

  // ops
  await run('getAgentsList', () => ops.getAgentsList());
  await run('getQueuesList', () => ops.getQueuesList());
  await run('pauseReasonList()', () => ops.pauseReasonList());
  await run('pauseReasonList({activeOnly, includeSystem:false})', () => ops.pauseReasonList({ activeOnly: true, includeSystem: false }));
  await run('pauseReasonGet(lunch)', () => ops.pauseReasonGet('lunch'));
  await run('pauseReasonForNotReady(lunch)', () => ops.pauseReasonForNotReady('lunch'));
  await run('isValidNotReadyReason(__WRAPUP)', () => ops.isValidNotReadyReason(ops.WRAPUP_REASON_CODE));
  await run('isValidNotReadyReason(bogus)', () => ops.isValidNotReadyReason('bogus'));
  await run('getSupervisionBySpyKeys([x])', () => ops.getSupervisionBySpyKeys(['x']));
  await run('getSupervisionForTarget(x)', () => ops.getSupervisionForTarget('x'));
  await run('getSupervisionTargets([x])', () => ops.getSupervisionTargets(['x']));
  await run(`agentActivityOpen(${uext})`, () => ops.agentActivityOpen(uext));
}

main()
  .catch((e) => process.stdout.write(`smoke run failed: ${(e as Error).stack}\n`))
  .finally(() => closePools());
