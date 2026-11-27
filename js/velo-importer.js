/**
 * APEX VELO // LAB - Ride file importers (.fit, .tcx, .gpx, .csv).
 *
 * Zero-placeholder policy: a channel that is absent from the source file stays
 * null/0 and is rendered as "--" by the UI. No default cadence, heart rate,
 * wattage or pedal balance is ever injected.
 */
class VeloRideImporter {
  /** Builds the ride summary from 1 Hz samples. Only recorded channels contribute. */
  static summarize(rawSamples, riderFtp, meta) {
    // Smart-recorded files (a point every few seconds) become 1 Hz first, so NP and peaks are right.
    const samples = VeloMetrics.toOneHz(rawSamples);
    const powers = samples.map(s => Number(s.power) || 0);
    const hasPower = samples.some(s => Number(s.power) > 0);
    const duration = samples.length;
    const p = VeloMetrics.stats(powers);
    const h = VeloMetrics.stats(samples.map(s => s.hr));
    const c = VeloMetrics.stats(samples.map(s => s.cadence));
    const np = hasPower ? (VeloMetrics.normalizedPower(samples) || VeloMetrics.avgPower(powers)) : 0;
    const ifac = hasPower && riderFtp > 0 ? np / riderFtp : 0;
    const tss = hasPower && riderFtp > 0 ? Math.round(((duration * np * ifac) / (riderFtp * 3600)) * 100) : 0;
    const kj = hasPower ? Math.round(VeloMetrics.workKjFromSamples(samples)) : 0;

    const balSamples = samples.filter(s => Number(s.leftBal) > 0 && Number(s.rightBal) > 0);
    const leftBal = balSamples.length ? Math.round((balSamples.reduce((a, s) => a + Number(s.leftBal), 0) / balSamples.length) * 10) / 10 : null;

    const last = samples[samples.length - 1] || {};
    const distanceKm = Number(last.dist) > 0 ? Math.round(Number(last.dist) * 100) / 100 : 0;
    const speeds = samples.map(s => Number(s.speed) || 0).filter(v => v > 0);
    const derived = VeloRideImporter._sampleRollups(samples, meta);

    return {
      ...derived,
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
      maxSpeedKmh: speeds.length ? Math.round(VeloMetrics.stats(speeds).max * 10) / 10 : 0,
      leftBal,
      rightBal: leftBal === null ? null : Math.round((100 - leftBal) * 10) / 10,
      samplesCount: samples.length,
      samples
    };
  }

  /** Optional ride-level rollups (elevation, temperature, cycling dynamics) computed strictly when present. */
  static _sampleRollups(samples, meta = {}) {
    const out = {};
    let gain = 0, loss = 0, prevAlt = null, hasAlt = false;
    let tempSum = 0, tempCnt = 0, maxTemp = -Infinity;
    let lteSum = 0, lteCnt = 0, rteSum = 0, rteCnt = 0;
    let lpsSum = 0, lpsCnt = 0, rpsSum = 0, rpsCnt = 0;
    for (const s of samples || []) {
      if (Number.isFinite(s.alt)) {
        hasAlt = true;
        if (prevAlt === null) prevAlt = s.alt;
        else {
          const d = s.alt - prevAlt;
          if (d >= 1.0) { gain += d; prevAlt = s.alt; }
          else if (d <= -1.0) { loss += -d; prevAlt = s.alt; }
        }
      }
      if (Number.isFinite(s.temp)) { tempSum += s.temp; tempCnt++; if (s.temp > maxTemp) maxTemp = s.temp; }
      if (s.leftTe > 0) { lteSum += s.leftTe; lteCnt++; }
      if (s.rightTe > 0) { rteSum += s.rightTe; rteCnt++; }
      if (s.leftPs > 0) { lpsSum += s.leftPs; lpsCnt++; }
      if (s.rightPs > 0) { rpsSum += s.rightPs; rpsCnt++; }
    }
    const r1 = (v) => Math.round(v * 10) / 10;
    if (hasAlt && meta.elevationGainM === undefined) out.elevationGainM = Math.round(gain);
    if (hasAlt && meta.elevationLossM === undefined) out.elevationLossM = Math.round(loss);
    if (tempCnt && meta.avgTempC === undefined) out.avgTempC = r1(tempSum / tempCnt);
    if (tempCnt && meta.maxTempC === undefined) out.maxTempC = r1(maxTemp);
    if (lteCnt && meta.avgLeftTe === undefined) out.avgLeftTe = r1(lteSum / lteCnt);
    if (rteCnt && meta.avgRightTe === undefined) out.avgRightTe = r1(rteSum / rteCnt);
    if (lpsCnt && meta.avgLeftPs === undefined) out.avgLeftPs = r1(lpsSum / lpsCnt);
    if (rpsCnt && meta.avgRightPs === undefined) out.avgRightPs = r1(rpsSum / rpsCnt);
    return out;
  }

