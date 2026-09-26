/**
 * APEX VELO // LAB - Ride file importers (.fit, .tcx, .csv).
 *
 * Zero-placeholder policy: a channel that is absent from the source file stays
 * null/0 and is rendered as "--" by the UI. No default cadence, heart rate,
 * wattage or pedal balance is ever injected.
 */
class VeloRideImporter {
  /** Builds the ride summary from 1 Hz samples. Only recorded channels contribute. */
  static summarize(samples, riderFtp, meta) {
    const powers = samples.map(s => Number(s.power) || 0);
    const hasPower = samples.some(s => Number(s.power) > 0);
    const duration = samples.length ? Math.max(samples.length, Math.round(samples[samples.length - 1].time || 0)) : 0;
    const p = VeloMetrics.stats(powers);
    const h = VeloMetrics.stats(samples.map(s => s.hr));
    const c = VeloMetrics.stats(samples.map(s => s.cadence));
    const np = hasPower ? (VeloMetrics.normalizedPower(powers) || p.avg) : 0;
    const ifac = hasPower && riderFtp > 0 ? np / riderFtp : 0;
    const tss = hasPower && riderFtp > 0 ? Math.round(((duration * np * ifac) / (riderFtp * 3600)) * 100) : 0;
    const kj = hasPower ? Math.round(VeloMetrics.workKjFromSamples(samples)) : 0;

    const balSamples = samples.filter(s => Number(s.leftBal) > 0 && Number(s.rightBal) > 0);
    const leftBal = balSamples.length ? Math.round((balSamples.reduce((a, s) => a + Number(s.leftBal), 0) / balSamples.length) * 10) / 10 : null;

    const last = samples[samples.length - 1] || {};
    const distanceKm = Number(last.dist) > 0 ? Math.round(Number(last.dist) * 100) / 100 : 0;
    const speeds = samples.map(s => Number(s.speed) || 0).filter(v => v > 0);

    return {
      ...meta,
      duration,
      durationMin: Math.round(duration / 60),
      np,
      tss,
      if: ifac ? ifac.toFixed(2) : 0,
      kj,
      totalCalories: kj ? VeloMetrics.kcalFromKj(kj) : 0,
      avgWatts: hasPower ? VeloMetrics.avgPower(samples.map(s => s.power)) : 0,
      maxWatts: p.max,
      avgHr: h.avg,
      maxHr: h.max,
      avgCadence: c.avg,
      maxCadence: c.max,
      distanceKm,
      totalDistanceMeters: distanceKm ? Math.round(distanceKm * 1000) : 0,
      avgSpeedKmh: distanceKm && duration ? Math.round((distanceKm / (duration / 3600)) * 10) / 10 : 0,
      maxSpeedKmh: speeds.length ? Math.round(Math.max(...speeds) * 10) / 10 : 0,
      leftBal,
      rightBal: leftBal === null ? null : Math.round((100 - leftBal) * 10) / 10,
      samplesCount: samples.length,
      samples
    };
  }

  static uid(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }

  // -------------------------------------------------------------------- TCX --
  static parseTcx(tcxXmlString, riderFtp = 185, profileName = 'Divan (HealthFit)') {
    const xmlDoc = new DOMParser().parseFromString(tcxXmlString, 'text/xml');
    const trackpoints = xmlDoc.getElementsByTagName('Trackpoint');
    if (!trackpoints.length) throw new Error('No trackpoints found in TCX file.');
    const text = (el, tag) => {
      const n = el.getElementsByTagName(tag)[0] || el.getElementsByTagNameNS('*', tag)[0];
      return n ? n.textContent.trim() : null;
    };

    const idNode = xmlDoc.getElementsByTagName('Id')[0];
    const firstTime = text(trackpoints[0], 'Time');
    const startIso = firstTime || (idNode ? idNode.textContent.trim() : new Date().toISOString());
    const startMs = new Date(startIso).getTime();

    const samples = [];
    for (let i = 0; i < trackpoints.length; i++) {
      const pt = trackpoints[i];
      const tStr = text(pt, 'Time');
      const t = tStr && Number.isFinite(startMs) ? Math.round((new Date(tStr).getTime() - startMs) / 1000) : i;
      const hrNode = pt.getElementsByTagName('HeartRateBpm')[0];
      const hr = hrNode ? parseInt(text(hrNode, 'Value'), 10) || 0 : 0;
      const watts = text(pt, 'Watts');
      const cad = text(pt, 'Cadence');
      const spd = text(pt, 'Speed');
      const dist = text(pt, 'DistanceMeters');
      samples.push({
        time: t,
        timestamp: tStr ? new Date(tStr).getTime() : undefined,
        power: watts !== null ? parseInt(watts, 10) || 0 : 0,
        cadence: cad !== null ? parseInt(cad, 10) || 0 : 0,
        hr,
        speed: spd !== null ? Math.round(parseFloat(spd) * 3.6 * 10) / 10 : null,
        dist: dist !== null ? parseFloat(dist) / 1000 : null
      });
    }

    return VeloRideImporter.summarize(samples, riderFtp, {
      id: VeloRideImporter.uid('imported_tcx'),
      date: new Date(startIso).toISOString(),
      profileName,
      title: 'Imported Ride (' + new Date(startIso).toLocaleDateString() + ')',
      source: 'TCX Import'
    });
  }

