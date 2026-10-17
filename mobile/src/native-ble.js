/**
 * Web Bluetooth (navigator.bluetooth) on top of the native Capacitor BLE plugin.
 *
 * Android's WebView has no Web Bluetooth, but js/velo-ble.js is written against it and holds all the
 * trainer, power-meter, heart-rate and fan logic (FTMS ERG, CPS, reconnects). This shim gives it the
 * subset of the API it uses, so that logic runs unchanged:
 *   navigator.bluetooth.requestDevice / getDevices / getAvailability
 *   BluetoothDevice: id, name, gatt, 'gattserverdisconnected'
 *   gatt: connect, disconnect, connected, getPrimaryService
 *   service.getCharacteristic; characteristic: properties, value, readValue, writeValue*,
 *   start/stopNotifications, 'characteristicvaluechanged'
 * watchAdvertisements is left out on purpose: velo-ble then treats RSSI as unavailable.
 *
 * `ble` is any object with the BleClient API (@capacitor-community/bluetooth-le), so tests can pass a fake.
 */

const BASE = '-0000-1000-8000-00805f9b34fb';
const ALIASES = {
  fitness_machine: 0x1826, cycling_power: 0x1818, heart_rate: 0x180d, battery_service: 0x180f,
  device_information: 0x180a, generic_access: 0x1800, cycling_speed_and_cadence: 0x1816
};
const DEVICES_KEY = 'apexNativeBleDevices';

export function canonicalUuid(u) {
  if (typeof u === 'number') return '0000' + u.toString(16).padStart(4, '0') + BASE;
  const s = String(u || '').trim().toLowerCase();
  if (ALIASES[s] !== undefined) return canonicalUuid(ALIASES[s]);
  if (/^(0x)?[0-9a-f]{4}$/.test(s)) return canonicalUuid(parseInt(s.replace(/^0x/, ''), 16));
  if (/^[0-9a-f]{8}$/.test(s)) return s + BASE;
  return s;
}

const domError = (name, message) => {
  try { return new DOMException(message, name); } catch (e) { return Object.assign(new Error(message), { name }); }
};

function toDataView(bytes) {
  if (bytes instanceof DataView) return bytes;
  if (bytes instanceof ArrayBuffer) return new DataView(bytes);
  if (ArrayBuffer.isView(bytes)) return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Array.isArray(bytes)) return new DataView(Uint8Array.from(bytes).buffer);
  throw new TypeError('Bluetooth value must be an ArrayBuffer or typed array');
}

/** Web Bluetooth filter semantics: a device matches when every field of at least one filter matches. */
export function matchesFilters(options, result) {
  if (!options || options.acceptAllDevices) return true;
  const name = result.localName || (result.device && result.device.name) || '';
  const uuids = (result.uuids || []).map(canonicalUuid);
  return (options.filters || []).some((f) => {
    if (f.services && !f.services.every((s) => uuids.includes(canonicalUuid(s)))) return false;
    if (f.name !== undefined && name !== f.name) return false;
    if (f.namePrefix !== undefined && !(name && name.startsWith(f.namePrefix))) return false;
    return !!(f.services || f.name !== undefined || f.namePrefix !== undefined);
  });
}

class ShimCharacteristic extends EventTarget {
  constructor(service, raw) {
    super();
    this.service = service;
    this.uuid = canonicalUuid(raw.uuid);
    const p = raw.properties || {};
    this.properties = {
      broadcast: !!p.broadcast, read: !!p.read, writeWithoutResponse: !!p.writeWithoutResponse, write: !!p.write,
      notify: !!p.notify, indicate: !!p.indicate, authenticatedSignedWrites: !!p.authenticatedSignedWrites,
      reliableWrite: !!p.reliableWrite, writableAuxiliaries: !!p.writableAuxiliaries
    };
    this.value = null;
  }
  get _ids() { const d = this.service.device; return [d.id, this.service.uuid, this.uuid]; }
  _check() { if (!this.service.device.gatt.connected) throw domError('NetworkError', 'GATT Server is disconnected.'); }
  _changed(value) { this.value = value; this.dispatchEvent(new Event('characteristicvaluechanged')); }
  async readValue() {
    this._check();
    const v = await this.service.device._shim.ble.read(...this._ids);
    this._changed(v);
    return v;
  }
  async writeValueWithResponse(bytes) { this._check(); await this.service.device._shim.ble.write(...this._ids, toDataView(bytes)); }
  async writeValueWithoutResponse(bytes) { this._check(); await this.service.device._shim.ble.writeWithoutResponse(...this._ids, toDataView(bytes)); }
  writeValue(bytes) { return this.properties.write || !this.properties.writeWithoutResponse ? this.writeValueWithResponse(bytes) : this.writeValueWithoutResponse(bytes); }
  async startNotifications() {
    this._check();
    const gatt = this.service.device.gatt, session = gatt._session;
    await this.service.device._shim.ble.startNotifications(...this._ids, (v) => { if (gatt._session === session) this._changed(v); });
    return this;
  }
  async stopNotifications() {
    if (this.service.device.gatt.connected) await this.service.device._shim.ble.stopNotifications(...this._ids).catch(() => {});
    return this;
  }
}

