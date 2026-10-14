/* Profile-scoped, derived FTP histories. No estimator or training-setting writes. */
(function (root) {
  const METRICS = {
    active: { label: 'FTP in Use', color: '#ffbe4a', stepped: true, main: true },
    A: { label: 'Power Curve', color: '#4be3a6' },
    Aplus: { label: 'Bayesian Power Curve', color: '#b199ff', dash: [5, 4] },
    B: { label: 'Power + Heart Rate', color: '#7cc8ff', main: true },
    Cfloor: { label: 'Workout Capacity Floor', color: '#65d8c7', points: true },
    C: { label: 'Workout Capacity Model', color: '#a4acc6', dash: [3, 5] }
  };
  const watts = v => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 2000 ? v : null;
  const time = v => typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  const text = v => typeof v === 'string' ? v.slice(0, 240) : '';
  function normalize(input, profileId) {
    if (!input || input.schema !== 'apex-ftp-history' || input.version !== 1) throw new Error('Choose an Apex FTP history export (version 1).');
    if (!profileId || input.profileId !== profileId) throw new Error('This FTP history belongs to a different rider profile.');
    const asOf = time(input.asOf);
    if (!Number.isFinite(asOf) || asOf > Date.now() + 300000) throw new Error('Invalid calculation snapshot date.');
    const series = {};
    let total = 0;
    // Preserve legacy benchmark data in exports/backups, without displaying it.
    for (const key of [...Object.keys(METRICS).filter(k => k !== 'active'), 'trainerRoad']) {
      const rows = input.series?.[key] || [];
      if (!Array.isArray(rows) || rows.length > 10000) throw new Error('Invalid or oversized FTP history.');
      series[key] = rows.map(p => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Invalid FTP history point.');
        const x = time(p.date), y = p.value == null ? null : watts(p.value);
        if (!Number.isFinite(x) || x > asOf || (p.value != null && y === null)) throw new Error('Invalid or future FTP history point.');
        const low = watts(p.low), high = watts(p.high);
        if ((p.low != null && low === null) || (p.high != null && high === null) ||
            (low != null && high != null && low > high) || (y != null && low != null && low > y) || (y != null && high != null && high < y)) throw new Error('Invalid uncertainty bounds.');
        const workoutImplied = p.workoutImplied == null ? null : watts(p.workoutImplied);
        if (p.workoutImplied != null && workoutImplied === null) throw new Error('Invalid workout-implied FTP.');
        return { x, y, low, high, workoutImplied, title: text(p.title), reason: text(p.reason), rangeKind: text(p.rangeKind),
          dateOnly: p.dateOnly === true, order: Number.isInteger(p.order) ? p.order : 0 };
      }).sort((a, b) => a.x - b.x || a.order - b.order);
      total += series[key].length;
    }
    if (total > 40000) throw new Error('FTP history has too many points.');
    return { schema: input.schema, version: 1, profileId, asOf, series, modelVersion: text(input.modelVersion),
      // null means the export did not record the profile inputs, so they cannot be compared with the current profile.
      context: input.context && typeof input.context === 'object' ? { maxHr: watts(input.context.maxHr), lthr: watts(input.context.lthr), age: watts(input.context.age) } : null };
  }
  function exportBundle(bundle) {
    return { ...bundle, asOf: new Date(bundle.asOf).toISOString(), series: Object.fromEntries(Object.entries(bundle.series).map(([key, rows]) =>
      [key, rows.map(p => ({ date: new Date(p.x).toISOString(), value: p.y, low: p.low, high: p.high, workoutImplied: p.workoutImplied, title: p.title, reason: p.reason,
        rangeKind: p.rangeKind, dateOnly: p.dateOnly, order: p.order }))])) };
  }
  function activeHistory(profile, rides, now = Date.now()) {
    const events = [];
    for (const r of rides || []) {
      const x = time(r.date), y = watts(r.ftpAtRide);
      if (Number.isFinite(x) && x <= now && y) events.push({ x, y, priority: 0, title: text(r.title), reason: 'Recorded FTP used for this ride' });
    }
    for (const p of profile?.ftpHistory || []) {
      const x = time(p.date), y = watts(p.ftp);
      if (Number.isFinite(x) && x <= now && y) events.push({ x, y, priority: 1, reason: 'Recorded profile FTP change' });
    }
    events.sort((a, b) => a.x - b.x || a.priority - b.priority);
    const unique = [];
    for (const p of events) { if (unique.at(-1)?.x === p.x) unique[unique.length - 1] = p; else unique.push(p); }
    const current = watts(profile?.ftp);
    if (current) unique.push({ x: now, y: current, reason: 'Current training setting; not a measured FTP label' });
    return unique;
  }
  function inRange(rows, start, end, stepped = false) {
    const result = rows.filter(p => p.x >= start && p.x <= end);
    if (stepped) {
      const prior = rows.filter(p => p.x < start).at(-1);
      if (prior) result.unshift({ ...prior, x: start, reason: prior.reason + ' (carried from earlier recorded setting)' });
    }
    return result;
  }
  // Date-only points are UTC midnight; show them in UTC so they never slip to the previous day west of Greenwich.
  function formatDate(x, dateOnly = false, options = {}) {
    return new Date(x).toLocaleDateString('en-GB', dateOnly ? { ...options, timeZone: 'UTC' } : options);
  }
  const api = { METRICS, normalize, exportBundle, activeHistory, inRange, formatDate, key: id => 'ftp_metric_history:v1:' + id };
  root.VeloFtpHistory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
