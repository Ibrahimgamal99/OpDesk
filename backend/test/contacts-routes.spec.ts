/**
 * The contacts API over HTTP, through the real auth guard: who may read and who may write.
 * requireScope lets ANY signed-in user through when no key is presented (no role check), so
 * the write handlers refuse a non-admin themselves; a key reaches only the routes wired with
 * its scope, and never PUT / DELETE (admin JWT only).
 *
 * No database: the pool (users, API keys, the JWT secret) and the db layer are mocked.
 */

const KEYS: Record<string, string[]> = {};

jest.mock('../src/db/pool', () => {
  const actual = jest.requireActual('../src/db/pool');
  return { ...actual, query: jest.fn(), queryOne: jest.fn(), execute: jest.fn() };
});
jest.mock('../src/db/db-manager', () => ({
  getSetting: jest.fn(async (_key: string, fallback: string | null = null) => fallback),
  contactsPage: jest.fn(async () => ({ items: [{ id: 1, name: 'Alice', phone: '0100', phone_key: '100', source: 'manual' }], next_cursor: null })),
  getContact: jest.fn(async (id: number) => (id === 1 ? { id: 1, name: 'Alice', phone: '0100', phone_key: '100', source: 'manual' } : null)),
  createContact: jest.fn(async () => 9),
  updateContact: jest.fn(async () => true),
  deleteContact: jest.fn(async () => true),
  contactUpsert: jest.fn(async () => ({ id: 10, action: 'created', error: null })),
}));
jest.mock('../src/integrations/crm-lookup', () => ({
  applyCrmRuntime: jest.fn(),
  monitoredExtensions: jest.fn(() => null),
  reloadResolverContacts: jest.fn(),
  runLookupTest: jest.fn(),
}));
jest.mock('../src/core/runtime', () => ({ runtime: { manager: { activeConnections: new Set() }, contactResolver: null, monitor: null } }));

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CrmController } from '../src/api/routes/crm.controller';
import { createAccessToken, generateApiKey, hashApiKey, resetJwtSecretCache } from '../src/core/security';
import * as dbm from '../src/db/db-manager';
import * as pool from '../src/db/pool';
import { nestApp } from './helpers/nest-app';

const USERS: Record<number, Record<string, unknown>> = {
  1: { id: 1, username: 'admin', extension: null, name: 'Admin', role: 'admin', is_active: 1 },
  2: { id: 2, username: 'agent', extension: '201', name: 'Agent', role: 'agent', is_active: 1 },
};

/** A key holding `scopes`, known to the mocked api_keys table. */
function keyWith(...scopes: string[]): string {
  const key = generateApiKey();
  KEYS[hashApiKey(key)] = scopes;
  return key;
}

let app: INestApplication;
let adminToken: string;
let agentToken: string;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  resetJwtSecretCache();
  (pool.queryOne as jest.Mock).mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('OpDesk_settings')) return null;
    if (sql.includes('FROM users')) return USERS[params[0] as number] ?? null;
    if (sql.includes('FROM api_keys')) {
      const scopes = KEYS[params[0] as string];
      return scopes ? { id: 5, name: 'sync', key_prefix: 'opd_x', scopes: JSON.stringify(scopes), enabled: 1 } : null;
    }
    return null;
  });
  (pool.query as jest.Mock).mockResolvedValue([]);
  (pool.execute as jest.Mock).mockResolvedValue({ affectedRows: 1, insertId: 0 });
  adminToken = await createAccessToken({ id: 1, username: 'admin', role: 'admin' });
  agentToken = await createAccessToken({ id: 2, username: 'agent', role: 'agent' });
  app = await nestApp([CrmController]);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  for (const f of ['createContact', 'contactUpsert', 'updateContact', 'deleteContact']) (dbm as unknown as Record<string, jest.Mock>)[f].mockClear();
});

const http = () => request(app.getHttpServer());

describe('reading the phonebook', () => {
  test('any signed-in user and a contacts:read key may read; nobody else', async () => {
    await http().get('/api/contacts').expect(401);
    const agent = await http().get('/api/contacts?search=ali&limit=5').set('Authorization', `Bearer ${agentToken}`).expect(200);
    expect(agent.body).toEqual({
      contacts: [expect.objectContaining({ id: 1, name: 'Alice', source: 'manual', external_id: null, source_system: null })],
      next_cursor: null,
    });
    expect(dbm.contactsPage).toHaveBeenLastCalledWith({ search: 'ali', limit: 5, cursor: null });

    const reader = keyWith('contacts:read');
    await http().get('/api/contacts').set('X-API-Key', reader).expect(200);
    await http().get('/api/contacts/1').set('X-API-Key', reader).expect(200);
    await http().get('/api/contacts/2').set('X-API-Key', reader).expect(404);
    const other = await http().get('/api/contacts').set('X-API-Key', keyWith('cdr:read')).expect(403);
    expect(other.body.error.message).toBe('API key missing required scope: contacts:read');
  });
});

