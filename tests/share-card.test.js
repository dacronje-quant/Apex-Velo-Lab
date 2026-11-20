const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');

const Card = require('../js/velo-share-card.js');

/** 1 Hz samples from [seconds, target, power] blocks, with HR drifting up through the efforts. */
function build(blocks, { targets = true } = {}) {
  const samples = [];
  let hr = 110;
  for (const [secs, target, power] of blocks) {
    for (let i = 0; i < secs; i++) {
      hr += power > 200 ? 0.15 : -0.08;
      samples.push({ time: samples.length, power, cadence: 92, hr: Math.round(hr), target: targets ? target : null });
    }
  }
  return samples;
}
const ride = (title, samples, extra = {}) => ({ id: 'ride_card_test', date: '2026-11-15T14:53:57Z', title, duration: samples.length, distanceKm: 20.4,
  avgWatts: 151, maxWatts: 313, np: 177, tss: 56, if: '0.86', kj: 407, avgHr: 136, maxHr: 162, avgCadence: 94, maxCadence: 108, ftpAtRide: 206, samples, ...extra });

const fourByFour = () => {
  const b = [[600, 130, 130]];
  for (let k = 0; k < 4; k++) { b.push([240, 240, 220 + (k === 0 ? 12 : 0)]); b.push([180, 110, 110]); }
  b.push([300, 105, 105]);
  return b;
};

test('4x4: four 4-minute intervals with their power and heart-rate peaks', () => {
  const A = Card.analyse(ride('4x4 Minute VO2max Intervals', build(fourByFour())));
  assert.equal(A.intervals.length, 4);
  assert.deepEqual(A.intervals.map(x => x.seconds), [240, 240, 240, 240]);
  assert.deepEqual(A.intervals.map(x => x.avgPower), [232, 220, 220, 220]);
  assert.equal(A.best.i, 0);
  assert.equal(A.sets.length, 1);
  assert.equal(A.medLen, 240);
  assert.equal(A.medRec, 180);
  assert.equal(A.intervalAvg, 223);
  assert.ok(A.intervals.every((x, i) => i === 0 || x.peakHr > A.intervals[i - 1].peakHr), 'HR peaks rise interval by interval');
  assert.deepEqual(Card.subtitle(A), { bold: '4 × 4 min', rest: ' · 4 min on / 3 min off · 223 W average on the efforts' });
  assert.deepEqual(Card.titleParts(A.title), { before: '', token: '4×4', unit: 'min', after: 'VO2max Intervals' });
});

test('30/15: a lone opener is warm-up, the repeats split into two sets of ten', () => {
  const b = [[480, 130, 130], [30, 250, 300], [180, 110, 110]];
  for (let set = 0; set < 2; set++) {
    for (let k = 0; k < 10; k++) { b.push([30, 250, 250 + set * 4 + k]); b.push([15, 105, 105]); }
    b.push([300, 110, 110]);
  }
  const A = Card.analyse(ride('Rønnestad 30/15 Microbursts', build(b)));
  assert.equal(A.intervals.length, 20);
  assert.deepEqual(A.sets.map(s => s.length), [10, 10]);
  assert.equal(A.medLen, 30);
  assert.equal(A.medRec, 15);
  assert.equal(A.best.avgPower, 263);
  assert.equal(Card.subtitle(A).bold, '2 sets × 10');
  assert.equal(Card.titleParts(A.title).token, '30/15');
});

test('a ride without targets shows best efforts instead of intervals', () => {
  const samples = build(fourByFour(), { targets: false });
  const A = Card.analyse(ride('Endurance Ride', samples));
  assert.equal(A.intervals.length, 0);
  assert.deepEqual(A.bests.map(b => b.label), ['5 s', '1 min', '5 min', '20 min']);
  assert.equal(A.bests[0].watts, 232);
  assert.equal(Card.subtitle(A).bold, Card.fmtTime(samples.length));
  assert.deepEqual(Card.titleParts('Endurance Ride'), { before: 'Endurance Ride', token: '', unit: '', after: '' });
});

