// Native ride import (src/native-import.js): streamed reads over the plugin, the import job log on the phone
// database, the watched folder (name+size+mtime tracking, nothing read twice, interrupted files) and the
// share inbox, against the real phone store on node:sqlite and a scripted ApexImport plugin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeStore } from '../src/native-store.js';
import { NativeImport, SqliteImportJobs, nativeSource, stamp, WATCH_JOB, SHARE_JOB } from '../src/native-import.js';
import { toBase64 } from '../src/native-store.js';
import { nodeDriver, folderFiles } from './sqlite-node.js';

async function openStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-native-import-'));
  const s = await NativeStore.open({ db: nodeDriver(path.join(dir, 'apex.sqlite')), files: folderFiles(path.join(dir, 'backups')), backupDelayMs: 3600000 });
  t.after(async () => { await s.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });
  return s;
}

/** ApexImport over in-memory files: folder entries { path, size, mtime, bytes } and inbox entries { uri, name, bytes }. */
function fakePlugin({ folder = [], inbox = [], permission = true } = {}) {
  const handles = new Map();
  let next = 1;
  const p = {
    folder, inbox, permission, picked: true, log: { opened: [], reads: 0, closed: 0, seen: null, removed: [], closeAll: 0 },
    byUri(uri) { return folder.find((f) => `content://tree/${f.path}` === uri) || inbox.find((f) => f.uri === uri); },
    async getFolder() { return p.picked ? { uri: 'content://tree', name: 'Rides', permission: p.permission, pendingNew: 0, workerCheckedAt: 0 } : { uri: null }; },
    async pickFolder() { p.picked = true; return p.getFolder(); },
    async removeFolder() { p.picked = false; },
    async listFolder() { return { files: folder.map((f) => ({ uri: `content://tree/${f.path}`, path: f.path, name: f.path.split('/').pop(), size: f.size ?? f.bytes.length, mtime: f.mtime ?? 1 })) }; },
    async setSeen({ stamps }) { p.log.seen = stamps; },
    async listInbox() { return { files: inbox.map((f) => ({ uri: f.uri, name: f.name, size: f.bytes.length, mtime: 5 })) }; },
    async removeInbox({ uri }) { p.log.removed.push(uri); const i = inbox.findIndex((f) => f.uri === uri); if (i >= 0) inbox.splice(i, 1); },
    async open({ uri }) { const f = p.byUri(uri); if (!f) throw new Error('gone'); p.log.opened.push(uri); const h = next++; handles.set(h, { bytes: f.bytes, pos: 0 }); return { handle: h, size: f.bytes.length }; },
    async read({ handle, length }) {
      p.log.reads++;
      const h = handles.get(handle);
      const chunk = h.bytes.subarray(h.pos, h.pos + length);
      h.pos += chunk.length;
      const eof = h.pos >= h.bytes.length;
      if (eof) handles.delete(handle);
      return { data: toBase64(chunk), eof };
    },
    async close({ handle }) { p.log.closed++; handles.delete(handle); },
    async closeAll() { p.log.closeAll++; handles.clear(); },
    get openHandles() { return handles.size; }
  };
  return p;
}

const bytes = (text) => new TextEncoder().encode(text);
async function readAll(src) {
  const reader = src.stream().getReader(), parts = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(...value); }
  return new TextDecoder().decode(Uint8Array.from(parts));
}

/**
 * Stands in for VeloApp.startBulkImport: reads every source to the end through its stream (as the importer
 * does), logs the job through `jobs` and answers like finishBulkImport. `behave(names)` may return
 * { cancelled, error, failed: [names] } for a run.
 */
function fakeApp(jobs, behave = () => ({})) {
  const app = {
    runs: [], read: [], toasts: [], _bulk: null,
    showToast(msg, kind) { app.toasts.push({ msg, kind }); },
    async startBulkImport(sources, opts) {
      const names = sources.map((s) => s.name);
      const b = behave(names) || {};
      const job = await jobs.create({ source: opts.jobSource, cursor: opts.jobCursor });
      app._bulk = { job };
      for (const s of sources) app.read.push([s.name, await readAll(s)]);
      app.runs.push({ names, opts });
      if (b.failed) await jobs.putFiles(job.id, b.failed.map((n) => ({ path: n, status: 'error', error: 'not a FIT file' })));
      await jobs.update(job.id, { status: b.error ? 'failed' : b.cancelled ? 'cancelled' : 'done', cursor: JSON.stringify({ counts: { found: names.length } }) });
      app._bulk = null;
      return { found: names.length, imported: names.length - (b.failed || []).length, duplicates: 0, skipped: 0, errors: (b.failed || []).length,
        cancelled: !!b.cancelled, error: b.error || null, jobId: job.id };
    }
  };
  return app;
}