describe('writing the phonebook', () => {
  test('a contacts:write key upserts as source api, single or bulk', async () => {
    const writer = keyWith('contacts:write');
    const one = await http()
      .post('/api/contacts')
      .set('X-API-Key', writer)
      .send({ name: 'Bob', phone: '+1 555 0100', external_id: 'c-1', source_system: 'hub' })
      .expect(200);
    expect(one.body).toEqual({ id: 10, action: 'created', reason: null });
    expect(dbm.contactUpsert).toHaveBeenCalledWith('Bob', '+1 555 0100', '15550100', expect.objectContaining({ source: 'api' }));

    const bulk = await http()
      .post('/api/contacts/bulk')
      .set('Authorization', `Bearer ${writer}`)
      .send({ contacts: [{ name: 'A', phone: '1' }, { name: 'B', phone: 'x' }] })
      .expect(200);
    expect(bulk.body.counts).toEqual({ created: 1, updated: 0, skipped: 1 });
  });

  test('a read-only key cannot write; a key never reaches edit or delete', async () => {
    const reader = keyWith('contacts:read');
    const res = await http().post('/api/contacts').set('X-API-Key', reader).send({ name: 'Bob', phone: '1' }).expect(403);
    expect(res.body.error.message).toBe('API key missing required scope: contacts:write');
    const writer = keyWith('contacts:write');
    // Admin routes are JWT-only: a key there is not a valid token.
    await http().put('/api/contacts/1').set('Authorization', `Bearer ${writer}`).send({ name: 'x', phone: '1' }).expect(401);
    await http().delete('/api/contacts/1').set('X-API-Key', writer).expect(401);
    expect(dbm.updateContact).not.toHaveBeenCalled();
    expect(dbm.deleteContact).not.toHaveBeenCalled();
  });

  test('a signed-in non-admin cannot write, though the scope route lets the JWT through', async () => {
    const asAgent = (r: request.Test) => r.set('Authorization', `Bearer ${agentToken}`);
    await asAgent(http().post('/api/contacts')).send({ name: 'Bob', phone: '1' }).expect(403);
    await asAgent(http().post('/api/contacts/bulk')).send({ contacts: [{ name: 'Bob', phone: '1' }] }).expect(403);
    await asAgent(http().put('/api/contacts/1')).send({ name: 'Bob', phone: '1' }).expect(403);
    expect(dbm.createContact).not.toHaveBeenCalled();
    expect(dbm.contactUpsert).not.toHaveBeenCalled();
  });

  test('an admin creates manual contacts and edits them; the bulk cap and body shape hold', async () => {
    const asAdmin = (r: request.Test) => r.set('Authorization', `Bearer ${adminToken}`);
    const created = await asAdmin(http().post('/api/contacts')).send({ name: 'Bob', phone: '0100 555' }).expect(200);
    expect(created.body).toEqual({ id: 9, action: 'created', reason: null });
    expect(dbm.createContact).toHaveBeenCalledWith('Bob', '0100 555', '0100555', null, null);
    await asAdmin(http().put('/api/contacts/1')).send({ name: 'Bob', phone: '1' }).expect(200);
    await asAdmin(http().delete('/api/contacts/1')).expect(200);

    const tooMany = Array.from({ length: 501 }, (_, i) => ({ name: `N${i}`, phone: String(100 + i) }));
    const capped = await asAdmin(http().post('/api/contacts/bulk')).send({ contacts: tooMany }).expect(400);
    expect(capped.body.error.message).toBe('Too many contacts in one request (max 500)');
    // A malformed item (no name field at all) rejects the request; an empty name only skips the item.
    const invalid = await asAdmin(http().post('/api/contacts/bulk')).send({ contacts: [{ phone: '1' }] }).expect(400);
    expect(invalid.body.error.fields).toEqual([expect.objectContaining({ path: 'contacts[0].name', code: 'value.required' })]);
  });
});
