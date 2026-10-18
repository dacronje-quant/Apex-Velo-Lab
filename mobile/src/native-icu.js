/**
 * intervals.icu wellness for the Android app: resting HR, HRV and sleep as the recovery data source.
 *
 * On the desktop, Apple Health data arrives through Health Auto Export and the PC server. The app has no
 * server, but intervals.icu already holds the same days (synced there from the watch), so the phone reads
 * them straight from intervals.icu's API with the rider's personal API key (Basic auth, user "API_KEY",
 * athlete id 0 = the key's owner). The key stays in Android app storage (Capacitor Preferences).
 *
 * toHealthDays() turns intervals.icu's one-row-per-day wellness into js/velo-health.js day records
 * ({ summary: {...} }), so readiness, the calendar strip and the recovery trends run unchanged.
 * Sleep stages come from the custom numeric wellness fields DeepSleep, LightSleep and REMSleep (seconds),
 * the codes the iPhone wellness-sync apps write; intervals.icu returns custom fields under their code.
 */

export const ICU_BASE = 'https://intervals.icu';
const KEYS = { key: 'icu_api_key', athlete: 'icu_athlete', hrvField: 'icu_hrv_field', hrvMode: 'icu_hrv_mode', lastSync: 'icu_last_sync', schema: 'icu_schema' };
/** Bumped when toHealthDays keeps more fields: the next sync reads all history again. */
export const SCHEMA = '2';
/** HRV choice in Settings: 'auto' (the column most days have), or one column for every day. */
export const HRV_MODES = ['auto', 'hrv', 'hrvSDNN'];
const TIMEOUT_MS = 30000;
/** velo-health keeps 800 days (VeloHealth.compact), so a backfill asks for no more than that. */
export const BACKFILL_DAYS = 799;
export const RECENT_DAYS = 7;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (v) => Math.round(v * 10) / 10;

export function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Which HRV column to use for every day: rMSSD ("hrv") or Apple's SDNN ("hrvSDNN"). The two are
 * different scales, so one field is used throughout, or the baselines would mix them. The field with
 * more days wins; rMSSD on a tie.
 */
export function pickHrvField(rows) {
  let rmssd = 0, sdnn = 0;
  for (const r of rows || []) {
    if (num(r && r.hrv) > 0) rmssd++;
    if (num(r && r.hrvSDNN) > 0) sdnn++;
  }
  if (!rmssd && !sdnn) return null;
  return sdnn > rmssd ? 'hrvSDNN' : 'hrv';
}

/**
 * The other wellness fields kept for Analytics > Health (js/velo-wellness.js): store key, intervals.icu
 * field, plausible range and decimals. A value outside its range is dropped, never clamped.
 */
const EXTRA = [
  ['sleepHr', 'avgSleepingHR', 25, 150, 0],
  ['hrvRmssd', 'hrv', 1, 300, 0],
  ['hrvSdnn', 'hrvSDNN', 1, 300, 0],
  ['sleepScore', 'sleepScore', 0, 100, 0],
  ['icuReadiness', 'readiness', 0, 100, 0],
  ['baevsky', 'baevskySI', 0, 3000, 2],
  ['resp', 'respiration', 4, 60, 1],
  ['spo2', 'spO2', 50, 100, 1],
  ['weight', 'weight', 20, 300, 1],
  ['bodyFat', 'bodyFat', 2, 70, 1],
  ['vo2max', 'vo2max', 10, 100, 1],
  ['steps', 'steps', 0, 200000, 0],
  ['bpSys', 'systolic', 60, 260, 0],
  ['bpDia', 'diastolic', 30, 160, 0],
  ['glucose', 'bloodGlucose', 1, 40, 1],
  ['kcalIn', 'kcalConsumed', 1, 20000, 0]
];

/** intervals.icu wellness rows -> { 'YYYY-MM-DD': { summary } } for days with resting HR, HRV or sleep. */
export function toHealthDays(rows, hrvField = 'hrv') {
  const days = {};
  for (const r of rows || []) {
    const day = r && typeof r.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.id) ? r.id : null;
    if (!day) continue;
    const rhrV = num(r.restingHR), hrvV = num(r[hrvField]);
    const rhr = rhrV !== null && rhrV >= 25 && rhrV <= 130 ? Math.round(rhrV) : null;
    const hrv = hrvV !== null && hrvV > 0 && hrvV <= 300 ? Math.round(hrvV) : null;
    const hours = (v, max) => { const n = num(v); return n !== null && n > 0 && n <= max * 3600 ? round1(n / 3600) : null; };
    const sleepH = hours(r.sleepSecs, 20);
    if (rhr === null && hrv === null && sleepH === null) continue;
    const stages = sleepH !== null ? { deepH: hours(r.DeepSleep, 16), remH: hours(r.REMSleep, 16), coreH: hours(r.LightSleep, 16) } : { deepH: null, remH: null, coreH: null };
    const summary = { rhr, hrv, sleepH, ...stages, awakeH: null, rhrSrc: 'icu', hrvSrc: 'icu', hrvKind: hrvField === 'hrvSDNN' ? 'sdnn' : 'rmssd' };
    for (const [key, field, lo, hi, dec] of EXTRA) {
      const v = num(r[field]);
      if (v !== null && v >= lo && v <= hi) summary[key] = dec ? Math.round(v * 10 ** dec) / 10 ** dec : Math.round(v);
    }
    days[day] = { summary, src: 'icu' };
  }
  return days;
}