  static uid(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }

  // ------------------------------------------------------------------- XML --
  /** Text of the first <tag> (any namespace prefix) inside an XML fragment, or null. Works without DOMParser (Web Workers). */
  static _xmlText(block, tag) {
    const m = block.match(new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>((?:<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|[^<])*)<`));
    return m ? VeloRideImporter._xmlDecode(m[1].trim()) : null;
  }

  /** Inner text of every <tag>...</tag> element (any namespace prefix). */
  static _xmlBlocks(text, tag) {
    const out = [];
    const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>)`, 'g');
    let m;
    while ((m = re.exec(text))) out.push({ attrs: m[1] || '', body: m[2] || '' });
    return out;
  }

  static _xmlAttr(attrs, name) {
    const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`));
    return m ? VeloRideImporter._xmlDecode(m[2] ?? m[3]) : null;
  }

  static _xmlDecode(s) {
    return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
  }

  // -------------------------------------------------------------------- TCX --
  /** Trackpoints of a TCX file as plain values; DOMParser when the page has it, a tolerant scanner in Web Workers. */
  static _tcxPoints(tcxXmlString) {
    if (typeof DOMParser !== 'undefined') {
      const xmlDoc = new DOMParser().parseFromString(tcxXmlString, 'text/xml');
      const trackpoints = xmlDoc.getElementsByTagName('Trackpoint');
      const text = (el, tag) => {
        const n = el.getElementsByTagName(tag)[0] || el.getElementsByTagNameNS('*', tag)[0];
        return n ? n.textContent.trim() : null;
      };
      const points = [];
      const tracks = [];
      for (let i = 0; i < trackpoints.length; i++) {
        const pt = trackpoints[i];
        let track = pt.parentNode;
        while (track && track.localName !== 'Track') track = track.parentNode;
        let ti = tracks.indexOf(track);
        if (ti < 0) { tracks.push(track); ti = tracks.length - 1; }
        const hrNode = pt.getElementsByTagName('HeartRateBpm')[0];
        points.push({ track: ti, time: text(pt, 'Time'), hr: hrNode ? text(hrNode, 'Value') : null, watts: text(pt, 'Watts'),
          cad: text(pt, 'Cadence'), spd: text(pt, 'Speed'), dist: text(pt, 'DistanceMeters') });
      }
      const idNode = xmlDoc.getElementsByTagName('Id')[0];
      const act = xmlDoc.getElementsByTagName('Activity')[0];
      return { points, id: idNode ? idNode.textContent.trim() : null, sport: act ? act.getAttribute('Sport') : null };
    }
    const X = VeloRideImporter;
    const points = [];
    X._xmlBlocks(tcxXmlString, 'Track').forEach((track, ti) => {
      for (const pt of X._xmlBlocks(track.body, 'Trackpoint')) {
        const hrBlock = X._xmlBlocks(pt.body, 'HeartRateBpm')[0];
        points.push({ track: ti, time: X._xmlText(pt.body, 'Time'), hr: hrBlock ? X._xmlText(hrBlock.body, 'Value') : null, watts: X._xmlText(pt.body, 'Watts'),
          cad: X._xmlText(pt.body, 'Cadence'), spd: X._xmlText(pt.body, 'Speed'), dist: X._xmlText(pt.body, 'DistanceMeters') });
      }
    });
    const act = X._xmlBlocks(tcxXmlString, 'Activity')[0];
    return { points, id: X._xmlText(tcxXmlString, 'Id'), sport: act ? X._xmlAttr(act.attrs, 'Sport') : null };
  }

  static parseTcx(tcxXmlString, riderFtp = 185, profileName = 'Imported rider') {
    const { points, id, sport } = VeloRideImporter._tcxPoints(tcxXmlString);
    if (!points.length) throw new Error('No trackpoints found in TCX file.');
    const startIso = points[0].time || id || new Date().toISOString();
    const startMs = new Date(startIso).getTime();

    const samples = points.map((pt, i) => {
      const tStr = pt.time;
      return {
        time: tStr && Number.isFinite(startMs) ? Math.round((new Date(tStr).getTime() - startMs) / 1000) : i,
        segmentStart: i > 0 && pt.track !== points[i - 1].track,
        timestamp: tStr ? new Date(tStr).getTime() : undefined,
        power: pt.watts !== null ? parseInt(pt.watts, 10) || 0 : 0,
        cadence: pt.cad !== null ? parseInt(pt.cad, 10) || 0 : 0,
        hr: pt.hr !== null ? parseInt(pt.hr, 10) || 0 : 0,
        speed: pt.spd !== null ? Math.round(parseFloat(pt.spd) * 3.6 * 10) / 10 : null,
        dist: pt.dist !== null ? parseFloat(pt.dist) / 1000 : null
      };
    });

    return VeloRideImporter.summarize(samples, riderFtp, {
      id: VeloRideImporter.uid('imported_tcx'),
      date: new Date(startIso).toISOString(),
      profileName,
      title: 'Imported Ride (' + new Date(startIso).toLocaleDateString() + ')',
      source: 'TCX Import',
      ...(sport ? { fileSport: sport } : {})
    });
  }

  // -------------------------------------------------------------------- GPX --
  /**
   * GPX tracks (Strava, Garmin, Komoot, Wahoo exports). Speed and distance come from the coordinates;
   * heart rate, cadence and power from the usual Garmin/Strava extensions when present.
   */
  static parseGpx(gpxXmlString, profileName = 'Imported rider', riderFtp = 185) {
    const X = VeloRideImporter;
    const trk = X._xmlBlocks(gpxXmlString, 'trk')[0];
    const name = (trk && X._xmlText(trk.body.split(/<(?:[\w.-]+:)?trkseg\b/)[0], 'name')) || null;
    const type = (trk && X._xmlText(trk.body.split(/<(?:[\w.-]+:)?trkseg\b/)[0], 'type')) || null;
    const raw = [];
    X._xmlBlocks(trk ? trk.body : gpxXmlString, 'trkseg').forEach((seg, si) => {
      X._xmlBlocks(seg.body, 'trkpt').forEach((pt, pi) => {
        const t = Date.parse(X._xmlText(pt.body, 'time') || '');
        if (!Number.isFinite(t)) return;
        const num = (tag) => { const v = parseFloat(X._xmlText(pt.body, tag)); return Number.isFinite(v) ? v : null; };
        raw.push({ seg: si, newSeg: pi === 0, t, lat: parseFloat(X._xmlAttr(pt.attrs, 'lat')), lon: parseFloat(X._xmlAttr(pt.attrs, 'lon')),
          hr: num('hr') ?? num('heartrate'), cad: num('cad') ?? num('cadence'), power: num('power') ?? num('watts') });
      });
    });
    if (!raw.length) throw new Error('No timed track points found in GPX file.');
    raw.sort((a, b) => a.t - b.t);
    const startMs = raw[0].t;
    const R = 6371.0088;
    const rad = (d) => d * Math.PI / 180;
    let distKm = 0;
    const samples = raw.map((p, i) => {
      const prev = raw[i - 1];
      let speed = null;
      if (prev && Number.isFinite(p.lat) && Number.isFinite(prev.lat) && Number.isFinite(p.lon) && Number.isFinite(prev.lon)) {
        const dLat = rad(p.lat - prev.lat), dLon = rad(p.lon - prev.lon);
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(prev.lat)) * Math.cos(rad(p.lat)) * Math.sin(dLon / 2) ** 2;
        const d = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
        if (!p.newSeg) distKm += d;
        const dt = (p.t - prev.t) / 1000;
        if (dt > 0 && !p.newSeg) speed = Math.round((d / (dt / 3600)) * 10) / 10;
      }
      return {
        time: Math.round((p.t - startMs) / 1000),
        segmentStart: i > 0 && p.newSeg,
        timestamp: p.t,
        power: p.power !== null ? Math.round(p.power) : 0,
        cadence: p.cad !== null ? Math.round(p.cad) : 0,
        hr: p.hr !== null ? Math.round(p.hr) : 0,
        speed,
        dist: Number.isFinite(p.lat) ? distKm : null
      };
    });
    const iso = new Date(startMs).toISOString();
    return VeloRideImporter.summarize(samples, riderFtp, {
      id: VeloRideImporter.uid('imported_gpx'),
      date: iso,
      profileName,
      title: name || 'GPX Ride (' + new Date(iso).toLocaleDateString() + ')',
      source: 'GPX Import',
      ...(type ? { fileSport: type } : {})
    });
  }

  // -------------------------------------------------------------------- CSV --
  /**
   * Accepts APEX VELO's own export (named header) as well as generic
   * "time,target,power,cadence,hr,left,right" files. Missing columns stay empty.
   */
  static parseCsv(csvString, profileName = 'Imported rider', riderFtp = 185) {
    const lines = csvString.replace(/\r/g, '').trim().split('\n').filter(Boolean);
    if (lines.length < 2) throw new Error('Invalid CSV file.');
    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const named = header.some(h => /[a-z]/.test(h));
    const fields = {
      time: ['time_s', 'timesec', 'time', 'elapsed', 'secs', 'seconds'],
      ts: ['timestamp_iso', 'timestamp', 'datetime', 'date_time'],
      target: ['target_w', 'targetwatts', 'target'],
      power: ['power_w', 'actualwatts', 'power', 'watts'],
      cad: ['cadence_rpm', 'cadencerpm', 'cadence'],
      hr: ['heart_rate_bpm', 'heartratebpm', 'hr', 'heart'],
      speed: ['speed_kmh', 'speedkmh', 'speed'],
      dist: ['distance_km', 'distancekm', 'distance'],
      left: ['left_balance_pct', 'leftbalancepct', 'left'],
      right: ['right_balance_pct', 'rightbalancepct', 'right'],
      segment: ['segment_start']
    };
    // Exact header names win over prefixes, and a column claimed exactly is never taken by a prefix:
    // otherwise "time" would grab a "timestamp" column.
    const col = {};
    if (named) {
      const claimed = new Set();
      for (const [k, names] of Object.entries(fields)) {
        col[k] = header.findIndex(h => names.includes(h));
        if (col[k] >= 0) claimed.add(col[k]);
      }
      for (const [k, names] of Object.entries(fields)) {
        if (col[k] >= 0) continue;
        for (const n of names) {
          col[k] = header.findIndex((h, i) => !claimed.has(i) && h.startsWith(n) && !(k === 'time' && h.startsWith('timestamp')));
          if (col[k] >= 0) { claimed.add(col[k]); break; }
        }
      }
    } else Object.assign(col, { time: 0, ts: -1, target: 1, power: 2, cad: 3, hr: 4, speed: -1, dist: -1, left: 5, right: 6 });

    const num = (parts, idx) => {
      if (idx < 0 || idx >= parts.length) return null;
      const v = parseFloat(parts[idx]);
      return Number.isFinite(v) ? v : null;
    };
    // Seconds from "65", "1:05", "01:01:05" (elapsed) or an ISO date-time (relative to the first row).
    let firstClock = null;
    const seconds = (parts, idx) => {
      if (idx < 0 || idx >= parts.length) return null;
      const raw = String(parts[idx]).trim();
      if (/^-?\d+(\.\d+)?$/.test(raw)) return parseFloat(raw);
      const hms = raw.match(/^(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/);
      if (hms) return hms[3] !== undefined ? +hms[1] * 3600 + +hms[2] * 60 + parseFloat(hms[3]) : +hms[1] * 60 + +hms[2];
      const ms = /^\d{4}-\d{2}-\d{2}/.test(raw) ? Date.parse(raw) : NaN;
      if (!Number.isFinite(ms)) return null;
      if (firstClock === null) firstClock = ms;
      return (ms - firstClock) / 1000;
    };
    const samples = [];
    let firstTs = null;
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 2) continue;
      const tsRaw = col.ts >= 0 ? parts[col.ts] : null;
      const tsMs = tsRaw ? (/^\d+$/.test(tsRaw) ? Number(tsRaw) : new Date(tsRaw).getTime()) : NaN;
      if (Number.isFinite(tsMs) && firstTs === null) firstTs = tsMs;
      samples.push({
        time: seconds(parts, col.time) ?? (Number.isFinite(tsMs) ? Math.round((tsMs - firstTs) / 1000) : i - 1),
        timestamp: Number.isFinite(tsMs) ? tsMs : undefined,
        target: num(parts, col.target) ?? 0,
        power: num(parts, col.power) ?? 0,
        cadence: num(parts, col.cad) ?? 0,
        hr: num(parts, col.hr) ?? 0,
        speed: num(parts, col.speed),
        dist: num(parts, col.dist),
        leftBal: num(parts, col.left),
        rightBal: num(parts, col.right),
        segmentStart: num(parts, col.segment ?? -1) === 1
      });
    }
    if (!samples.length) throw new Error('CSV contained no telemetry rows.');
    const first = samples[0];
    const startMs = Number.isFinite(first.timestamp) ? first.timestamp - (first.time || 0) * 1000 : firstClock ?? Date.now();
    return VeloRideImporter.summarize(samples, riderFtp, {
      id: VeloRideImporter.uid('imported_csv'),
      date: new Date(startMs).toISOString(),
      profileName,
      title: 'Imported Telemetry CSV',
      source: 'CSV Import'
    });
  }

  // -------------------------------------------------------------------- FIT --
  static FIT_LAP_TRIGGERS = {
    0: 'manual', 1: 'time', 2: 'distance', 3: 'position_start', 4: 'position_lap',
    5: 'position_waypoint', 6: 'position_marked', 7: 'session_end', 8: 'fitness_equipment'
  };

  static parseFit(arrayBuffer, profileName = 'Imported rider', riderFtp = 185) {
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
    const rawLaps = [];
    let session = null;
    let lastTimestamp = 0;
    let timerStopped = false, segmentPending = false;
    let sport = null; // FIT sport / sub_sport from the session message, else the sport message
    const acceptMessage = (def, msg) => {
      if (msg.timestamp !== undefined) lastTimestamp = msg.timestamp;
      if ((def.globalMesg === 18 || def.globalMesg === 12) && msg.sport !== undefined && (!sport || (def.globalMesg === 18 && !sport.session))) {
        sport = { sport: msg.sport, subSport: msg.subSport ?? 0, session: def.globalMesg === 18 };
      }
      if (def.globalMesg === 18) session = { ...(session || {}), ...msg };
      if (def.globalMesg === 19) rawLaps.push(msg);
      if (def.globalMesg === 21 && msg.event === 0) {
        if (msg.eventType === 0) { if (timerStopped) segmentPending = true; timerStopped = false; }
        else if ([1, 4, 8, 9].includes(msg.eventType)) timerStopped = true;
      }
      if (def.globalMesg === 20 && !timerStopped) {
        if (segmentPending) { msg.segmentStart = true; segmentPending = false; }
        records.push(msg);
      }
    };

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
        msg.timestamp = ts;
        acceptMessage(def, msg);
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
        acceptMessage(def, msg);
      }
    }

    const firstTs = (records.find(r => r.timestamp) || {}).timestamp || (session && session.start_time) || 0;
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
      const s = {
        time: r.timestamp && firstTs ? r.timestamp - firstTs : i,
        segmentStart: !!r.segmentStart,
        timestamp: r.timestamp ? (r.timestamp + 631065600) * 1000 : undefined,
        power: r.power || 0,
        cadence: r.cadence || 0,
        hr: r.heart_rate || 0,
        speed: r.speed !== undefined ? Math.round(r.speed * 3.6 * 10) / 10 : null,
        dist: r.distance !== undefined ? r.distance / 1000 : null,
        leftBal,
        rightBal
      };
      if (r.altitude !== undefined) s.alt = r.altitude;
      if (r.grade !== undefined) s.grade = r.grade;
      if (r.temperature !== undefined) s.temp = r.temperature;
      if (r.position_lat !== undefined) s.lat = r.position_lat;
      if (r.position_long !== undefined) s.lon = r.position_long;
      if (r.left_torque_effectiveness !== undefined) s.leftTe = r.left_torque_effectiveness;
      if (r.right_torque_effectiveness !== undefined) s.rightTe = r.right_torque_effectiveness;
      if (r.left_pedal_smoothness !== undefined) s.leftPs = r.left_pedal_smoothness;
      if (r.right_pedal_smoothness !== undefined) s.rightPs = r.right_pedal_smoothness;
      return s;
    });

    const laps = rawLaps.map((l, idx) => {
      const durationSec = Math.round(l.total_timer_time ?? l.total_elapsed_time ?? 0);
      const elapsedSec = l.total_elapsed_time !== undefined ? Math.round(l.total_elapsed_time) : undefined;
      let startSec;
      if (l.start_time !== undefined && firstTs) startSec = Math.max(0, l.start_time - firstTs);
      else if (l.timestamp !== undefined && firstTs && durationSec > 0) startSec = Math.max(0, (l.timestamp - firstTs) - durationSec);
      let leftBal;
      if (l.left_right_balance !== undefined) {
        const pct = (l.left_right_balance & 0x7FFF) / 100;
        if (pct > 0 && pct < 100) {
          leftBal = Math.round(((l.left_right_balance & 0x8000) ? (100 - pct) : pct) * 10) / 10;
        }
      }
      const out = { lapIdx: idx + 1, durationSec };
      if (startSec !== undefined) out.startSec = startSec;
      if (elapsedSec !== undefined) out.elapsedSec = elapsedSec;
      if (l.total_distance !== undefined) out.distanceM = Math.round(l.total_distance);
      if (l.avg_power !== undefined) out.avgWatts = l.avg_power;
      if (l.max_power !== undefined) out.maxWatts = l.max_power;
      if (l.normalized_power !== undefined) out.np = l.normalized_power;
      if (l.avg_hr !== undefined) out.avgHr = l.avg_hr;
      if (l.max_hr !== undefined) out.maxHr = l.max_hr;
      if (l.min_hr !== undefined) out.minHr = l.min_hr;
      if (l.avg_cadence !== undefined) out.avgCadence = l.avg_cadence;
      if (l.max_cadence !== undefined) out.maxCadence = l.max_cadence;
      if (l.avg_speed !== undefined) out.avgSpeedKmh = Math.round(l.avg_speed * 3.6 * 10) / 10;
      if (l.total_ascent !== undefined) out.ascentM = l.total_ascent;
      if (l.total_descent !== undefined) out.descentM = l.total_descent;
      if (l.total_calories !== undefined) out.calories = l.total_calories;
      if (leftBal !== undefined) out.leftBal = leftBal;
      if (l.avg_temperature !== undefined) out.avgTempC = l.avg_temperature;
      if (l.lap_trigger !== undefined) out.trigger = VeloRideImporter.FIT_LAP_TRIGGERS[l.lap_trigger] || String(l.lap_trigger);
      return out;
    });

    const rideDate = new Date(startMs).toISOString();
    const extraMeta = {};
    if (sport) { extraMeta.fitSport = sport.sport; extraMeta.fitSubSport = sport.subSport; }
    if (laps.length) extraMeta.laps = laps;
    if (session) {
      if (session.total_ascent !== undefined) extraMeta.elevationGainM = session.total_ascent;
      if (session.total_descent !== undefined) extraMeta.elevationLossM = session.total_descent;
      if (session.avg_temperature !== undefined) extraMeta.avgTempC = session.avg_temperature;
      if (session.max_temperature !== undefined) extraMeta.maxTempC = session.max_temperature;
      if (session.total_elapsed_time !== undefined) extraMeta.elapsedSec = Math.round(session.total_elapsed_time);
      const fitMeta = {};
      if (session.total_training_effect !== undefined) fitMeta.trainingEffect = session.total_training_effect;
      if (session.total_anaerobic_training_effect !== undefined) fitMeta.anaerobicTe = session.total_anaerobic_training_effect;
      if (session.threshold_power !== undefined) fitMeta.thresholdPower = session.threshold_power;
      if (session.min_heart_rate !== undefined) fitMeta.minHr = session.min_heart_rate;
      if (Object.keys(fitMeta).length) extraMeta.fitMeta = fitMeta;
    }

    return VeloRideImporter.summarize(samples, riderFtp, {
      id: VeloRideImporter.uid('fit'),
      title: 'FIT Ride (' + new Date(rideDate).toLocaleDateString() + ')',
      date: rideDate,
      profileName,
      source: 'FIT Import',
      ...extraMeta
    });
  }

  static _readFitVal(dv, off, size, type, le) {
    const base = type & 0x1F;
    if (size === 1) {
      if (base === 1) { const v = dv.getInt8(off); return v === 0x7F ? undefined : v; }
      const v = dv.getUint8(off);
      return (base === 10 ? v === 0 : v === 0xFF) ? undefined : v;
    }
    if (size === 2) {
      if (base === 3) { const v = dv.getInt16(off, le); return v === 0x7FFF ? undefined : v; }
      const v = dv.getUint16(off, le);
      return (base === 11 ? v === 0 : v === 0xFFFF) ? undefined : v;
    }
    if (size === 4) {
      if (base === 5) { const v = dv.getInt32(off, le); return v === 0x7FFFFFFF ? undefined : v; }
      const v = dv.getUint32(off, le);
      return (base === 12 ? v === 0 : v === 0xFFFFFFFF) ? undefined : v;
    }
    return undefined;
  }

  static _readFitMsg(dv, startOff, def) {
    const msg = {};
    let off = startOff;
    const le = !def.isBigEndian;
    const gm = def.globalMesg;
    const r1 = (v) => Math.round(v * 10) / 10;
    for (const f of def.fields) {
      if (off + f.size > dv.byteLength) break;
      const val = VeloRideImporter._readFitVal(dv, off, f.size, f.type, le);
      if (val !== undefined) {
        if (gm === 12) {
          if (f.num === 0) msg.sport = val;
          else if (f.num === 1) msg.subSport = val;
        } else if (gm === 21) {
          if (f.num === 253) msg.timestamp = val;
          else if (f.num === 0) msg.event = val;
          else if (f.num === 1) msg.eventType = val;
        } else if (gm === 18) {
          if (f.num === 253) msg.timestamp = val;
          else if (f.num === 2) msg.start_time = val;
          else if (f.num === 5) msg.sport = val;
          else if (f.num === 6) msg.subSport = val;
          else if (f.num === 7) msg.total_elapsed_time = val / 1000;
          else if (f.num === 8) msg.total_timer_time = val / 1000;
          else if (f.num === 9) msg.total_distance = val / 100;
          else if (f.num === 11) msg.total_calories = val;
          else if (f.num === 22) msg.total_ascent = val;
          else if (f.num === 23) msg.total_descent = val;
          else if (f.num === 24) msg.total_training_effect = r1(val / 10);
          else if (f.num === 34) msg.normalized_power = val;
          else if (f.num === 35) msg.training_stress_score = r1(val / 10);
          else if (f.num === 36) msg.intensity_factor = val / 1000;
          else if (f.num === 45) msg.threshold_power = val;
          else if (f.num === 57) msg.avg_temperature = val;
          else if (f.num === 58) msg.max_temperature = val;
          else if (f.num === 64) msg.min_heart_rate = val;
          else if (f.num === 137) msg.total_anaerobic_training_effect = r1(val / 10);
        } else if (gm === 19) {
          if (f.num === 253) msg.timestamp = val;
          else if (f.num === 2) msg.start_time = val;
          else if (f.num === 7) msg.total_elapsed_time = val / 1000;
          else if (f.num === 8) msg.total_timer_time = val / 1000;
          else if (f.num === 9) msg.total_distance = val / 100;
          else if (f.num === 11) msg.total_calories = val;
          else if (f.num === 13 && msg.avg_speed === undefined) msg.avg_speed = val / 1000;
          else if (f.num === 14 && msg.max_speed === undefined) msg.max_speed = val / 1000;
          else if (f.num === 110) msg.avg_speed = val / 1000;
          else if (f.num === 111) msg.max_speed = val / 1000;
          else if (f.num === 15) msg.avg_hr = val;
          else if (f.num === 16) msg.max_hr = val;
          else if (f.num === 63) msg.min_hr = val;
          else if (f.num === 17) msg.avg_cadence = val;
          else if (f.num === 18) msg.max_cadence = val;
          else if (f.num === 19) msg.avg_power = val;
          else if (f.num === 20) msg.max_power = val;
          else if (f.num === 21) msg.total_ascent = val;
          else if (f.num === 22) msg.total_descent = val;
          else if (f.num === 24) msg.lap_trigger = val;
          else if (f.num === 25) msg.sport = val;
          else if (f.num === 39) msg.sub_sport = val;
          else if (f.num === 34) msg.left_right_balance = val;
          else if (f.num === 42) msg.normalized_power = val;
          else if (f.num === 50) msg.avg_temperature = val;
          else if (f.num === 51) msg.max_temperature = val;
        } else if (gm === 20) {
          if (f.num === 253) msg.timestamp = val;
          else if (f.num === 0) msg.position_lat = Math.round(val * (180 / 2147483648) * 1e6) / 1e6;
          else if (f.num === 1) msg.position_long = Math.round(val * (180 / 2147483648) * 1e6) / 1e6;
          else if (f.num === 2 && msg.altitude === undefined) msg.altitude = r1(val / 5 - 500);
          else if (f.num === 78) msg.altitude = r1(val / 5 - 500);
          else if (f.num === 3) msg.heart_rate = val;
          else if (f.num === 4) msg.cadence = val;
          else if (f.num === 5) msg.distance = val / 100;
          else if (f.num === 6 && msg.speed === undefined) msg.speed = val / 1000;
          else if (f.num === 73) msg.speed = val / 1000;
          else if (f.num === 7) msg.power = val;
          else if (f.num === 9) msg.grade = r1(val / 100);
          else if (f.num === 13) msg.temperature = val;
          else if (f.num === 30) msg.left_right_balance = val;
          else if (f.num === 43) msg.left_torque_effectiveness = r1(val / 2);
          else if (f.num === 44) msg.right_torque_effectiveness = r1(val / 2);
          else if (f.num === 45) msg.left_pedal_smoothness = r1(val / 2);
          else if (f.num === 46) msg.right_pedal_smoothness = r1(val / 2);
        }
      }
      off += f.size;
    }
    return msg;
  }
}

if (typeof window !== 'undefined') window.VeloRideImporter = VeloRideImporter;
if (typeof self !== 'undefined' && typeof window === 'undefined') self.VeloRideImporter = VeloRideImporter;
if (typeof module !== 'undefined') module.exports = VeloRideImporter;
