/**
 * APEX VELO // LAB - fuzzy duplicate detection for synced activities (Strava, HealthFit, cockpit).
 *
 * Two records are the same session when they overlap in time and look alike, even if
 * titles, start times (clock drift, timezone labelling), durations (auto-pause, trimmed
 * ends), distances or calories differ a little. The score combines:
 *  - start time: within minutes, OR offset by a whole number of hours (a timezone
 *    mislabel, e.g. local time stored as UTC) with matching minutes/seconds;
 *  - time overlap of the two sessions;
 *  - duration, distance and energy similarity;
 *  - sport compatibility (Ride ~ indoor cycling; WeightTraining ~ Workout).
 * Titles are ignored on purpose: the same session is often named differently per app.
 */
class VeloDedupe {
  static FAMILY = {
    Ride: 'ride', VirtualRide: 'ride', EBikeRide: 'ride', GravelRide: 'ride', MountainBikeRide: 'ride', cycling: 'ride',
    WeightTraining: 'strength', Workout: 'strength', Crossfit: 'strength', HighIntensityIntervalTraining: 'strength', strength: 'strength',
    Walk: 'walk', Hike: 'walk', Run: 'run', TrailRun: 'run', VirtualRun: 'run', Yoga: 'mobility', Pilates: 'mobility'
  };

