/**
 * APEX VELO // LAB - Strength analytics engine (pure JS, no DOM, no Chart.js).
 *
 * Parses Hevy (and Strava) strength workouts into per-exercise volume, working sets,
 * Epley estimated 1RM (e1RM), muscle-group splits, weekly volume/set/load trends,
 * and all-time lifting personal records.
 */
class VeloStrengthAnalytics {
  static MUSCLE_GROUPS = [
    { key: 'legs', label: 'Legs & Glutes', color: '#ff5c86' },
    { key: 'back', label: 'Back', color: '#4aa8ff' },
    { key: 'chest', label: 'Chest', color: '#ffae3d' },
    { key: 'shoulders', label: 'Shoulders', color: '#9b7bff' },
    { key: 'arms', label: 'Arms', color: '#3ddc97' },
    { key: 'core', label: 'Core & Other', color: '#7a85a3' }
  ];

  static COMPOUND_LIFTS = [
    ['Squat', /\bsquat\b/i],
    ['Deadlift', /dead\s*lift|\brdl\b|romanian/i],
    ['Bench Press', /\bbench\b/i],
    ['Overhead Press', /overhead\s*press|military\s*press|\bohp\b|shoulder\s*press/i],
    ['Barbell Row', /\brow\b/i],
    ['Lat Pulldown / Pull-up', /pulldown|pull[\s-]*up|chin[\s-]*up/i]
  ];

