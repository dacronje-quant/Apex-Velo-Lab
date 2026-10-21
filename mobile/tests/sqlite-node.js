/**
 * Test stand-ins for the phone's SQLite plugin and app storage: the native-store db driver on node:sqlite,
 * and snapshot files in a folder. Never part of the app build.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/** The store's db driver over node:sqlite (the same SQLite the desktop store uses). */
export function nodeDriver(file) {
  const db = new DatabaseSync(file);
  // Like the plugin, values come back as plain objects and every call is asynchronous.
  const plain = (row) => (row ? { ...row } : row);
  return {
    raw: db,
    async exec(sql) { db.exec(sql); },
    async run(sql, params = []) { db.prepare(sql).run(...params); },
    async all(sql, params = []) { return db.prepare(sql).all(...params).map(plain); },
    async begin() { db.exec('BEGIN IMMEDIATE'); },
    async commit() { db.exec('COMMIT'); },
    async rollback() { if (db.isTransaction) db.exec('ROLLBACK'); },
    async close() { if (db.isOpen) db.close(); }
  };
}

/** Snapshot files in `dir`, created on the first write. */
export function folderFiles(dir) {
  const at = (name) => path.join(dir, name);
  return {
    dir,
    async write(name, bytes) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(at(name), bytes, { flush: true }); },
    async read(name) { return new Uint8Array(fs.readFileSync(at(name))); },
    async list() { try { return fs.readdirSync(dir); } catch { return []; } },
    async stat(name) { try { const s = fs.statSync(at(name)); return { size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; } },
    async rename(from, to) { fs.renameSync(at(from), at(to)); },
    async remove(name) { fs.unlinkSync(at(name)); }
  };
}