  // -------------------------------------------------------------------- CSV --
  /**
   * Accepts APEX VELO's own export (named header) as well as generic
   * "time,target,power,cadence,hr,left,right" files. Missing columns stay empty.
   */
  static parseCsv(csvString, profileName = 'Divan (HealthFit)', riderFtp = 185) {
    const lines = csvString.replace(/\r/g, '').trim().split('\n').filter(Boolean);
    if (lines.length < 2) throw new Error('Invalid CSV file.');
    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const find = (...names) => header.findIndex(h => names.some(n => h === n || h.startsWith(n)));
    const named = header.some(h => /[a-z]/.test(h));
    const col = named ? {
      time: find('time_s', 'timesec', 'time'),
      ts: find('timestamp_iso', 'timestamp'),
      target: find('target_w', 'targetwatts', 'target'),
      power: find('power_w', 'actualwatts', 'power', 'watts'),
      cad: find('cadence_rpm', 'cadencerpm', 'cadence'),
      hr: find('heart_rate_bpm', 'heartratebpm', 'hr', 'heart'),
      speed: find('speed_kmh', 'speedkmh', 'speed'),
      dist: find('distance_km', 'distancekm', 'distance'),
      left: find('left_balance_pct', 'leftbalancepct', 'left'),
      right: find('right_balance_pct', 'rightbalancepct', 'right')
    } : { time: 0, ts: -1, target: 1, power: 2, cad: 3, hr: 4, speed: -1, dist: -1, left: 5, right: 6 };

    const num = (parts, idx) => {
      if (idx < 0 || idx >= parts.length) return null;
      const v = parseFloat(parts[idx]);
      return Number.isFinite(v) ? v : null;
    };
    const samples = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 2) continue;
      const tsRaw = col.ts >= 0 ? parts[col.ts] : null;
      const tsMs = tsRaw ? (/^\d+$/.test(tsRaw) ? Number(tsRaw) : new Date(tsRaw).getTime()) : NaN;
      samples.push({
        time: num(parts, col.time) ?? (i - 1),
        timestamp: Number.isFinite(tsMs) ? tsMs : undefined,
        target: num(parts, col.target) ?? 0,
        power: num(parts, col.power) ?? 0,
        cadence: num(parts, col.cad) ?? 0,
        hr: num(parts, col.hr) ?? 0,
        speed: num(parts, col.speed),
        dist: num(parts, col.dist),
        leftBal: num(parts, col.left),
        rightBal: num(parts, col.right)
      });
    }
    if (!samples.length) throw new Error('CSV contained no telemetry rows.');
    const first = samples[0];
    const startMs = Number.isFinite(first.timestamp) ? first.timestamp - (first.time || 0) * 1000 : Date.now();
    return VeloRideImporter.summarize(samples, riderFtp, {
      id: VeloRideImporter.uid('imported_csv'),
      date: new Date(startMs).toISOString(),
      profileName,
      title: 'Imported Telemetry CSV',
      source: 'CSV Import'
    });
  }

  // -------------------------------------------------------------------- FIT --
  static parseFit(arrayBuffer, profileName = 'Divan (HealthFit)', riderFtp = 185) {
    const dv = new DataView(arrayBuffer);
    if (dv.byteLength < 14) throw new Error('File too short for FIT format.');
    const headerSize = dv.getUint8(0);
    let tag = '';
    for (let i = 8; i < 12; i++) tag += String.fromCharCode(dv.getUint8(i));
    if (tag !== '.FIT') throw new Error('Invalid FIT signature: ' + tag);
    const dataSize = dv.getUint32(4, true);
    const endPos = Math.min(dv.byteLength, headerSize + dataSize);

    let offset = headerSize;
    const defs = {};
    const records = [];
    let lastTimestamp = 0;

    while (offset < endPos) {
      const headerByte = dv.getUint8(offset++);
      if (headerByte & 0x80) {                         // compressed-timestamp data message
        const localId = (headerByte & 0x60) >> 5;
        const timeOffset = headerByte & 0x1f;
        const def = defs[localId];
        if (!def) break;
        let ts = (lastTimestamp & ~0x1f) + timeOffset;
        if (timeOffset < (lastTimestamp & 0x1f)) ts += 0x20;
        lastTimestamp = ts;
        const msg = VeloRideImporter._readFitMsg(dv, offset, def);
        offset += def.totalSize;
        if (def.globalMesg === 20) { msg.timestamp = ts; records.push(msg); }
        continue;
      }
      const isDefinition = (headerByte & 0x40) !== 0;
      const hasDevData = (headerByte & 0x20) !== 0;
      const localId = headerByte & 0x0f;
      if (isDefinition) {
        if (offset + 5 > dv.byteLength) break;
        const isBigEndian = dv.getUint8(offset + 1) === 1;
        const globalMesg = dv.getUint16(offset + 2, !isBigEndian);
        const numFields = dv.getUint8(offset + 4);
        offset += 5;
        const fields = [];
        let totalSize = 0;
        for (let i = 0; i < numFields && offset + 3 <= dv.byteLength; i++) {
          fields.push({ num: dv.getUint8(offset), size: dv.getUint8(offset + 1), type: dv.getUint8(offset + 2) });
          totalSize += dv.getUint8(offset + 1);
          offset += 3;
        }
        if (hasDevData && offset < dv.byteLength) {
          const numDevFields = dv.getUint8(offset++);
          for (let i = 0; i < numDevFields && offset + 3 <= dv.byteLength; i++) {
            totalSize += dv.getUint8(offset + 1);
            offset += 3;
          }
        }
        defs[localId] = { globalMesg, isBigEndian, fields, totalSize };
      } else {
        const def = defs[localId];
        if (!def) break;
        const msg = VeloRideImporter._readFitMsg(dv, offset, def);
        offset += def.totalSize;
        if (def.globalMesg === 20) {
          if (msg.timestamp) lastTimestamp = msg.timestamp;
          records.push(msg);
        }
      }
    }

    const firstTs = (records.find(r => r.timestamp) || {}).timestamp || 0;
    const startMs = firstTs ? (firstTs + 631065600) * 1000 : Date.now();
    const samples = records.map((r, i) => {
      // left_right_balance: bit 7 = the stored value is the RIGHT pedal share.
      let leftBal = null, rightBal = null;
      if (r.left_right_balance !== undefined) {
        const pct = r.left_right_balance & 0x7F;
        if (pct > 0 && pct < 100) {
          if (r.left_right_balance & 0x80) { rightBal = pct; leftBal = 100 - pct; } else { leftBal = pct; rightBal = 100 - pct; }
        }
      }
      return {
        time: r.timestamp && firstTs ? r.timestamp - firstTs : i,
        timestamp: r.timestamp ? (r.timestamp + 631065600) * 1000 : undefined,
        power: r.power || 0,
        cadence: r.cadence || 0,
        hr: r.heart_rate || 0,
        speed: r.speed !== undefined ? Math.round(r.speed * 3.6 * 10) / 10 : null,
        dist: r.distance !== undefined ? r.distance / 1000 : null,
        leftBal,
        rightBal
      };
    });

    const rideDate = new Date(startMs).toISOString();
    return VeloRideImporter.summarize(samples, riderFtp, {
      id: VeloRideImporter.uid('fit'),
      title: 'FIT Ride (' + new Date(rideDate).toLocaleDateString() + ')',
      date: rideDate,
      profileName,
      source: 'FIT Import'
    });
  }

  static _readFitMsg(dv, startOff, def) {
    const msg = {};
    let off = startOff;
    const le = !def.isBigEndian;
    for (const f of def.fields) {
      if (off + f.size > dv.byteLength) break;
      if (f.size === 1) {
        const val = dv.getUint8(off);
        if (val !== 0xff) {
          if (f.num === 3) msg.heart_rate = val;
          else if (f.num === 4) msg.cadence = val;
          else if (f.num === 30) msg.left_right_balance = val;
        }
      } else if (f.size === 2) {
        const val = dv.getUint16(off, le);
        if (val !== 0xffff) {
          if (f.num === 7) msg.power = val;
          else if (f.num === 6) msg.speed = val / 1000;
        }
      } else if (f.size === 4) {
        const val = dv.getUint32(off, le);
        if (val !== 0xffffffff) {
          if (f.num === 253) msg.timestamp = val;
          else if (f.num === 5) msg.distance = val / 100;
          else if (f.num === 73 && msg.speed === undefined) msg.speed = val / 1000; // enhanced_speed
        }
      }
      off += f.size;
    }
    return msg;
  }
}

if (typeof window !== 'undefined') window.VeloRideImporter = VeloRideImporter;
