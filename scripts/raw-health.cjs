'use strict';
/**
 * Pure raw Apple Health / Health Auto Export parsing & normalization.
 *
 * Converts Health Auto Export v1/v2 JSON, legacy `apex_health_v1` raw day
 * buckets, and streaming Apple Health `export.xml` records into normalized
 * rows for `health_readings` and `health_sleep_sessions`.
 */
const fs = require('node:fs');
const readline = require('node:readline');

const DAY_MS = 86400000;
const STAMP_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/i;

const CANONICAL_METRICS = {
  heart_rate: 'heart_rate',
  hkquantitytypeidentifierheartrate: 'heart_rate',
  heart_rate_variability: 'heart_rate_variability',
  heart_rate_variability_sdnn: 'heart_rate_variability',
  hkquantitytypeidentifierheartratevariabilitysdnn: 'heart_rate_variability',
  resting_heart_rate: 'resting_heart_rate',
  hkquantitytypeidentifierrestingheartrate: 'resting_heart_rate',
  walking_heart_rate_average: 'walking_heart_rate_average',
  hkquantitytypeidentifierwalkingheartrateaverage: 'walking_heart_rate_average',
  step_count: 'step_count',
  steps: 'step_count',
  hkquantitytypeidentifierstepcount: 'step_count',
  active_energy: 'active_energy',
  active_energy_burned: 'active_energy',
  hkquantitytypeidentifieractiveenergyburned: 'active_energy',
  basal_energy_burned: 'basal_energy_burned',
  hkquantitytypeidentifierbasalenergyburned: 'basal_energy_burned',
  respiratory_rate: 'respiratory_rate',
  hkquantitytypeidentifierrespiratoryrate: 'respiratory_rate',
  blood_oxygen_saturation: 'blood_oxygen_saturation',
  oxygen_saturation: 'blood_oxygen_saturation',
  hkquantitytypeidentifieroxygensaturation: 'blood_oxygen_saturation',
  apple_sleeping_wrist_temperature: 'apple_sleeping_wrist_temperature',
  sleeping_wrist_temperature: 'apple_sleeping_wrist_temperature',
  hkquantitytypeidentifierapplesleepingwristtemperature: 'apple_sleeping_wrist_temperature',
  vo2_max: 'vo2_max',
  hkquantitytypeidentifiervo2max: 'vo2_max',
  weight_body_mass: 'weight_body_mass',
  body_mass: 'weight_body_mass',
  hkquantitytypeidentifierbodymass: 'weight_body_mass',
  body_fat_percentage: 'body_fat_percentage',
  hkquantitytypeidentifierbodyfatpercentage: 'body_fat_percentage',
  lean_body_mass: 'lean_body_mass',
  hkquantitytypeidentifierleanbodymass: 'lean_body_mass',
  apple_exercise_time: 'apple_exercise_time',
  hkquantitytypeidentifierappleexercisetime: 'apple_exercise_time',
  apple_stand_time: 'apple_stand_time',
  hkquantitytypeidentifierapplestandtime: 'apple_stand_time',
  flights_climbed: 'flights_climbed',
  hkquantitytypeidentifierflightsclimbed: 'flights_climbed',
  walking_running_distance: 'walking_running_distance',
  distance_walking_running: 'walking_running_distance',
  hkquantitytypeidentifierdistancewalkingrunning: 'walking_running_distance',
  time_in_daylight: 'time_in_daylight',
  hkquantitytypeidentifiertimeindaylight: 'time_in_daylight',
  physical_effort: 'physical_effort',
  hkquantitytypeidentifierphysicaleffort: 'physical_effort',
  blood_pressure_systolic: 'blood_pressure_systolic',
  hkquantitytypeidentifierbloodpressuresystolic: 'blood_pressure_systolic',
  blood_pressure_diastolic: 'blood_pressure_diastolic',
  hkquantitytypeidentifierbloodpressurediastolic: 'blood_pressure_diastolic',
  blood_glucose: 'blood_glucose',
  hkquantitytypeidentifierbloodglucose: 'blood_glucose',
  dietary_energy: 'dietary_energy',
  dietary_energy_consumed: 'dietary_energy',
  hkquantitytypeidentifierdietaryenergyconsumed: 'dietary_energy',
  protein: 'dietary_protein',
  dietary_protein: 'dietary_protein',
  hkquantitytypeidentifierdietaryprotein: 'dietary_protein',
  carbohydrates: 'dietary_carbohydrates',
  dietary_carbohydrates: 'dietary_carbohydrates',
  hkquantitytypeidentifierdietarycarbohydrates: 'dietary_carbohydrates',
  total_fat: 'dietary_fat_total',
  dietary_fat_total: 'dietary_fat_total',
  hkquantitytypeidentifierdietaryfattotal: 'dietary_fat_total',
  water: 'dietary_water',
  dietary_water: 'dietary_water',
  hkquantitytypeidentifierdietarywater: 'dietary_water',
  sleep_analysis: 'sleep_analysis',
  hkcategorytypeidentifiersleepanalysis: 'sleep_analysis',
  blood_pressure: 'blood_pressure'
};

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Deterministic timestamp parser for Apple Health / Health Auto Export stamps.
 * Matches VeloHealth's overnight boundary (`localHour >= 18` -> next calendar day).
 */
