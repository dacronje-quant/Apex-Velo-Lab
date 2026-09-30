/**
 * APEX VELO // LAB - Activity file encoders (FIT, TCX, CSV).
 *
 * Pure builders: they take a ride record (plus its recorded 1 Hz samples) and
 * return file contents. Nothing is invented: fields that were not recorded are
 * written as the format's "invalid"/absent value, never as a guess.
 *
 * Sample shape: { time (s from start), timestamp (ms epoch, optional), target,
 *                 power, cadence, hr, speed (km/h), dist (km), leftBal, rightBal }
 */
class VeloExport {
  // ---------------------------------------------------------------- shared --
  static FIT_EPOCH_OFFSET = 631065600; // seconds between 1970-01-01 and 1989-12-31 (FIT epoch)

  static startDateOf(ride, samples) {
    const s0 = samples && samples[0];
    if (s0 && Number.isFinite(s0.timestamp) && Number.isFinite(s0.time)) {
      return new Date(s0.timestamp - s0.time * 1000);
    }
    const d = new Date(ride && ride.date ? ride.date : Date.now());
    return isNaN(d.getTime()) ? new Date() : d;
  }

  static sampleDate(start, s) {
    if (Number.isFinite(s.timestamp)) return new Date(s.timestamp);
    return new Date(start.getTime() + (Number(s.time) || 0) * 1000);
  }

  static fileStem(ride) {
    const d = VeloExport.startDateOf(ride, ride && ride.samples);
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    const title = String((ride && ride.title) || 'ride').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    return `apex_velo_${stamp}_${title || 'ride'}`;
  }

  /** Totals derived strictly from the record + samples (null = not recorded). */
  static totals(ride, samples) {
    const n = samples.length;
    const pos = (v) => (Number(v) > 0 ? Number(v) : null);
    const duration = pos(ride.duration) || VeloMetrics.toOneHz(samples).length;
    let distM = pos(ride.totalDistanceMeters) || (pos(ride.distanceKm) ? Math.round(ride.distanceKm * 1000) : null);
    if (!distM && n && pos(samples[n - 1].dist)) distM = Math.round(samples[n - 1].dist * 1000);
    let maxSpeed = pos(ride.maxSpeedKmh);
    if (!maxSpeed && n) {
      const m = VeloMetrics.stats(samples.map(s => s.speed)).max;
      maxSpeed = m > 0 ? m : null;
    }
    const kj = pos(ride.kj) || (n ? Math.round(VeloMetrics.workKjFromSamples(samples)) || null : null);
    const kcal = pos(ride.totalCalories) || (kj ? VeloMetrics.kcalFromKj(kj) : null);
    const p = VeloMetrics.stats(samples.map(s => s.power));
    const h = VeloMetrics.stats(samples.map(s => s.hr));
    const c = VeloMetrics.stats(samples.map(s => s.cadence));
    return {
      duration,
      distM,
      avgSpeed: pos(ride.avgSpeedKmh) || (distM && duration ? (distM / 1000) / (duration / 3600) : null),
      maxSpeed,
      kj,
      kcal,
      avgPower: pos(ride.avgWatts) || (p.count ? VeloMetrics.avgPower(samples.map(s => s.power)) : null),
      maxPower: pos(ride.maxWatts) || (p.count ? p.max : null),
      np: pos(ride.np),
      tss: pos(ride.tss),
      ifac: pos(parseFloat(ride.if)),
      avgHr: pos(ride.avgHr) || (h.count ? h.avg : null),
      maxHr: pos(ride.maxHr) || (h.count ? h.max : null),
      avgCad: pos(ride.avgCadence) || (c.count ? c.avg : null),
      maxCad: pos(ride.maxCadence) || (c.count ? c.max : null)
    };
  }

  // ------------------------------------------------------------------- CSV --
  static CSV_HEADER = ['time_s', 'timestamp_iso', 'target_w', 'power_w', 'cadence_rpm', 'heart_rate_bpm', 'speed_kmh', 'distance_km', 'left_balance_pct', 'right_balance_pct', 'segment_start'];

