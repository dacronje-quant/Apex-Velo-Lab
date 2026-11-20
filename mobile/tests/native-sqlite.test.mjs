// The plugin wrapper (src/native-sqlite.js) against a scripted SQLiteConnection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openCapacitorDatabase, capacitorDriver } from '../src/native-sqlite.js';

/** A stand-in for @capacitor-community/sqlite's SQLiteConnection and its one connection, logging every call. */
function plugin({ existing = false, open = false, inTransaction = false } = {}) {
  const log = [];
  const conn = {
    async isDBOpen() { return { result: open }; },
    async open() { log.push('open'); open = true; },
    async isTransactionActive() { return { result: inTransaction }; },
    async beginTransaction() { log.push('begin'); inTransaction = true; },
    async commitTransaction() { log.push('commit'); inTransaction = false; },
    async rollbackTransaction() { log.push('rollback'); inTransaction = false; },
    async execute(sql, transaction) { log.push(['execute', sql, transaction]); },
    async run(sql, values, transaction) { log.push(['run', sql, values, transaction]); },
    async query(sql, values) { log.push(['query', sql, values]); return { values: [{ n: 1 }] }; },
    async close() { log.push('close'); }
  };
  class SQLiteConnection {
    async checkConnectionsConsistency() { return { result: true }; }
    async isConnection() { return { result: existing }; }
    async retrieveConnection(name) { log.push(['retrieve', name]); return conn; }
    async createConnection(name, encrypted, mode) { log.push(['create', name, encrypted, mode]); return conn; }
  }
  return { SQLiteConnection, log, state: () => ({ open, inTransaction }) };
}

test('a reused connection with a transaction left open by the earlier page is rolled back first', async () => {
  const p = plugin({ existing: true, open: true, inTransaction: true });
  const db = await openCapacitorDatabase(p.SQLiteConnection, {});
  assert.deepEqual(p.log, [['retrieve', 'apex'], 'rollback']);
  assert.equal(p.state().inTransaction, false);
  await db.run('INSERT INTO meta VALUES (?,?)', ['a', 'b']);
  assert.deepEqual(p.log.at(-1), ['run', 'INSERT INTO meta VALUES (?,?)', ['a', 'b'], false]);
});

test('a new connection is created without encryption and opened; nothing to roll back', async () => {
  const p = plugin();
  await openCapacitorDatabase(p.SQLiteConnection, {});
  assert.deepEqual(p.log, [['create', 'apex', false, 'no-encryption'], 'open']);
});

test('the driver runs every statement outside the plugin\'s own transactions; rollback only when one is open', async () => {
  const p = plugin({ open: true });
  const conn = await new p.SQLiteConnection().createConnection('apex', false, 'no-encryption');
  const db = capacitorDriver(conn);
  await db.exec('PRAGMA synchronous=FULL');
  assert.deepEqual(await db.all('SELECT 1 AS n', []), [{ n: 1 }]);
  await db.rollback();
  assert.equal(p.log.includes('rollback'), false);
  await db.begin(); await db.rollback();
  assert.deepEqual(p.log.slice(-2), ['begin', 'rollback']);
  assert.deepEqual(p.log[1], ['execute', 'PRAGMA synchronous=FULL', false]);
});