function parseLocalStamp(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = STAMP_RE.exec(s);
  if (m) {
    const localDay = m[1];
    const hh = m[2];
    const mm = m[3];
    const ss = m[4] || '00';
    const frac = m[5] ? `.${m[5].slice(0, 3)}` : '';
    let tz = m[6] || '';
    if (tz && /^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
    const iso = `${localDay}T${hh}:${mm}:${ss}${frac}${tz}`;
    let tsMs = Date.parse(iso);
    if (!Number.isFinite(tsMs)) {
      tsMs = Date.parse(`${localDay}T${hh}:${mm}:${ss}Z`);
    }
    if (!Number.isFinite(tsMs)) return null;
    const localHour = Number(hh);
    const localTs = `${localDay} ${hh}:${mm}:${ss}`;
    const nightDay = localHour >= 18 ? addDays(localDay, 1) : localDay;
    return { tsMs: Math.round(tsMs), localTs, localDay, nightDay, localHour };
  }
  const fallbackMs = Date.parse(s);
  if (!Number.isFinite(fallbackMs)) return null;
  const d = new Date(fallbackMs);
  const p2 = (n) => String(n).padStart(2, '0');
  const localDay = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const hh = p2(d.getHours());
  const localHour = d.getHours();
  const localTs = `${localDay} ${hh}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  return {
    tsMs: Math.round(fallbackMs),
    localTs,
    localDay,
    nightDay: localHour >= 18 ? addDays(localDay, 1) : localDay,
    localHour
  };
}

/** Converts Health Auto Export or Apple HealthKit metric names into clean snake_case. */
function normalizeMetricName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const direct = CANONICAL_METRICS[s.toLowerCase()];
  if (direct) return direct;

  let stripped = s.replace(/^HK(?:Quantity|Category|Correlation|Workout)TypeIdentifier/i, '');
  stripped = stripped
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

  return CANONICAL_METRICS[stripped] || stripped;
}

function normalizeUnit(unit) {
  const s = String(unit || '').trim();
  if (!s) return '';
  if (/^counts?\/min$/i.test(s) || /^bpm$/i.test(s)) return 'bpm';
  if (s === '°C' || /^degC$/i.test(s)) return 'degC';
  if (s === '°F' || /^degF$/i.test(s)) return 'degF';
  return s;
}

function numVal(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function hoursOf(v, units) {
  const n = numVal(v);
  if (n === null) return null;
  if (/^min/i.test(units || '')) return n / 60;
  if (/^s(ec)?$/i.test(units || '')) return n / 3600;
  return n;
}

function minutesOf(v, units) {
  const n = numVal(v);
  if (n === null) return null;
  if (/^s(ec)?$/i.test(units || '')) return n / 60;
  if (/^hr|^h(ours?)?$/i.test(units || '')) return n * 60;
  return n;
}

function normalizeSleepStage(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/^hkcategoryvaluesleepanalysis/i, '').replace(/\s+/g, '');
  if (s === 'asleepdeep' || s === 'deep') return 'deep';
  if (s === 'asleepcore' || s === 'core' || s === 'light') return 'core';
  if (s === 'asleeprem' || s === 'rem') return 'rem';
  if (s === 'awake') return 'awake';
  if (s === 'inbed') return 'inbed';
  if (s === 'asleep' || s === 'asleepunspecified') return 'asleep';
  return s || 'asleep';
}

function cleanSource(raw) {
  const s = String(raw || '').trim();
  return s || 'apple_health';
}

/**
 * Parses one Health Auto Export JSON payload into raw `readings` and `sleepSessions`.
 * Unknown metrics are normalized and stored rather than dropped.
 */
function parseHealthAutoExportPayload(json) {
  const readings = [];
  const sleepSessions = [];
  const metrics = (json && json.data && Array.isArray(json.data.metrics) ? json.data.metrics : null)
    || (json && Array.isArray(json.metrics) ? json.metrics : null)
    || [];

  for (const m of metrics) {
    if (!m || typeof m !== 'object') continue;
    const metric = normalizeMetricName(m.name);
    if (!metric) continue;
    const unit = normalizeUnit(m.units);
    const rows = Array.isArray(m.data) ? m.data : [];

    if (metric === 'sleep_analysis') {
      for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        if (r.value !== undefined && (r.startDate || r.endDate)) {
          const s0 = parseLocalStamp(r.startDate);
          const s1 = parseLocalStamp(r.endDate || r.startDate);
          if (!s1 && !s0) continue;
          let durationMin = minutesOf(r.qty, m.units);
          let endMs = s1 ? s1.tsMs : null;
          let startMs = s0 ? s0.tsMs : null;
          if (durationMin === null && startMs !== null && endMs !== null && endMs >= startMs) {
            durationMin = Math.round(((endMs - startMs) / 60000) * 100) / 100;
          }
          if (!(durationMin > 0)) continue;
          if (startMs === null && endMs !== null) startMs = Math.round(endMs - durationMin * 60000);
          if (endMs === null && startMs !== null) endMs = Math.round(startMs + durationMin * 60000);
          sleepSessions.push({
            kind: 'stage',
            nightDay: (s1 || s0).nightDay,
            stage: normalizeSleepStage(r.value),
            startMs: startMs || 0,
            endMs: endMs || 0,
            durationMin: Math.round(durationMin * 100) / 100,
            deepH: null,
            remH: null,
            coreH: null,
            awakeH: null,
            inBedH: null,
            source: cleanSource(r.source || r.sleepSource)
          });
        } else {
          const endStamp = parseLocalStamp(r.sleepEnd || r.inBedEnd) || parseLocalStamp(r.date || r.endDate || r.startDate);
          const startStamp = parseLocalStamp(r.sleepStart || r.inBedStart);
          if (!endStamp && !startStamp) continue;
          const nightDay = (r.sleepEnd || r.inBedEnd) && endStamp ? endStamp.nightDay : (endStamp || startStamp).localDay;
          const part = (k) => hoursOf(r[k], m.units);
          const core = part('core'), deep = part('deep'), rem = part('rem'), awake = part('awake'), inBed = part('inBed');
          const staged = [core, deep, rem].some(x => x !== null) ? (core || 0) + (deep || 0) + (rem || 0) : null;
          const total = part('totalSleep') !== null ? part('totalSleep')
            : part('asleep') !== null && part('asleep') > 0 ? part('asleep') : staged;
          if (total === null || total <= 0 || total > 24) continue;
          const endMs = endStamp ? endStamp.tsMs : (startStamp ? Math.round(startStamp.tsMs + total * 3600000) : 0);
          const spanHours = inBed !== null && inBed > 0 ? inBed : total + (awake || 0);
          const startMs = startStamp ? startStamp.tsMs : Math.round(endMs - spanHours * 3600000);
          sleepSessions.push({
            kind: 'night',
            nightDay,
            stage: 'total',
            startMs,
            endMs,
            durationMin: Math.round(total * 600) / 10,
            deepH: deep,
            remH: rem,
            coreH: core,
            awakeH: awake,
            inBedH: inBed,
            source: cleanSource(r.source || r.sleepSource)
          });
        }
      }
      continue;
    }

    if (metric === 'blood_pressure') {
      for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        const st = parseLocalStamp(r.date || r.startDate || r.endDate);
        if (!st) continue;
        const source = cleanSource(r.source);
        const sys = numVal(r.systolic);
        const dia = numVal(r.diastolic);
        if (sys !== null) {
          readings.push({ metric: 'blood_pressure_systolic', tsMs: st.tsMs, localTs: st.localTs, localDay: st.localDay, nightDay: st.nightDay, value: sys, valMin: null, valMax: null, unit: 'mmHg', source });
        }
        if (dia !== null) {
          readings.push({ metric: 'blood_pressure_diastolic', tsMs: st.tsMs, localTs: st.localTs, localDay: st.localDay, nightDay: st.nightDay, value: dia, valMin: null, valMax: null, unit: 'mmHg', source });
        }
        if (sys === null && dia === null) {
          const v = numVal(r.qty ?? r.Avg ?? r.avg ?? r.value);
          if (v !== null) {
            readings.push({ metric, tsMs: st.tsMs, localTs: st.localTs, localDay: st.localDay, nightDay: st.nightDay, value: v, valMin: numVal(r.Min ?? r.min), valMax: numVal(r.Max ?? r.max), unit: unit || 'mmHg', source });
          }
        }
      }
      continue;
    }

    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const st = parseLocalStamp(r.date || r.startDate || r.endDate);
      if (!st) continue;
      const v = numVal(r.qty !== undefined ? r.qty : (r.Avg !== undefined ? r.Avg : (r.avg !== undefined ? r.avg : r.value)));
      if (v === null) continue;
      readings.push({
        metric,
        tsMs: st.tsMs,
        localTs: st.localTs,
        localDay: st.localDay,
        nightDay: st.nightDay,
        value: v,
        valMin: numVal(r.Min !== undefined ? r.Min : r.min),
        valMax: numVal(r.Max !== undefined ? r.Max : r.max),
        unit,
        source: cleanSource(r.source)
      });
    }
  }

  return { readings, sleepSessions };
}

/**
 * Extracts raw timestamped readings and sleep entries preserved inside `apex_health_v1`
 * (either live settings or historical backups before 7-day compaction removed them).
 */
function parseApexHealthStoreRaw(healthStore) {
  const readings = [];
  const sleepSessions = [];
  const days = healthStore && healthStore.days && typeof healthStore.days === 'object' ? healthStore.days : {};

  for (const [day, rec] of Object.entries(days)) {
    if (!rec || typeof rec !== 'object') continue;

    const pushMap = (bucket, metric, unit) => {
      if (!bucket || typeof bucket !== 'object') return;
      for (const [stampStr, val] of Object.entries(bucket)) {
        const v = numVal(val);
        const st = parseLocalStamp(stampStr);
        if (v === null || !st) continue;
        readings.push({
          metric,
          tsMs: st.tsMs,
          localTs: st.localTs,
          localDay: st.localDay,
          nightDay: st.nightDay,
          value: v,
          valMin: null,
          valMax: null,
          unit,
          source: 'apple_health'
        });
      }
    };

    pushMap(rec.hr, 'heart_rate', 'bpm');
    pushMap(rec.hrv, 'heart_rate_variability', 'ms');
    pushMap(rec.rhr, 'resting_heart_rate', 'bpm');

    if (rec.sleep && typeof rec.sleep === 'object') {
      for (const [key, item] of Object.entries(rec.sleep)) {
        if (!item || typeof item !== 'object') continue;
        if (item.night) {
          const n = item.night;
          const total = numVal(n.total);
          if (!(total > 0) || total > 24) continue;
          const parts = String(key).split('|');
          const keyDay = /^\d{4}-\d{2}-\d{2}$/.test(parts[1] || '') ? parts[1] : day;
          const source = cleanSource(parts.slice(2).join('|'));
          const endStamp = parseLocalStamp(n.end);
          const startStamp = parseLocalStamp(n.start);
          const endMs = endStamp ? endStamp.tsMs : (startStamp ? Math.round(startStamp.tsMs + total * 3600000) : Date.parse(`${keyDay}T07:00:00Z`));
          const spanHours = numVal(n.inBed) > 0 ? numVal(n.inBed) : total + (numVal(n.awake) || 0);
          const startMs = startStamp ? startStamp.tsMs : Math.round(endMs - spanHours * 3600000);
          sleepSessions.push({
            kind: 'night',
            nightDay: keyDay,
            stage: 'total',
            startMs,
            endMs,
            durationMin: Math.round(total * 600) / 10,
            deepH: numVal(n.deep),
            remH: numVal(n.rem),
            coreH: numVal(n.core),
            awakeH: numVal(n.awake),
            inBedH: numVal(n.inBed),
            source
          });
        } else if (item.seg) {
          const s = item.seg;
          const parts = String(key).split('|');
          const stage = normalizeSleepStage(s.stage || parts[1]);
          const s0 = parseLocalStamp(parts[2]);
          const s1 = parseLocalStamp(parts[3]);
          const h = numVal(s.h);
          const durMin = h !== null ? h * 60 : (s0 && s1 && s1.tsMs >= s0.tsMs ? (s1.tsMs - s0.tsMs) / 60000 : null);
          if (!(durMin > 0)) continue;
          const endMs = s1 ? s1.tsMs : (s0 ? Math.round(s0.tsMs + durMin * 60000) : Date.parse(`${day}T07:00:00Z`));
          const startMs = s0 ? s0.tsMs : Math.round(endMs - durMin * 60000);
          sleepSessions.push({
            kind: 'stage',
            nightDay: (s1 || s0) ? (s1 || s0).nightDay : day,
            stage,
            startMs,
            endMs,
            durationMin: Math.round(durMin * 100) / 100,
            deepH: null,
            remH: null,
            coreH: null,
            awakeH: null,
            inBedH: null,
            source: 'apple_health'
          });
        }
      }
    }
  }

  return { readings, sleepSessions };
}

function decodeXmlEntities(str) {
  return String(str || '').replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_, ent) => {
    if (ent === 'amp') return '&';
    if (ent === 'lt') return '<';
    if (ent === 'gt') return '>';
    if (ent === 'quot') return '"';
    if (ent === 'apos') return "'";
    if (ent.startsWith('#x') || ent.startsWith('#X')) {
      const code = parseInt(ent.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    }
    if (ent.startsWith('#')) {
      const code = parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    }
    return _;
  });
}

function parseXmlAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z0-9_:-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag)) !== null) {
    attrs[m[1]] = decodeXmlEntities(m[2]);
  }
  return attrs;
}

const FRACTIONAL_PCT_TYPES = new Set([
  'HKQuantityTypeIdentifierOxygenSaturation',
  'HKQuantityTypeIdentifierBodyFatPercentage'
]);

/**
 * Streams an Apple Health `export.xml` file line-by-line and invokes `onBatch({ readings, sleepSessions })`.
 * Converts fractional percentage types (e.g. SpO2 0.97 -> 97) and captures sleep stages + all numeric metrics.
 */
async function streamAppleHealthXml(filePath, onBatch, { batchSize = 5000 } = {}) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 256 * 1024 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let readings = [];
  let sleepSessions = [];
  let pendingTag = null;
  let totalReadings = 0;
  let totalSleep = 0;

  const flush = async () => {
    if (!readings.length && !sleepSessions.length) return;
    const batch = { readings, sleepSessions };
    readings = [];
    sleepSessions = [];
    await onBatch(batch);
  };

  const processRecordTag = async (tag) => {
    const a = parseXmlAttrs(tag);
    const rawType = a.type || '';
    if (!rawType) return;
    const source = cleanSource(a.sourceName);

    if (rawType === 'HKCategoryTypeIdentifierSleepAnalysis') {
      const s0 = parseLocalStamp(a.startDate);
      const s1 = parseLocalStamp(a.endDate || a.startDate);
      if (!s0 || !s1 || s1.tsMs <= s0.tsMs) return;
      const durationMin = Math.round(((s1.tsMs - s0.tsMs) / 60000) * 100) / 100;
      if (!(durationMin > 0)) return;
      sleepSessions.push({
        kind: 'stage',
        nightDay: s1.nightDay,
        stage: normalizeSleepStage(a.value),
        startMs: s0.tsMs,
        endMs: s1.tsMs,
        durationMin,
        deepH: null,
        remH: null,
        coreH: null,
        awakeH: null,
        inBedH: null,
        source
      });
      totalSleep++;
      if (readings.length + sleepSessions.length >= batchSize) await flush();
      return;
    }

    let val = numVal(a.value);
    if (val === null) return;
    const st = parseLocalStamp(a.startDate || a.creationDate || a.endDate);
    if (!st) return;

    let unit = normalizeUnit(a.unit);
    if (FRACTIONAL_PCT_TYPES.has(rawType) && unit === '%' && val > 0 && val <= 1) {
      val = Math.round(val * 10000) / 100;
    }

    readings.push({
      metric: normalizeMetricName(rawType),
      tsMs: st.tsMs,
      localTs: st.localTs,
      localDay: st.localDay,
      nightDay: st.nightDay,
      value: val,
      valMin: null,
      valMax: null,
      unit,
      source
    });
    totalReadings++;
    if (readings.length + sleepSessions.length >= batchSize) await flush();
  };

  for await (const line of rl) {
    if (pendingTag !== null) {
      pendingTag += ' ' + line.trim();
      if (pendingTag.includes('>')) {
        const full = pendingTag;
        pendingTag = null;
        await processRecordTag(full);
      }
      continue;
    }
    const idx = line.indexOf('<Record ');
    if (idx === -1) continue;
    const endIdx = line.indexOf('>', idx);
    if (endIdx === -1) {
      pendingTag = line.slice(idx);
      continue;
    }
    await processRecordTag(line.slice(idx, endIdx + 1));
  }

  await flush();
  return { totalReadings, totalSleep };
}

module.exports = {
  CANONICAL_METRICS,
  addDays,
  parseLocalStamp,
  normalizeMetricName,
  normalizeUnit,
  normalizeSleepStage,
  parseHealthAutoExportPayload,
  parseApexHealthStoreRaw,
  streamAppleHealthXml
};
