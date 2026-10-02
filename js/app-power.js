/**
 * APEX VELO // LAB - Power analysis cache, critical-power model and live W' balance (mixin on VeloApp).
 *
 * Each ride's mean-maximal curve (1 s to 4 h) and zone times are computed once and cached by ride id
 * and sample count (recorded samples never change), so Analytics, medals and the ride review reuse
 * them instead of rescanning every ride on every refresh. The CP model (VeloPower.fitModel) is fitted
 * to the best efforts of the 90 days up to a date and memoised until the ride history changes.
 * During a ride, W' balance runs live from the model in force when the ride started.
 */
(function () {
  const DAY = 86400000;
  const MODEL_DAYS = 90;
  const MMP_IDX = VeloMetrics.MMP_DURATIONS.map(d => VeloPower.gridIndex(d));
  const MEDAL_IDX = VeloInsight.MEDAL_DURATIONS.map(d => VeloPower.gridIndex(d));

  Object.assign(VeloApp.prototype, {
    /** FTP a ride was analysed with: the FTP stored with it, else the current one. */
    rideFtp(r) { return Number(r && r.ftpAtRide) > 0 ? Number(r.ftpAtRide) : Number((this.activeProfile || {}).ftp) || 0; },

    /** Cached { curve (VeloPower.GRID), zones, zonesFtp, n } for a ride with samples, else null. */
    ridePower(r) {
      if (!VeloInsight.hasSamples(r)) return null;
      const cache = this._ridePowerCache || (this._ridePowerCache = new Map());
      const key = `${r.id}|${r.samples.length}`;
      let e = cache.get(key);
      if (!e) {
        const prep = VeloPower.prepare(r.samples);
        const ftp = this.rideFtp(r);
        e = { n: prep.n, curve: VeloPower.mmp(prep), zones: VeloPower.zoneSeconds(prep.power, ftp), zonesFtp: ftp };
        if (cache.size > 2 * (this.completedWorkouts || []).length + 50) cache.clear();
        cache.set(key, e);
      }
      return e;
    },

    /** Seconds in Z1..Z7 for a ride (1 Hz power vs the ride's FTP), or null without samples. */
    rideZoneSeconds(r) {
      const e = this.ridePower(r);
      if (!e) return null;
      const ftp = this.rideFtp(r);
      if (e.zonesFtp !== ftp) { e.zones = VeloPower.zoneSeconds(VeloPower.prepare(r.samples).power, ftp); e.zonesFtp = ftp; }
      return e.zones;
    },

    /** VeloTrends.efOf, cached per ride (NP over the steady part is the expensive bit). */
    rideEf(r) {
      const cache = this._efCache || (this._efCache = new Map());
      const key = `${r.id}|${r.samples ? r.samples.length : 0}|${r.ftpAtRide || ''}|${r.np || ''}|${r.avgHr || ''}|${r.duration || ''}`;
      if (!cache.has(key)) {
        if (cache.size > 2 * (this.completedWorkouts || []).length + 50) cache.clear();
        cache.set(key, VeloTrends.efOf(r));
      }
      return cache.get(key);
    },

    /** Best powers for the MMP durations (VeloMetrics.MMP_DURATIONS) of one ride. */
    rideMmp(r) {
      const e = this.ridePower(r);
      return e ? MMP_IDX.map(i => e.curve[i]) : null;
    },

    /** Best powers for the medal durations (VeloInsight.MEDAL_DURATIONS) of one ride. */
    rideMedalPeaks(r) {
      const e = this.ridePower(r);
      return e ? MEDAL_IDX.map(i => e.curve[i]) : null;
    },

    /** Cheap fingerprint of the ride list: ids, dates and sample counts (FNV-1a). */
    historySignature() {
      let h = 2166136261;
      const mix = (s) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } };
      for (const r of this.completedWorkouts || []) {
        if (!r) continue;
        mix(String(r.id)); mix(String(r.date)); mix(String(r.samples ? r.samples.length : 0)); mix(String(r.ftpAtRide || ''));
      }
      return `${(this.completedWorkouts || []).length}:${h >>> 0}`;
    },

    /**
     * Memo store that empties itself when the ride history changes. Keys carry the minute, so a page
     * left open (or a long ride on the Analytics tab) keeps adding entries: past 300 it starts over.
     */
    powerMemo() {
      const sig = this.historySignature();
      if (!this._powerMemo || this._powerMemo.sig !== sig || this._powerMemo.map.size > 300) this._powerMemo = { sig, map: new Map() };
      return this._powerMemo.map;
    },

    /** Cycling rides with power curves: [{ id, t, title, curve }], oldest first. */
    powerEntries() {
      const memo = this.powerMemo();
      if (!memo.has('entries')) {
        memo.set('entries', this.cyclingRides().filter(VeloInsight.hasSamples)
          .map(r => ({ id: r.id, t: Date.parse(r.date), title: r.title, curve: this.ridePower(r).curve }))
          .filter(e => Number.isFinite(e.t)).sort((a, b) => a.t - b.t));
      }
      return memo.get('entries');
    },

    /** Best curve over rides with from < t <= to: { watts, ids, times } on VeloPower.GRID. */
    powerEnvelope(from, to) {
      const memo = this.powerMemo();
      const key = `env|${Math.floor(from / 60000)}|${Math.floor(to / 60000)}`;
      if (!memo.has(key)) memo.set(key, VeloPower.envelope(this.powerEntries().filter(e => e.t > from && e.t <= to)));
      return memo.get(key);
    },

    /** CP model from the best efforts of the 90 days up to (and including) time t. */
    powerModelAt(t = Date.now()) {
      const memo = this.powerMemo();
      const key = `model|${Math.floor(t / 60000)}`;
      if (!memo.has(key)) {
        const env = this.powerEnvelope(t - MODEL_DAYS * DAY, t);
        memo.set(key, { ...VeloPower.fitModel(env.watts), from: t - MODEL_DAYS * DAY, to: t, env });
      }
      return memo.get(key);
    },

    /** Rolling 90-day model every stepDays across [from, to]. */
    powerModelHistory(from, to, stepDays) {
      const memo = this.powerMemo();
      const key = `hist|${Math.floor(from / DAY)}|${Math.floor(to / DAY)}|${stepDays}`;
      if (!memo.has(key)) memo.set(key, VeloPower.modelHistory(this.powerEntries(), { from, to, stepDays, windowDays: MODEL_DAYS }));
      return memo.get(key);
    },

    // ------------------------------------------------------------ live W'bal --
    /** Starts live W' balance for a new ride from the current model (no model = no W'bal). */
    resetLiveWbal() {
      const m = this.powerModelAt(Date.now());
      this.liveWbal = m && m.ok ? { cp: m.cp, w: m.w, bal: m.w, min: m.w, matches: 0, burning: false, peak: m.w, trough: m.w, lastTs: null } : null;
      this.renderLiveWbal();
    },

    /** One ride second of W' balance; a pause (new segment) recovers W' over the paused seconds. */
    updateLiveWbal(power, segmentStart) {
      const s = this.liveWbal;
      if (!s) return;
      const now = Date.now();
      if (segmentStart && s.lastTs) s.bal = VeloPower.wbalRecover(s.bal, s.cp, s.w, Math.max(0, (now - s.lastTs) / 1000 - 1));
      s.lastTs = now;
      s.bal = VeloPower.wbalStep(s.bal, Number(power) || 0, s.cp, s.w);
      if (s.bal < s.min) s.min = s.bal;
      if (!s.burning) {
        if (s.bal > s.peak) s.peak = s.bal;
        if (s.peak - s.bal >= VeloPower.MATCH_J) { s.matches++; s.burning = true; s.trough = s.bal; }
      } else {
        if (s.bal < s.trough) s.trough = s.bal;
        if (s.bal - s.trough >= VeloPower.MATCH_J / 2) { s.burning = false; s.peak = s.bal; }
      }
      this.renderLiveWbal();
    },

    /** Snapshot for the cockpit and the phone: { kj, pct, tte (s or null), matches, cp, wKj } or null. */
    liveWbalState() {
      const s = this.liveWbal;
      if (!s) return null;
      const p10 = this.isPlaying && this.powerBuffer && this.powerBuffer.length ? this.getSmoothedPower(10) : 0;
      const tte = VeloPower.timeToEmpty(s.bal, p10, s.cp);
      return {
        kj: Math.round(s.bal / 100) / 10, pct: Math.max(0, Math.min(100, Math.round((s.bal / s.w) * 100))),
        tte: Number.isFinite(tte) ? Math.round(tte) : null, matches: s.matches, cp: s.cp, wKj: Math.round(s.w / 100) / 10,
        state: s.bal <= 0 ? 'empty' : p10 > s.cp ? 'burning' : s.bal < s.w - 50 ? 'recovering' : 'full'
      };
    },

    renderLiveWbal() {
      const card = document.getElementById('wbalCard');
      if (!card) return;
      const st = this.liveWbalState();
      const fill = document.getElementById('wbalFill');
      if (!st) {
        // Before the ride: preview the model the ride will use (W' starts full).
        const m = this.powerModelAt(Date.now());
        const ready = m && m.ok && this.liveWbal === undefined;
        card.dataset.state = ready ? 'ready' : 'none';
        this.setText('wbalValue', ready ? (m.w / 1000).toFixed(1) : '--');
        this.setText('wbalPct', ready ? '100%' : '');
        this.setText('wbalCpChip', ready ? `CP ${m.cp} W \u00b7 W\u2032 ${(m.w / 1000).toFixed(1)} kJ` : 'NO MODEL');
        this.setText('wbalMatches', '0');
        this.setText('wbalNote', ready ? 'Full - your anaerobic reserve above CP. It drains above CP and recharges below it.'
          : m && m.reason === 'coverage' ? 'Needs a ride of 20 min or more with hard 3-5 min efforts in the last 90 days to model CP and W\u2032.'
            : 'No CP model from the last 90 days yet - see Analytics \u203a Power & CP.');
        if (fill) { fill.style.width = ready ? '100%' : '0%'; fill.dataset.level = 'high'; }
        return;
      }
      card.dataset.state = st.state;
      this.setText('wbalValue', st.kj.toFixed(1));
      this.setText('wbalPct', `${st.pct}%`);
      this.setText('wbalCpChip', `CP ${st.cp} W \u00b7 W\u2032 ${st.wKj} kJ`);
      if (fill) { fill.style.width = `${st.pct}%`; fill.dataset.level = st.pct < 25 ? 'low' : st.pct < 60 ? 'mid' : 'high'; }
      const tte = st.tte === null ? '' : st.tte >= 3600 ? 'over an hour' : this.fmtTime(st.tte);
      this.setText('wbalNote', {
        empty: 'Empty - past your modelled limit. If you are still holding on, your CP or W\u2032 is higher than the model.',
        burning: `Above CP - empty in ${tte} at this power`,
        recovering: 'Under CP - recharging',
        full: 'Full - fresh for the next effort'
      }[st.state]);
      this.setText('wbalMatches', String(st.matches));
    }
  });
})();
