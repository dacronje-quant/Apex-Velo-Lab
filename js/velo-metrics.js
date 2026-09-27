/**
 * APEX VELO // LAB - Pure training-science helpers (no DOM access).
 *
 * Everything here is deterministic math over recorded telemetry, so it can be
 * unit-tested in isolation and reused by the cockpit, analytics and exporters.
 */
class VeloMetrics {
  /** Coggan 7-zone model (upper bound in % FTP, inclusive). Shared by canvas, CSS and tables. */
  static ZONES = [
    { idx: 1, key: 'z1', short: 'Z1', name: 'Active Recovery', max: 55,  color: '#7c8aa5' },
    { idx: 2, key: 'z2', short: 'Z2', name: 'Endurance',       max: 75,  color: '#3b82f6' },
    { idx: 3, key: 'z3', short: 'Z3', name: 'Tempo',           max: 90,  color: '#22c55e' },
    { idx: 4, key: 'z4', short: 'Z4', name: 'Threshold',       max: 105, color: '#eab308' },
    { idx: 5, key: 'z5', short: 'Z5', name: 'VO2 Max',         max: 120, color: '#f97316' },
    { idx: 6, key: 'z6', short: 'Z6', name: 'Anaerobic',       max: 150, color: '#ef4444' },
    { idx: 7, key: 'z7', short: 'Z7', name: 'Neuromuscular',   max: Infinity, color: '#a855f7' }
  ];

  /** Standard mean-maximal durations used across the app (seconds). */
  static MMP_DURATIONS = [5, 15, 30, 60, 180, 300, 600, 1200, 3600];
  static MMP_LABELS = ['5s', '15s', '30s', '1m', '3m', '5m', '10m', '20m', '60m'];

  /** Returns the Coggan zone for a % FTP value (below 55% is Z1, 55-75 Z2, ...). */
  static zoneForPct(pct) {
    const p = Number(pct) || 0;
    if (p < 55) return VeloMetrics.ZONES[0];
    for (let i = 1; i < VeloMetrics.ZONES.length; i++) {
      if (p <= VeloMetrics.ZONES[i].max) return VeloMetrics.ZONES[i];
    }
    return VeloMetrics.ZONES[6];
  }

  /**
   * True for cycling records. Non-cycling activities imported from Strava (strength, walks, yoga...)
   * carry activityType and are kept out of cycling analytics, MMP, FTP and power charts.
   */
  static isCycling(r) { return !!r && (!r.activityType || r.activityType === 'ride'); }

  /** Local-calendar YYYY-MM-DD key (avoids the UTC shift of toISOString at local midnight). */
  static localDateKey(input) {
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return '';
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  /**
   * Performance Management "form" classification from TSB.
   * Bands follow common Banister/TSB coaching practice.
   */
  static formZone(tsb) {
    const t = Number(tsb) || 0;
    if (t > 5)   return { key: 'fresh',       label: 'Fresh',        desc: 'Fully recovered. Ideal for testing, racing or a key session.' };
    if (t > -10) return { key: 'productive',  label: 'Productive',   desc: 'Balanced load. Normal training can progress as planned.' };
    if (t > -25) return { key: 'optimal',     label: 'Optimal',      desc: 'Optimal overload window: fitness is being built efficiently.' };
    if (t > -40) return { key: 'fatigue',     label: 'High Fatigue', desc: 'Heavy accumulated fatigue. Prioritise sleep, fuelling and easier days.' };
    return         { key: 'overtraining', label: 'Overtraining', desc: 'Overtraining risk. Recovery should take priority.' };
  }

  /** Best rolling average over `windowSec` samples (1 Hz). Returns null when too few samples. */
  static bestRollingAvg(powers, windowSec) {
    const n = powers.length;
    if (!windowSec || n < windowSec) return null;
    let sum = 0;
    for (let i = 0; i < windowSec; i++) sum += powers[i] || 0;
    let best = sum;
    for (let i = windowSec; i < n; i++) {
      sum += (powers[i] || 0) - (powers[i - windowSec] || 0);
      if (sum > best) best = sum;
    }
    return Math.round(best / windowSec);
  }

  /**
   * Makes recorded samples 1 Hz: many head units log a point only every few seconds ("smart
   * recording"). A gap of up to `maxHoldSec` holds the last reading so every sample is one second
   * (NP, power bests and medals assume that); a longer gap is a pause and is left out. Points in
   * the same second keep the first one. Samples must have `time` in seconds.
   */
  static toOneHz(samples, maxHoldSec = 10) {
    const src = (samples || []).filter(s => s && Number.isFinite(Number(s.time)));
    if (src.length < 2) return samples || [];
    src.sort((a, b) => a.time - b.time);
    const out = [];
    for (const s of src) {
      const prev = out[out.length - 1];
      if (prev) {
        const gap = Math.round(s.time - prev.time);
        if (gap <= 0) continue;
        for (let k = 1; gap <= maxHoldSec && k < gap; k++) {
          out.push({ ...prev, time: prev.time + k, timestamp: Number.isFinite(prev.timestamp) ? prev.timestamp + k * 1000 : prev.timestamp });
        }
      }
      out.push(s);
    }
    return out;
  }

  /** Mean-maximal power curve for the given durations. Missing durations are null. */
  static mmpCurve(powers, durations = VeloMetrics.MMP_DURATIONS) {
    return durations.map(d => VeloMetrics.bestRollingAvg(powers, d));
  }

  /** Normalized Power (30 s rolling, 4th power mean). Returns 0 with fewer than 30 samples. */
  static normalizedPower(powers) {
    const n = powers.length;
    if (n < 30) return 0;
    let sum = 0;
    for (let i = 0; i < 30; i++) sum += powers[i] || 0;
    let acc = Math.pow(sum / 30, 4);
    let count = 1;
    for (let i = 30; i < n; i++) {
      sum += (powers[i] || 0) - (powers[i - 30] || 0);
      acc += Math.pow(sum / 30, 4);
      count++;
    }
    return Math.round(Math.pow(acc / count, 0.25));
  }

  /** Min / max / mean over the positive (i.e. recorded) values of an array. */
  /**
   * Average power the standard way (TrainingPeaks / Garmin default): coasting seconds count as 0 W.
   * Missing samples (null / undefined) are skipped.
   */
  static avgPower(values) {
    let sum = 0, n = 0;
    for (const v of values || []) {
      if (v === null || v === undefined || v === '') continue;
      const x = Number(v);
      if (!Number.isFinite(x)) continue;
      sum += Math.max(0, x); n++;
    }
    return n ? Math.round(sum / n) : 0;
  }

  static stats(values) {
    let sum = 0, count = 0, max = 0;
    for (const v of values) {
      const x = Number(v) || 0;
      if (x > 0) { sum += x; count++; if (x > max) max = x; }
    }
    return { avg: count ? Math.round(sum / count) : 0, max, count };
  }

  /**
   * Mechanical work in kJ integrated from recorded samples.
   * Uses the real time step between samples (defaults to 1 s at 1 Hz).
   */
  static workKjFromSamples(samples) {
    if (!samples || !samples.length) return 0;
    let joules = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      let dt = 1;
      if (i > 0 && Number.isFinite(s.time) && Number.isFinite(samples[i - 1].time)) {
        dt = Math.max(0, s.time - samples[i - 1].time) || 1;
      } else if (i === 0 && samples.length > 1 && Number.isFinite(s.time) && Number.isFinite(samples[1].time)) {
        dt = Math.max(0, samples[1].time - s.time) || 1;
      }
      joules += (Number(s.power) || 0) * dt;
    }
    return joules / 1000;
  }

