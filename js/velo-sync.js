/**
 * APEX VELO // LAB - Two-way sync merge engine (shared between Desktop server and Android app).
 *
 * Pure functions, no DOM or network calls:
 *  - SYNCED_SETTINGS / isSyncedSetting(): explicit allowlist of settings synced across devices.
 *  - rideMetaJson() / formatRideHash(): canonical metadata + samples content hash.
 *  - mergeRides(): ID + tombstone + fuzzy cross-device dedupe (via VeloDedupe).
 *  - mergeChat(): message-ID + timestamp + clearedAt union for AI Coach chat (apex_ask_v1).
 *  - mergeProfiles(), mergeSavedWorkouts(), mergeTrainingBlock(), mergeSettings().
 *  - mergeWellnessRows() / buildHealthStore(): multi-source wellness (apple, healthconnect, icu)
 *    with strict HRV scale isolation (never mixing SDNN and rMSSD).
 *  - planDelta(): compares local & remote manifests to request only changed items.
 */
(function (root) {
  'use strict';

  const SYNCED_SETTINGS = new Set([
    'apex_velo_profiles',
    'apex_velo_active_prof_id',
    'apex_velo_saved_workouts',
    'apex_training_block',
    'apex_block_options',
    'apex_ask_v1',
    'apex_health_v1',
    'apex_coach_goal',
    'apex_coach_lookback_days',
    'apex_coach_intent',
    'apex_coach_provider',
    'apex_coach_model',
    'apex_coach_effort',
    'apex_claude_model',
    'apex_claude_effort',
    'apex_gemini_model',
    'apex_ftp_source',
    'apex_ftp_suggest_dismissed',
    'apex_strength_load',
    'apex_hevy_skip_strava_strength',
    'apex_ana_pins',
    'apex_ana_panel',
    'apex_ana_more',
    'apex_ana_story',
    'apex_pdc_unit',
    'apex_power_view',
    'apex_share_card_style'
  ]);

  const isSyncedSetting = (key) => typeof key === 'string' && SYNCED_SETTINGS.has(key);

  const safeParse = (raw, fallback) => {
    if (raw === null || raw === undefined || raw === '') return fallback;
    if (typeof raw !== 'string') return raw;
    try { const v = JSON.parse(raw); return v === null ? fallback : v; } catch { return fallback; }
  };

  /** Canonical JSON of a ride's metadata (sorted top-level keys, without samples or sampleSummary). */
  function rideMetaJson(ride) {
    if (!ride || typeof ride !== 'object') return '{}';
    const keys = Object.keys(ride)
      .filter((k) => k !== 'samples' && k !== 'sampleSummary' && ride[k] !== undefined)
      .sort();
    const clean = {};
    for (const k of keys) clean[k] = ride[k];
    return JSON.stringify(clean);
  }

  function formatRideHash(metaHash, samplesHash = '0') {
    return `${metaHash || ''}:${samplesHash || '0'}`;
  }

  function hasSamples(r) {
    return !!(r && Array.isArray(r.samples) && r.samples.length > 0);
  }

  function hasStravaLink(r) {
    return !!(r && (r.stravaActivityId || (r.strava && (r.strava.activityId || ['sent', 'duplicate', 'found'].includes(r.strava.state)))));
  }

  function isGenericTitle(title) {
    const t = String(title || '').trim().toLowerCase();
    return !t || t === 'ride' || t === 'cycling' || t === 'workout' || t === 'imported ride' || / ride$/.test(t) && /^(health connect|strava|zwift|garmin|wahoo) ride$/i.test(t);
  }

  function mergeRidePair(winnerWrap, loserWrap) {
    const w = { ...winnerWrap.ride };
    const l = loserWrap.ride;
    if (!hasSamples(w) && hasSamples(l)) w.samples = l.samples;
    if (!hasStravaLink(w) && hasStravaLink(l)) {
      if (l.strava) w.strava = l.strava;
      if (l.stravaActivityId) w.stravaActivityId = l.stravaActivityId;
    }
    if (!w.fileHash && l.fileHash) w.fileHash = l.fileHash;
    if (!w.notes && l.notes) w.notes = l.notes;
    if (!w.description && l.description) w.description = l.description;
    if (isGenericTitle(w.title) && l.title && !isGenericTitle(l.title)) w.title = l.title;
    return {
      ride: w,
      updatedAt: Math.max(Number(winnerWrap.updatedAt) || 0, Number(loserWrap.updatedAt) || 0),
      contentHash: winnerWrap.contentHash || loserWrap.contentHash || ''
    };
  }

  function normalizeTombstones(tombstones) {
    const map = new Map();
    const list = Array.isArray(tombstones) ? tombstones : tombstones instanceof Map ? [...tombstones.values()] : [];
    for (const t of list) {
      if (!t || !t.kind || t.id === undefined || t.id === null) continue;
      const key = `${t.kind}|${String(t.id)}`;
      const at = Number(t.deletedAt) || 0;
      const prev = map.get(key);
      if (!prev || at > prev.deletedAt) map.set(key, { kind: String(t.kind), id: String(t.id), deletedAt: at });
    }
    return map;
  }

  /**
   * Merges two ride collections with tombstones and optional fuzzy cross-ID dedupe.
   * Each entry in localRides/remoteRides is { ride, updatedAt, contentHash }.
   */
  function mergeRides(localRides = [], remoteRides = [], tombstones = [], dedupe = null, now = Date.now()) {
    const tombMap = normalizeTombstones(tombstones);
    const byId = new Map();

    const consider = (wrap) => {
      if (!wrap || !wrap.ride || wrap.ride.id === undefined || wrap.ride.id === null) return;
      const id = String(wrap.ride.id);
      const updatedAt = Number(wrap.updatedAt) || 0;
      const tomb = tombMap.get(`ride|${id}`);
      if (tomb && tomb.deletedAt >= updatedAt) return;
      if (tomb && updatedAt > tomb.deletedAt) tombMap.delete(`ride|${id}`);

      const cur = byId.get(id);
      if (!cur) {
        byId.set(id, { ride: { ...wrap.ride }, updatedAt, contentHash: wrap.contentHash || '' });
        return;
      }
      if (cur.contentHash && wrap.contentHash && cur.contentHash === wrap.contentHash) {
        const winner = updatedAt > cur.updatedAt ? wrap : cur;
        const loser = winner === wrap ? cur : wrap;
        byId.set(id, mergeRidePair(winner, loser));
        return;
      }
      const winner = updatedAt > cur.updatedAt ? wrap : cur;
      const loser = winner === wrap ? cur : wrap;
      const merged = mergeRidePair(winner, loser);
      merged.contentHash = winner.contentHash || '';
      byId.set(id, merged);
    };

    for (const r of localRides) consider(r);
    for (const r of remoteRides) consider(r);

    // Cross-ID fuzzy deduplication (e.g. Health Connect ride on Android + Strava/FIT on Desktop).
    if (dedupe && typeof dedupe.sameRide === 'function') {
      const items = [...byId.values()];
      const dropped = new Set();
      const byMinute = new Map();
      const bucket = (r) => {
        const t = typeof dedupe.startMsOf === 'function' ? dedupe.startMsOf(r.ride) : Date.parse(r.ride.date);
        return Number.isFinite(t) ? Math.floor(t / 60000) : null;
      };
      for (const item of items) {
        const m = bucket(item);
        if (m === null) continue;
        if (!byMinute.has(m)) byMinute.set(m, []);
        byMinute.get(m).push(item);
      }
      for (const a of items) {
        const aId = String(a.ride.id);
        if (dropped.has(aId)) continue;
        const m = bucket(a);
        const candidates = [];
        if (m !== null) {
          for (const k of [m - 1, m, m + 1]) for (const b of byMinute.get(k) || []) candidates.push(b);
        }
        // Also check matching fileHash across any minute bucket.
        if (a.ride.fileHash) {
          for (const b of items) if (b !== a && b.ride.fileHash === a.ride.fileHash) candidates.push(b);
        }
        for (const b of candidates) {
          if (b === a) continue;
          const bId = String(b.ride.id);
          if (dropped.has(bId) || dropped.has(aId)) continue;
          if (!dedupe.sameRide(a.ride, b.ride)) continue;

          const recA = dedupe.recordedHere ? dedupe.recordedHere(a.ride) : false;
          const recB = dedupe.recordedHere ? dedupe.recordedHere(b.ride) : false;
          let keepA;
          if (recA !== recB) keepA = recA;
          else {
            const q = dedupe.compareQuality ? dedupe.compareQuality(a.ride, b.ride) : 0;
            if (q !== 0) keepA = q > 0;
            else if ((a.updatedAt || 0) !== (b.updatedAt || 0)) keepA = (a.updatedAt || 0) > (b.updatedAt || 0);
            else keepA = aId < bId;
          }
          const keeper = keepA ? a : b;
          const loser = keepA ? b : a;
          const merged = mergeRidePair(keeper, loser);
          byId.set(String(keeper.ride.id), merged);
          Object.assign(keeper, merged);
          const loserId = String(loser.ride.id);
          byId.delete(loserId);
          dropped.add(loserId);
          tombMap.set(`ride|${loserId}`, { kind: 'ride', id: loserId, deletedAt: Math.max(keeper.updatedAt || 0, loser.updatedAt || 0, now) });
        }
      }
    }

    const rides = [...byId.values()].sort((a, b) => Date.parse(b.ride.date || 0) - Date.parse(a.ride.date || 0));
    return { rides, tombstones: [...tombMap.values()] };
  }

  function msgKey(m) {
    if (m.id) return `id:${m.id}`;
    const ref = (m.workout && m.workout.id) || (m.plan && m.plan.id) || String(m.content || '').slice(0, 120);
    return `legacy:${m.role || ''}|${Number(m.at) || 0}|${ref}`;
  }

  /**
   * Merges two AI Coach chat payloads (`apex_ask_v1`).
   * Preserves messages newer than max(local.clearedAt, remote.clearedAt), deduplicates by id,
   * and sorts chronologically.
   */
  function mergeChat(localRaw, localAt = 0, remoteRaw, remoteAt = 0) {
    const l = safeParse(localRaw, null);
    const r = safeParse(remoteRaw, null);
    if (!l && !r) return { value: null, updatedAt: Math.max(localAt, remoteAt) };
    const la = l && typeof l === 'object' ? l : {};
    const ra = r && typeof r === 'object' ? r : {};
    const clearedAt = Math.max(Number(la.clearedAt) || 0, Number(ra.clearedAt) || 0);
    const byKey = new Map();

    const add = (list) => {
      for (const m of Array.isArray(list) ? list : []) {
        if (!m || typeof m !== 'object' || !m.role) continue;
        const at = Number(m.at) || 0;
        if (clearedAt > 0 && at <= clearedAt) continue;
        const k = msgKey(m);
        const prev = byKey.get(k);
        if (!prev) {
          byKey.set(k, { ...m });
        } else {
          const merged = { ...prev, ...m };
          if (prev.saved || m.saved) merged.saved = true;
          if (!merged.thoughts && prev.thoughts) merged.thoughts = prev.thoughts;
          if (!merged.id && prev.id) merged.id = prev.id;
          byKey.set(k, merged);
        }
      }
    };
    add(la.messages);
    add(ra.messages);

    let messages = [...byKey.values()].sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
    if (messages.length > 100) messages = messages.slice(-100);
    const recentWorkouts = new Set(messages.filter((m) => m.role === 'workout').slice(-5));
    messages = messages.map((m) => (m.role === 'workout' && !recentWorkouts.has(m) && m.thoughts ? { ...m, thoughts: '' } : m));

    const preferRemote = (Number(remoteAt) || 0) > (Number(localAt) || 0);
    const base = preferRemote ? (r ? ra : la) : (l ? la : ra);
    const out = {
      period: base.period || '6w',
      from: base.from || '',
      to: base.to || '',
      clearedAt,
      messages
    };
    return { value: JSON.stringify(out), updatedAt: Math.max(Number(localAt) || 0, Number(remoteAt) || 0) };
  }

  /** Merges profile lists by ID, unioning ftpHistory entries chronologically. */
  function mergeProfiles(localRaw, localAt = 0, remoteRaw, remoteAt = 0) {
    const l = safeParse(localRaw, null);
    const r = safeParse(remoteRaw, null);
    if (!Array.isArray(l) && !Array.isArray(r)) return { value: null, updatedAt: Math.max(localAt, remoteAt) };
    const localList = Array.isArray(l) ? l : [];
    const remoteList = Array.isArray(r) ? r : [];
    const preferRemote = (Number(remoteAt) || 0) > (Number(localAt) || 0);
    const byId = new Map();

    const mergeFtpHistory = (a = [], b = []) => {
      const m = new Map();
      for (const e of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
        if (!e || typeof e !== 'object') continue;
        const k = `${e.date || ''}|${e.ftp || ''}|${e.source || ''}`;
        if (!m.has(k)) m.set(k, e);
      }
      return [...m.values()].sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')));
    };

    for (const p of localList) if (p && p.id) byId.set(String(p.id), p);
    for (const p of remoteList) {
      if (!p || !p.id) continue;
      const id = String(p.id);
      const prev = byId.get(id);
      if (!prev) { byId.set(id, p); continue; }
      const base = preferRemote ? p : prev;
      const other = preferRemote ? prev : p;
      const merged = { ...other, ...base };
      if (Array.isArray(prev.ftpHistory) || Array.isArray(p.ftpHistory)) {
        merged.ftpHistory = mergeFtpHistory(prev.ftpHistory, p.ftpHistory);
      }
      byId.set(id, merged);
    }
    return { value: JSON.stringify([...byId.values()]), updatedAt: Math.max(Number(localAt) || 0, Number(remoteAt) || 0) };
  }

  /** Merges saved custom workouts by id/title. */
  function mergeSavedWorkouts(localRaw, localAt = 0, remoteRaw, remoteAt = 0) {
    const l = safeParse(localRaw, null);
    const r = safeParse(remoteRaw, null);
    if (!Array.isArray(l) && !Array.isArray(r)) return { value: null, updatedAt: Math.max(localAt, remoteAt) };
    const localList = Array.isArray(l) ? l : [];
    const remoteList = Array.isArray(r) ? r : [];
    const preferRemote = (Number(remoteAt) || 0) > (Number(localAt) || 0);
    const byKey = new Map();
    const keyOf = (w) => String(w.id || w.title || JSON.stringify(w));
    const first = preferRemote ? localList : remoteList;
    const second = preferRemote ? remoteList : localList;
    for (const w of first) if (w && typeof w === 'object') byKey.set(keyOf(w), w);
    for (const w of second) if (w && typeof w === 'object') byKey.set(keyOf(w), w);
    return { value: JSON.stringify([...byKey.values()]), updatedAt: Math.max(Number(localAt) || 0, Number(remoteAt) || 0) };
  }

  function mergeTrainingBlock(localRaw, localAt = 0, remoteRaw, remoteAt = 0) {
    const preferRemote = (Number(remoteAt) || 0) > (Number(localAt) || 0);
    const value = preferRemote ? (remoteRaw ?? localRaw ?? null) : (localRaw ?? remoteRaw ?? null);
    return { value, updatedAt: Math.max(Number(localAt) || 0, Number(remoteAt) || 0) };
  }

  /** Merges synced settings maps ({ key: { value, updatedAt } }) + setting tombstones. */
  function mergeSettings(localSettings = {}, remoteSettings = {}, tombstones = []) {
    const tombMap = normalizeTombstones(tombstones);
    const keys = new Set([
      ...Object.keys(localSettings).filter(isSyncedSetting),
      ...Object.keys(remoteSettings).filter(isSyncedSetting)
    ]);
    const out = {};
    for (const k of keys) {
      const l = localSettings[k];
      const r = remoteSettings[k];
      const tomb = tombMap.get(`setting|${k}`);
      const lAt = l ? Number(l.updatedAt) || 0 : 0;
      const rAt = r ? Number(r.updatedAt) || 0 : 0;
      const lAlive = l && l.value !== null && l.value !== undefined && (!tomb || lAt > tomb.deletedAt);
      const rAlive = r && r.value !== null && r.value !== undefined && (!tomb || rAt > tomb.deletedAt);
      if (!lAlive && !rAlive) continue;

      const lv = lAlive ? l.value : null;
      const rv = rAlive ? r.value : null;
      if (k === 'apex_ask_v1') {
        const res = mergeChat(lv, lAlive ? lAt : 0, rv, rAlive ? rAt : 0);
        if (res.value !== null) out[k] = res;
      } else if (k === 'apex_velo_profiles') {
        const res = mergeProfiles(lv, lAlive ? lAt : 0, rv, rAlive ? rAt : 0);
        if (res.value !== null) out[k] = res;
      } else if (k === 'apex_velo_saved_workouts') {
        const res = mergeSavedWorkouts(lv, lAlive ? lAt : 0, rv, rAlive ? rAt : 0);
        if (res.value !== null) out[k] = res;
      } else if (k === 'apex_training_block') {
        const res = mergeTrainingBlock(lv, lAlive ? lAt : 0, rv, rAlive ? rAt : 0);
        if (res.value !== null) out[k] = res;
      } else {
        const pickRemote = rAlive && (!lAlive || rAt > lAt);
        out[k] = { value: pickRemote ? rv : lv, updatedAt: Math.max(lAlive ? lAt : 0, rAlive ? rAt : 0) };
      }
    }
    return { settings: out, tombstones: [...tombMap.values()] };
  }

  // --------------------------------------------------- multi-source wellness --
  const DEFAULT_WELLNESS_ORDER = ['apple', 'healthconnect', 'icu'];
  const WELLNESS_GROUPS = {
    rhr: ['rhr', 'rhrSrc'],
    hrv: ['hrv', 'hrvSrc', 'hrvKind'],
    sleep: ['sleepH', 'deepH', 'remH', 'coreH', 'awakeH', 'bed', 'wake'],
    weight: ['weight'],
    spo2: ['spo2'],
    resp: ['resp']
  };
  const EXTRA_WELLNESS_FIELDS = ['sleepScore', 'icuReadiness', 'baevsky', 'bpSys', 'bpDia', 'glucose', 'kcalIn', 'sleepHr', 'hrvRmssd', 'hrvSdnn'];
  const hasVal = (obj, k) => obj && obj[k] !== null && obj[k] !== undefined;

  /** Merges wellness_days rows [{ day, source, data, updatedAt }] per (day, source). */
  function mergeWellnessRows(localRows = [], remoteRows = [], tombstones = []) {
    const tombMap = normalizeTombstones(tombstones);
    const byKey = new Map();
    const consider = (row) => {
      if (!row || !row.day || !row.source) return;
      const updatedAt = Number(row.updatedAt) || 0;
      const tKey = `wellness|${row.source}:${row.day}`;
      const tomb = tombMap.get(tKey);
      if (tomb && tomb.deletedAt >= updatedAt) return;
      if (tomb && updatedAt > tomb.deletedAt) tombMap.delete(tKey);
      const key = `${row.day}|${row.source}`;
      const prev = byKey.get(key);
      if (!prev || updatedAt > prev.updatedAt) {
        byKey.set(key, { day: row.day, source: row.source, data: row.data, updatedAt });
      }
    };
    for (const r of localRows) consider(r);
    for (const r of remoteRows) consider(r);
    const rows = [...byKey.values()].sort((a, b) => a.day.localeCompare(b.day) || a.source.localeCompare(b.source));
    return { rows, tombstones: [...tombMap.values()] };
  }

  function summarizeWellnessRow(day, source, data, veloHealth) {
    if (!data || typeof data !== 'object') return null;
    let s;
    if (data.summary && typeof data.summary === 'object') {
      s = { ...data.summary };
    } else if (veloHealth && typeof veloHealth.summarizeDay === 'function') {
      s = veloHealth.summarizeDay(day, data);
      delete s.day;
    } else {
      return null;
    }
    if (source === 'apple') {
      if (s.rhr !== null && s.rhr !== undefined && !s.rhrSrc) s.rhrSrc = 'apple';
      if (s.hrv !== null && s.hrv !== undefined) {
        if (!s.hrvSrc) s.hrvSrc = 'apple';
        s.hrvKind = s.hrvKind || 'sdnn';
      }
    } else if (source === 'healthconnect') {
      if (s.hrv !== null && s.hrv !== undefined) s.hrvKind = s.hrvKind || 'rmssd';
    } else if (source === 'icu') {
      if (s.hrv !== null && s.hrv !== undefined) s.hrvKind = s.hrvKind || 'rmssd';
    }
    return s;
  }

  /**
   * Folds multi-source wellness rows into a single VeloHealth store ({ v: 1, days })
   * prioritizing Apple Health first (then Health Connect, then intervals.icu), while
   * keeping HRV on a single consistent scale (never mixing SDNN and rMSSD).
   */
  function buildHealthStore(rows = [], prefs = {}, veloHealth = null) {
    const order = Array.isArray(prefs.sourceOrder) && prefs.sourceOrder.length ? prefs.sourceOrder : DEFAULT_WELLNESS_ORDER;
    const vh = veloHealth || (typeof root.VeloHealth !== 'undefined' ? root.VeloHealth : null);
    const byDay = new Map();
    for (const r of rows) {
      if (!r || !r.day || !r.source) continue;
      const sum = summarizeWellnessRow(r.day, r.source, r.data, vh);
      if (!sum) continue;
      if (!byDay.has(r.day)) byDay.set(r.day, {});
      byDay.get(r.day)[r.source] = sum;
    }

    // Pick one consistent HRV kind from the highest-priority source that has HRV readings.
    const hrvSourceOrder = prefs.hrv && !order.includes(prefs.hrv) ? [prefs.hrv, ...order]
      : prefs.hrv ? [prefs.hrv, ...order.filter((s) => s !== prefs.hrv)] : order;
    let activeHrvKind = prefs.hrvKind || null;
    if (!activeHrvKind) {
      for (const src of hrvSourceOrder) {
        for (const perSrc of byDay.values()) {
          if (perSrc[src] && hasVal(perSrc[src], 'hrv') && perSrc[src].hrv > 0) {
            activeHrvKind = perSrc[src].hrvKind || (src === 'apple' ? 'sdnn' : 'rmssd');
            break;
          }
        }
        if (activeHrvKind) break;
      }
    }

    const days = {};
    for (const day of [...byDay.keys()].sort()) {
      const perSrc = byDay.get(day);
      const out = { rhr: null, hrv: null, sleepH: null, deepH: null, remH: null, coreH: null, awakeH: null };
      const used = new Set();

      for (const [group, keys] of Object.entries(WELLNESS_GROUPS)) {
        const pref = prefs[group];
        const groupOrder = pref ? [pref, ...order.filter((s) => s !== pref)] : order;
        let chosen = null, chosenSrc = null;
        for (const src of groupOrder) {
          const rec = perSrc[src];
          if (!rec || !hasVal(rec, keys[0])) continue;
          if (group === 'hrv') {
            const kind = rec.hrvKind || (src === 'apple' ? 'sdnn' : 'rmssd');
            if (activeHrvKind && kind !== activeHrvKind) continue;
          }
          chosen = rec;
          chosenSrc = src;
          break;
        }
        if (chosen) {
          used.add(chosenSrc);
          for (const k of keys) if (hasVal(chosen, k)) out[k] = chosen[k];
        }
      }

      for (const k of EXTRA_WELLNESS_FIELDS) {
        for (const src of order) {
          if (perSrc[src] && hasVal(perSrc[src], k)) { out[k] = perSrc[src][k]; break; }
        }
      }

      if (out.rhr === null && out.hrv === null && out.sleepH === null && !hasVal(out, 'weight') && !hasVal(out, 'spo2') && !hasVal(out, 'resp')) {
        continue;
      }
      const list = [...used];
      days[day] = { summary: out, src: list.length > 1 ? 'merged' : (list[0] || 'merged') };
    }
    return { v: 1, days };
  }

  /**
   * Computes which ride IDs, setting keys, and wellness keys need to be pulled or pushed
   * between a local manifest and remote manifest.
   */
  function planDelta(local = {}, remote = {}) {
    const lRides = new Map((local.rides || []).map((r) => [String(r.id), r]));
    const rRides = new Map((remote.rides || []).map((r) => [String(r.id), r]));
    const lTombs = normalizeTombstones(local.tombstones);
    const rTombs = normalizeTombstones(remote.tombstones);

    const pullRideIds = [], pushRideIds = [];
    for (const [id, r] of rRides) {
      const tomb = lTombs.get(`ride|${id}`);
      if (tomb && tomb.deletedAt >= (r.updatedAt || 0)) continue;
      const l = lRides.get(id);
      if (!l || (l.contentHash !== r.contentHash && (r.updatedAt || 0) >= (l.updatedAt || 0))) pullRideIds.push(id);
    }
    for (const [id, l] of lRides) {
      const tomb = rTombs.get(`ride|${id}`);
      if (tomb && tomb.deletedAt >= (l.updatedAt || 0)) continue;
      const r = rRides.get(id);
      if (!r || (l.contentHash !== r.contentHash && (l.updatedAt || 0) >= (r.updatedAt || 0))) pushRideIds.push(id);
    }

    const lSet = local.settings || {};
    const rSet = remote.settings || {};
    const pullSettingKeys = [], pushSettingKeys = [];
    for (const [k, r] of Object.entries(rSet)) {
      if (!isSyncedSetting(k)) continue;
      const tomb = lTombs.get(`setting|${k}`);
      if (tomb && tomb.deletedAt >= (r.updatedAt || 0)) continue;
      const l = lSet[k];
      if (!l || l.hash !== r.hash) pullSettingKeys.push(k);
    }
    for (const [k, l] of Object.entries(lSet)) {
      if (!isSyncedSetting(k)) continue;
      const tomb = rTombs.get(`setting|${k}`);
      if (tomb && tomb.deletedAt >= (l.updatedAt || 0)) continue;
      const r = rSet[k];
      if (!r || l.hash !== r.hash) pushSettingKeys.push(k);
    }

    const lWell = new Map((local.wellness || []).map((w) => [`${w.day}|${w.source}`, w]));
    const rWell = new Map((remote.wellness || []).map((w) => [`${w.day}|${w.source}`, w]));
    const pullWellnessKeys = [], pushWellnessKeys = [];
    for (const [key, r] of rWell) {
      const tomb = lTombs.get(`wellness|${r.source}:${r.day}`);
      if (tomb && tomb.deletedAt >= (r.updatedAt || 0)) continue;
      const l = lWell.get(key);
      if (!l || (r.updatedAt || 0) > (l.updatedAt || 0) || (l.hash && r.hash && l.hash !== r.hash && (r.updatedAt || 0) === (l.updatedAt || 0))) {
        pullWellnessKeys.push({ day: r.day, source: r.source });
      }
    }
    for (const [key, l] of lWell) {
      const tomb = rTombs.get(`wellness|${l.source}:${l.day}`);
      if (tomb && tomb.deletedAt >= (l.updatedAt || 0)) continue;
      const r = rWell.get(key);
      if (!r || (l.updatedAt || 0) > (r.updatedAt || 0)) {
        pushWellnessKeys.push({ day: l.day, source: l.source });
      }
    }

    return {
      pullRideIds,
      pushRideIds,
      pullSettingKeys,
      pushSettingKeys,
      pullWellnessKeys,
      pushWellnessKeys,
      pullTombstones: [...rTombs.values()],
      pushTombstones: [...lTombs.values()]
    };
  }

  const VeloSync = {
    SYNCED_SETTINGS: [...SYNCED_SETTINGS],
    DEFAULT_WELLNESS_ORDER,
    WELLNESS_GROUPS,
    isSyncedSetting,
    rideMetaJson,
    formatRideHash,
    mergeRides,
    mergeChat,
    mergeProfiles,
    mergeSavedWorkouts,
    mergeTrainingBlock,
    mergeSettings,
    mergeWellnessRows,
    buildHealthStore,
    planDelta
  };

  root.VeloSync = VeloSync;
  if (typeof module !== 'undefined' && module.exports) module.exports = VeloSync;
})(typeof window !== 'undefined' ? window : globalThis);