test('leading zero power and missing HR are filled, not drawn as cliffs', () => {
  const samples = build([[400, 150, 150]]);
  samples.slice(0, 5).forEach(s => { s.power = 0; s.hr = null; });
  const A = Card.analyse(ride('Ride', samples));
  assert.equal(A.series.power[0], 150);
  assert.equal(A.series.hr[0], samples[5].hr);
});

test('file names are safe and cards need a recorded power stream', () => {
  assert.equal(Card.fileName(ride('Rønnestad 30/15 Microbursts!', []), 'minimal'), 'apex-velo-2026-11-15-rnnestad-3015-microbursts-minimal.jpg');
  assert.equal(Card.fileName({ title: '' }, 'full').endsWith('-ride.jpg'), true);
  assert.equal(Card.canRender(ride('Summary only', [])), false);
  assert.equal(Card.canRender(ride('Zero power', build([[60, 100, 0]]))), false);
  assert.equal(Card.canRender(ride('Real', build([[60, 100, 150]]))), true);
  assert.match(Card.fmtTime(3725), /^1:02:05$/);
});

test('the card module is pure ASCII so any server charset renders its symbols', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'velo-share-card.js'));
  assert.ok(src.every(b => b < 128));
});

// ------------------------------------------------------------- phone upload --
const ctx = vm.createContext({ window: { addEventListener() {} }, navigator: {}, AbortController, setTimeout, clearTimeout });
for (const file of ['velo-metrics', 'velo-export', 'app', 'app-remote']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file + '.js'), 'utf8'), ctx);
}
const App = vm.runInContext('VeloApp', ctx);
const plain = (v) => JSON.parse(JSON.stringify(v)); // arrays made inside the vm sandbox are another realm's

test('finished rides publish both card styles to the phone and resend after a server restart', async () => {
  const png = new Uint8Array([255, 216, 255, 224, 1, 2, 3]);
  ctx.window.VeloShareCard = { STYLES: ['full', 'minimal'], canRender: () => true, fileName: (r, s) => `card-${s}.jpg`,
    toBlob: async () => ({ arrayBuffer: async () => png.buffer }) };
  const app = Object.assign(Object.create(App.prototype), { _remoteEnabled: true, publishSoon() {} });
  await app.preparePhoneCards({ id: 'ride_card_test', samples: [] });
  assert.deepEqual(plain(app._remoteCardUploads.items.map(i => i.style)), ['full', 'minimal']);
  const posted = [];
  ctx.fetch = async (url) => { posted.push(url); if (posted.length === 1) throw new Error('Wi-Fi'); return { ok: true }; };
  await app.publishPhoneCards();
  assert.deepEqual(plain(app._remoteCardUploads.items.map(i => i.ready)), [false, true]);
  assert.match(posted[1], /^api\/live\/card\?id=ride_card_test&style=minimal&filename=card-minimal\.jpg$/);
  app._remoteCardUploads.items[0].retryAt = 0;
  await app.publishPhoneCards();
  assert.ok(app._remoteCardUploads.items.every(i => i.ready));
  // A restarted server no longer holds the cards: mark them for upload again.
  app.buildRemoteSnapshot = () => ({ state: 'finished' });
  ctx.fetch = async () => ({ ok: true, json: async () => ({ cmds: [], fitId: null, cards: { id: 'ride_card_test', styles: ['full'] } }) });
  await app.publishRemoteSnapshot();
  assert.deepEqual(plain(app._remoteCardUploads.items.map(i => i.ready)), [true, false]);
  ctx.window.VeloShareCard = { canRender: () => false };
  await app.preparePhoneCards({ id: 'summary_only' });
  assert.equal(app._remoteCardUploads, null);
});