function setup(store, plugin, behave) {
  const jobs = new SqliteImportJobs(Promise.resolve(store), () => { throw new Error('no fallback expected'); });
  const app = fakeApp(jobs, behave);
  const ni = new NativeImport({ plugin, store: Promise.resolve(store), getApp: () => app, chunk: 4, waitMs: 5 });
  return { jobs, app, ni };
}

test('a native source streams the file in chunks and closes it at the end or on cancel', async () => {
  const plugin = fakePlugin({ inbox: [{ uri: 'file:///inbox/1/ride.gpx', name: 'ride.gpx', bytes: bytes('0123456789') }] });
  const src = nativeSource(plugin, { uri: 'file:///inbox/1/ride.gpx', name: 'ride.gpx', size: 10 }, 4);
  assert.equal(plugin.log.opened.length, 0, 'opened only when read');
  assert.equal(await readAll(src), '0123456789');
  assert.equal(plugin.log.reads, 3, 'three reads of at most 4 bytes');
  assert.equal(plugin.openHandles, 0);
  const reader = src.stream().getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(plugin.log.closed, 1, 'a cancelled read closes the file');
  assert.equal(plugin.openHandles, 0);
});

test('the stamp is name+size+mtime, the same string ImportFiles.stamp builds in Kotlin', () => {
  assert.equal(stamp({ path: 'Garmin/ride.fit', size: 2048, mtime: 1760000000000 }), 'Garmin/ride.fit|2048|1760000000000');
});

test('SqliteImportJobs keeps the VeloImportJobs shape on the phone tables and merges cursors', async (t) => {
  const store = await openStore(t);
  const jobs = new SqliteImportJobs(Promise.resolve(store), null);
  const job = await jobs.create({ source: 'export.zip', cursor: { native: 'share' } });
  assert.equal(job.status, 'running');
  assert.equal(typeof job.created_at, 'string');
  assert.deepEqual(JSON.parse(job.cursor), { native: 'share' });
  await jobs.update(job.id, { total: 4, done: 2, cursor: JSON.stringify({ counts: { found: 4 } }) });
  const got = await jobs.get(job.id);
  assert.deepEqual(JSON.parse(got.cursor), { native: 'share', counts: { found: 4 } }, 'the counts join what was there');
  assert.equal(got.done, 2);
  await jobs.putFiles(job.id, [{ path: 'export.zip/a.fit', status: 'error', error: 'bad', hash: null, ride_id: null }]);
  assert.deepEqual(await jobs.files(job.id), [{ job_id: job.id, path: 'export.zip/a.fit', hash: null, ride_id: null, status: 'error', error: 'bad' }]);
  await store.putImportJob({ id: WATCH_JOB, status: 'watching' });
  assert.deepEqual((await jobs.list()).map((j) => j.id), [job.id], 'the watched folder record is not an import job');
  for (let i = 0; i < SqliteImportJobs.KEEP + 3; i++) await jobs.create({ source: `f${i}` });
  const list = await jobs.list();
  assert.equal(list.length, SqliteImportJobs.KEEP, 'old jobs are pruned');
  assert.ok(await store.getImportJob(WATCH_JOB), 'but never the folder record');
  assert.equal(list[0].source, `f${SqliteImportJobs.KEEP + 2}`, 'newest first');
});

test('without the phone database the job log falls back to settings keys', async () => {
  const calls = [];
  const fallback = { create: async (o) => { calls.push(['create', o.source]); return { id: 'x' }; }, list: async () => { calls.push(['list']); return []; } };
  const jobs = new SqliteImportJobs(Promise.reject(new Error('no db')), () => fallback);
  assert.deepEqual(await jobs.create({ source: 'a.fit' }), { id: 'x' });
  assert.deepEqual(await jobs.list(), []);
  assert.deepEqual(calls, [['create', 'a.fit'], ['list']]);
});