  static num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  static localDateKey(d) {
    const dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt.getTime())) return '';
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }

  static weekStart(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dow = (x.getDay() + 6) % 7;
    x.setDate(x.getDate() - dow);
    return x;
  }

  static strengthWorkouts(workouts) {
    return (workouts || []).filter(r => r && r.activityType === 'strength' && r.date && Number.isFinite(Date.parse(r.date)));
  }

  static inWindow(workouts, days, now = new Date()) {
    const list = VeloStrengthAnalytics.strengthWorkouts(workouts);
    if (!days || days <= 0) return list;
    const end = now.getTime();
    const start = end - days * 86400000;
    return list.filter(r => { const t = Date.parse(r.date); return t >= start && t <= end; });
  }

  static e1rm(weightKg, reps) {
    const w = VeloStrengthAnalytics.num(weightKg);
    const r = Math.round(VeloStrengthAnalytics.num(reps));
    if (w <= 0 || r < 1 || r > 15) return 0;
    const raw = r === 1 ? w : w * (1 + r / 30);
    return Math.round(raw * 2) / 2;
  }

  static classifyMuscle(title) {
    const s = String(title || '');
    if (/squat|dead\s*lift|\brdl\b|romanian|lunge|leg\s*press|leg\s*curl|leg\s*extension|calf|hip\s*thrust|glute|hamstring|quad|bulgarian|step[\s-]*up|good\s*morning/i.test(s)) return 'legs';
    if (/shoulder|overhead\s*press|military\s*press|\bohp\b|lateral\s*raise|front\s*raise|rear\s*delt|arnold|upright\s*row/i.test(s)) return 'shoulders';
    if (/curl|tricep|bicep|pushdown|skull\s*crusher|preacher|hammer|kickback|rope\s*extension/i.test(s)) return 'arms';
    if (/pull[\s-]*up|chin[\s-]*up|pulldown|\blat\b|\brow\b|shrug|back\s*extension|face\s*pull|hyperextension/i.test(s)) return 'back';
    if (/bench|chest|pec|\bfly\b|flye|push[\s-]*up|\bdip\b/i.test(s)) return 'chest';
    return 'core';
  }

  static fmtWeight(w) {
    const n = VeloStrengthAnalytics.num(w);
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
  }

  /**
   * Normalises exercise naming variants across Hevy, Motra and Bevel so identical
   * movements combine cleanly in progression charts, muscle splits and leaderboards.
   */
  static canonicalName(title) {
    let s = String(title || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    s = s
      .replace(/\s*\(Single\)/gi, '')
      .replace(/\s+per\s+side\b/gi, '')
      .replace(/\bParellel\b/gi, 'Parallel')
      .replace(/\bPull-Up\b/gi, 'Pull Up')
      .replace(/\bChin-Up\b/gi, 'Chin Up')
      .replace(/\bPush-Up\b/gi, 'Push Up')
      .replace(/\bBiceps\b/gi, 'Bicep')
      .replace(/\bTricep\b/gi, 'Triceps')
      .replace(/\s*·\s*([A-Za-z][^·]*)$/, ' ($1)')
      .replace(/\s+/g, ' ')
      .trim();

    if (!/\([^)]+\)$/.test(s)) {
      const equipPrefixes = [
        [/^Smith\s*Machine\s+(.+)$/i, 'Smith Machine'],
        [/^Barbell\s+(.+)$/i, 'Barbell'],
        [/^Dumbbell\s+(.+)$/i, 'Dumbbell'],
        [/^Cable\s+(.+)$/i, 'Cable'],
        [/^Machine\s+(.+)$/i, 'Machine'],
        [/^Kettlebell\s+(.+)$/i, 'Kettlebell']
      ];
      for (const [re, eq] of equipPrefixes) {
        const m = s.match(re);
        if (m) { s = `${m[1].trim()} (${eq})`; break; }
      }
    }

    if (/^(?:Back\s+)?Squat\s*\(Barbell\)$/i.test(s)) return 'Squat (Barbell)';
    if (/^Bench\s+Press\s*\(Barbell\)$/i.test(s)) return 'Bench Press (Barbell)';
    if (/^Deadlift\s*\(Barbell\)$/i.test(s)) return 'Deadlift (Barbell)';
    if (/^(?:(?:Standing\s+)?Military\s+Press(?:\s*\(Barbell\))?|Overhead\s+Press(?:\s*\/\s*Military\s+Press)?\s*\(Barbell\))$/i.test(s)) {
      return 'Overhead Press (Barbell)';
    }
    if (/^(?:Romanian\s+Deadlift(?:\s*\(Barbell\))?|Straight\s+Leg\s+Deadlift(?:\s*\(Barbell\))?)$/i.test(s)) {
      return 'Romanian Deadlift (Barbell)';
    }
    if (/^(?:Lat\s+Pull\s*Down.*|Pulldown\s*\((?:Wide\s+Parallel\s+Grip|Hammer)\)|Reverse\s+Grip\s+Lat\s+Pulldown.*)$/i.test(s)) {
      return 'Lat Pulldown';
    }
    if (/^(?:(?:Rope\s+Cable\s+|Cable\s+Rope\s+|Rope\s+)?Triceps\s+(?:Rope\s+)?(?:Pushdown|Extension)(?:\s*\/\s*Extension)?(?:\s*\(Cable\))?)$/i.test(s)) {
      return 'Triceps Pushdown (Cable)';
    }
    if (/^(?:Row\s*\(Hammer\s*machine\)|Iso-?Lateral\s+Row\s*\(Machine\))$/i.test(s)) return 'Machine Row';
    if (/^(?:Seated\s+Cable\s+Row.*|Seated\s+Row\s*\(Cable\))$/i.test(s)) return 'Seated Cable Row';
    if (/^(?:Bent\s+Over\s+Row\s*\(Barbell\)|Barbell\s+Row)$/i.test(s)) return 'Bent Over Row (Barbell)';
    if (/^(?:Kneeling\s+Crunch\s*\(Cable\)|Cable\s+Crunch|Crunch\s*\(Cable\))$/i.test(s)) return 'Cable Crunch';
    return s;
  }

  static mergeSessionExercises(items) {
    const byName = new Map();
    for (const ex of items) {
      if (!ex || !ex.title) continue;
      const key = ex.title;
      const cur = byName.get(key);
      if (!cur) { byName.set(key, { ...ex }); continue; }
      const totalSets = cur.sets + ex.sets;
      const rpeNum = (cur.avgRpe > 0 ? cur.avgRpe * cur.sets : 0) + (ex.avgRpe > 0 ? ex.avgRpe * ex.sets : 0);
      const rpeDen = (cur.avgRpe > 0 ? cur.sets : 0) + (ex.avgRpe > 0 ? ex.sets : 0);
      cur.sets = totalSets;
      cur.volumeKg += ex.volumeKg;
      if (ex.bestE1rmKg > cur.bestE1rmKg || (ex.bestE1rmKg === cur.bestE1rmKg && ex.bestWeightKg > cur.bestWeightKg)) {
        cur.bestE1rmKg = ex.bestE1rmKg;
        cur.bestWeightKg = Math.max(cur.bestWeightKg, ex.bestWeightKg);
        cur.bestReps = ex.bestReps;
        cur.bestSetLabel = ex.bestSetLabel;
      } else if (ex.bestWeightKg > cur.bestWeightKg) {
        cur.bestWeightKg = ex.bestWeightKg;
      }
      cur.avgRpe = rpeDen ? Math.round((rpeNum / rpeDen) * 10) / 10 : 0;
    }
    return [...byName.values()];
  }

  /**
   * Extracts per-exercise metrics from either structured `rec.hevy.exercises` or
   * formatted `rec.exercises[]` lines produced by VeloHevySync.
   */
  static parseExercises(rec) {
    if (!rec) return [];
    const n = VeloStrengthAnalytics.num;
    const fmtW = VeloStrengthAnalytics.fmtWeight;
    const out = [];

    if (rec.hevy && Array.isArray(rec.hevy.exercises) && rec.hevy.exercises.length) {
      rec.hevy.exercises.forEach(ex => {
        if (!ex || !ex.title) return;
        const rawSets = Array.isArray(ex.sets) ? ex.sets.filter(Boolean) : [];
        const nonWarmup = rawSets.filter(s => s.type !== 'warmup');
        const work = nonWarmup.length ? nonWarmup : rawSets;
        let volumeKg = 0, bestWeightKg = 0, bestReps = 0, bestE1rmKg = 0, bestSetLabel = '', rpeSum = 0, rpeN = 0;
        work.forEach(s => {
          const w = n(s.weight_kg), r = n(s.reps), rpe = n(s.rpe);
          if (rpe > 0) { rpeSum += rpe; rpeN++; }
          if (w > 0 && r > 0) volumeKg += w * r;
          const e = VeloStrengthAnalytics.e1rm(w, r);
          if (e > bestE1rmKg || (e === bestE1rmKg && w > bestWeightKg)) {
            bestE1rmKg = e; bestWeightKg = Math.max(bestWeightKg, w); bestReps = r;
            bestSetLabel = `${fmtW(w)} kg x ${r}`;
          } else if (w > bestWeightKg) {
            bestWeightKg = w;
            if (!bestSetLabel) bestSetLabel = r > 0 ? `${fmtW(w)} kg x ${r}` : `${fmtW(w)} kg`;
          } else if (!bestSetLabel && r > 0) {
            bestSetLabel = `${r} reps`;
          }
        });
        const exTitle = VeloStrengthAnalytics.canonicalName(ex.title);
        out.push({
          title: exTitle,
          muscleGroup: VeloStrengthAnalytics.classifyMuscle(exTitle),
          sets: work.length,
          volumeKg: Math.round(volumeKg),
          bestWeightKg,
          bestReps,
          bestE1rmKg,
          bestSetLabel,
          avgRpe: rpeN ? Math.round((rpeSum / rpeN) * 10) / 10 : 0
        });
      });
      return VeloStrengthAnalytics.mergeSessionExercises(out);
    }

    const lines = Array.isArray(rec.exercises) ? rec.exercises : [];
    const META_RE = /^(?:Tracked with\b|Superset\b|TVL\s*:|Duration\s*:|Calories\s*:|Exercises\s*:|Time\s*:|Rest\s*:|Note\s*:|Warm\s*up\b|https?:)/i;
    const SET_LINE_RE = /^Set\s*\d+\s*[:—–-]\s*(.+)$/i;
    const isMultiLine = lines.some(l => SET_LINE_RE.test(String(l || '').trim()));

    const makeEntry = (title) => ({
      title,
      muscleGroup: VeloStrengthAnalytics.classifyMuscle(title),
      sets: 0,
      volumeKg: 0,
      bestWeightKg: 0,
      bestReps: 0,
      bestE1rmKg: 0,
      bestSetLabel: '',
      avgRpe: 0,
      _rpeSum: 0,
      _rpeN: 0
    });
    const recordSet = (entry, count, w, r, rpe, label) => {
      entry.sets += count;
      if (rpe > 0) { entry._rpeSum += rpe * count; entry._rpeN += count; }
      if (w > 0 && r > 0) entry.volumeKg += count * w * r;
      const e = VeloStrengthAnalytics.e1rm(w, r);
      if (e > entry.bestE1rmKg || (e === entry.bestE1rmKg && w > entry.bestWeightKg)) {
        entry.bestE1rmKg = e; entry.bestWeightKg = Math.max(entry.bestWeightKg, w); entry.bestReps = r;
        entry.bestSetLabel = `${fmtW(w)} kg x ${r}`;
      } else if (w > entry.bestWeightKg) {
        entry.bestWeightKg = w;
        if (!entry.bestSetLabel) entry.bestSetLabel = label;
      } else if (!entry.bestSetLabel && label) {
        entry.bestSetLabel = label;
      }
    };
    const finishEntry = (e) => ({
      title: e.title,
      muscleGroup: e.muscleGroup,
      sets: e.sets,
      volumeKg: Math.round(e.volumeKg),
      bestWeightKg: e.bestWeightKg,
      bestReps: e.bestReps,
      bestE1rmKg: e.bestE1rmKg,
      bestSetLabel: e.bestSetLabel,
      avgRpe: e._rpeN ? Math.round((e._rpeSum / e._rpeN) * 10) / 10 : 0
    });

    if (isMultiLine) {
      let cur = null;
      for (const rawLine of lines) {
        const line = String(rawLine || '').trim();
        if (!line || META_RE.test(line)) continue;
        const sm = line.match(SET_LINE_RE);
        if (sm) {
          if (!cur) continue;
          const txt = sm[1].trim().replace(/,(\d)/g, '.$1');
          let m;
          if ((m = txt.match(/([\d.]+)\s*kg\s*[x×]\s*(\d+)/i))) {
            const w = Number(m[1]), r = Number(m[2]);
            recordSet(cur, 1, w, r, 0, `${fmtW(w)} kg x ${r}`);
          } else if ((m = txt.match(/(\d+)\s*reps?\s*[x×]\s*([\d.]+)\s*kg/i))) {
            const r = Number(m[1]), w = Number(m[2]);
            recordSet(cur, 1, w, r, 0, `${fmtW(w)} kg x ${r}`);
          } else if ((m = txt.match(/^(\d+)\s*reps?\b/i))) {
            recordSet(cur, 1, 0, Number(m[1]), 0, `${m[1]} reps`);
          } else if ((m = txt.match(/^([\d.]+)\s*kg\b/i))) {
            recordSet(cur, 1, Number(m[1]), 0, 0, `${fmtW(Number(m[1]))} kg`);
          }
          continue;
        }
        if (cur && cur.sets > 0) out.push(finishEntry(cur));
        const cname = VeloStrengthAnalytics.canonicalName(line);
        cur = makeEntry(cname);
      }
      if (cur && cur.sets > 0) out.push(finishEntry(cur));
      return VeloStrengthAnalytics.mergeSessionExercises(out);
    }

    for (const rawLine of lines) {
      const line = String(rawLine || '').trim();
      if (!line || META_RE.test(line)) continue;
      const colonIdx = line.indexOf(': ');
      if (colonIdx <= 0) continue;
      const rawTitle = line.slice(0, colonIdx).trim();
      const body = line.slice(colonIdx + 2).trim();
      if (!rawTitle || !body || /^(?:Set\s*\d+|Warm\s*up|TVL|Duration|Calories|Exercises|Superset|Time|Rest|Note)$/i.test(rawTitle)) continue;

      const entry = makeEntry(VeloStrengthAnalytics.canonicalName(rawTitle));
      const chunks = body.split(/\s*,\s*/);
      for (const ch of chunks) {
        let m;
        if ((m = ch.match(/^(\d+)\s*x\s*(\d+)\s*@\s*([\d.]+)\s*kg(?:\s*\(RPE\s*([\d.]+)\))?/i))) {
          const c = Number(m[1]), r = Number(m[2]), w = Number(m[3]), rpe = Number(m[4] || 0);
          recordSet(entry, c, w, r, rpe, `${fmtW(w)} kg x ${r}`);
        } else if ((m = ch.match(/^([\d.]+)\s*kg\s*x\s*(\d+)(?:\s*\(RPE\s*([\d.]+)\))?/i))) {
          const w = Number(m[1]), r = Number(m[2]), rpe = Number(m[3] || 0);
          recordSet(entry, 1, w, r, rpe, `${fmtW(w)} kg x ${r}`);
        } else if ((m = ch.match(/^(\d+)\s*x\s*(\d+)\s*(s|m)\b(?:\s*\(RPE\s*([\d.]+)\))?/i))) {
          recordSet(entry, Number(m[1]), 0, 0, Number(m[4] || 0), `${m[2]}${m[3]}`);
        } else if ((m = ch.match(/^(\d+)\s*x\s*(\d+)(?:\s*\(RPE\s*([\d.]+)\))?/i))) {
          recordSet(entry, Number(m[1]), 0, Number(m[2]), Number(m[3] || 0), `${m[2]} reps`);
        } else if ((m = ch.match(/^(\d+)\s*reps?(?:\s*\(RPE\s*([\d.]+)\))?/i))) {
          recordSet(entry, 1, 0, Number(m[1]), Number(m[2] || 0), `${m[1]} reps`);
        } else if ((m = ch.match(/^(\d+)\s*(s|m)\b(?:\s*\(RPE\s*([\d.]+)\))?/i))) {
          recordSet(entry, 1, 0, 0, Number(m[3] || 0), `${m[1]}${m[2]}`);
        } else if ((m = ch.match(/^(\d+)\s*sets?/i))) {
          recordSet(entry, Number(m[1]), 0, 0, 0, `${m[1]} sets`);
        } else if (/^1\s*set\b/i.test(ch)) {
          recordSet(entry, 1, 0, 0, 0, '1 set');
        } else if ((m = ch.match(/^([\d.]+)\s*kg(?:\s*\(RPE\s*([\d.]+)\))?/i))) {
          recordSet(entry, 1, Number(m[1]), 0, Number(m[2] || 0), `${fmtW(Number(m[1]))} kg`);
        }
      }

      out.push(finishEntry(entry));
    }
    return VeloStrengthAnalytics.mergeSessionExercises(out);
  }

  static workoutStats(rec) {
    const n = VeloStrengthAnalytics.num;
    const exs = VeloStrengthAnalytics.parseExercises(rec);
    const parsedSets = exs.reduce((a, e) => a + e.sets, 0);
    const parsedVol = exs.reduce((a, e) => a + e.volumeKg, 0);
    return {
      exercises: exs,
      sets: (rec.hevy && (n(rec.hevy.workingSetCount) || n(rec.hevy.setCount))) || parsedSets,
      volumeKg: (rec.hevy && n(rec.hevy.volumeKg)) || parsedVol,
      load: n(rec.strengthTss),
      duration: n(rec.duration),
      heavyLegs: !!rec.heavyLegs
    };
  }

  static totals(workouts, fromMs, toMs) {
    const list = VeloStrengthAnalytics.strengthWorkouts(workouts).filter(r => {
      const t = Date.parse(r.date);
      return t >= fromMs && t < toMs;
    });
    let sessions = 0, volumeKg = 0, sets = 0, sec = 0, load = 0, heavyLegDays = 0;
    for (const r of list) {
      const st = VeloStrengthAnalytics.workoutStats(r);
      sessions++;
      volumeKg += st.volumeKg;
      sets += st.sets;
      sec += st.duration;
      load += st.load;
      if (st.heavyLegs) heavyLegDays++;
    }
    return {
      sessions,
      volumeKg: Math.round(volumeKg),
      sets,
      hours: Math.round((sec / 3600) * 10) / 10,
      avgLoad: sessions ? Math.round(load / sessions) : 0,
      heavyLegDays
    };
  }

  static kpis(workouts, days = 182, now = new Date()) {
    const all = VeloStrengthAnalytics.strengthWorkouts(workouts);
    const endMs = now.getTime();
    if (!days || days <= 0) {
      const firstMs = all.length ? Math.min(...all.map(r => Date.parse(r.date))) : endMs;
      const spanWeeks = Math.max(1, (endMs - firstMs) / (7 * 86400000));
      const cur = VeloStrengthAnalytics.totals(all, 0, endMs + 1);
      cur.sessionsPerWeek = Math.round((cur.sessions / spanWeeks) * 10) / 10;
      return { cur, prev: null };
    }
    const startMs = endMs - days * 86400000;
    const prevStartMs = startMs - days * 86400000;
    const weeks = Math.max(1, days / 7);
    const cur = VeloStrengthAnalytics.totals(all, startMs, endMs + 1);
    cur.sessionsPerWeek = Math.round((cur.sessions / weeks) * 10) / 10;
    const prev = VeloStrengthAnalytics.totals(all, prevStartMs, startMs);
    prev.sessionsPerWeek = Math.round((prev.sessions / weeks) * 10) / 10;
    return { cur, prev: prev.sessions > 0 ? prev : null };
  }

  static weekly(workouts, weeks = 26, now = new Date()) {
    const list = VeloStrengthAnalytics.strengthWorkouts(workouts);
    const thisWeek = VeloStrengthAnalytics.weekStart(now);
    let first;
    if (weeks > 0) {
      first = new Date(thisWeek);
      first.setDate(first.getDate() - (weeks - 1) * 7);
    } else if (list.length) {
      first = VeloStrengthAnalytics.weekStart(new Date(Math.min(...list.map(r => Date.parse(r.date)))));
    } else {
      first = new Date(thisWeek);
    }
    const buckets = [];
    const index = new Map();
    for (let d = new Date(first); d <= thisWeek; d.setDate(d.getDate() + 7)) {
      const key = VeloStrengthAnalytics.localDateKey(d);
      index.set(key, buckets.length);
      buckets.push({
        key,
        start: new Date(d),
        label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        volumeKg: 0,
        sets: 0,
        sessions: 0,
        load: 0,
        hours: 0,
        heavyLegs: 0,
        sessionIds: []
      });
    }
    for (const r of list) {
      const k = VeloStrengthAnalytics.localDateKey(VeloStrengthAnalytics.weekStart(new Date(r.date)));
      const i = index.get(k);
      if (i === undefined) continue;
      const b = buckets[i];
      const st = VeloStrengthAnalytics.workoutStats(r);
      b.volumeKg += st.volumeKg;
      b.sets += st.sets;
      b.sessions += 1;
      b.load += st.load;
      b.hours += st.duration / 3600;
      if (st.heavyLegs) b.heavyLegs += 1;
      b.sessionIds.push(r.id);
    }
    buckets.forEach(b => {
      b.volumeKg = Math.round(b.volumeKg);
      b.load = Math.round(b.load);
      b.hours = Math.round(b.hours * 10) / 10;
    });
    return buckets;
  }

  /** Monthly buckets from the first strength workout through the current month (for multi-year views). */
  static monthly(workouts, now = new Date()) {
    const list = VeloStrengthAnalytics.strengthWorkouts(workouts);
    const endM = new Date(now.getFullYear(), now.getMonth(), 1);
    const startM = list.length
      ? (() => { const d = new Date(Math.min(...list.map(r => Date.parse(r.date)))); return new Date(d.getFullYear(), d.getMonth(), 1); })()
      : new Date(endM);
    const buckets = [];
    const index = new Map();
    for (let d = new Date(startM); d <= endM; d.setMonth(d.getMonth() + 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      index.set(key, buckets.length);
      buckets.push({
        key,
        start: new Date(d),
        label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
        volumeKg: 0,
        sets: 0,
        sessions: 0,
        load: 0,
        hours: 0,
        heavyLegs: 0,
        sessionIds: []
      });
    }
    for (const r of list) {
      const dt = new Date(r.date);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      const i = index.get(key);
      if (i === undefined) continue;
      const b = buckets[i];
      const st = VeloStrengthAnalytics.workoutStats(r);
      b.volumeKg += st.volumeKg;
      b.sets += st.sets;
      b.sessions += 1;
      b.load += st.load;
      b.hours += st.duration / 3600;
      if (st.heavyLegs) b.heavyLegs += 1;
      b.sessionIds.push(r.id);
    }
    buckets.forEach(b => {
      b.volumeKg = Math.round(b.volumeKg);
      b.load = Math.round(b.load);
      b.hours = Math.round(b.hours * 10) / 10;
    });
    return buckets;
  }

  static exerciseCatalog(workouts, days = 182, now = new Date()) {
    const list = VeloStrengthAnalytics.inWindow(workouts, days, now)
      .slice()
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const map = new Map();
    for (const r of list) {
      const exs = VeloStrengthAnalytics.parseExercises(r);
      for (const ex of exs) {
        let entry = map.get(ex.title);
        if (!entry) {
          entry = {
            title: ex.title,
            muscleGroup: ex.muscleGroup,
            sessions: 0,
            totalSets: 0,
            totalVolumeKg: 0,
            bestWeightKg: 0,
            bestE1rmKg: 0,
            bestSetLabel: '',
            bestDate: r.date,
            bestWorkoutId: r.id,
            firstE1rmKg: 0,
            latestE1rmKg: 0,
            deltaPct: null
          };
          map.set(ex.title, entry);
        }
        entry.sessions += 1;
        entry.totalSets += ex.sets;
        entry.totalVolumeKg += ex.volumeKg;
        if (ex.bestE1rmKg > entry.bestE1rmKg || (ex.bestE1rmKg === entry.bestE1rmKg && ex.bestWeightKg > entry.bestWeightKg)) {
          entry.bestE1rmKg = ex.bestE1rmKg;
          entry.bestWeightKg = Math.max(entry.bestWeightKg, ex.bestWeightKg);
          entry.bestSetLabel = ex.bestSetLabel || entry.bestSetLabel;
          entry.bestDate = r.date;
          entry.bestWorkoutId = r.id;
        } else if (ex.bestWeightKg > entry.bestWeightKg) {
          entry.bestWeightKg = ex.bestWeightKg;
          if (!entry.bestSetLabel) {
            entry.bestSetLabel = ex.bestSetLabel;
            entry.bestDate = r.date;
            entry.bestWorkoutId = r.id;
          }
        }
        if (ex.bestE1rmKg > 0) {
          if (!entry.firstE1rmKg) entry.firstE1rmKg = ex.bestE1rmKg;
          entry.latestE1rmKg = ex.bestE1rmKg;
        }
      }
    }
    const items = [...map.values()].map(e => {
      if (e.firstE1rmKg > 0 && e.latestE1rmKg > 0 && e.sessions >= 2) {
        e.deltaPct = Math.round(((e.latestE1rmKg - e.firstE1rmKg) / e.firstE1rmKg) * 100);
      }
      e.totalVolumeKg = Math.round(e.totalVolumeKg);
      return e;
    });
    return items.sort((a, b) => b.sessions - a.sessions || b.totalVolumeKg - a.totalVolumeKg || a.title.localeCompare(b.title));
  }

  static exerciseProgression(workouts, exerciseTitle, days = 182, now = new Date()) {
    if (!exerciseTitle) return [];
    const list = VeloStrengthAnalytics.inWindow(workouts, days, now)
      .slice()
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const pts = [];
    for (const r of list) {
      const ex = VeloStrengthAnalytics.parseExercises(r).find(e => e.title === exerciseTitle);
      if (!ex) continue;
      pts.push({
        date: r.date,
        workoutId: r.id,
        title: r.title || exerciseTitle,
        e1rmKg: ex.bestE1rmKg,
        bestWeightKg: ex.bestWeightKg,
        volumeKg: ex.volumeKg,
        sets: ex.sets,
        bestSetLabel: ex.bestSetLabel,
        avgRpe: ex.avgRpe
      });
    }
    return pts;
  }

  static muscleSplit(workouts, days = 182, now = new Date()) {
    const list = VeloStrengthAnalytics.inWindow(workouts, days, now);
    const groups = new Map(VeloStrengthAnalytics.MUSCLE_GROUPS.map(g => [g.key, { ...g, sets: 0, volumeKg: 0, exercises: 0 }]));
    for (const r of list) {
      for (const ex of VeloStrengthAnalytics.parseExercises(r)) {
        const g = groups.get(ex.muscleGroup) || groups.get('core');
        g.sets += ex.sets;
        g.volumeKg += ex.volumeKg;
        g.exercises += 1;
      }
    }
    const items = [...groups.values()];
    const totalSets = items.reduce((a, g) => a + g.sets, 0);
    const totalVol = items.reduce((a, g) => a + g.volumeKg, 0);
    items.forEach(g => {
      g.volumeKg = Math.round(g.volumeKg);
      g.setsPct = totalSets ? Math.round((g.sets / totalSets) * 100) : 0;
      g.volumePct = totalVol ? Math.round((g.volumeKg / totalVol) * 100) : 0;
    });
    return { groups: items, totalSets, totalVolumeKg: Math.round(totalVol) };
  }

  static records(workouts) {
    const list = VeloStrengthAnalytics.strengthWorkouts(workouts);
    let biggestVolume = null, mostSets = null, heaviestLift = null;
    const compounds = new Map(VeloStrengthAnalytics.COMPOUND_LIFTS.map(([name]) => [name, null]));
    const weekMap = new Map();

    for (const r of list) {
      const st = VeloStrengthAnalytics.workoutStats(r);
      if (st.volumeKg > 0 && (!biggestVolume || st.volumeKg > biggestVolume.v)) biggestVolume = { v: st.volumeKg, r };
      if (st.sets > 0 && (!mostSets || st.sets > mostSets.v)) mostSets = { v: st.sets, r };

      const wk = VeloStrengthAnalytics.weekStart(new Date(r.date));
      const wkKey = VeloStrengthAnalytics.localDateKey(wk);
      const wEntry = weekMap.get(wkKey) || { key: wkKey, start: wk, volumeKg: 0, sessions: 0, label: wk.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) };
      wEntry.volumeKg += st.volumeKg;
      wEntry.sessions += 1;
      weekMap.set(wkKey, wEntry);

      for (const ex of st.exercises) {
        if (ex.bestWeightKg > 0 && (!heaviestLift || ex.bestWeightKg > heaviestLift.weightKg)) {
          heaviestLift = { weightKg: ex.bestWeightKg, e1rmKg: ex.bestE1rmKg, setLabel: ex.bestSetLabel, exercise: ex.title, r };
        }
        for (const [name, re] of VeloStrengthAnalytics.COMPOUND_LIFTS) {
          if (!re.test(ex.title)) continue;
          const prev = compounds.get(name);
          const score = ex.bestE1rmKg || ex.bestWeightKg;
          const prevScore = prev ? (prev.e1rmKg || prev.weightKg) : 0;
          if (score > prevScore) {
            compounds.set(name, { name, e1rmKg: ex.bestE1rmKg, weightKg: ex.bestWeightKg, setLabel: ex.bestSetLabel, exercise: ex.title, r });
          }
          break;
        }
      }
    }

    let bestWeekVolume = null;
    weekMap.forEach(w => { if (w.volumeKg > 0 && (!bestWeekVolume || w.volumeKg > bestWeekVolume.volumeKg)) bestWeekVolume = w; });

    // Consecutive-week streak
    const sortedWeeks = [...weekMap.keys()].sort();
    let streak = 0, run = 0, prevMs = null;
    for (const k of sortedWeeks) {
      const ms = Date.parse(k + 'T00:00:00');
      run = (prevMs !== null && Math.round((ms - prevMs) / (7 * 86400000)) === 1) ? run + 1 : 1;
      if (run > streak) streak = run;
      prevMs = ms;
    }

    const topLifts = [...compounds.values()].filter(Boolean);
    return { biggestVolume, mostSets, heaviestLift, bestWeekVolume, weekStreak: streak, topLifts };
  }
}

if (typeof window !== 'undefined') window.VeloStrengthAnalytics = VeloStrengthAnalytics;
if (typeof module !== 'undefined') module.exports = VeloStrengthAnalytics;
