/**
 * Health Connect on Android: recovery data and rides from other apps in, rides recorded here out.
 *
 * The native side (android/.../plugins/HealthConnectPlugin.kt) reads and writes records and keeps the changes
 * token; this module turns what it reads into the app's data:
 *   - toHealthDays(): HRV (rMSSD), resting HR, sleep with stages, weight, SpO2 and breathing rate become the
 *     same day records as src/native-icu.js's toHealthDays() makes for js/velo-health.js, so readiness, the
 *     calendar strip and the recovery trends run unchanged. They are kept in wellness_days (source
 *     'healthconnect'); WellnessSources folds them with the intervals.icu days, field by field, in the order
 *     chosen in Settings > Health (Health Connect first by default).
 *   - toRide() / importRides(): cycling sessions from other apps, with their heart rate, power, speed,
 *     cadence and distance, become rides (source 'healthconnect', origin = the app's package), deduplicated
 *     against the history per docs/ANDROID-CONTRACTS.md (js/velo-dedupe.js: the copy with power wins).
 *   - HealthConnectDestination: rides recorded in the app go to Health Connect through the upload queue and
 *     its sync ledger. A ride that came from Health Connect is never written back.
 *   - NativeHealthConnect.sync(): a two-year backfill in 30-day chunks (resumable), then only the days and
 *     sessions the changes token reports, at app start and on resume. A token that expired (the app unused
 *     for about 30 days) reads everything again.
 * Times from the plugin are epoch ms with zone offsets in seconds (null: the phone's own zone).
 */

export const HC_SOURCE = 'healthconnect';
export const BACKFILL_DAYS = 730;
export const CHUNK_DAYS = 30;
/** App start always syncs; coming back to the app syncs again after this long. */
export const RESUME_SYNC_MS = 15 * 60 * 1000;

export const WELLNESS_TYPES = ['HeartRateVariabilityRmssd', 'RestingHeartRate', 'SleepSession', 'Weight', 'OxygenSaturation', 'RespiratoryRate'];
export const RIDE_TYPES = ['ExerciseSession', 'HeartRate', 'Power', 'Speed', 'Cadence', 'Distance'];
export const WRITE_TYPES = ['ExerciseSession', 'HeartRate', 'Power', 'Cadence', 'Speed', 'Distance', 'TotalCaloriesBurned'];

/** What each permission is for, in the words Settings > Health shows next to it. */
export const TYPE_TEXT = {
  HeartRateVariabilityRmssd: 'Heart rate variability (overnight rMSSD): the main input of your readiness score.',
  RestingHeartRate: 'Resting heart rate: compared with your normal range for readiness and the calendar.',
  SleepSession: 'Sleep, with its stages: hours slept, deep and REM sleep, bedtime and wake-up.',
  Weight: 'Weight: shown over time in Analytics > Health.',
  OxygenSaturation: 'Blood oxygen (SpO2): shown over time in Analytics > Health.',
  RespiratoryRate: 'Breathing rate: shown over time in Analytics > Health.',
  ExerciseSession: 'Exercise sessions: cycling rides recorded by other apps join your history. Other sports are skipped.',
  HeartRate: 'Heart rate during those rides (not the rest of the day).',
  Power: 'Power during those rides: training load, power curve and FTP.',
  Speed: 'Speed during those rides.',
  Cadence: 'Pedalling cadence during those rides.',
  Distance: 'Distance of those rides.',
  TotalCaloriesBurned: 'Calories of the rides you record here (written only).'
};

const CYCLING = new Set([8, 9]); // ExerciseSessionRecord.EXERCISE_TYPE_BIKING, _BIKING_STATIONARY
const SELF = /^com\.apexvelo\.lab(\.|$)/;
const APPS = {
  'com.zwift.zwiftgame': 'Zwift', 'com.zwift.android.prod': 'Zwift', 'com.sec.android.app.shealth': 'Samsung Health', 'com.google.android.apps.fitness': 'Google Fit',
  'com.fitbit.FitbitMobile': 'Fitbit', 'com.garmin.android.apps.connectmobile': 'Garmin Connect', 'com.strava': 'Strava', 'com.ouraring.oura': 'Oura',
  'com.wahoofitness.fitness': 'Wahoo', 'com.wahoofitness.boltcompanion': 'Wahoo ELEMNT', 'com.whoop.android': 'WHOOP', 'com.polar.polarflow': 'Polar Flow'
};
export const appName = (pkg) => APPS[pkg] || 'Health Connect';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (v) => Math.round(v * 10) / 10;
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