class ShimService {
  constructor(device, raw) {
    this.device = device;
    this.uuid = canonicalUuid(raw.uuid);
    this.isPrimary = true;
    this._raw = raw;
    this._chars = new Map();
  }
  async getCharacteristic(uuid) {
    if (!this.device.gatt.connected) throw domError('NetworkError', 'GATT Server is disconnected.');
    const want = canonicalUuid(uuid);
    if (!this._chars.has(want)) {
      const raw = (this._raw.characteristics || []).find((c) => canonicalUuid(c.uuid) === want);
      if (!raw) throw domError('NotFoundError', `No Characteristics matching UUID ${want} found in Service.`);
      this._chars.set(want, new ShimCharacteristic(this, raw));
    }
    return this._chars.get(want);
  }
  async getCharacteristics() {
    return Promise.all((this._raw.characteristics || []).map((c) => this.getCharacteristic(c.uuid)));
  }
}

class ShimGatt {
  constructor(device) {
    this.device = device;
    this.connected = false;
    this._session = 0;
    this._services = null;
  }
  async connect() {
    const shim = this.device._shim;
    await shim.ready();
    if (this.connected) return this;
    const session = ++this._session;
    try {
      await shim.ble.connect(this.device.id, () => this._lost(session), { timeout: 15000 });
    } catch (e) {
      throw domError('NetworkError', String((e && e.message) || e || 'Connection failed'));
    }
    if (session !== this._session) {
      // disconnect() (e.g. velo-ble's connect timeout) ran while connecting: do not leave the link open.
      shim.ble.disconnect(this.device.id).catch(() => {});
      throw domError('AbortError', 'Connection attempt was cancelled.');
    }
    this.connected = true;
    this._services = null;
    return this;
  }
  disconnect() {
    if (!this.connected) { this._session++; return; }
    const session = this._session;
    this.device._shim.ble.disconnect(this.device.id).catch(() => {});
    this._lost(session);
  }
  _lost(session) {
    if (session !== this._session || !this.connected) return;
    this._session++;
    this.connected = false;
    this._services = null;
    this.device.dispatchEvent(new Event('gattserverdisconnected'));
  }
  async _loadServices() {
    if (!this.connected) throw domError('NetworkError', 'GATT Server is disconnected.');
    if (!this._services) {
      const list = await this.device._shim.ble.getServices(this.device.id);
      this._services = new Map(list.map((s) => [canonicalUuid(s.uuid), new ShimService(this.device, s)]));
    }
    return this._services;
  }
  async getPrimaryService(uuid) {
    const svc = (await this._loadServices()).get(canonicalUuid(uuid));
    if (!svc) throw domError('NotFoundError', `No Services matching UUID ${canonicalUuid(uuid)} found in Device.`);
    return svc;
  }
  async getPrimaryServices() { return [...(await this._loadServices()).values()]; }
}

