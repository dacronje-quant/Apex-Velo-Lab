/**
 * APEX VELO // LAB - "Sync from Hevy": pure planning logic (no DOM, no storage, no network).
 *
 * Hevy is only ever READ via the local server's GET /api/hevy/workouts proxy.
 * Imported strength workouts replace any matching Strava strength record (carrying over HR,
 * calories and stravaActivityId) so strength sessions from Hevy never double up with Strava
 * in Calendar or History.
 */
class VeloHevySync {
  static SOURCE = 'Hevy';
  static PRESET_WEEKS = [2, 4, 8, 12, 26];
  static DEFAULT_WEEKS = 8;
  static RANGE_KEY = 'apex_hevy_sync_range';
  static SKIP_STRAVA_STRENGTH_KEY = 'apex_hevy_skip_strava_strength';
  static STATE_KEY = 'apex_hevy_sync_state';
  static STRENGTH_TSS_CAP = 60;
  static HEAVY_STRENGTH_TSS = 45;
  static MATCH_WINDOW_MS = 15 * 60000;
  static LEG_LIFTS = /squat|dead\s*lift|\brdl\b|romanian|lunge|leg\s*press|hip\s*thrust|step[\s-]*up|bulgarian/i;

  static num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  static fmtNum(v) { const n = Number(v); if (!Number.isFinite(n)) return '0'; return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10); }
  static isoZ(v) { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString().replace('.000Z', 'Z') : ''; }
  static localDayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  static parseDay(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  static dayKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  static normaliseChoice(c) {
    if (c && c.mode === 'custom' && VeloHevySync.parseDay(c.from) && VeloHevySync.parseDay(c.to)) {
      return { mode: 'custom', from: c.from, to: c.to };
    }
    const w = Number(c && c.weeks);
    return { mode: 'preset', weeks: VeloHevySync.PRESET_WEEKS.includes(w) ? w : VeloHevySync.DEFAULT_WEEKS };
  }

  static rangeFor(choice, now = new Date()) {
    const c = VeloHevySync.normaliseChoice(choice);
    let after, before;
    if (c.mode === 'custom') {
      after = VeloHevySync.parseDay(c.from);
      before = VeloHevySync.parseDay(c.to);
      if (before < after) { const t = after; after = before; before = t; }
      before = new Date(before.getFullYear(), before.getMonth(), before.getDate() + 1);
    } else {
      const today = VeloHevySync.localDayStart(now);
      after = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (c.weeks * 7 - 1));
      before = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    }
    const lastDay = new Date(before.getFullYear(), before.getMonth(), before.getDate() - 1);
    return {
      choice: c, afterMs: after.getTime(), beforeMs: before.getTime(),
      afterIso: after.toISOString(), beforeIso: before.toISOString(),
      label: c.mode === 'custom'
        ? `${VeloHevySync.dayKey(after)} to ${VeloHevySync.dayKey(lastDay)}`
        : `last ${c.weeks} weeks (${VeloHevySync.dayKey(after)} to ${VeloHevySync.dayKey(lastDay)})`
    };
  }

  static inRange(dateIso, range) {
    const t = Date.parse(dateIso);
    return Number.isFinite(t) && t >= range.afterMs && t < range.beforeMs;
  }

  static stable(v) {
    if (Array.isArray(v)) return `[${v.map(VeloHevySync.stable).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${VeloHevySync.stable(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  static formatSet(s) {
    const n = VeloHevySync.num;
    const fmt = VeloHevySync.fmtNum;
    const w = n(s && s.weight_kg);
    const r = n(s && s.reps);
    const dur = n(s && s.duration_seconds);
    const dist = n(s && s.distance_meters);
    const rpe = n(s && s.rpe);
    let core;
    if (w > 0 && r > 0) core = `${fmt(w)} kg x ${r}`;
    else if (r > 0) core = `${r} reps`;
    else if (dur > 0) core = `${Math.round(dur)}s`;
    else if (dist > 0) core = `${Math.round(dist)} m`;
    else if (w > 0) core = `${fmt(w)} kg`;
    else core = '1 set';
    return rpe > 0 ? `${core} (RPE ${fmt(rpe)})` : core;
  }

  /** Turns one Hevy exercise object into a compact human-readable line. */
  static formatExercise(ex) {
    if (!ex) return '';
    const title = String(ex.title || '').trim() || 'Exercise';
    const sets = Array.isArray(ex.sets) ? ex.sets.filter(Boolean) : [];
    const nonWarmup = sets.filter(s => s.type !== 'warmup');
    const work = nonWarmup.length ? nonWarmup : sets;
    if (!work.length) return title;
    const n = VeloHevySync.num;
    const fmt = VeloHevySync.fmtNum;
    const sig = (s) => `${n(s.weight_kg)}|${n(s.reps)}|${n(s.duration_seconds)}|${n(s.distance_meters)}`;
    const allSame = work.length > 1 && work.every(s => sig(s) === sig(work[0]));
    if (allSame) {
      const s = work[0];
      const w = n(s.weight_kg), r = n(s.reps), dur = n(s.duration_seconds), dist = n(s.distance_meters);
      let head;
      if (w > 0 && r > 0) head = `${work.length}x${r} @ ${fmt(w)} kg`;
      else if (r > 0) head = `${work.length}x${r}`;
      else if (dur > 0) head = `${work.length}x${Math.round(dur)}s`;
      else if (dist > 0) head = `${work.length}x${Math.round(dist)} m`;
      else head = `${work.length} sets`;
      const rpes = work.map(x => n(x.rpe)).filter(x => x > 0);
      const rpeStr = rpes.length ? ` (RPE ${fmt(Math.max(...rpes))})` : '';
      return `${title}: ${head}${rpeStr}`;
    }
    const list = work.slice(0, 12).map(VeloHevySync.formatSet).join(', ');
    return `${title}: ${list}${work.length > 12 ? ', ...' : ''}`;
  }

  /** Estimates strength load (0-60) from working sets and RPE, with duration fallback. */
  static computeStrengthLoad(workout, durationSec = 0) {
    const n = VeloHevySync.num;
    const exs = Array.isArray(workout && workout.exercises) ? workout.exercises : [];
    let raw = 0, workingSets = 0, totalSets = 0, volumeKg = 0, hasRpe = false;
    exs.forEach(ex => {
      const sets = Array.isArray(ex && ex.sets) ? ex.sets : [];
      const nonWarmup = sets.filter(s => s && s.type !== 'warmup');
      const useWarmupOnly = nonWarmup.length === 0 && sets.length > 0;
      sets.forEach(s => {
        if (!s) return;
        totalSets++;
        const w = n(s.weight_kg), r = n(s.reps);
        if (s.type !== 'warmup') {
          workingSets++;
          if (w > 0 && r > 0) volumeKg += w * r;
          const rpe = n(s.rpe);
          if (rpe > 0) hasRpe = true;
          const mult = rpe <= 0 ? 1.0 : rpe <= 6 ? 0.75 : rpe <= 7 ? 0.9 : rpe <= 8 ? 1.05 : rpe <= 9 ? 1.2 : 1.35;
          const typeBonus = (s.type === 'failure' || s.type === 'dropset') ? 0.15 : 0;
          raw += 2.2 * (mult + typeBonus);
        } else if (useWarmupOnly) {
          raw += 1.0;
        }
      });
    });
    const cap = VeloHevySync.STRENGTH_TSS_CAP;
    if (workingSets > 0 || raw > 0) {
      return {
        strengthTss: Math.min(cap, Math.max(5, Math.round(raw))),
        strengthTssMethod: hasRpe ? 'sets & RPE' : 'sets',
        setCount: totalSets,
        workingSetCount: workingSets,
        volumeKg: Math.round(volumeKg)
      };
    }
    return {
      strengthTss: Math.min(cap, Math.round((Math.max(0, durationSec) / 3600) * 30)),
      strengthTssMethod: 'duration',
      setCount: totalSets,
      workingSetCount: 0,
      volumeKg: 0
    };
  }

  static isHeavyLegDay(rec) {
    if (!rec || rec.activityType !== 'strength') return false;
    if (typeof VeloStravaSync !== 'undefined' && typeof VeloStravaSync.isHeavyLegDay === 'function') {
      return VeloStravaSync.isHeavyLegDay(rec);
    }
    const text = [rec.description || '', ...(rec.exercises || [])].join('\n');
    return VeloHevySync.LEG_LIFTS.test(text) || VeloHevySync.num(rec.strengthTss) >= VeloHevySync.HEAVY_STRENGTH_TSS;
  }

  static toRecord(w, opts = {}, existing = null) {
    const n = VeloHevySync.num;
    const id = String(w.id);
    const startIso = VeloHevySync.isoZ(w.start_time);
    const startMs = Date.parse(w.start_time);
    const endMs = Date.parse(w.end_time);
    const dur = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? Math.round((endMs - startMs) / 1000)
      : Math.max(0, Math.round(n(w.duration)));
    const exercises = (Array.isArray(w.exercises) ? w.exercises : []).map(VeloHevySync.formatExercise).filter(Boolean).slice(0, 30);
    const notes = String(w.description || '').trim();
    const desc = notes || exercises.join('\n');
    const load = VeloHevySync.computeStrengthLoad(w, dur);
    const rec = {
      id: `hevy_${id}`,
      source: VeloHevySync.SOURCE,
      hevyWorkoutId: id,
      title: String(w.title || '').trim() || 'Strength workout',
      date: startIso,
      duration: dur,
      activityType: 'strength',
      sportType: 'WeightTraining',
      profileName: (existing && existing.profileName) || opts.profileName || '',
      tss: 0,
      strengthTss: load.strengthTss,
      strengthTssMethod: load.strengthTssMethod,
      hevy: {
        workoutId: id,
        updatedAt: VeloHevySync.isoZ(w.updated_at) || undefined,
        setCount: load.setCount,
        workingSetCount: load.workingSetCount,
        volumeKg: load.volumeKg
      }
    };
    if (exercises.length) rec.exercises = exercises;
    if (desc) rec.description = desc;
    rec.heavyLegs = VeloHevySync.isHeavyLegDay(rec);
    if (existing) {
      if (existing.strava) rec.strava = existing.strava;
      if (existing.stravaActivityId) rec.stravaActivityId = existing.stravaActivityId;
      for (const k of ['avgHr', 'maxHr', 'totalCalories', 'sufferScore']) {
        if (n(existing[k]) > 0) rec[k] = Math.round(n(existing[k]));
      }
    }
    return rec;
  }

  static mergeStravaMetrics(rec, stravaRec) {
    if (!stravaRec) return rec;
    const n = VeloHevySync.num;
    const sid = String(stravaRec.stravaActivityId || (stravaRec.strava && stravaRec.strava.activityId) || '');
    const out = { ...rec };
    if (sid) {
      out.stravaActivityId = sid;
      out.strava = { state: 'found', activityId: sid, name: stravaRec.title || '', linkedBy: 'hevy' };
    }
    for (const k of ['avgHr', 'maxHr', 'totalCalories', 'sufferScore']) {
      if (!n(out[k]) && n(stravaRec[k]) > 0) out[k] = Math.round(n(stravaRec[k]));
    }
    return out;
  }

  static isMatchingStrengthRecord(hevyRec, candidate) {
    if (!hevyRec || !candidate || candidate.activityType !== 'strength') return false;
    const tA = Date.parse(hevyRec.date), tB = Date.parse(candidate.date);
    if (!Number.isFinite(tA) || !Number.isFinite(tB)) return false;
    if (Math.abs(tA - tB) <= VeloHevySync.MATCH_WINDOW_MS) return true;
    if (typeof VeloDedupe !== 'undefined') {
      const a = { id: hevyRec.id, start: hevyRec.date, family: 'strength', durSec: hevyRec.duration, localAsUtc: false };
      const b = { id: candidate.id, start: candidate.date, family: 'strength', durSec: candidate.duration, kcal: candidate.totalCalories };
      return VeloDedupe.score(a, b).score >= 0.6;
    }
    return false;
  }

  static diffRecords(a, b) {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    const changes = [];
    keys.forEach(k => {
      if (VeloHevySync.stable(a[k]) !== VeloHevySync.stable(b[k])) changes.push(k);
    });
    return changes.sort();
  }

  /**
   * Plans a Hevy sync against current history (pure).
   * Matches and replaces Strava-imported duplicates so Calendar and History never double up.
   */
  static plan({ workouts, history, range, opts = {} }) {
    const H = VeloHevySync;
    const hist = history || [];
    const list = (workouts || []).filter(w => w && w.id != null && H.inRange(w.start_time, range))
      .map(w => ({ ...w, id: String(w.id) }));
    const fetchedIds = new Set(list.map(w => w.id));

    const existingByHevyId = new Map();
    const stravaStrength = [];
    hist.forEach(r => {
      if (!r) return;
      if (r.source === H.SOURCE || r.hevyWorkoutId) {
        const hid = String(r.hevyWorkoutId || String(r.id || '').replace(/^hevy_/, ''));
        if (hid) existingByHevyId.set(hid, r);
      } else if (r.source === 'Strava' && r.activityType === 'strength') {
        stravaStrength.push(r);
      }
    });

    const out = {
      range, opts, fetched: list.length,
      added: [], updated: [], replaced: [], removed: [], unchanged: 0
    };
    const claimedStravaIds = new Set();

    list.forEach(w => {
      const existing = existingByHevyId.get(w.id);
      if (existing) {
        const prelim = H.toRecord(w, opts, existing);
        const dup = stravaStrength.find(r => !claimedStravaIds.has(r.id) && H.isMatchingStrengthRecord(prelim, r));
        let next = prelim;
        if (dup) {
          claimedStravaIds.add(dup.id);
          next = H.mergeStravaMetrics(prelim, dup);
          out.replaced.push({ workout: w, record: next, replacedRecord: dup, updateExistingId: existing.id });
        } else {
          const changes = H.diffRecords(existing, next);
          if (changes.length) out.updated.push({ workout: w, record: next, before: existing, changes });
          else out.unchanged++;
        }
        return;
      }
      const prelim = H.toRecord(w, opts, null);
      const dup = stravaStrength.find(r => !claimedStravaIds.has(r.id) && H.isMatchingStrengthRecord(prelim, r));
      if (dup) {
        claimedStravaIds.add(dup.id);
        const merged = H.mergeStravaMetrics(prelim, dup);
        out.replaced.push({ workout: w, record: merged, replacedRecord: dup });
        return;
      }
      out.added.push({ workout: w, record: prelim });
    });

    existingByHevyId.forEach((rec, hid) => {
      if (H.inRange(rec.date, range) && !fetchedIds.has(hid)) out.removed.push({ record: rec });
    });

    out.changeCount = out.added.length + out.updated.length + out.replaced.length + out.removed.length;
    out.hasChanges = out.changeCount > 0;
    return out;
  }

  static nextState(history, plan) {
    const drop = new Set([
      ...plan.removed.map(x => x.record.id),
      ...plan.replaced.map(x => x.replacedRecord.id)
    ]);
    const replacements = new Map();
    const added = [];
    plan.replaced.forEach(x => {
      if (x.updateExistingId) replacements.set(x.updateExistingId, x.record);
      else added.push(x.record);
    });
    const updated = new Map(plan.updated.map(x => [x.record.id, x.record]));
    const put = [];
    const kept = [];
    (history || []).forEach(r => {
      if (drop.has(r.id)) return;
      if (replacements.has(r.id)) { const rec = replacements.get(r.id); kept.push(rec); put.push(rec); return; }
      if (updated.has(r.id)) { const rec = updated.get(r.id); kept.push(rec); put.push(rec); return; }
      kept.push(r);
    });
    const fresh = [...added, ...plan.added.map(x => x.record)].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    put.push(...fresh);
    return { history: [...fresh, ...kept], put, del: [...drop] };
  }
}

if (typeof window !== 'undefined') window.VeloHevySync = VeloHevySync;
if (typeof module !== 'undefined') module.exports = VeloHevySync;