export function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Local midnight of a day on this phone, in ms. */
export const dayStart = (day) => new Date(day + 'T00:00:00').getTime();

/** Wall-clock day, hour and minute of a time at its own zone offset (the phone's zone when it has none). */
export function wall(ms, offsetSec) {
  const off = offsetSec === null || offsetSec === undefined ? -new Date(ms).getTimezoneOffset() * 60 : offsetSec;
  const d = new Date(ms + off * 1000);
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
/** As in js/velo-health.js: sleep and overnight readings belong to the morning you wake up (from 18:00 on, the next day). */
const nightOf = (w) => (w.hour >= 18 ? addDays(w.day, 1) : w.day);

const ASLEEP = new Set([2, 4, 5, 6]); // SleepSessionRecord stages: sleeping, light, deep, REM
function sleepParts(s) {
  const p = { total: 0, deep: 0, rem: 0, light: 0, awake: 0, staged: false };
  for (const st of s.stages || []) {
    const h = Math.max(0, st.end - st.start) / 3600e3;
    if (!h) continue;
    p.staged = true;
    if (ASLEEP.has(st.stage)) p.total += h;
    if (st.stage === 5) p.deep += h; else if (st.stage === 6) p.rem += h; else if (st.stage === 4) p.light += h;
    else if (st.stage === 1 || st.stage === 7) p.awake += h;
  }
  if (!p.staged) p.total = Math.max(0, s.end - s.start) / 3600e3;
  return p;
}

/**
 * Health Connect records ({ HeartRateVariabilityRmssd: [...], SleepSession: [...], ... }, as the plugin reads
 * them) -> { 'YYYY-MM-DD': { summary, src: 'healthconnect', ids } } in velo-health's day format. A night with
 * sleep from two apps keeps the app with the longer night (never adds them up); naps from that app count.
 * HRV is the average of the readings taken asleep (all of that night's when none were); resting HR the lowest.
 */
export function toHealthDays(recs = {}) {
  const raw = {};
  const at = (day) => raw[day] || (raw[day] = { rhr: [], hrv: [], weight: [], spo2: [], resp: [], sleep: [], ids: [] });
  const each = (type, dayOf, key) => {
    for (const r of recs[type] || []) {
      const v = num(r && r.value), t = num(r && r.time);
      if (v === null || t === null) continue;
      const d = at(dayOf(wall(t, r.offset)));
      d[key].push({ v, t });
      d.ids.push(r.id);
    }
  };
  each('RestingHeartRate', (w) => w.day, 'rhr');
  each('HeartRateVariabilityRmssd', nightOf, 'hrv');
  each('Weight', (w) => w.day, 'weight');
  each('OxygenSaturation', nightOf, 'spo2');
  each('RespiratoryRate', nightOf, 'resp');
  for (const s of recs.SleepSession || []) {
    if (!s || !(s.end > s.start)) continue;
    const d = at(nightOf(wall(s.end, s.endOffset)));
    d.sleep.push(s);
    d.ids.push(s.id);
  }
  const days = {};
  for (const [day, d] of Object.entries(raw)) {
    const s = { rhr: null, hrv: null, sleepH: null, deepH: null, remH: null, coreH: null, awakeH: null, rhrSrc: 'hc', hrvSrc: 'hc', hrvKind: 'rmssd' };
    const rhr = d.rhr.map((x) => x.v).filter((v) => v >= 25 && v <= 130);
    if (rhr.length) s.rhr = Math.round(Math.min(...rhr));
    if (d.sleep.length) {
      const byApp = {};
      for (const x of d.sleep) (byApp[x.origin] = byApp[x.origin] || []).push(x);
      const nights = Object.values(byApp).map((list) => ({ list, parts: list.map(sleepParts) }))
        .map((n) => ({ ...n, total: n.parts.reduce((a, p) => a + p.total, 0) }));
      const n = nights.reduce((a, b) => (b.total > a.total ? b : a));
      const sum = (k) => n.parts.reduce((a, p) => a + p[k], 0);
      if (n.total > 0 && n.total <= 20) {
        const staged = n.parts.some((p) => p.staged);
        Object.assign(s, { sleepH: round1(n.total), deepH: staged ? round1(sum('deep')) : null, remH: staged ? round1(sum('rem')) : null,
          coreH: staged ? round1(sum('light')) : null, awakeH: staged ? round1(sum('awake')) : null });
        const main = n.list.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
        s.bed = wall(main.start, main.startOffset).min;
        s.wake = wall(main.end, main.endOffset).min;
      }
    }
    // HRV: the readings inside any of the night's sleep sessions, else all of them.
    const hrvAll = d.hrv.filter((x) => x.v > 0 && x.v <= 300);
    const asleep = hrvAll.filter((x) => d.sleep.some((z) => x.t >= z.start && x.t <= z.end));
    const hrv = asleep.length ? asleep : hrvAll;
    if (hrv.length) s.hrv = s.hrvRmssd = Math.round(mean(hrv.map((x) => x.v)));
    const last = (list) => list.reduce((a, b) => (b.t > a.t ? b : a)).v;
    const weight = d.weight.filter((x) => x.v >= 20 && x.v <= 300);
    if (weight.length) s.weight = round1(last(weight));
    const avg = (list, lo, hi) => { const v = list.map((x) => x.v).filter((x) => x >= lo && x <= hi); return v.length ? round1(mean(v)) : null; };
    const spo2 = avg(d.spo2, 50, 100), resp = avg(d.resp, 4, 60);
    if (spo2 !== null) s.spo2 = spo2;
    if (resp !== null) s.resp = resp;
    if ([s.rhr, s.hrv, s.sleepH, s.weight, s.spo2, s.resp].every((v) => v === null || v === undefined)) continue;
    days[day] = { summary: s, src: HC_SOURCE, ids: [...new Set(d.ids)] };
  }
  return days;
}

// ------------------------------------------------------------------ merging --
/** The fields Settings > Health lets the rider take from either source, and the default (Health Connect first). */
export const MERGE_FIELDS = {
  rhr: ['rhr', 'rhrSrc'],
  hrv: ['hrv', 'hrvSrc', 'hrvKind'],
  sleep: ['sleepH', 'deepH', 'remH', 'coreH', 'awakeH', 'bed', 'wake'],
  weight: ['weight'], spo2: ['spo2'], resp: ['resp']
};
export const DEFAULT_PREFS = Object.fromEntries(Object.keys(MERGE_FIELDS).map((k) => [k, HC_SOURCE]));

const has = (s, k) => s && s[k] !== null && s[k] !== undefined;
/**
 * One day from both sources (either may be missing): intervals.icu's other values (scores, stress, blood
 * pressure...) stay, and each field group comes from the preferred source, or the other one when the preferred
 * has none that day. HRV only falls back to a value of the same kind: Health Connect has rMSSD, intervals.icu
 * may have SDNN (prefs.icuHrvKind), and one scale is used throughout or the baselines would mix them.
 */
export function mergeDay(icu, hc, prefs = DEFAULT_PREFS) {
  if (!icu && !hc) return null;
  const a = (icu && icu.summary) || {}, b = (hc && hc.summary) || {};
  // HRV kind of each source: Health Connect only has rMSSD; intervals.icu has whichever its days use.
  const kind = (source) => (source === 'icu' ? prefs.icuHrvKind || a.hrvKind || 'rmssd' : 'rmssd');
  // A day only one source has stays as it is, except an HRV of the kind not in use.
  const single = !icu || !hc;
  const out = { ...(single ? (icu || hc).summary : a) };
  for (const [group, keys] of Object.entries(MERGE_FIELDS)) {
    const icuFirst = (prefs[group] || HC_SOURCE) === 'icu';
    const [first, second] = icuFirst ? [a, b] : [b, a];
    let pick = has(first, keys[0]) ? first : has(second, keys[0]) ? second : null;
    if (group === 'hrv' && pick === second && kind('icu') !== kind(HC_SOURCE)) pick = null;
    if (single) { if (!pick && has(out, keys[0])) for (const k of keys) if (k in out) out[k] = null; continue; }
    for (const k of keys) out[k] = has(pick, k) ? pick[k] : null;
  }
  if (single) return { ...(icu || hc), summary: out };
  if (has(b, 'hrvRmssd') || has(a, 'hrvRmssd')) out.hrvRmssd = has(b, 'hrvRmssd') ? b.hrvRmssd : a.hrvRmssd;
  return { summary: out, src: 'merged' };
}

const PREFS_KEY = 'hc_field_prefs';
/**
 * The wellness_days table (both sources) and the merged days velo-health reads (`target`, the app's
 * healthStore.days). Days stored before this existed hold only intervals.icu data: they are copied into the
 * table as source 'icu' the first time they are merged, so the next merge still has them.
 */
export class WellnessSources {
  constructor({ store, prefs }) { Object.assign(this, { store, prefs }); }

  async fieldPrefs() {
    let p = {};
    try { p = JSON.parse((await this.prefs.get(PREFS_KEY)) || '{}') || {}; } catch { p = {}; }
    return Object.fromEntries(Object.keys(MERGE_FIELDS).map((k) => [k, p[k] === 'icu' ? 'icu' : HC_SOURCE]));
  }
  async setFieldPref(group, source) {
    if (!MERGE_FIELDS[group] || ![HC_SOURCE, 'icu'].includes(source)) throw new Error('Unknown health field or source.');
    await this.prefs.set(PREFS_KEY, JSON.stringify({ ...(await this.fieldPrefs()), [group]: source }));
  }

  /** Stores days of one source ({ day: record | null }) and merges them into `target`. Resolves to the days changed. */
  async apply(target, source, days) {
    await this.store.putWellnessDays(source, days);
    return this.remerge(target, Object.keys(days));
  }

  /**
   * Merges `dayList` (every stored day when left out) into `target` again. HRV comes from the preferred
   * source only if that source has HRV at all; when the source in effect changes (or a preference does),
   * every day is merged again, so all days use the same one.
   */
  async remerge(target, dayList) {
    const rows = await this.store.listWellnessDays();
    const by = {};
    for (const r of rows) (by[r.day] = by[r.day] || {})[r.source === 'icu' ? 'icu' : r.source === HC_SOURCE ? 'hc' : 'other'] = r.data;
    const icuDays = Object.keys(target).filter((d) => target[d] && target[d].src === 'icu');
    const hrvIn = (source) => rows.some((r) => r.source === source && has(r.data && r.data.summary, 'hrv'))
      || (source === 'icu' && icuDays.some((d) => has(target[d].summary, 'hrv')));
    const prefs = await this.fieldPrefs();
    const icuHrv = rows.find((r) => r.source === 'icu' && has(r.data && r.data.summary, 'hrv')) || icuDays.map((d) => ({ data: target[d] })).find((r) => has(r.data.summary, 'hrv'));
    if (icuHrv) prefs.icuHrvKind = icuHrv.data.summary.hrvKind || 'rmssd';
    if (!hrvIn(prefs.hrv)) prefs.hrv = prefs.hrv === 'icu' ? HC_SOURCE : 'icu';
    const effective = JSON.stringify(prefs);
    const all = effective !== await this.prefs.get(PREFS_KEY + '_in_effect');
    const days = !all && dayList ? [...new Set(dayList)].sort() : [...new Set([...Object.keys(by), ...icuDays, ...(dayList || [])])].sort();
    const seed = {};
    let changed = 0;
    for (const day of days) {
      const cur = target[day];
      let { icu, hc } = by[day] || {};
      if (!icu && cur && cur.src === 'icu') { icu = cur; seed[day] = cur; }
      const next = mergeDay(icu, hc, prefs);
      if (!next) {
        if (cur && (cur.src === HC_SOURCE || cur.src === 'merged')) { delete target[day]; changed++; }
        continue;
      }
      if (JSON.stringify(cur) !== JSON.stringify(next)) { target[day] = next; changed++; }
    }
    if (Object.keys(seed).length) await this.store.putWellnessDays('icu', seed);
    if (all) await this.prefs.set(PREFS_KEY + '_in_effect', effective);
    return changed;
  }

  /** The Health Connect days holding any of these record ids (to re-read them after a deletion). */
  async daysWithIds(ids) {
    const want = new Set(ids);
    return (await this.store.listWellnessDays({ source: HC_SOURCE })).filter((r) => (r.data.ids || []).some((id) => want.has(id))).map((r) => r.day);
  }
}

// -------------------------------------------------------------------- rides --
export const isCyclingSession = (s) => !!s && CYCLING.has(s.exerciseType);
/** Records this app wrote itself (they come back when Health Connect is read). */
export const fromThisApp = (r) => SELF.test((r && r.origin) || '') || /^apexvelo-/.test((r && r.clientId) || '');

/**
 * A cycling session and its series ({ HeartRate, Power, Speed, Cadence, Distance }: records of the session's
 * own app) -> a ride with 1 Hz samples, summarised by js/velo-importer.js (`summarize`). Gaps up to 5 s hold
 * the last value; distance records are spread evenly over their own time.
 */
export function toRide(session, series = {}, { ftp = 0, profileName = '', summarize }) {
  const start = session.start, dur = Math.max(1, Math.round((session.end - start) / 1000));
  const channel = (recs, scale = 1) => {
    const a = new Array(dur).fill(null);
    let any = false;
    for (const r of recs || []) for (const [t, v] of r.samples || []) {
      const i = Math.floor((t - start) / 1000);
      if (i >= 0 && i < dur && Number.isFinite(v)) { a[i] = v * scale; any = true; }
    }
    if (!any) return null;
    for (let i = 1, held = 0; i < dur; i++) {
      if (a[i] !== null) { held = 0; continue; }
      if (a[i - 1] !== null && held < 5) { a[i] = a[i - 1]; held++; }
    }
    return a;
  };
  const power = channel(series.Power), hr = channel(series.HeartRate), cadence = channel(series.Cadence), speed = channel(series.Speed, 3.6);
  let dist = null, totalM = 0;
  if ((series.Distance || []).length) {
    const inc = new Array(dur).fill(0);
    for (const r of series.Distance) {
      const m = num(r.value);
      if (!m || m <= 0) continue;
      totalM += m;
      const a = Math.max(0, Math.floor((r.start - start) / 1000)), b = Math.min(dur, Math.max(a + 1, Math.ceil((r.end - start) / 1000)));
      for (let i = a; i < b; i++) inc[i] += m / (b - a);
    }
    if (totalM > 0) { dist = []; let sum = 0; for (let i = 0; i < dur; i++) { sum += inc[i]; dist.push(sum / 1000); } }
  }
  const meta = {
    id: 'hc_' + session.id, title: session.title || `${appName(session.origin)} ride`, date: new Date(start).toISOString(), profileName,
    source: HC_SOURCE, origin: session.origin, activityType: 'ride', indoor: session.exerciseType === 9,
    hc: { id: session.id, origin: session.origin, exerciseType: session.exerciseType }
  };
  if (!power && !hr && !cadence && !speed && !dist) {
    return { ...meta, duration: dur, durationMin: Math.round(dur / 60), avgWatts: 0, np: 0, tss: 0, kj: 0, distanceKm: 0, samplesCount: 0, samples: [] };
  }
  const r0 = (v) => (v === null ? 0 : Math.round(v));
  const samples = Array.from({ length: dur }, (_, i) => ({
    time: i, timestamp: start + i * 1000, power: power ? r0(power[i]) : 0, cadence: cadence ? r0(cadence[i]) : 0, hr: hr ? r0(hr[i]) : 0,
    speed: speed && speed[i] !== null ? round1(speed[i]) : null, dist: dist ? Math.round(dist[i] * 1000) / 1000 : null
  }));
  return summarize(samples, ftp, meta);
}

/**
 * Adds Health Connect rides to `list` (the app's history, changed in place), per the dedupe contract
 * (js/velo-dedupe.js `admit`): a new ride is added; a copy of a stored ride replaces it only when it is better
 * (power, then more channels, then longer) and the stored one was not recorded in this app, keeping the stored
 * id, title, file hash and Strava link (and its source as replacedFrom); otherwise it is skipped. A session read again (edited in its app) updates its ride.
 */
export function importRides(list, incoming, Dedupe) {
  const out = { added: [], replaced: [], updated: [], skipped: 0 };
  const index = Dedupe.rideIndex(list);
  for (const ride of incoming) {
    const at = list.findIndex((r) => r.id === ride.id || (r.hc && ride.hc && r.hc.id === ride.hc.id));
    const keep = (old) => {
      const k = { id: old.id, title: old.title || ride.title, description: old.description, strava: old.strava, stravaActivityId: old.stravaActivityId,
        fileHash: old.fileHash, replacedFrom: old.source === HC_SOURCE ? old.replacedFrom : old.source };
      Object.keys(k).forEach((x) => k[x] === undefined && delete k[x]);
      return { ...ride, ...k };
    };
    if (at >= 0) {
      const merged = keep(list[at]);
      index.remove(list[at]); list[at] = merged; index.add(merged);
      out.updated.push(merged);
      continue;
    }
    const v = Dedupe.admit(index, ride);
    if (v.verdict === 'new') { list.unshift(ride); out.added.push(ride); }
    else if (v.verdict === 'replace') {
      const i = list.indexOf(v.with);
      const merged = keep(v.with);
      index.remove(ride); index.add(merged);
      if (i >= 0) list[i] = merged; else list.unshift(merged);
      out.replaced.push(merged);
    } else out.skipped++;
  }
  return out;
}

/** True when a ride also came from somewhere other than Health Connect (a replaced copy, a file, Strava). */
export const hasOtherSource = (r) => !!(r.replacedFrom || r.fileHash || r.stravaActivityId || (r.strava && (r.strava.activityId || r.strava.state === 'sent')));

/**
 * A session deleted in Health Connect: its ride goes only when Health Connect is its only source. A ride that
 * replaced a file copy, has a file hash on record (a duplicate file was dropped for it) or a Strava link is
 * detached instead: it loses its Health Connect link and gets back the source it replaced.
 * Resolves to { removed, detached }.
 */
export function removeRides(list, sessionIds) {
  const ids = new Set(sessionIds);
  const out = { removed: [], detached: [] };
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (r.source !== HC_SOURCE || !r.hc || !ids.has(r.hc.id)) continue;
    if (!hasOtherSource(r)) { out.removed.push(...list.splice(i, 1)); continue; }
    delete r.hc;
    if (r.replacedFrom) { r.source = r.replacedFrom; delete r.replacedFrom; }
    out.detached.push(r);
  }
  return out;
}