  /**
   * Metabolic energy estimate from mechanical work. Human gross efficiency on a
   * bike (~24%) almost exactly cancels the 4.184 kJ/kcal conversion, so the
   * standard cycling convention is kcal ~= kJ of work done.
   */
  static kcalFromKj(kj) {
    return Math.round(Number(kj) || 0);
  }

  /** Execution fidelity score (0-100) of actual power vs interval targets. */
  static complianceScore(samples) {
    const withTarget = (samples || []).filter(s => s.target > 0);
    if (!withTarget.length) return null;
    const total = withTarget.reduce((acc, s) => {
      const diffRatio = Math.abs((s.power || 0) - s.target) / s.target;
      return acc + Math.max(0, 100 - diffRatio * 100);
    }, 0);
    return Math.round(total / withTarget.length);
  }

  /** Target compliance state for a power reading vs target (tolerance in %). */
  static targetState(power, target, tolerancePct = 5) {
    if (!target || target <= 0) return { state: 'idle', diff: 0, diffPct: 0 };
    const diff = Math.round(power - target);
    const diffPct = (diff / target) * 100;
    if (Math.abs(diffPct) <= tolerancePct) return { state: 'on', diff, diffPct };
    return { state: diff < 0 ? 'under' : 'over', diff, diffPct };
  }

  /** Heart-rate zone (5-zone, % of max HR). */
  static hrZone(hr, maxHr) {
    if (!hr || !maxHr) return { idx: 0, label: '--', pct: 0 };
    const pct = (hr / maxHr) * 100;
    let idx = 1, label = 'Z1 Recovery';
    if (pct > 89) { idx = 5; label = 'Z5 Max'; }
    else if (pct > 82) { idx = 4; label = 'Z4 Threshold'; }
    else if (pct > 72) { idx = 3; label = 'Z3 Tempo'; }
    else if (pct > 60) { idx = 2; label = 'Z2 Aerobic'; }
    return { idx, label, pct: Math.round(pct) };
  }

  /** Exponential reconnect backoff schedule with an upper cap (milliseconds). */
  static backoffDelay(attempt, baseMs = 1000, capMs = 30000) {
    const a = Math.max(0, attempt | 0);
    return Math.min(capMs, baseMs * Math.pow(2, a));
  }

  /** Number of days from Jan 1 (local) through today inclusive. */
  static daysYearToDate(now = new Date()) {
    const jan1 = new Date(now.getFullYear(), 0, 1);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((today - jan1) / 86400000) + 1;
  }
}

if (typeof window !== 'undefined') window.VeloMetrics = VeloMetrics;