  /** Normalises any record into { id, source, family, startMs, clock, durSec, distM, kcal }. */
  static norm(r) {
    const iso = String(r.start || r.date || '');
    const clockIso = iso.replace(/(Z|[+-]\d{2}:?\d{2})$/, '');
    return {
      id: r.id, source: r.source || '', title: r.title || r.name || '',
      // true = this record's clock is local time labelled as UTC (HealthFit); false = a true UTC instant
      // (Strava, cockpit); undefined = unknown (the mislabel check then applies as before).
      localAsUtc: r.localAsUtc,
      family: VeloDedupe.FAMILY[r.sport || r.sport_type || r.type] || (r.family || 'ride'),
      startMs: Date.parse(iso.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z'),
      clockMs: Date.parse(clockIso + 'Z'), // wall-clock reading, timezone ignored
      durSec: Number(r.durSec || r.moving_time || r.duration) || 0,
      elapsedSec: Number(r.elapsed_time || r.durSec || r.duration) || 0,
      distM: Number(r.distM ?? r.distance ?? (r.distanceKm ? r.distanceKm * 1000 : 0)) || 0,
      kcal: Number(r.kcal ?? r.total_calories ?? r.totalCalories ?? r.kj) || 0
    };
  }

  static rel(a, b) { return a > 0 && b > 0 ? Math.abs(a - b) / Math.max(a, b) : null; }

  /** Similarity 0-1 of two records plus the reasons. */
  static score(ra, rb) {
    const a = VeloDedupe.norm(ra), b = VeloDedupe.norm(rb);
    const why = [];
    const compatible = a.family === b.family;
    if (!compatible) return { score: 0, why: ['different sport'] };
    // Start time: true instant, or wall clock (timezone mislabel), or a whole-hour shift.
    const dAbs = Math.abs(a.startMs - b.startMs) / 60000;
    const dClock = Math.abs(a.clockMs - b.clockMs) / 60000;
    // Only this computer's UTC offset on that date counts as a timezone mislabel (local time stored
    // as UTC); any other whole-hour gap is a different session.
    const tzH = Math.abs(new Date(a.startMs).getTimezoneOffset()) / 60;
    // A mislabel needs a record that stores local time as UTC; two true UTC instants are never shifted.
    const mislabelPossible = (a.localAsUtc === undefined && b.localAsUtc === undefined) || a.localAsUtc === true || b.localAsUtc === true;
    const dShift = tzH && mislabelPossible ? Math.abs(dAbs - tzH * 60) : Infinity;
    let dt = Math.min(dAbs, dClock);
    let tzNote = '';
    if (dShift < dt) { dt = dShift; tzNote = `${tzH} h timezone offset (local time stored as UTC)`; }
    if (dt > 20) return { score: 0, why: [`starts ${Math.round(dt)} min apart`] };
    const sTime = dt <= 1 ? 1 : dt <= 5 ? 0.9 : dt <= 10 ? 0.7 : 0.4;
    why.push(dt < 1 ? 'same start' : `start ${dt.toFixed(1)} min apart`);
    if (tzNote) why.push(tzNote);
    // Duration (moving vs elapsed, whichever is closer)
    const rd = Math.min(...[VeloDedupe.rel(a.durSec, b.durSec), VeloDedupe.rel(a.elapsedSec, b.durSec), VeloDedupe.rel(a.durSec, b.elapsedSec)].filter(x => x !== null).concat([1]));
    const sDur = rd <= 0.03 ? 1 : rd <= 0.1 ? 0.8 : rd <= 0.25 ? 0.5 : 0.1;
    why.push(`duration ${Math.round(rd * 100)}% apart`);
    // Optional evidence
    let extra = 0, n = 0;
    const rDist = VeloDedupe.rel(a.distM, b.distM);
    if (rDist !== null && a.distM > 500 && b.distM > 500) { n++; extra += rDist <= 0.05 ? 1 : rDist <= 0.15 ? 0.6 : 0; why.push(`distance ${Math.round(rDist * 100)}% apart`); }
    const rK = VeloDedupe.rel(a.kcal, b.kcal);
    if (rK !== null) { n++; extra += rK <= 0.1 ? 1 : rK <= 0.3 ? 0.6 : 0.2; why.push(`energy ${Math.round(rK * 100)}% apart`); }
    const sExtra = n ? extra / n : 0.7;
    const score = 0.45 * sTime + 0.35 * sDur + 0.2 * sExtra;
    return { score: Math.round(score * 100) / 100, why };
  }

  /** 'duplicate' >= 0.8, 'possible' 0.6-0.8 (ask), otherwise 'new'. */
  static classify(score) { return score >= 0.8 ? 'duplicate' : score >= 0.6 ? 'possible' : 'new'; }

  /**
   * Plans a sync: which incoming records are new, which duplicate an existing record,
   * and which duplicate another incoming record (e.g. the same gym session logged by two apps).
   * Prefers the richer record of an incoming pair (description / exercise list, longer title).
   */
  static plan(incoming, existing) {
    const richness = (r) => (r.description ? 2 : 0) + (r.hasSets ? 2 : 0) + (String(r.name || r.title || '').length > 20 ? 1 : 0);
    const out = [];
    const taken = new Set();
    const sorted = [...incoming].sort((x, y) => richness(y) - richness(x));
    for (const r of sorted) {
      let best = null;
      for (const e of existing) { const s = VeloDedupe.score(r, e); if (!best || s.score > best.score) best = { ...s, with: e }; }
      const twin = sorted.find(o => o !== r && taken.has(o.id) && VeloDedupe.classify(VeloDedupe.score(r, o).score) === 'duplicate');
      if (twin) { out.push({ record: r, verdict: 'duplicate-incoming', with: twin, ...VeloDedupe.score(r, twin) }); continue; }
      const verdict = best ? VeloDedupe.classify(best.score) : 'new';
      if (verdict === 'new') taken.add(r.id);
      out.push({ record: r, verdict, with: best && verdict !== 'new' ? best.with : null, score: best ? best.score : 0, why: best ? best.why : [] });
    }
    return out;
  }

  // ------------------------------------------------- ride files (bulk import) --
  // Contract (docs/ANDROID-CONTRACTS.md): the same ride = the same fileHash, or a start within ±60 s and a
  // duration within ±5 %. Of two copies keep the one with power, then more channels, then the longer one.

  static startMsOf(r) { const t = VeloDedupe.norm(r).startMs; return Number.isFinite(t) ? t : NaN; }

  static durationOf(r) {
    const d = Number(r.duration || r.durSec || r.moving_time || r.elapsed_time) || (Number(r.durationMin) || 0) * 60;
    return d > 0 ? d : 0;
  }

  static hasPower(r) {
    return Number(r.avgWatts) > 0 || Number(r.np) > 0 || (Array.isArray(r.samples) && r.samples.some(s => Number(s.power) > 0));
  }

  /** Recorded channels: power, heart rate, cadence, speed/distance, pedal balance. */
  static channelCount(r) {
    const any = (key, summary) => Number(summary) > 0 || (Array.isArray(r.samples) && r.samples.some(s => Number(s[key]) > 0));
    return [VeloDedupe.hasPower(r), any('hr', r.avgHr), any('cadence', r.avgCadence), any('dist', r.distanceKm || r.distance), r.leftBal > 0].filter(Boolean).length;
  }

  /** > 0 when a is the better copy to keep, < 0 when b is, 0 when equal. */
  static compareQuality(a, b) {
    return (VeloDedupe.hasPower(a) - VeloDedupe.hasPower(b)) || (VeloDedupe.channelCount(a) - VeloDedupe.channelCount(b))
      || (VeloDedupe.durationOf(a) - VeloDedupe.durationOf(b));
  }

  static recordedHere(r) { return r.source === 'APEX VELO Cockpit' || r.source === 'recorded'; }

  static sameRide(a, b) {
    if (a.fileHash && b.fileHash && a.fileHash === b.fileHash) return true;
    const ta = VeloDedupe.startMsOf(a), tb = VeloDedupe.startMsOf(b);
    if (!Number.isFinite(ta) || !Number.isFinite(tb) || Math.abs(ta - tb) > 60000) return false;
    const da = VeloDedupe.durationOf(a), db = VeloDedupe.durationOf(b);
    return !(da > 0 && db > 0) || Math.abs(da - db) / Math.max(da, db) <= 0.05;
  }

  /**
   * Lookup structure for importing many rides against a large history: fileHash map plus rides bucketed
   * by start minute, so each check only looks at neighbouring minutes.
   */
  static rideIndex(rides = []) {
    const byHash = new Map(), byMin = new Map();
    const key = (t) => Math.floor(t / 60000);
    const idx = {
      add(r) {
        if (r.fileHash) byHash.set(r.fileHash, r);
        const t = VeloDedupe.startMsOf(r);
        if (Number.isFinite(t)) { const k = key(t); if (!byMin.has(k)) byMin.set(k, []); byMin.get(k).push(r); }
      },
      remove(r) {
        if (r.fileHash && byHash.get(r.fileHash) === r) byHash.delete(r.fileHash);
        const t = VeloDedupe.startMsOf(r), list = Number.isFinite(t) && byMin.get(key(t));
        if (list) { const i = list.indexOf(r); if (i >= 0) list.splice(i, 1); }
      },
      hasHash(h) { return byHash.has(h); },
      /** The stored ride that r duplicates, or null. */
      find(r) {
        if (r.fileHash && byHash.has(r.fileHash)) return byHash.get(r.fileHash);
        const t = VeloDedupe.startMsOf(r);
        if (!Number.isFinite(t)) return null;
        for (const k of [key(t) - 1, key(t), key(t) + 1]) for (const o of byMin.get(k) || []) if (VeloDedupe.sameRide(r, o)) return o;
        return null;
      }
    };
    rides.forEach(r => r && idx.add(r));
    return idx;
  }

  /**
   * Decides what to do with one imported ride: 'new' (add it), 'duplicate' (a copy at least as good, or
   * one recorded in this app, is already kept) or 'replace' (it is better than the copy in `with`).
   * Updates the index accordingly.
   */
  static admit(index, ride) {
    const twin = index.find(ride);
    if (!twin) { index.add(ride); return { verdict: 'new' }; }
    // A ride recorded in this app (targets, compliance, its own links) is never swapped for a file copy.
    if (!VeloDedupe.recordedHere(twin) && VeloDedupe.compareQuality(ride, twin) > 0) { index.remove(twin); index.add(ride); return { verdict: 'replace', with: twin }; }
    return { verdict: 'duplicate', with: twin };
  }
}

if (typeof window !== 'undefined') window.VeloDedupe = VeloDedupe;
if (typeof module !== 'undefined') module.exports = VeloDedupe;