// ------------------------------------------------------------------ writing --
/** A ride recorded in the app -> the plugin's writeRide() payload (series as [ms, value] pairs). */
export function ridePayload(ride) {
  const start = Date.parse(ride.date);
  const samples = Array.isArray(ride.samples) ? ride.samples : [];
  const t = (s, i) => (Number.isFinite(s.timestamp) ? s.timestamp : start + (Number.isFinite(s.time) ? s.time : i) * 1000);
  const pairs = (key, keepZero, scale = 1) => samples.map((s, i) => [t(s, i), Number(s[key])]).filter(([, v]) => Number.isFinite(v) && (keepZero ? v >= 0 : v > 0)).map(([x, v]) => [x, v * scale]);
  const duration = Number(ride.duration) || samples.length || 1;
  const end = Math.max(start + duration * 1000, samples.length ? t(samples[samples.length - 1], samples.length - 1) + 1000 : 0);
  return {
    clientId: 'apexvelo-' + ride.id, version: Number(ride.completedAt) || start, title: ride.title || 'Apex Velo ride',
    exerciseType: ride.indoor === false ? 8 : 9, start, end, offset: -new Date(start).getTimezoneOffset() * 60,
    hr: pairs('hr', false), power: pairs('power', true), cadence: pairs('cadence', true), speed: pairs('speed', true, 1 / 3.6),
    distance: Number(ride.totalDistanceMeters) || (Number(ride.distanceKm) || 0) * 1000, kcal: Number(ride.totalCalories) || 0
  };
}

