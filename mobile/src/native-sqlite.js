/**
 * Thin wrappers that give src/native-store.js its two dependencies on the phone:
 *   - a db driver over @capacitor-community/sqlite (one connection, platform transactions; every
 *     statement runs with transaction=false so the store's own BEGIN/COMMIT decides what is atomic),
 *   - snapshot files in the app's private storage (Directory.Data/backups) through @capacitor/filesystem.
 */
import { toBase64, fromBase64 } from './native-store.js';

/** Adapts an open SQLiteDBConnection to the driver the store expects. */
export function capacitorDriver(conn) {
  return {
    exec: (sql) => conn.execute(sql, false),
    run: (sql, params = []) => conn.run(sql, params, false),
    all: async (sql, params = []) => (await conn.query(sql, params)).values || [],
    begin: () => conn.beginTransaction(),
    commit: () => conn.commitTransaction(),
    rollback: async () => { if ((await conn.isTransactionActive()).result) await conn.rollbackTransaction(); },
    close: () => conn.close()
  };
}

/**
 * Opens (or reuses, after a WebView reload) the app database "apex" without encryption: the file sits in
 * the app's private storage, which Android already encrypts at rest. `SQLiteConnection` comes from the
 * plugin package; it is passed in so this module stays free of plugin imports.
 */
export async function openCapacitorDatabase(SQLiteConnection, CapacitorSQLite, name = 'apex') {
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const consistent = await sqlite.checkConnectionsConsistency().catch(() => ({ result: false }));
  const exists = consistent.result && (await sqlite.isConnection(name, false)).result;
  const conn = exists ? await sqlite.retrieveConnection(name, false) : await sqlite.createConnection(name, false, 'no-encryption', 1, false);
  if (!(await conn.isDBOpen()).result) await conn.open();
  return capacitorDriver(conn);
}

const blobBytes = async (data) => new Uint8Array(await data.arrayBuffer());

/** Snapshot files in Directory.Data/<dir> (removed with the app; History > Export keeps a copy elsewhere). */
export function filesystemFiles(Filesystem, dir = 'backups') {
  const at = (name) => ({ path: `${dir}/${name}`, directory: 'DATA' });
  let made = null;
  return {
    async write(name, bytes) {
      if (!made) made = Filesystem.mkdir({ path: dir, directory: 'DATA', recursive: true }).catch(() => {});
      await made;
      await Filesystem.writeFile({ ...at(name), data: toBase64(bytes) });
    },
    async read(name) {
      const { data } = await Filesystem.readFile(at(name));
      return typeof data === 'string' ? fromBase64(data) : blobBytes(data);
    },
    async list() {
      try { return (await Filesystem.readdir({ path: dir, directory: 'DATA' })).files.map((f) => (typeof f === 'string' ? f : f.name)); } catch { return []; }
    },
    async stat(name) {
      try { const s = await Filesystem.stat(at(name)); return { size: Number(s.size), mtimeMs: Number(s.mtime) }; } catch { return null; }
    },
    rename: (from, to) => Filesystem.rename({ from: `${dir}/${from}`, to: `${dir}/${to}`, directory: 'DATA', toDirectory: 'DATA' }),
    remove: (name) => Filesystem.deleteFile(at(name))
  };
}