test('watched folder: new files are imported once, a changed file again, and the worker learns what is known', async (t) => {
  const store = await openStore(t);
  const plugin = fakePlugin({ folder: [
    { path: 'Garmin/a.fit', bytes: bytes('ride-a'), mtime: 10 },
    { path: 'b.gpx', bytes: bytes('ride-b'), mtime: 20 }
  ] });
  const { app, ni } = setup(store, plugin);
  const first = await ni.scanFolder();
  assert.deepEqual(first, { files: 2, fresh: 2, summary: first.summary });
  assert.deepEqual(app.read, [['Garmin/a.fit', 'ride-a'], ['b.gpx', 'ride-b']], 'read through the plugin under their folder paths');
  assert.equal(app.runs[0].opts.jobCursor.native, 'folder');
  const rows = await store.listImportFiles(WATCH_JOB);
  assert.deepEqual(rows.map((r) => [r.path, r.status]), [['Garmin/a.fit|6|10', 'imported'], ['b.gpx|6|20', 'imported']]);
  assert.deepEqual(plugin.log.seen.sort(), ['Garmin/a.fit|6|10', 'b.gpx|6|20']);
  const job = await store.getImportJob(WATCH_JOB);
  assert.equal(job.status, 'watching');
  assert.equal(job.total, 2);
  assert.equal(job.done, 2);
  assert.equal(job.cursor.lastImported, 2);
  assert.equal(plugin.log.closeAll, 1);

  const opened = plugin.log.opened.length;
  const again = await ni.scanFolder();
  assert.equal(again.fresh, 0);
  assert.equal(plugin.log.opened.length, opened, 'nothing is read twice');
  assert.equal(app.runs.length, 1);

  plugin.folder[1].mtime = 21; // saved again by the sync app
  plugin.folder.push({ path: 'c.tcx', bytes: bytes('ride-c'), mtime: 30 });
  const third = await ni.scanFolder();
  assert.equal(third.fresh, 2);
  assert.deepEqual(app.runs[1].names, ['b.gpx', 'c.tcx']);
  assert.equal((await store.getImportJob(WATCH_JOB)).total, 3);
});

test('watched folder: a file that could not be read is recorded with its error and not read again', async (t) => {
  const store = await openStore(t);
  const plugin = fakePlugin({ folder: [{ path: 'broken.fit', bytes: bytes('xx') }, { path: 'ok.fit', bytes: bytes('ok') }] });
  const { ni } = setup(store, plugin, () => ({ failed: ['broken.fit'] }));
  await ni.scanFolder();
  const rows = Object.fromEntries((await store.listImportFiles(WATCH_JOB)).map((r) => [r.path, r]));
  assert.equal(rows['broken.fit|2|1'].status, 'error');
  assert.equal(rows['broken.fit|2|1'].error, 'not a FIT file');
  assert.equal(rows['ok.fit|2|1'].status, 'imported');
  assert.equal((await store.getImportJob(WATCH_JOB)).errors, 1);
  assert.equal((await ni.scanFolder()).fresh, 0);
});

test('watched folder: a file the app was killed on is read once more, then recorded as interrupted', async (t) => {
  const store = await openStore(t);
  const plugin = fakePlugin({ folder: [{ path: 'crash.fit', bytes: bytes('boom') }, { path: 'later.fit', bytes: bytes('fine') }] });
  // The first start was killed while reading both files.
  await store.putImportFiles(WATCH_JOB, [{ path: 'crash.fit|4|1', status: 'reading' }, { path: 'later.fit|4|1', status: 'reading' }]);
  await store.putImportJob({ id: 'job_killed', source: 'Rides', status: 'running', cursor: { native: 'folder' } });
  // The second start dies too (an import error, as when the worker stops responding).
  const { app, ni } = setup(store, plugin, () => ({ error: 'the import stopped responding' }));
  await ni.scanFolder();
  assert.deepEqual(app.runs[0].names, ['crash.fit', 'later.fit']);
  assert.deepEqual((await store.listImportFiles(WATCH_JOB)).map((r) => r.status), ['retrying', 'retrying']);
  const killed = await store.getImportJob('job_killed');
  assert.equal(killed.status, 'interrupted');
  assert.equal(killed.cursor.resumedBy, app.runs[0] && (await store.listImportJobs()).find((j) => j.source === 'Rides: 2 new files').id);
  assert.equal(plugin.log.seen.length, 0, 'files still being retried are not known to the worker');
  // Third start: given up on, never read again.
  const third = await ni.scanFolder();
  assert.equal(third.fresh, 0);
  assert.equal(app.runs.length, 1);
  assert.deepEqual((await store.listImportFiles(WATCH_JOB)).map((r) => r.status), ['interrupted', 'interrupted']);
  assert.equal(plugin.log.seen.length, 2);
});