/** Only rides recorded in the app are written; imports already live in the app that made them. */
export const recordedHere = (ride) => !!ride && (ride.source === 'APEX VELO Cockpit' || ride.source === 'recorded');

/** Upload-queue destination (src/native-outbox.js): Health Connect as an outbound copy of rides recorded here. */
export class HealthConnectDestination {
  constructor({ hc }) { Object.assign(this, { hc, id: HC_SOURCE, label: 'Health Connect' }); }
  isConnected() { return this.hc.canWrite(); }
  async upload(ride) {
    if (!recordedHere(ride)) throw Object.assign(new Error('Only rides recorded in Apex Velo are saved to Health Connect.'), { retryable: false });
    try {
      const r = await this.hc.plugin.writeRide(ridePayload(ride));
      return { externalId: (r && r.id) || 'apexvelo-' + ride.id };
    } catch (e) {
      const permission = e && e.code === 'PERMISSION';
      throw Object.assign(new Error(permission ? 'Health Connect no longer allows Apex Velo to save rides. Allow it in Settings > Health.' : `Health Connect: ${(e && e.message) || e}`),
        { needsConnect: permission, retryable: !permission });
    }
  }
}

// --------------------------------------------------------------------- sync --
const STATE_KEY = 'hc_sync_state';

/**
 * The plugin wrapper and the sync. plugin: the HealthConnect Capacitor plugin (or a test fake); prefs:
 * { get, set, remove }. sync() takes the app's handlers: days(map) stores wellness days ({ day: rec|null }),
 * sessions(list of { session, series }) imports rides, removed(ids) drops rides of deleted sessions, and
 * daysWithIds(ids) finds stored days a deleted record belonged to.
 */
