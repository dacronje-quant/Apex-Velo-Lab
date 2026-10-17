import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUuid, matchesFilters, NativeBluetooth } from '../src/native-ble.js';

const FTMS = '00001826-0000-1000-8000-00805f9b34fb';

test('canonicalUuid resolves Web Bluetooth names, 16-bit and 32-bit forms', () => {
  assert.equal(canonicalUuid('fitness_machine'), FTMS);
  assert.equal(canonicalUuid(0x1826), FTMS);
  assert.equal(canonicalUuid('0x1826'), FTMS);
  assert.equal(canonicalUuid('1826'), FTMS);
  assert.equal(canonicalUuid('00001826'), FTMS);
  assert.equal(canonicalUuid('A026EE0C-0A7D-4AB3-97FA-F1500F9FEB8B'), 'a026ee0c-0a7d-4ab3-97fa-f1500f9feb8b');
});

test('matchesFilters follows Web Bluetooth: any filter, every field of it', () => {
  const kickr = { device: { deviceId: '1' }, localName: 'KICKR CORE', uuids: [FTMS] };
  const strap = { device: { deviceId: '2', name: 'TICKR' }, uuids: ['0000180d-0000-1000-8000-00805f9b34fb'] };
  const trainer = { filters: [{ services: ['fitness_machine'] }, { namePrefix: 'Bike' }] };
  assert.equal(matchesFilters(trainer, kickr), true);
  assert.equal(matchesFilters(trainer, strap), false);
  assert.equal(matchesFilters({ filters: [{ namePrefix: 'TICKR' }] }, strap), true, 'device.name counts when there is no localName');
  assert.equal(matchesFilters({ filters: [{ services: [FTMS], namePrefix: 'Wahoo' }] }, kickr), false, 'all fields of one filter must match');
  assert.equal(matchesFilters({ acceptAllDevices: true }, strap), true);
  assert.equal(matchesFilters({ filters: [{}] }, strap), false, 'an empty filter matches nothing');
});

function fakeBle() {
  const calls = [];
  let onDisconnect = null;
  return {
    calls,
    drop: () => onDisconnect && onDisconnect(),
    initialize: async () => {}, isEnabled: async () => true, requestEnable: async () => {},
    connect: async (id, cb) => { calls.push(['connect', id]); onDisconnect = cb; },
    disconnect: async (id) => { calls.push(['disconnect', id]); },
    getServices: async () => [{ uuid: FTMS, characteristics: [{ uuid: '00002ad2-0000-1000-8000-00805f9b34fb', properties: { notify: true } }] }],
    startNotifications: async (id, s, c, cb) => { calls.push(['notify', c]); fakeBle.emit = cb; },
    write: async (id, s, c, v) => calls.push(['write', [...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)]]),
    writeWithoutResponse: async () => {}, read: async () => new DataView(new ArrayBuffer(1)), stopNotifications: async () => {}
  };
}

const memoryStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };

test('GATT: services, characteristics, notifications and one disconnect event per link', async () => {
  const ble = fakeBle();
  const bt = new NativeBluetooth(ble, { storage: memoryStorage(), document: null });
  const device = bt._device('AA', 'KICKR');
  let drops = 0;
  device.addEventListener('gattserverdisconnected', () => drops++);
  const server = await device.gatt.connect();
  assert.equal(device.gatt.connected, true);
  const svc = await server.getPrimaryService('fitness_machine');
  const ch = await svc.getCharacteristic(0x2ad2);
  assert.equal(ch, await svc.getCharacteristic('00002ad2-0000-1000-8000-00805f9b34fb'), 'same object for the same characteristic');
  await assert.rejects(svc.getCharacteristic(0x2ad9), { name: 'NotFoundError' });
  await assert.rejects(server.getPrimaryService('heart_rate'), { name: 'NotFoundError' });
  const values = [];
  ch.addEventListener('characteristicvaluechanged', (e) => values.push(e.target.value.getUint8(0)));
  await ch.startNotifications();
  fakeBle.emit(new DataView(Uint8Array.of(9).buffer));
  assert.deepEqual(values, [9]);
  await ch.writeValueWithResponse(Uint8Array.of(5, 200, 0));
  assert.deepEqual(ble.calls.find((c) => c[0] === 'write')[1], [5, 200, 0]);

  ble.drop();
  assert.equal(device.gatt.connected, false);
  assert.equal(drops, 1);
  fakeBle.emit(new DataView(Uint8Array.of(1).buffer));
  assert.deepEqual(values, [9], 'notifications from an old link are ignored');
  await assert.rejects(ch.writeValueWithResponse(Uint8Array.of(1)), { name: 'NetworkError' });

  await device.gatt.connect();
  device.gatt.disconnect();
  ble.drop(); // the plugin reports the same disconnect again
  assert.equal(drops, 2, 'a user disconnect fires the event once, like Chrome');
});

test('devices chosen before are offered by getDevices after a restart', async () => {
  const storage = memoryStorage();
  const first = new NativeBluetooth(fakeBle(), { storage, document: null });
  first._save(first._device('AA:BB', 'KICKR CORE'));
  const again = new NativeBluetooth(fakeBle(), { storage, document: null });
  const list = await again.getDevices();
  assert.deepEqual(list.map((d) => [d.id, d.name]), [['AA:BB', 'KICKR CORE']]);
});