test('watched folder: a cancelled import is not restarted until the rider asks, then reads the files again', async (t) => {
  const store = await openStore(t);
  const plugin = fakePlugin({ folder: [{ path: 'a.fit', bytes: bytes('a') }] });
  let cancel = true;
  const { app, ni } = setup(store, plugin, () => ({ cancelled: cancel }));
  await ni.scanFolder();
  assert.deepEqual((await store.listImportFiles(WATCH_JOB)).map((r) => r.status), ['queued']);
  assert.equal(await ni.scanFolder(), null, 'resume does not start it again');
  cancel = false;
  const r = await ni.scanFolder({ force: true });
  assert.equal(r.fresh, 1);
  assert.equal(app.runs.length, 2);
  assert.deepEqual((await store.listImportFiles(WATCH_JOB)).map((x) => x.status), ['imported']);
});

test('watched folder: a lost permission is reported and Remove forgets the folder', async (t) => {
  const store = await openStore(t);
  const plugin = fakePlugin({ folder: [{ path: 'a.fit', bytes: bytes('a') }], permission: false });
  const { app, ni } = setup(store, plugin);
  assert.deepEqual(await ni.scanFolder(), { error: 'permission' });
  assert.equal(app.runs.length, 0);
  const st = await ni.folderStatus();
  assert.equal(st.permission, false);
  assert.match(st.lastError, /no longer has access/);
  plugin.permission = true;
  await ni.scanFolder();
  assert.equal((await ni.folderStatus()).tracked, 1);
  await ni.removeFolder();
  assert.equal(await store.getImportJob(WATCH_JOB), null);
  assert.deepEqual(await store.listImportFiles(WATCH_JOB), []);
  assert.deepEqual(await ni.folderStatus(), { folder: null });
  // Choosing a folder again starts from nothing.
  await ni.pickFolder();
  assert.equal(app.runs.length, 2);
});

test('share inbox: shared files are imported together, removed from the inbox, and a rejected file is named', async (t) => {
  const store = await openStore(t);
  const plugin = fakePlugin({ inbox: [
    { uri: 'file:///inbox/1-0/export.zip', name: 'export.zip', bytes: bytes('zip-bytes') },
    { uri: 'file:///inbox/1-1/ride.fit', name: 'ride.fit', bytes: bytes('fit-bytes') }
  ] });
  const { app, ni } = setup(store, plugin);
  await ni.onShared({ accepted: 2, rejected: ['photo.jpg'] });
  assert.deepEqual(app.read, [['export.zip', 'zip-bytes'], ['ride.fit', 'fit-bytes']]);
  assert.equal(app.runs[0].opts.jobSource, '2 shared files');
  assert.equal(app.runs[0].opts.jobCursor.native, 'share');
  assert.equal(plugin.inbox.length, 0);
  assert.match(app.toasts[0].msg, /photo\.jpg: not a ride file/);
  assert.match(app.toasts[1].msg, /Importing 2 shared files/);
  assert.deepEqual((await store.listImportFiles(SHARE_JOB)).map((r) => r.status), ['imported', 'imported']);
});

