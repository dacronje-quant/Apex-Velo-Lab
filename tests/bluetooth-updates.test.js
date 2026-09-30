const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const storage = new Map();
  const ctx = vm.createContext({
    window: { addEventListener() {} }, navigator: { bluetooth: {} },
    localStorage: { getItem: k => storage.get(k) || null, setItem: (k,v) => storage.set(k,v) },
    performance: { now: () => 10000 }, console: { warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
  });
  for (const file of ['velo-metrics', 'velo-ble', 'app', 'app-devices', 'app-remote']) vm.runInContext(fs.readFileSync(`js/${file}.js`, 'utf8'), ctx);
  const Ble = vm.runInContext('VeloBle', ctx), App = vm.runInContext('VeloApp', ctx);
  Ble.delay = async () => {};
  const events = [], ble = new Ble(e => events.push(e));
  return { ctx, Ble, App, ble, events, storage };
}
function device(id, server = {}) {
  const listeners = new Map();
  const d = { id, name: id, addEventListener(e,h) { listeners.set(e,h); }, removeEventListener(e,h) { if (listeners.get(e) === h) listeners.delete(e); }, listeners };
  d.gatt = { connected: false, async connect() { this.connected = true; return server; }, disconnect() { this.connected = false; listeners.get('gattserverdisconnected')?.(); } };
  return d;
}
function link(f, kind, d = device(kind), chars = { control: {}, measurement: {} }) {
  f.ble._adopt(kind, d); d.gatt.connected = true;
  Object.assign(f.ble.slots[kind], { state: 'connected', manualDisconnect: false, chars });
  f.ble._remember(kind,d); return d;
}
function appFixture(f) {
  const app = Object.create(f.App.prototype);
  Object.assign(app, { ble: f.ble, powerSourcePreference: 'auto', cadenceSourcePreference: 'auto',
    blePedal: { watts: 220, cadence: 91, lastTime: 9999, leftPct: 48 },
    bleTrainer: { watts: 200, cadence: 88, lastTime: 9999 }, bleHr: { hr: 150, lastTime: 9999 },
    activeProfile: { ftp: 200, maxHr: 180 }, simulator: { enabled: true }, isPlaying: true,
    erg: { offset: 20, pedalBuf: [220], pmSettle: 4 }, powerBuffer: [220], totalElapsedSeconds: 15,
    renderDevicesPanel() {}, updatePowerSourceBadge() {}, showToast() {}, publishSoon() {}, ergApplyNow() {},
    setText() {}, $() { return null; } });
  return app;
}
const view = bytes => new DataView(Uint8Array.from(bytes).buffer);