export class NativeHealthConnect {
  constructor({ plugin, prefs, now = () => Date.now() }) {
    Object.assign(this, { plugin, prefs, now });
    this._busy = null;
  }

  async availability() {
    try { return await this.plugin.availability(); } catch { return { status: 'unsupported' }; }
  }
  async granted() {
    try { return await this.plugin.grantedHealthPermissions(); } catch { return { read: [], write: [], history: false }; }
  }
  async canWrite() {
    if ((await this.availability()).status !== 'available') return false;
    return (await this.granted()).write.includes('ExerciseSession');
  }

  /** Health Connect's permission screen for one group: 'recovery', 'rides' or 'write'. */
  request(group) {
    const ask = { recovery: { read: WELLNESS_TYPES, history: true }, rides: { read: RIDE_TYPES, history: true }, write: { write: WRITE_TYPES } }[group];
    if (!ask) throw new Error('Unknown Health Connect permission group.');
    return this.plugin.requestHealthPermissions({ read: [], write: [], history: false, ...ask });
  }

  async state() {
    try { return JSON.parse((await this.prefs.get(STATE_KEY)) || 'null'); } catch { return null; }
  }
  async _save(st) { await this.prefs.set(STATE_KEY, JSON.stringify(st)); }
  async status() {
    const [availability, st] = await Promise.all([this.availability(), this.state()]);
    return { availability, granted: availability.status === 'available' ? await this.granted() : null, state: st };
  }
  /** Forgets the sync position (after disconnecting): the next sync backfills again. */
  async reset() { await this.prefs.remove(STATE_KEY); }