class ShimDevice extends EventTarget {
  constructor(shim, id, name) {
    super();
    this._shim = shim;
    this.id = id;
    this.name = name || null;
    this.gatt = new ShimGatt(this);
  }
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class NativeBluetooth extends EventTarget {
  constructor(ble, { storage = window.localStorage, document: doc = window.document } = {}) {
    super();
    this.ble = ble;
    this.storage = storage;
    this.doc = doc;
    this.devices = new Map();
    this._ready = null;
  }

  /** Permissions (Nearby devices) and the Bluetooth switch, asked once and again after a refusal. */
  async ready() {
    if (!this._ready) {
      this._ready = this.ble.initialize({ androidNeverForLocation: true }).catch((e) => {
        this._ready = null;
        throw new Error(`Bluetooth permission is needed. Allow "Nearby devices" for Apex Velo in Android settings (${(e && e.message) || e}).`);
      });
    }
    await this._ready;
    if (await this.ble.isEnabled()) return;
    try { await this.ble.requestEnable(); } catch (e) { /* user said no */ }
    if (!(await this.ble.isEnabled())) throw new Error('Bluetooth is turned off. Turn it on and try again.');
  }

  getAvailability() { return Promise.resolve(true); }

  _device(id, name) {
    let d = this.devices.get(id);
    if (!d) { d = new ShimDevice(this, id, name); this.devices.set(id, d); }
    else if (name && !d.name) d.name = name;
    return d;
  }

  _saved() {
    try { return JSON.parse(this.storage.getItem(DEVICES_KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  _save(device) {
    const all = this._saved();
    all[device.id] = device.name || null;
    try { this.storage.setItem(DEVICES_KEY, JSON.stringify(all)); } catch (e) { /* storage unavailable */ }
  }

  /** Devices chosen in this app before, so a restart can reconnect without the chooser. */
  async getDevices() {
    return Object.entries(this._saved()).map(([id, name]) => this._device(id, name));
  }

  /** Scans and shows an in-app chooser, the counterpart of Chrome's device picker. */
  async requestDevice(options = {}) {
    if (!options.acceptAllDevices && !(options.filters && options.filters.length)) throw new TypeError('Either filters or acceptAllDevices is required');
    await this.ready();
    const doc = this.doc;
    const found = new Map();
    const overlay = doc.createElement('div');
    overlay.className = 'apex-ble-chooser';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="apex-ble-sheet">
        <div class="apex-ble-head"><strong>Choose a device</strong><span class="apex-ble-scan"><span class="apex-ble-spinner"></span>Scanning...</span></div>
        <p class="apex-ble-hint">Wake the device (pedal the trainer, wet the strap). Close Zwift or other apps that hold it.</p>
        <ul class="apex-ble-list" aria-live="polite"></ul>
        <p class="apex-ble-empty">Looking for nearby devices...</p>
        <div class="apex-ble-actions"><button type="button" class="btn btn-ghost" data-ble="cancel">Cancel</button></div>
      </div>`;
    const list = overlay.querySelector('.apex-ble-list');
    const empty = overlay.querySelector('.apex-ble-empty');
    let renderQueued = false;
    const render = () => {
      renderQueued = false;
      const rows = [...found.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
      empty.hidden = rows.length > 0;
      list.innerHTML = rows.map((r) => `<li><button type="button" class="apex-ble-item" data-ble-id="${esc(r.id)}">
          <span class="apex-ble-name">${esc(r.name || 'Unnamed device')}</span>
          <span class="apex-ble-meta">${r.rssi != null ? esc(r.rssi) + ' dBm' : ''}</span></button></li>`).join('');
    };
    const onResult = (result) => {
      if (!result || !result.device || !matchesFilters(options, result)) return;
      const id = result.device.deviceId;
      const prev = found.get(id);
      found.set(id, { id, name: result.localName || result.device.name || (prev && prev.name) || '', rssi: result.rssi ?? (prev && prev.rssi) });
      if (!renderQueued) { renderQueued = true; setTimeout(render, prev ? 400 : 0); }
    };
    doc.body.appendChild(overlay);
    let stop;
    const choice = new Promise((resolve) => {
      stop = resolve;
      overlay.addEventListener('click', (e) => {
        const item = e.target.closest('[data-ble-id]');
        if (item) return resolve(found.get(item.dataset.bleId));
        if (e.target.closest('[data-ble="cancel"]') || e.target === overlay) resolve(null);
      });
    });
    this._cancelChooser = () => stop(null);
    try {
      await this.ble.requestLEScan({ allowDuplicates: true, scanMode: 2 }, onResult);
    } catch (e) {
      overlay.remove();
      throw new Error(`Bluetooth scan failed: ${(e && e.message) || e}`);
    }
    const timer = setTimeout(() => { const s = overlay.querySelector('.apex-ble-scan'); if (s) s.textContent = 'Still scanning...'; }, 15000);
    let picked;
    try { picked = await choice; }
    finally {
      clearTimeout(timer);
      this._cancelChooser = null;
      await this.ble.stopLEScan().catch(() => {});
      overlay.remove();
    }
    if (!picked) throw domError('NotFoundError', 'User cancelled the requestDevice() chooser.');
    const device = this._device(picked.id, picked.name);
    if (picked.name) device.name = picked.name;
    this._save(device);
    return device;
  }

  /** Closes an open chooser (Android back button). */
  cancelChooser() {
    if (!this._cancelChooser) return false;
    this._cancelChooser();
    return true;
  }
}

export function installNativeBluetooth(ble, opts) {
  const bt = new NativeBluetooth(ble, opts);
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, enumerable: true, get: () => bt });
  return bt;
}
