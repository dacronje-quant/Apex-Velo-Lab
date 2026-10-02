/**
 * APEX VELO // LAB - Live session analytics + Banister PMC model.
 * Pure math over recorded power; no DOM access.
 */
class VeloAnalytics {
  /** "Mar 4" labels; one cached formatter (toLocaleDateString builds a new one on every call). */
  static dayLabel(d) {
    if (!VeloAnalytics._fmt) VeloAnalytics._fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
    return VeloAnalytics._fmt.format(d);
  }

  constructor(ftp = 185, weightKg = 75) {
    this.ftp = ftp;
    this.weightKg = weightKg;
    this.reset();
  }

  reset() {
    this.rolling30s = [];
    this.rolling30Sum = 0;
    this.npSum = 0;
    this.npCount = 0;
    this.normalizedPower = 0;
    this.intensityFactor = 0;
    this.tss = 0;
    this.totalSeconds = 0;
    this.totalJoules = 0;
    this.zoneSeconds = [0, 0, 0, 0, 0, 0, 0];
    this.mmpDurations = VeloMetrics.MMP_DURATIONS.slice();
    this.mmpCurrentBests = {};
    this.mmpRunningSums = {};
    this._hasMmpWindow = {};
    this.mmpDurations.forEach(d => { this.mmpCurrentBests[d] = 0; this.mmpRunningSums[d] = 0; });
    this.powerBuffer = [];
  }

  /** A pause ends continuous windows without discarding accumulated work, NP or bests. */
  startSegment() {
    this.rolling30s = [];
    this.rolling30Sum = 0;
    this.powerBuffer = [];
    this.mmpDurations.forEach(d => { this.mmpRunningSums[d] = 0; });
  }

  /** Feeds one 1 Hz power sample. O(number of MMP durations) per call. */
  update(powerWatts) {
    const p = Math.max(0, Number(powerWatts) || 0);
    this.totalSeconds++;
    this.totalJoules += p;
    this.powerBuffer.push(p);

    this.rolling30s.push(p);
    this.rolling30Sum += p;
    if (this.rolling30s.length > 30) this.rolling30Sum -= this.rolling30s.shift();
    // NP counts only full 30 s windows (like VeloMetrics.normalizedPower), so the live, saved and
    // post-ride NP agree; before 30 s there is no NP yet.
    if (this.rolling30s.length === 30) {
      const avg30 = this.rolling30Sum / 30;
      this.npSum += Math.pow(avg30, 4);
      this.npCount++;
      this.normalizedPower = Math.round(Math.pow(this.npSum / this.npCount, 0.25));
    }

    this.intensityFactor = this.ftp > 0 ? (this.normalizedPower / this.ftp) : 0;
    this.tss = this.ftp > 0
      ? Math.round(((this.totalSeconds * this.normalizedPower * this.intensityFactor) / (this.ftp * 3600)) * 100)
      : 0;

    const zone = VeloMetrics.zoneForPct(this.ftp > 0 ? (p / this.ftp) * 100 : 0);
    this.zoneSeconds[zone.idx - 1]++;

    const len = this.powerBuffer.length;
    for (const d of this.mmpDurations) {
      this.mmpRunningSums[d] += p;
      if (len > d) this.mmpRunningSums[d] -= this.powerBuffer[len - 1 - d];
      if (len >= d) {
        this._hasMmpWindow[d] = true;
        const avg = Math.round(this.mmpRunningSums[d] / d);
        if (avg > this.mmpCurrentBests[d]) this.mmpCurrentBests[d] = avg;
      }
    }
  }

  /** Live mean-maximal curve of the current session (null where not yet long enough). */
  getLiveMmp() {
    return this.mmpDurations.map(d => (this._hasMmpWindow[d] ? this.mmpCurrentBests[d] : null));
  }

  getCurrentZoneInfo(powerWatts) {
    const pct = this.ftp > 0 ? Math.round((powerWatts / this.ftp) * 100) : 0;
    const z = VeloMetrics.zoneForPct(pct);
    return { name: `${z.short} ${z.name}`, color: z.color, pct, index: z.idx, key: z.key };
  }

  getZone(pctFtp) {
    return this.getCurrentZoneInfo(Math.round(this.ftp * (pctFtp / 100)));
  }

  /**
   * Banister impulse-response PMC (CTL tau 42 d, ATL tau 7 d) computed for every
   * calendar day from the first ride through today.
   * @param days number of trailing days to return (0 / 'all' = everything)
   * @param opts { strengthInAtl = true, strengthInCtl = false }: strength sessions (strengthTss) add to
   *        fatigue (ATL) but not to cycling fitness (CTL) unless asked. Other non-cycling records add nothing.
   */
  calculatePmcHistory(workouts = [], days = 90, opts = {}) {
    const inAtl = opts.strengthInAtl !== false;
    const inCtl = opts.strengthInCtl === true;
    const empty = { labels: [], dateKeys: [], ctlData: [], atlData: [], tsbData: [], tssData: [], currentCtl: 0, currentAtl: 0, currentTsb: 0 };
    if (!workouts || workouts.length === 0) return empty;

    const dailyTss = new Map();      // cycling TSS
    const dailyStrength = new Map(); // strength load
    let minDate = null;
    workouts.forEach(w => {
      if (!w || !w.date) return;
      const d = new Date(w.date);
      if (isNaN(d.getTime())) return;
      const k = VeloMetrics.localDateKey(d);
      if (VeloMetrics.isCycling(w)) dailyTss.set(k, (dailyTss.get(k) || 0) + (Number(w.tss) || 0));
      else if (Number(w.strengthTss) > 0 && (inAtl || inCtl)) dailyStrength.set(k, (dailyStrength.get(k) || 0) + Number(w.strengthTss));
      else return;
      if (!minDate || d < minDate) minDate = d;
    });
    if (!minDate) return empty;

    const today = new Date();
    const curr = new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate());
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const kCtl = 1 - Math.exp(-1 / 42);
    const kAtl = 1 - Math.exp(-1 / 7);

    let ctl = 0.0;
    let atl = 0.0;
    const all = [];
    while (curr <= end) {
      const k = VeloMetrics.localDateKey(curr);
      const dayTss = dailyTss.get(k) || 0;
      const dayStrength = dailyStrength.get(k) || 0;
      ctl += (dayTss + (inCtl ? dayStrength : 0) - ctl) * kCtl;
      atl += (dayTss + (inAtl ? dayStrength : 0) - atl) * kAtl;
      all.push({
        dateKey: k,
        label: VeloAnalytics.dayLabel(curr),
        ctl: parseFloat(ctl.toFixed(1)),
        atl: parseFloat(atl.toFixed(1)),
        tsb: parseFloat((ctl - atl).toFixed(1)),
        tss: Math.round(dayTss)
      });
      curr.setDate(curr.getDate() + 1);
    }

    const n = Number(days);
    const shown = (n > 0 && all.length > n) ? all.slice(-n) : all;
    const last = all[all.length - 1];
    return {
      labels: shown.map(p => p.label),
      dateKeys: shown.map(p => p.dateKey),
      ctlData: shown.map(p => p.ctl),
      atlData: shown.map(p => p.atl),
      tsbData: shown.map(p => p.tsb),
      tssData: shown.map(p => p.tss),
      currentCtl: last.ctl,
      currentAtl: last.atl,
      currentTsb: last.tsb
    };
  }
}

if (typeof window !== 'undefined') window.VeloAnalytics = VeloAnalytics;
