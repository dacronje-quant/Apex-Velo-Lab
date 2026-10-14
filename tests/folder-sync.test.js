const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');

function fixture({ files = ['a_cycling.fit', 'b_cycling.fit'], accept = true, backupFails = false } = {}) {
  const calls = [], toasts = [];
  const handle = { name: 'HealthFit <b>', async *values() { for (const name of files) yield { kind: 'file', name, async getFile() { return { async arrayBuffer() { return name; } }; } }; } };
  const ctx = vm.createContext({
    console, confirm: (msg) => { calls.push(['confirm', msg]); return accept; },
    document: { getElementById: () => null },
    VeloRideImporter: { parseFit: (buf) => ({ id: 'new_' + buf, title: '', samples: [] }) },
    VeloDB: { async applyRideChanges(put, del, opts) { calls.push(['apply', put.map(r => r.id), del, opts]); return true; } },
    VeloStorage: { enabled: true, async request(url) { calls.push(['backup', url]); if (backupFails) throw new Error('disk full'); return { ok: true }; } },
  });
  ctx.window = ctx; ctx.window.showDirectoryPicker = async () => handle;
  vm.runInContext(fs.readFileSync('js/velo-folder-sync.js', 'utf8'), ctx);
  const app = { completedWorkouts: [{ id: 'old1' }, { id: 'old2' }], activeProfile: { name: 'R', ftp: 200 },
    showToast: (m) => toasts.push(m), async saveHistory() { calls.push(['saveHistory']); },
    renderHistoryTable() {}, recalculatePmc() {}, renderCalendarView() {}, updateMmpChart() {}, updateHeroStats() {} };
  return { sync: new ctx.VeloFolderSync(app), app, calls, toasts };
}

test('replace from folder asks first, saves a restore point, then replaces in one change', async () => {
  const f = fixture();
  await f.sync.connectFolder(true);
  assert.deepEqual(f.calls.map(c => c[0]), ['confirm', 'backup', 'apply', 'saveHistory']);
  assert.match(f.calls[0][1], /Replace all 2 rides .* with the 2 rides/s);
  assert.deepEqual([...f.calls[2][1]], ['new_a_cycling.fit', 'new_b_cycling.fit']);
  assert.deepEqual([...f.calls[2][2]], ['old1', 'old2']);
  assert.deepEqual([...f.app.completedWorkouts].map(r => r.id), ['new_a_cycling.fit', 'new_b_cycling.fit']);
});

test('declining, an empty folder or a failed restore point leaves history untouched', async () => {
  for (const opts of [{ accept: false }, { files: [] }, { backupFails: true }]) {
    const f = fixture(opts);
    await f.sync.connectFolder(true);
    assert.equal(f.calls.some(c => c[0] === 'apply' || c[0] === 'saveHistory'), false, JSON.stringify(opts));
    assert.deepEqual([...f.app.completedWorkouts].map(r => r.id), ['old1', 'old2']);
  }
});

test('the normal folder import only adds rides', async () => {
  const f = fixture();
  await f.sync.connectFolder(false);
  assert.equal(f.calls.some(c => c[0] === 'confirm' || c[0] === 'apply'), false);
  assert.deepEqual([...f.app.completedWorkouts].map(r => r.id), ['new_b_cycling.fit', 'new_a_cycling.fit', 'old1', 'old2']);
});