// ------------------------------------------------------------------ servers --
async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const pwsh = [process.env.PWSH, 'pwsh', 'powershell'].filter(Boolean).find(exe => spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', windowsHide: true }).status === 0);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(120, 9)]);

for (const kind of ['node', 'powershell']) {
  test(`${kind} server hands the ride's share cards to the phone`, { skip: kind === 'powershell' && !pwsh }, async t => {
    const tempRoot = path.resolve(os.tmpdir());
    const dir = fs.mkdtempSync(path.join(tempRoot, 'apex-share-card-'));
    const port = await freePort();
    const entry = kind === 'node' ? 'server.js' : 'start_server.ps1';
    fs.copyFileSync(path.join(__dirname, '..', entry), path.join(dir, entry));
    fs.writeFileSync(path.join(dir, '.env'), `APEX_PORT=${port}\n`);
    const child = spawn(kind === 'node' ? process.execPath : pwsh,
      kind === 'node' ? [path.join(dir, entry)] : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, entry)],
      { cwd: dir, windowsHide: true, env: { ...process.env, APEX_NO_BROWSER: '1', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    t.after(async () => {
      if (child.exitCode === null) {
        const stopped = new Promise(resolve => child.once('exit', resolve));
        child.kill();
        await stopped;
      }
      assert.equal(path.dirname(path.resolve(dir)), tempRoot);
      assert.ok(path.basename(dir).startsWith('apex-share-card-'));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const base = `http://localhost:${port}`;
    let up = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { if ((await fetch(base + '/api/live')).ok) { up = true; break; } } catch {}
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(up, output);
    const url = (style, id = 'ride_card_test', name = `card-${style}.jpg`) => `${base}/api/live/card?id=${id}&style=${style}&filename=${name}`;
    const upload = (u, body = JPG, headers = {}) => fetch(u, { method: 'POST', body, headers: { 'Content-Type': 'image/jpeg', ...headers } });
    assert.equal((await fetch(url('full'))).status, 404);
    assert.equal((await upload(url('full'), Buffer.from('not an image, just some text that is long enough to pass the size floor of the check'))).status, 400);
    assert.equal((await upload(url('full'), PNG)).status, 400); // PNG bytes under a .jpg name
    assert.equal((await upload(url('full', 'ride_card_test', 'card-full.gif'))).status, 400);
    assert.equal((await upload(url('poster'))).status, 400);
    assert.equal((await upload(url('full', 'ride_card_test', '../x.jpg'))).status, 400);
    assert.equal((await upload(url('full'), JPG, { Origin: `http://192.168.1.2:${port}` })).status, 403);
    const before = await (await fetch(base + '/api/live')).json();
    assert.equal(before.cards, null);
    const notified = fetch(`${base}/api/live?after=${before.seq}`).then(r => r.json());
    assert.equal((await upload(url('full'))).status, 200);
    assert.deepEqual((await notified).cards, { id: 'ride_card_test', styles: ['full'] });
    assert.equal((await upload(url('minimal', 'ride_card_test', 'card-minimal.png'), PNG)).status, 200);
    const got = await fetch(`${base}/api/live/card?id=ride_card_test&style=minimal`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.match(got.headers.get('content-disposition'), /^inline; filename="card-minimal\.png"$/);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
    const dl = await fetch(`${base}/api/live/card?id=ride_card_test&style=full&download=1`);
    assert.equal(dl.headers.get('content-type'), 'image/jpeg');
    assert.match(dl.headers.get('content-disposition'), /^attachment; filename="card-full\.jpg"$/);
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), JPG);
    const published = await (await fetch(base + '/api/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'finished', cmdAck: 0 }) })).json();
    assert.deepEqual(published.cards, { id: 'ride_card_test', styles: ['full', 'minimal'] });
    // A new ride replaces the previous ride's cards.
    assert.equal((await upload(url('full', 'ride_next'))).status, 200);
    assert.equal((await fetch(`${base}/api/live/card?id=ride_card_test&style=minimal`)).status, 404);
    assert.deepEqual((await (await fetch(base + '/api/live')).json()).cards, { id: 'ride_next', styles: ['full'] });
  });
}