  static buildCsv(ride, samples) {
    const cell = (v, digits) => {
      if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return '';
      return digits !== undefined ? Number(v).toFixed(digits) : String(v);
    };
    if (!samples || !samples.length) {
      // Summary-only activity: one honest row of the recorded session totals.
      const t = VeloExport.totals(ride, []);
      const hdr = 'date_iso,title,duration_s,distance_km,avg_power_w,max_power_w,np_w,tss,if,work_kj,avg_hr_bpm,max_hr_bpm,avg_cadence_rpm';
      const title = '"' + String(ride.title || '').replace(/"/g, '""') + '"';
      const row = [new Date(ride.date).toISOString(), title, cell(t.duration), cell(t.distM ? t.distM / 1000 : null, 2),
        cell(t.avgPower), cell(t.maxPower), cell(t.np), cell(t.tss), cell(t.ifac, 2), cell(t.kj), cell(t.avgHr), cell(t.maxHr), cell(t.avgCad)].join(',');
      return `${hdr}\n${row}\n`;
    }
    const start = VeloExport.startDateOf(ride, samples);
    const lines = [VeloExport.CSV_HEADER.join(',')];
    for (const s of samples) {
      const hasBal = Number(s.leftBal) > 0 && Number(s.rightBal) > 0;
      lines.push([
        cell(s.time), VeloExport.sampleDate(start, s).toISOString(), cell(s.target), cell(s.power),
        cell(s.cadence > 0 ? s.cadence : null), cell(s.hr > 0 ? s.hr : null),
        cell(s.speed, 1), cell(s.dist, 3),
        hasBal ? cell(s.leftBal, 1) : '', hasBal ? cell(s.rightBal, 1) : '', s.segmentStart ? '1' : ''
      ].join(','));
    }
    return lines.join('\n') + '\n';
  }

  // ------------------------------------------------------------------- TCX --
  static xmlEscape(s) {
    return String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  }

  static buildTcx(ride, samples) {
    samples = VeloMetrics.toOneHz(samples);
    const start = VeloExport.startDateOf(ride, samples);
    const t = VeloExport.totals(ride, samples);
    const iso = start.toISOString();
    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">');
    out.push('  <Activities>');
    out.push('    <Activity Sport="Biking">');
    out.push(`      <Id>${iso}</Id>`);
    out.push(`      <Lap StartTime="${iso}">`);
    out.push(`        <TotalTimeSeconds>${t.duration || 0}</TotalTimeSeconds>`);
    out.push(`        <DistanceMeters>${t.distM || 0}</DistanceMeters>`);
    if (t.maxSpeed) out.push(`        <MaximumSpeed>${(t.maxSpeed / 3.6).toFixed(3)}</MaximumSpeed>`);
    out.push(`        <Calories>${t.kcal || 0}</Calories>`);
    if (t.avgHr) out.push(`        <AverageHeartRateBpm><Value>${t.avgHr}</Value></AverageHeartRateBpm>`);
    if (t.maxHr) out.push(`        <MaximumHeartRateBpm><Value>${t.maxHr}</Value></MaximumHeartRateBpm>`);
    out.push('        <Intensity>Active</Intensity>');
    if (t.avgCad) out.push(`        <Cadence>${Math.min(254, t.avgCad)}</Cadence>`);
    out.push('        <TriggerMethod>Manual</TriggerMethod>');
    if (samples.length) {
      out.push('        <Track>');
      for (const [i, s] of samples.entries()) {
        if (VeloMetrics.isSampleBreak(samples[i - 1], s)) out.push('        </Track>', '        <Track>');
        out.push('          <Trackpoint>');
        out.push(`            <Time>${VeloExport.sampleDate(start, s).toISOString()}</Time>`);
        if (Number.isFinite(Number(s.dist)) && s.dist !== null && s.dist !== undefined) out.push(`            <DistanceMeters>${(Number(s.dist) * 1000).toFixed(1)}</DistanceMeters>`);
        if (s.hr > 0) out.push(`            <HeartRateBpm><Value>${Math.round(s.hr)}</Value></HeartRateBpm>`);
        if (s.cadence > 0) out.push(`            <Cadence>${Math.min(254, Math.round(s.cadence))}</Cadence>`);
        const ext = [];
        if (Number.isFinite(Number(s.speed)) && s.speed !== null && s.speed !== undefined) ext.push(`<ns3:Speed>${(Number(s.speed) / 3.6).toFixed(3)}</ns3:Speed>`);
        if (Number.isFinite(Number(s.power)) && s.power !== null && s.power !== undefined) ext.push(`<ns3:Watts>${Math.max(0, Math.round(s.power))}</ns3:Watts>`);
        if (ext.length) out.push(`            <Extensions><ns3:TPX>${ext.join('')}</ns3:TPX></Extensions>`);
        out.push('          </Trackpoint>');
      }
      out.push('        </Track>');
    } else {
      out.push('        <Notes>Summary-only session: second-by-second trackpoints were not recorded for this activity.</Notes>');
    }
    const lx = [];
    if (t.avgSpeed) lx.push(`<ns3:AvgSpeed>${(t.avgSpeed / 3.6).toFixed(3)}</ns3:AvgSpeed>`);
    if (t.avgPower) lx.push(`<ns3:AvgWatts>${t.avgPower}</ns3:AvgWatts>`);
    if (t.maxPower) lx.push(`<ns3:MaxWatts>${t.maxPower}</ns3:MaxWatts>`);
    if (lx.length) out.push(`        <Extensions><ns3:LX>${lx.join('')}</ns3:LX></Extensions>`);
    out.push('      </Lap>');
    out.push(`      <Notes>${VeloExport.xmlEscape(ride.title || 'APEX VELO Session')}</Notes>`);
    out.push('    </Activity>');
    out.push('  </Activities>');
    out.push('</TrainingCenterDatabase>');
    return out.join('\n') + '\n';
  }

  // ------------------------------------------------------------------- FIT --
  static FIT_TYPES = {
    enum:   { id: 0x00, size: 1, invalid: 0xFF },
    uint8:  { id: 0x02, size: 1, invalid: 0xFF },
    uint16: { id: 0x84, size: 2, invalid: 0xFFFF },
    uint32: { id: 0x86, size: 4, invalid: 0xFFFFFFFF },
    uint32z:{ id: 0x8C, size: 4, invalid: 0x00000000 }
  };

  static fitCrc(crc, byte) {
    const T = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
    let tmp = T[crc & 0xF];
    crc = (crc >> 4) & 0x0FFF;
    crc = crc ^ tmp ^ T[byte & 0xF];
    tmp = T[crc & 0xF];
    crc = (crc >> 4) & 0x0FFF;
    return crc ^ tmp ^ T[(byte >> 4) & 0xF];
  }

  static fitCrcOf(bytes, start = 0, end = bytes.length) {
    let crc = 0;
    for (let i = start; i < end; i++) crc = VeloExport.fitCrc(crc, bytes[i]);
    return crc;
  }

  /**
   * Encodes a FIT activity (file_id, event, record x N, event, lap, session, activity).
   * Returns a Uint8Array. Record fields that were not measured are written as FIT invalid values.
   */
  static buildFit(ride, samples) {
    samples = VeloMetrics.toOneHz(samples);
    const TY = VeloExport.FIT_TYPES;
    const start = VeloExport.startDateOf(ride, samples);
    const t = VeloExport.totals(ride, samples);
    const fitTs = (date) => Math.max(0, Math.round(date.getTime() / 1000) - VeloExport.FIT_EPOCH_OFFSET);
    const startTs = fitTs(start);
    // Imported 0-based points represent the second starting at their timestamp; cockpit
    // 1-based points are taken at the end of the recorded second. Timer events enclose
    // each full second, including the last one, and resume before the first resumed tick.
    const tickAtEnd = samples.length && samples[0].time !== 0 ? 1 : 0;
    const sampleStartTs = s => fitTs(VeloExport.sampleDate(start, s)) - tickAtEnd;
    const sampleEndTs = s => sampleStartTs(s) + 1;
    const timerStartTs = samples.length ? sampleStartTs(samples[0]) : startTs;
    const endTs = samples.length ? sampleEndTs(samples[samples.length - 1]) : startTs + (t.duration || 0);

    const bytes = [];
    const defs = {};
    const u = (type, v) => {
      const spec = TY[type];
      const missing = v === null || v === undefined || !Number.isFinite(Number(v));
      const maxValid = type === 'uint32z' ? 0xFFFFFFFF : spec.invalid - 1;
      const val = missing ? spec.invalid : Math.max(0, Math.min(maxValid, Math.round(Number(v))));
      for (let i = 0; i < spec.size; i++) bytes.push(Math.floor(val / Math.pow(256, i)) & 0xFF);
    };
    const define = (local, globalNum, fields) => {
      defs[local] = fields;
      bytes.push(0x40 | local, 0, 0, globalNum & 0xFF, (globalNum >> 8) & 0xFF, fields.length);
      for (const [num, type] of fields) bytes.push(num, TY[type].size, TY[type].id);
    };
    const write = (local, values) => {
      bytes.push(local & 0x0F);
      defs[local].forEach(([, type], i) => u(type, values[i]));
    };

    // file_id (0)
    define(0, 0, [[0, 'enum'], [1, 'uint16'], [2, 'uint16'], [3, 'uint32z'], [4, 'uint32']]);
    write(0, [4 /* activity */, 255 /* development */, 1, (startTs % 0xFFFFFFFE) + 1, startTs]);

    // event (21): timer start / stop_all
    define(1, 21, [[253, 'uint32'], [0, 'enum'], [1, 'enum']]);
    write(1, [timerStartTs, 0 /* timer */, 0 /* start */]);

    // record (20)
    if (samples.length) {
      define(2, 20, [[253, 'uint32'], [7, 'uint16'], [4, 'uint8'], [3, 'uint8'], [6, 'uint16'], [5, 'uint32'], [30, 'uint8']]);
      for (const [i, s] of samples.entries()) {
        const ts = fitTs(VeloExport.sampleDate(start, s));
        if (VeloMetrics.isSampleBreak(samples[i - 1], s)) {
          write(1, [sampleEndTs(samples[i - 1]), 0, 4 /* stop_all */]);
          write(1, [sampleStartTs(s), 0, 0 /* start */]);
        }
        const speed = (s.speed === null || s.speed === undefined || !Number.isFinite(Number(s.speed))) ? null : (Number(s.speed) / 3.6) * 1000;
        const dist = (s.dist === null || s.dist === undefined || !Number.isFinite(Number(s.dist))) ? null : Number(s.dist) * 1000 * 100;
        // left_right_balance: bit 7 set = value is the RIGHT pedal contribution (%).
        const bal = (Number(s.rightBal) > 0 && Number(s.leftBal) > 0) ? (Math.round(Number(s.rightBal)) & 0x7F) | 0x80 : null;
        write(2, [ts,
          Number.isFinite(Number(s.power)) && s.power !== null ? Math.max(0, s.power) : null,
          s.cadence > 0 ? Math.min(254, s.cadence) : null,
          s.hr > 0 ? Math.min(254, s.hr) : null,
          speed, dist, bal]);
      }
    }

    write(1, [endTs, 0 /* timer */, 4 /* stop_all */]);

    const timerMs = t.duration * 1000;
    const elapsedMs = Math.max(t.duration, endTs - startTs) * 1000;
    const distCm = t.distM ? t.distM * 100 : null;
    const avgSpeed = t.avgSpeed ? (t.avgSpeed / 3.6) * 1000 : null;
    const maxSpeed = t.maxSpeed ? (t.maxSpeed / 3.6) * 1000 : null;

    // lap (19)
    define(3, 19, [[253, 'uint32'], [2, 'uint32'], [7, 'uint32'], [8, 'uint32'], [9, 'uint32'], [11, 'uint16'],
      [13, 'uint16'], [14, 'uint16'], [15, 'uint8'], [16, 'uint8'], [17, 'uint8'], [18, 'uint8'], [19, 'uint16'], [20, 'uint16'],
      [0, 'enum'], [1, 'enum'], [25, 'enum']]);
    write(3, [endTs, startTs, elapsedMs, timerMs, distCm, t.kcal, avgSpeed, maxSpeed, t.avgHr, t.maxHr, t.avgCad, t.maxCad,
      t.avgPower, t.maxPower, 9 /* lap */, 1 /* stop */, 2 /* cycling */]);

    // session (18)
    define(4, 18, [[253, 'uint32'], [2, 'uint32'], [7, 'uint32'], [8, 'uint32'], [9, 'uint32'], [11, 'uint16'],
      [14, 'uint16'], [15, 'uint16'], [16, 'uint8'], [17, 'uint8'], [18, 'uint8'], [19, 'uint8'], [20, 'uint16'], [21, 'uint16'],
      [34, 'uint16'], [35, 'uint16'], [36, 'uint16'], [48, 'uint32'], [25, 'uint16'], [26, 'uint16'],
      [0, 'enum'], [1, 'enum'], [5, 'enum'], [6, 'enum']]);
    write(4, [endTs, startTs, elapsedMs, timerMs, distCm, t.kcal, avgSpeed, maxSpeed, t.avgHr, t.maxHr, t.avgCad, t.maxCad,
      t.avgPower, t.maxPower, t.np, t.tss ? t.tss * 10 : null, t.ifac ? t.ifac * 1000 : null, t.kj ? t.kj * 1000 : null,
      0, 1, 8 /* session */, 1 /* stop */, 2 /* cycling */, 6 /* indoor_cycling */]);

    // activity (34)
    define(5, 34, [[253, 'uint32'], [0, 'uint32'], [1, 'uint16'], [2, 'enum'], [3, 'enum'], [4, 'enum']]);
    write(5, [endTs, timerMs, 1, 0 /* manual */, 26 /* activity */, 1 /* stop */]);

    // Header (14 bytes) + data + file CRC
    const dataSize = bytes.length;
    const header = [14, 0x20, 2132 & 0xFF, (2132 >> 8) & 0xFF,
      dataSize & 0xFF, (dataSize >> 8) & 0xFF, (dataSize >> 16) & 0xFF, (dataSize >>> 24) & 0xFF,
      0x2E, 0x46, 0x49, 0x54];
    const hCrc = VeloExport.fitCrcOf(header);
    header.push(hCrc & 0xFF, (hCrc >> 8) & 0xFF);
    const all = new Uint8Array(header.length + dataSize + 2);
    all.set(header, 0);
    all.set(bytes, header.length);
    const fCrc = VeloExport.fitCrcOf(all, 0, header.length + dataSize);
    all[all.length - 2] = fCrc & 0xFF;
    all[all.length - 1] = (fCrc >> 8) & 0xFF;
    return all;
  }
}

if (typeof window !== 'undefined') window.VeloExport = VeloExport;
