/**
 * The database layer: the port of db_manager.py, split by section into
 * src/db/manager/*.ts and re-exported here so callers keep one namespace:
 *
 *     import * as dbm from '../db/db-manager';
 *     await dbm.getUserById(5);
 *
 * Each section owns distinct names; `export *` fails to compile on a clash, which is
 * the point -- two modules must never answer to the same name.
 */

export * from './manager/pbx';
export * from './manager/users';
export * from './manager/groups';
export * from './manager/platform';
export * from './manager/ops';
export * from './manager/call-log';
export * from './manager/audit';
export { appDbName, pbxDbName, cdrDbName, MAX_PAGE_LIMIT } from './pool';