test('share inbox: a killed import is resumed at the next start, and a file that stops it twice is dropped', async (t) => {
  const store = await openStore(t);
  const plugin = fakePlugin({ inbox: [
    { uri: 'file:///inbox/1-0/a.fit', name: 'a.fit', bytes: bytes('aaa') },
    { uri: 'file:///inbox/1-1/b.fit', name: 'b.fit', bytes: bytes('bbb') },
    { uri: 'file:///inbox/1-2/c.fit', name: 'c.fit', bytes: bytes('ccc') }
  ] });
  await store.putImportJob({ id: 'job_old', source: '3 shared files', status: 'running', cursor: { native: 'share' } });
  await store.putImportFiles(SHARE_JOB, [
    { path: 'file:///inbox/1-0/a.fit', status: 'reading' },  // killed during the first try
    { path: 'file:///inbox/1-1/b.fit', status: 'retrying' }, // killed during both tries
    { path: 'file:///inbox/1-2/c.fit', status: 'imported' }  // read, but the app stopped before removing it
  ]);
  const { app, ni } = setup(store, plugin);
  await ni.catchUp();
  assert.deepEqual(app.runs.map((r) => r.names), [['a.fit']]);
  assert.equal(plugin.inbox.length, 0);
  assert.match(app.toasts.map((x) => x.msg).join('\n'), /b\.fit: the import stopped twice/);
  const old = await store.getImportJob('job_old');
  assert.equal(old.status, 'interrupted');
  assert.ok(old.cursor.resumedBy);
  assert.equal((await store.getImportJob(old.cursor.resumedBy)).status, 'done');
});

test('share inbox: an import that fails keeps the files for the next start', async (t) => {
  const store = await openStore(t);
  const plugin = fakePlugin({ inbox: [{ uri: 'file:///inbox/1-0/a.fit', name: 'a.fit', bytes: bytes('aaa') }] });
  const { ni } = setup(store, plugin, () => ({ error: 'the import stopped responding' }));
  await ni.importInbox();
  assert.equal(plugin.inbox.length, 1);
  assert.deepEqual((await store.listImportFiles(SHARE_JOB)).map((r) => r.status), ['reading']);
});

test('imports wait for a running import and never run during a ride', async (t) => {
  const store = await openStore(t);
  const plugin = fakePlugin({ inbox: [{ uri: 'file:///inbox/1-0/a.fit', name: 'a.fit', bytes: bytes('aaa') }] });
  const { app, ni } = setup(store, plugin);
  app.isPlaying = true;
  const p = ni.importInbox();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(app.runs.length, 0, 'waits while riding');
  app.isPlaying = false;
  await p;
  assert.equal(app.runs.length, 1);
});

test('watched folder: a big first scan runs in batches, so a kill costs only the batch being read, with one toast', async (t) => {
  const store = await openStore(t);
  const was = NativeImport.BATCH;
  NativeImport.BATCH = 2;
  t.after(() => { NativeImport.BATCH = was; });
  const plugin = fakePlugin({ folder: ['a', 'b', 'c', 'd', 'e'].map((n) => ({ path: `${n}.fit`, bytes: bytes(n) })) });
  let run = 0;
  const { app, ni } = setup(store, plugin, () => (++run === 2 ? { error: 'the import stopped responding' } : {}));
  await ni.scanFolder();
  assert.deepEqual(app.runs.map((r) => r.names), [['a.fit', 'b.fit'], ['c.fit', 'd.fit']], 'stops at the failed batch');
  assert.ok(app.runs.every((r) => r.opts.quiet));
  const status = async () => Object.fromEntries((await store.listImportFiles(WATCH_JOB)).map((r) => [r.path.split('|')[0], r.status]));
  assert.deepEqual(await status(), { 'a.fit': 'imported', 'b.fit': 'imported', 'c.fit': 'reading', 'd.fit': 'reading' }, 'e.fit was never started');
  assert.equal(app.toasts.length, 1);
  assert.match(app.toasts[0].msg, /^Rides: 2 rides imported from 5 new files, 0 duplicates\. Stopped: the import stopped responding\.$/);
  await ni.scanFolder();
  assert.deepEqual(app.runs.slice(2).map((r) => r.names), [['c.fit', 'd.fit'], ['e.fit']]);
  assert.deepEqual(await status(), { 'a.fit': 'imported', 'b.fit': 'imported', 'c.fit': 'imported', 'd.fit': 'imported', 'e.fit': 'imported' });
  assert.equal((await store.getImportJob(WATCH_JOB)).done, 5);
});