  async _readAll(type, start, end, origin) {
    const out = [];
    let pageToken;
    do {
      const r = await this.plugin.readRecords({ type, start, end, ...(origin ? { origin } : {}), ...(pageToken ? { pageToken } : {}) });
      out.push(...(r.records || []));
      pageToken = r.pageToken || undefined;
    } while (pageToken);
    return out;
  }

  /** Wellness days in [from, to) (YYYY-MM-DD, to exclusive), read with a day either side so nights at the edges are whole. */
  async _readDays(from, to, types) {
    const recs = {};
    for (const type of WELLNESS_TYPES) if (types.includes(type)) recs[type] = await this._readAll(type, dayStart(addDays(from, -1)), dayStart(addDays(to, 1)));
    const mapped = toHealthDays(recs);
    return Object.fromEntries(Object.entries(mapped).filter(([d]) => d >= from && d < to));
  }

  async _sessions(list, types) {
    const out = [];
    for (const session of list) {
      if (!isCyclingSession(session) || fromThisApp(session)) continue;
      const series = {};
      for (const type of ['HeartRate', 'Power', 'Speed', 'Cadence', 'Distance']) {
        if (types.includes(type)) series[type] = await this._readAll(type, session.start, session.end, session.origin);
      }
      out.push({ session, series });
    }
    return out;
  }