/** http.request (CapacitorHttp) -> { status, data }; prefs: { get, set, remove }. */
export class NativeIcu {
  constructor({ http, prefs, base = ICU_BASE, now = () => Date.now() }) {
    Object.assign(this, { http, prefs, base, now });
  }

  _auth(key) { return 'Basic ' + btoa('API_KEY:' + key); }

  async _get(key, path) {
    const r = await this.http.request({ url: `${this.base}/api/v1/athlete/0${path}`, method: 'GET', headers: { Authorization: this._auth(key), Accept: 'application/json' }, readTimeout: TIMEOUT_MS, connectTimeout: TIMEOUT_MS });
    let data = r.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { /* not JSON */ } }
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('intervals.icu did not accept the API key. Copy it again from intervals.icu > Settings > Developer settings.'), { status: r.status });
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`intervals.icu answered ${r.status}.`), { status: r.status });
    return data;
  }

  async status() {
    const [key, athlete, last] = await Promise.all([this.prefs.get(KEYS.key), this.prefs.get(KEYS.athlete), this.prefs.get(KEYS.lastSync)]);
    let a = null;
    try { a = JSON.parse(athlete || 'null'); } catch (e) { /* ignore */ }
    const schema = await this.prefs.get(KEYS.schema);
    return { configured: !!key, athlete: a, lastSync: last ? Number(last) : null, needsBackfill: !last || schema !== SCHEMA, hrvField: await this.prefs.get(KEYS.hrvField), hrvMode: (await this.prefs.get(KEYS.hrvMode)) || 'auto' };
  }

  /** Sets the HRV column ('auto', 'hrv' = rMSSD, 'hrvSDNN'). The caller backfills again, so every day uses it. */
  async setHrvMode(mode) {
    if (!HRV_MODES.includes(mode)) throw new Error('Unknown HRV choice.');
    await this.prefs.set(KEYS.hrvMode, mode);
    if (mode === 'auto') await this.prefs.remove(KEYS.hrvField); // picked again on the next read
    else await this.prefs.set(KEYS.hrvField, mode);
  }

  /** Checks the key against intervals.icu, then keeps it. A different account starts its HRV choice afresh. */
  async setKey(key) {
    key = String(key || '').trim();
    if (!/^[A-Za-z0-9]{8,}$/.test(key)) throw new Error('The API key is the letters-and-numbers code under intervals.icu > Settings > Developer settings.');
    const me = await this._get(key, '');
    const athlete = { id: String((me && me.id) || ''), name: String((me && me.name) || '').slice(0, 80) };
    const old = (await this.status()).athlete;
    if (!old || old.id !== athlete.id) { for (const k of [KEYS.hrvField, KEYS.hrvMode, KEYS.lastSync, KEYS.schema]) await this.prefs.remove(k); }
    await this.prefs.set(KEYS.key, key);
    await this.prefs.set(KEYS.athlete, JSON.stringify(athlete));
    return athlete;
  }

  async removeKey() {
    for (const k of Object.values(KEYS)) await this.prefs.remove(k);
  }

  /**
   * Reads wellness for `days` days up to `today` and returns { days, count, hrvField }.
   * The HRV field is the one set in Settings, or (auto) chosen on the first, longest read and kept, so
   * later short reads use the same one.
   */
  async wellness(today, days) {
    const key = await this.prefs.get(KEYS.key);
    if (!key) throw new Error('Add your intervals.icu API key first.');
    const oldest = addDays(today, -days);
    const rows = await this._get(key, `/wellness?oldest=${oldest}&newest=${today}`);
    const list = Array.isArray(rows) ? rows : [];
    let field = await this.prefs.get(KEYS.hrvField);
    if (!field) {
      field = pickHrvField(list);
      if (field) await this.prefs.set(KEYS.hrvField, field);
    }
    await this.prefs.set(KEYS.lastSync, String(this.now()));
    if (days >= BACKFILL_DAYS) await this.prefs.set(KEYS.schema, SCHEMA);
    return { days: toHealthDays(list, field || 'hrv'), count: list.length, hrvField: field };
  }
}