test('cancelled replacement keeps a working device and its saved identity', async () => {
  const f = fixture(), old = link(f, 'trainer');
  f.ctx.navigator.bluetooth.requestDevice = async () => { throw Object.assign(new Error('User cancelled'), { name: 'NotFoundError' }); };
  await assert.rejects(f.ble.connectTrainer());
  assert.equal(f.ble.slots.trainer.device, old);
  assert.equal(f.ble.isTrainerConnected(), true);
  assert.equal(f.ble.getState('trainer'), 'connected');
  assert.equal(f.ble._knownIds().trainer.id, old.id);
});
test('duplicate physical device is rejected without disrupting either assignment', async () => {
  const f = fixture(), old = link(f, 'pedals'), trainer = link(f, 'trainer');
  f.ctx.navigator.bluetooth.requestDevice = async () => trainer;
  await assert.rejects(f.ble.connectPedals(), /already assigned/);
  assert.equal(f.ble.slots.pedals.device, old);
  assert.equal(f.ble.isPedalsConnected(), true);
  assert.equal(f.ble.isTrainerConnected(), true);
});
test('a failed replacement restores the previous saved device for reconnect', async () => {
  const f = fixture(), old = link(f, 'hr');
  const bad = device('bad'); bad.gatt.connect = async () => { throw new Error('Unsupported service'); };
  f.ctx.navigator.bluetooth.requestDevice = async () => bad;
  assert.equal(await f.ble.connectHr(), false);
  assert.equal(f.ble.slots.hr.device, old);
  assert.equal(f.ble._knownIds().hr.id, old.id);
  assert.equal(f.ble.canReconnect('hr'), true);
  assert.match(f.ble.slots.hr.lastError.message, /previous device/);
  assert.equal(bad.listeners.size, 0);
});
test('Stop during the chooser rejects a late selection and prevents connection', async () => {
  const f = fixture(); let select;
  f.ctx.navigator.bluetooth.requestDevice = () => new Promise(r => { select = r; });
  const result = f.ble.connectFan();
  f.ble.disconnectFan(); select(device('fan'));
  await assert.rejects(result, /cancelled/);
  assert.equal(f.ble.getState('fan'), 'disconnected');
  assert.equal(f.ble.slots.fan.device, null);
});
test('Stop during GATT setup cannot publish connected or leave notification listeners', async () => {
  const f = fixture(), d = device('hr'); f.ble._adopt('hr',d);
  let unblock, started; const setupStarted = new Promise(r => { started = r; });
  const result = f.ble._connect('hr', async () => { started(); await new Promise(r => { unblock = r; }); f.ble._listen('hr',d,'test',() => {}); });
  await setupStarted; f.ble.disconnectHr(); unblock();
  assert.equal(await result, false);
  assert.equal(f.ble.getState('hr'), 'disconnected');
  assert.equal(f.ble.slots.hr.listeners.length, 0);
  assert.equal(d.gatt.connected, false);
  assert.equal(f.events.some(e => e.state === 'connected'), false);
});
test('saved setup connects sequentially; Stop discards remaining devices', async () => {
  const f = fixture(), app = appFixture(f); const order = []; let finish, started;
  const connectionStarted = new Promise(r => { started = r; });
  for (const kind of Object.keys(f.ble.slots)) f.ble._adopt(kind,device(kind));
  f.ble.refreshPermitted = async () => ({});
  app._devicesBatchToken = 0;
  app.connectSavedDevice = async kind => { order.push(kind); f.ble.slots[kind].state = 'connecting'; await new Promise(r => { finish = r; started(); }); };
  const result = app.connectSavedDevices(); await connectionStarted;
  app.stopDeviceConnections(); finish(); await result;
  assert.deepEqual(order, ['trainer']); assert.equal(app._devicesConnectingAll, false);
  assert.equal(f.ble.getState('trainer'), 'disconnected');
});
test('HEADWIND setup validates notifications but sends no airflow commands', async () => {
  const f = fixture(), writes = [];
  const c = device('characteristic'); c.properties = { write: true }; c.startNotifications = async () => c; c.writeValueWithResponse = async bytes => writes.push([...bytes]);
  await f.ble._setupFan({ getPrimaryService: async id => { assert.equal(id,f.Ble.UUID.HEADWIND); return { getCharacteristic: async id => { assert.equal(id,f.Ble.UUID.HEADWIND_CONTROL); return c; } }; } });
  assert.deepEqual(writes, []);
  c.listeners.get('characteristicvaluechanged')({ target: { value: view([0xFD,1,75,4]) } });
  assert.equal(f.ble.slots.fan.fanSpeed,75);
  c.listeners.get('characteristicvaluechanged')({ target: { value: view([0xFD,1,200,4]) } });
  assert.equal(f.ble.slots.fan.fanSpeed,75);
});
test('Stop while saved permissions load prevents a delayed device adoption', async () => {
  const f = fixture(), d = device('hr'); let finish;
  f.ble.refreshPermitted = () => new Promise(r => { finish = r; });
  const result = f.ble.reconnect('hr'); f.ble.disconnectHr(); finish({hr:d});
  assert.equal(await result,false); assert.equal(f.ble.slots.hr.device,null); assert.equal(d.gatt.connected,false);
});
test('setup errors after Stop still remove late notification listeners', async () => {
  const f = fixture(), d = device('hr'); f.ble._adopt('hr',d);
  let unblock, started; const setupStarted = new Promise(r => { started = r; });
  const result = f.ble._connect('hr', async () => { started(); await new Promise(r => { unblock = r; }); f.ble._listen('hr',d,'test',()=>{}); throw new Error('Disconnected during setup'); });
  await setupStarted; f.ble.disconnectHr(); unblock();
  assert.equal(await result,false); assert.equal(f.ble.slots.hr.listeners.length,0); assert.equal(d.listeners.has('test'),false);
});
test('HEADWIND parser rejects unrelated, truncated and out-of-range responses', () => {
  const f = fixture();
  for (const b of [[],[0xFD,1,20],[0xFD,2,20,4],[0xFD,1,101,4],[0xFD,1,20,3],[0xFD,1,20,4,0]]) assert.equal(f.Ble.parseFanResponse(view(b)),null);
  assert.equal(f.Ble.parseFanResponse(view([0xFD,1,0,4])),0);
});
test('fan commands serialize manual activation and speed; Off sends only Off', async () => {
  const f = fixture(), writes = [];
  const c = { properties: { writeWithoutResponse: true }, async writeValueWithoutResponse(b) { writes.push([...b]); } };
  link(f,'fan',device('fan'),{ control:c });
  await Promise.all([f.ble.setFanSpeed(25),f.ble.setFanSpeed(75),f.ble.setFanSpeed(0)]);
  assert.deepEqual(writes,[[4,4,1],[2,25],[4,4,1],[2,75],[2,0]]);
  assert.equal(f.ble.slots.fan.requestedSpeed,0);
  assert.equal(f.ble.slots.fan.fanSpeed,null); // a sent command is not confirmed airflow
});
test('failed or cancelled writes never claim requested or confirmed airflow', async () => {
  const f = fixture(); let stop;
  link(f,'fan',device('fan'),{control:{ async writeValueWithResponse() { await new Promise(r => { stop = r; }); } }});
  const result = f.ble.setFanSpeed(50); await Promise.resolve();
  f.ble.disconnectFan(); stop();
  await assert.rejects(result,/disconnected/);
  assert.equal(f.ble.slots.fan.requestedSpeed,null);
  assert.equal(f.ble.slots.fan.fanSpeed,null);
});
test('power and cadence selections are independent and never silently fall back', () => {
  const f = fixture(), app = appFixture(f);
  app.powerSourcePreference = 'trainer';
  assert.equal(app.devicePowerFresh().pedals,false);
  assert.equal(app.deviceCadenceReading(),91);
  app.cadenceSourcePreference = 'trainer'; app.bleTrainer.lastTime = 0;
  assert.equal(app.devicePowerFresh().trainer,false);
  assert.equal(app.deviceCadenceReading(),null);
  app.cadenceSourcePreference = 'auto'; assert.equal(app.deviceCadenceReading(),91);
});
test('a hung fan write times out and cannot block commands after reconnect', async () => {
  const f = fixture(); f.Ble.FAN_WRITE_TIMEOUT_MS = 5;
  link(f,'fan',device('fan'),{control:{writeValueWithResponse:()=>new Promise(()=>{})}});
  await assert.rejects(f.ble.setFanSpeed(50),/timed out/);
  assert.equal(f.ble.isFanConnected(),false); assert.equal(f.ble.slots.fan.requestedSpeed,null);
  const writes=[];
  link(f,'fan',device('fan'),{control:{writeValueWithResponse:async b=>writes.push([...b])}});
  assert.equal(await f.ble.setFanSpeed(0),0); assert.deepEqual(writes,[[2,0]]);
});
test('changing sources clears averaging and PowerMatch memory and records ride time', () => {
  const f = fixture(), app = appFixture(f); app.setDeviceSource('power','trainer');
  assert.equal(app.powerBuffer.length,0); assert.equal(app.erg.offset,0); assert.equal(app.erg.pedalBuf.length,0);
  assert.equal(app._deviceSourceChanges[0].seconds,15);
  assert.equal(JSON.parse(f.storage.get('apex_device_sources')).power,'trainer');
});
test('automatic fan cooling holds on stale data or pause and never uses simulator data', () => {
  const f = fixture(), app = appFixture(f); link(f,'fan'); const speeds = [];
  app.fanMode = 'power'; app.setFanAirflow = v => speeds.push(v);
  app.blePedal.lastTime = app.bleTrainer.lastTime = 0; app.updateFanAutomatic(); assert.deepEqual(speeds,[]);
  app.bleTrainer.lastTime = 9999; app.isPlaying = false; app.updateFanAutomatic(); assert.deepEqual(speeds,[]);
  app.isPlaying = true; app.updateFanAutomatic(); assert.equal(speeds.length,1);
  assert.equal(speeds[0],80);
});
test('manual fan command exits automatic mode; automatic failure stops repeat writes', async () => {
  const f = fixture(), app = appFixture(f); link(f,'fan',device('fan'),{ control:{ async writeValueWithResponse() {} } });
  app.fanMode = 'hr'; await app.setFanAirflow(25); assert.equal(app.fanMode,'manual');
  app.fanMode = 'power'; f.ble.setFanSpeed = async () => { throw new Error('Write failed'); };
  assert.equal(await app.setFanAirflow(50,{automatic:true}),false); assert.equal(app.fanMode,'manual');
});
test('fan connection preserves simulator; trainer control grant is separate from link state', () => {
  const f = fixture(), app = appFixture(f); app.onHardwareConnected('fan'); assert.equal(app.simulator.enabled,true);
  f.ble._onFtmsControlResponse(view([0x80,0,1])); assert.equal(f.ble.slots.trainer.controlGranted,true);
  f.ble._onFtmsControlResponse(view([0x80,0,4])); assert.equal(f.ble.slots.trainer.controlGranted,false);
});
test('aliases survive reconnect and Forget removes only Apex assignment', () => {
  const f = fixture(), d = link(f,'hr'); f.ble.rename('hr','My strap'); f.ble._remember('hr',d);
  assert.equal(f.ble.getDiagnostics('hr').alias,'My strap'); f.ble.forget('hr');
  assert.equal(f.ble.canReconnect('hr'),false); assert.equal(f.ble._knownIds().hr,undefined);
  assert.equal(d.listeners.size,0);
});
test('phone fan commands are constrained and both server allowlists agree', () => {
  const f = fixture(), app = appFixture(f); const commands = []; link(f,'fan');
  app.setFanAirflow = v => commands.push(v);
  app.applyRemoteCommand('fan-50'); app.applyRemoteCommand('fan-999'); app.applyRemoteCommand('fan-mode-hr');
  assert.deepEqual(commands,[50]); assert.equal(app.fanMode,'hr');
  for (const file of ['server.js','start_server.ps1']) {
    const source = fs.readFileSync(file,'utf8');
    for (const cmd of ['connect-fan','disconnect-fan','connect-stop','fan-0','fan-25','fan-50','fan-75','fan-100','fan-mode-manual','fan-mode-hr','fan-mode-power']) assert.ok(source.includes(`'${cmd}'`),`${file}: ${cmd}`);
  }
});