  /** One sync (overlapping calls share it). Resolves to { days, sessions, removed, backfilled }. */
  sync(handlers, opts = {}) {
    if (!this._busy) this._busy = this._sync(handlers, opts).finally(() => { this._busy = null; });
    return this._busy;
  }

  async _sync(h, { today, onProgress = () => {} }) {
    const res = { days: 0, sessions: 0, removed: 0, backfilled: false };
    if ((await this.availability()).status !== 'available') return res;
    const types = (await this.granted()).read;
    if (!types.length) return res;
    let st = await this.state();
    const limit = addDays(today, 1 - BACKFILL_DAYS);
    // The token follows the day-level types allowed; more allowed later (e.g. rides) reads everything again.
    const tracked = [...WELLNESS_TYPES, 'ExerciseSession'].filter((t) => types.includes(t));
    if (!tracked.length) return res;
    if (st && JSON.stringify(st.types || []) !== JSON.stringify(tracked)) st = null;
    for (let round = 0; round < 2; round++) {
      // Two years back in 30-day chunks, newest first; the position is kept, so a killed app goes on from it.
      // The changes token is taken first: anything written during the backfill comes as a change after it.
      if (!st || !st.done) {
        if (!st) { await this.plugin.startChanges({ types: tracked }); st = { types: tracked, next: addDays(today, 1), done: false }; await this._save(st); }
        while (!st.done) {
          const from = addDays(st.next, -CHUNK_DAYS) < limit ? limit : addDays(st.next, -CHUNK_DAYS);
          const found = await this._readDays(from, st.next, types);
          const days = {};
          for (let d = from; d < st.next; d = addDays(d, 1)) days[d] = found[d] || null;
          res.days += Object.keys(found).length;
          await h.days(days);
          if (types.includes('ExerciseSession')) {
            const sessions = await this._sessions(await this._readAll('ExerciseSession', dayStart(from), dayStart(st.next)), types);
            res.sessions += sessions.length;
            if (sessions.length) await h.sessions(sessions);
          }
          st = { ...st, next: from, done: from <= limit };
          await this._save(st);
          onProgress(Math.min(BACKFILL_DAYS, Math.round((dayStart(addDays(today, 1)) - dayStart(from)) / 86400e3)), BACKFILL_DAYS);
        }
        res.backfilled = true;
      }
      // Then what changed since: the days touched and the sessions added, edited or deleted.
      const p = await this.plugin.pendingChanges();
      if (p.tokenExpired || !p.hasToken) { st = null; continue; } // read everything again
      const changes = p.changes || [];
      const touched = new Set(), sessions = [], deleted = [];
      for (const c of changes) {
        if (c.op === 'delete') { deleted.push(c.id); continue; }
        if (c.type === 'ExerciseSession') { sessions.push(c); continue; }
        if (!WELLNESS_TYPES.includes(c.type)) continue;
        const w = wall(c.time ?? c.end, c.offset ?? c.endOffset);
        touched.add(w.day); touched.add(nightOf(w));
      }
      if (deleted.length) {
        for (const d of await h.daysWithIds(deleted)) touched.add(d);
        res.removed += (await h.removed(deleted)) || 0;
      }
      const list = [...touched].filter((d) => d >= limit && d <= today).sort();
      if (list.length) {
        const found = await this._readDays(list[0], addDays(list[list.length - 1], 1), types);
        await h.days(Object.fromEntries(list.map((d) => [d, found[d] || null])));
        res.days += list.length;
      }
      const read = await this._sessions(sessions.filter((s) => s.start >= dayStart(limit)), types);
      if (read.length) { res.sessions += read.length; await h.sessions(read); }
      if (changes.length) await this.plugin.ackChanges({ upTo: Math.max(...changes.map((c) => c.seq)) });
      break;
    }
    await this._save({ ...(st || {}), lastSync: this.now() });
    return res;
  }
}
