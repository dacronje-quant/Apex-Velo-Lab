/**
 * APEX VELO // LAB - the data side of the AI Coach chat's questions (mixin on VeloApp).
 *
 * When the rider ticks "Ask about my riding" in the coach chat (js/app-coach-chat.js), the question, the
 * conversation and a text summary of the chosen period (js/velo-ask.js) go to POST /api/ask on the local
 * server (or the phone's own AI engine), which holds the API key; the engine is the one chosen in
 * Settings > AI engine. This file keeps the period, that summary and the engine warning.
 */
(function () {
  const DAY = 86400000;
  const STORE_KEY = 'apex_ask_v1';
  const MEANING_KEYS = [['TSS', 'tss'], ['NP', 'np'], ['IF', 'if'], ['CTL', 'ctl'], ['ATL', 'atl'], ['TSB', 'tsb'], ['EF', 'ef'], ['CP', 'cp'], ["W'", 'wprime'], ['VI', 'vi']];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDay = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });

  Object.assign(VeloApp.prototype, {
    /** The period the questions look at, saved with the chat (apex_ask_v1); the thread itself is js/app-coach-chat.js. */
    initAskUi() {
      this.askPeriod = '6w';
      this.askFrom = '';
      this.askTo = '';
      try {
        const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
        if (s && typeof s === 'object') {
          if (VeloAsk.PERIODS.some(p => p.key === s.period)) this.askPeriod = s.period;
          this.askFrom = typeof s.from === 'string' ? s.from : '';
          this.askTo = typeof s.to === 'string' ? s.to : '';
        }
      } catch (e) { /* storage unavailable: the default period */ }
      const pills = document.getElementById('askPeriodPills');
      if (pills) {
        pills.innerHTML = VeloAsk.PERIODS.map(p => `<button type="button" class="ask-period" data-period="${p.key}" aria-pressed="false">${esc(p.short)}</button>`).join('');
        pills.querySelectorAll('.ask-period').forEach(b => this.on(b, 'click', () => this.setAskPeriod(b.dataset.period)));
      }
      const from = document.getElementById('askFrom'), to = document.getElementById('askTo');
      if (from) { from.value = this.askFrom; this.on(from, 'change', () => { this.askFrom = from.value; this.askPeriodChanged(); }); }
      if (to) { to.value = this.askTo; this.on(to, 'change', () => { this.askTo = to.value; this.askPeriodChanged(); }); }
      this.on(document.getElementById('btnAskEngineWarn'), 'click', () => this.openSettings && this.openSettings('ai'));
      const peek = document.getElementById('askDataPeek');
      if (peek) this.on(peek, 'toggle', () => { if (peek.open) this.renderAskPeek(); });
      this.renderAskPeriod();
      this.updateAskEngine();
    },

    askRange(now = new Date()) {
      const first = this.cyclingRides().reduce((m, r) => { const t = Date.parse(r.date); return Number.isFinite(t) && (m === null || t < m) ? t : m; }, null);
      return VeloAsk.range(this.askPeriod, now, { fromKey: this.askFrom, toKey: this.askTo, firstTs: first });
    },

    setAskPeriod(key) {
      if (!VeloAsk.PERIODS.some(p => p.key === key) || key === this.askPeriod) { if (key === 'custom') this.renderAskPeriod(); return; }
      this.askPeriod = key;
      if (key === 'custom' && !this.askFrom) {
        const r = VeloAsk.range('6w');
        this.askFrom = VeloAsk.dayKey(r.from); this.askTo = VeloAsk.dayKey(r.to);
        const from = document.getElementById('askFrom'), to = document.getElementById('askTo');
        if (from) from.value = this.askFrom;
        if (to) to.value = this.askTo;
      }
      this.askPeriodChanged();
    },

    /** A new period applies from the next question; mid-chat, a note in the thread says so. */
    askPeriodChanged() {
      const r = this.askRange();
      if ((this.askMessages || []).some(m => m.role === 'user')) {
        const last = this.askMessages[this.askMessages.length - 1];
        const note = { role: 'note', content: `Now looking at: ${r.label} (${VeloAsk.dayKey(r.from)} to ${VeloAsk.dayKey(r.to)})` };
        if (last && last.role === 'note') this.askMessages[this.askMessages.length - 1] = note; else this.askMessages.push(note);
        if (this.renderAskThread) this.renderAskThread();
      } else if (this.renderAskThread) this.renderAskThread();
      if (this.saveAsk) this.saveAsk();
      this.renderAskPeriod();
    },

    renderAskPeriod() {
      document.querySelectorAll('#askPeriodPills .ask-period').forEach(b => {
        const on = b.dataset.period === this.askPeriod;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      const custom = document.getElementById('askCustom');
      if (custom) custom.hidden = this.askPeriod !== 'custom';
      const r = this.askRange();
      const rides = this.cyclingRides().filter(x => { const t = Date.parse(x.date); return t >= r.from.getTime() && t <= r.to.getTime(); });
      const hours = rides.reduce((a, x) => a + (Number(x.duration) || 0), 0) / 3600;
      const withPower = rides.filter(x => VeloRideSummary.has(x) || Number(x.np) > 0 || Number(x.avgWatts) > 0).length;
      const scope = document.getElementById('askScope');
      if (scope) {
        scope.innerHTML = rides.length
          ? `<b class="num">${rides.length}</b> ride${rides.length === 1 ? '' : 's'} &middot; <b class="num">${hours.toFixed(1)}</b> h &middot; ${esc(fmtDay(r.from))} - ${esc(fmtDay(r.to))}${withPower < rides.length ? ` &middot; ${withPower} with power` : ''}`
          : `No rides from ${esc(fmtDay(r.from))} to ${esc(fmtDay(r.to))} - pick a longer period`;
      }
      const peek = document.getElementById('askDataPeek');
      if (peek && peek.open) this.renderAskPeek();
      if (!(this.askMessages || []).length && this.renderAskThread) this.renderAskThread();
      if (this.updateCoachGoButton) this.updateCoachGoButton();
    },

    renderAskPeek() {
      const pre = document.getElementById('askDataText');
      if (!pre) return;
      const text = this.askContext();
      pre.textContent = text;
      this.setText('askDataSize', `about ${Math.round(text.length / 4).toLocaleString()} tokens`);
    },

    /** The warning above the thread: questions need an AI key (workouts and plans fall back to the built-in engine). */
    updateAskEngine() {
      const c = this.aiCoach;
      if (!c) return;
      const warn = document.getElementById('askEngineWarn');
      if (!warn) return;
      const asking = (this.coachIntent || 'chat') === 'chat';
      warn.hidden = c.isLive || !asking;
      this.setText('askEngineWarnText', c.engine.reachable
        ? `Questions need a ${c.providerLabel} API key: add ${VeloAiCoach.PROVIDERS[c.provider].keyName} to the .env file and restart Launch-Apex-Velo.bat. Workouts and plans still work with the built-in coach.`
        : 'Questions use Claude, Gemini or ChatGPT through the local server: open the app with Launch-Apex-Velo.bat (your API key stays on this PC). Workouts and plans still work with the built-in coach.');
    },

    /** The text summary of the chosen period the AI answers from (memoised until the data changes). */
    askContext(range = this.askRange()) {
      const p = this.activeProfile || {};
      const key = [range.key, VeloAsk.dayKey(range.from), VeloAsk.dayKey(range.to), this.historySignature(), (this.healthDays || []).length, p.ftp, p.weightKg, p.maxHr, VeloAsk.dayKey(new Date())].join('|');
      if (this._askCtx && this._askCtx.key === key) return this._askCtx.text;
      const text = VeloAsk.build(this.askInput(range));
      this._askCtx = { key, text };
      return text;
    },

    /** Plain numbers for VeloAsk.build(): only measured values, from the app's cached ride analysis. */
    askInput(range) {
      const p = this.activeProfile || {};
      const fromT = range.from.getTime(), toT = range.to.getTime();
      const span = toT - fromT + 1;
      const when = (r) => Date.parse(r.date);
      const within = (r, a, b) => { const t = when(r); return Number.isFinite(t) && t >= a && t <= b; };
      const cycling = this.cyclingRides();
      const rides = cycling.filter(r => within(r, fromT, toT)).sort((a, b) => when(b) - when(a));
      const prev = cycling.filter(r => within(r, fromT - span, fromT - 1));
      const totals = (list) => {
        let sec = 0, km = 0, tss = 0, kj = 0, npSum = 0, npN = 0, longest = 0, withPower = 0, withHr = 0;
        list.forEach(r => {
          const d = Number(r.duration) || 0;
          sec += d; km += Number(r.distanceKm) || 0; tss += Number(r.tss) || 0; kj += Number(r.kj) || 0; longest = Math.max(longest, d);
          const np = Number(r.np) || 0;
          if (np > 0) { npSum += np; npN++; }
          if (VeloRideSummary.has(r) || np > 0 || Number(r.avgWatts) > 0) withPower++;
          if (Number(r.avgHr) > 0) withHr++;
        });
        return { rides: list.length, hours: sec / 3600, km, tss: Math.round(tss), kj: Math.round(kj), avgNp: npN ? Math.round(npSum / npN) : 0, longestSec: longest, withPower, withHr };
      };

      // Form today and fitness at each week end (PMC over the whole history).
      const pmc = this.analytics.calculatePmcHistory(this.completedWorkouts, 0, this.pmcOpts());
      const keys = pmc.dateKeys || [];
      const ctlOn = (k) => { let v = null; for (let i = 0; i < keys.length && keys[i] <= k; i++) v = pmc.ctlData[i]; return v; };
      let form = null;
      if (keys.length && cycling.length) {
        const ramp = VeloTrends.rampRate(pmc.ctlData);
        form = { ctl: pmc.currentCtl, atl: pmc.currentAtl, tsb: pmc.currentTsb, formLabel: VeloMetrics.formZone(pmc.currentTsb).label, ramp, rampLabel: VeloTrends.rampVerdict(ramp).label.toLowerCase() };
      }
      const weeks = [];
      for (let ws = VeloProgress.weekStart(range.from); ws.getTime() <= toT; ws = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 7)) {
        const we = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 7).getTime() - 1;
        const list = rides.filter(r => within(r, Math.max(ws.getTime(), fromT), Math.min(we, toT)));
        const t = totals(list);
        weeks.push({ start: VeloAsk.dayKey(ws), rides: t.rides, hours: t.hours, tss: t.tss, kj: t.kj, ctl: ctlOn(VeloAsk.dayKey(new Date(Math.min(we, toT)))) });
      }

      // Power bests: this period (1 Hz curves) vs all-time (archive included).
      const env = this.powerEnvelope(fromT - 1, toT);
      const all = this.getAllTimeMmpBests();
      const bests = [[5, '5 s', 0], [60, '1 min', 3], [300, '5 min', 5], [1200, '20 min', 7], [3600, '60 min', 8]]
        .map(([sec, label, i]) => ({ label, period: env.watts[VeloPower.gridIndex(sec)] || null, allTime: all[i] || null }))
        .filter(b => b.period || b.allTime);

      // Zones, aerobic signs, balance.
      const z = [0, 0, 0, 0, 0, 0, 0];
      rides.forEach(r => { const zs = this.rideZoneSeconds(r); if (zs) zs.forEach((v, i) => { z[i] += v; }); });
      const zt = z.reduce((a, b) => a + b, 0);
      const zones = zt ? { pct: z.map(v => Math.round((v / zt) * 100)), hours: (zt / 3600).toFixed(1), seiler: VeloPower.seiler(z) } : null;
      const oldestFirst = rides.slice().reverse();
      const efs = oldestFirst.map(r => this.rideEf(r)).filter(Boolean).map(e => e.ef);
      const drifts = oldestFirst.map(r => this.askDrift(r)).filter(v => v !== null);
      const aerobic = efs.length || drifts.length ? {
        efN: efs.length, efFirst: efs.length ? efs[0] : null, efLast: efs.length ? efs[efs.length - 1] : null,
        driftN: drifts.length, driftAvg: drifts.length ? drifts.reduce((a, b) => a + b, 0) / drifts.length : null
      } : null;
      const bal = VeloTrends.balancePoints(rides);
      const balance = bal.length ? { avgLeft: Math.round((bal.reduce((a, b) => a + b.v, 0) / bal.length) * 10) / 10, n: bal.length } : null;

      // Recovery (Apple Health) by week.
      const health = [];
      const hd = (this.healthDays || []).filter(d => { const t = new Date(`${d.day}T12:00:00`).getTime(); return t >= fromT && t <= toT; });
      if (hd.length) {
        const byWeek = new Map();
        hd.forEach(d => { const k = VeloAsk.dayKey(VeloProgress.weekStart(new Date(`${d.day}T12:00:00`))); if (!byWeek.has(k)) byWeek.set(k, []); byWeek.get(k).push(d); });
        const avg = (list, f) => { const v = list.map(x => Number(x[f])).filter(x => Number.isFinite(x) && x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
        [...byWeek.keys()].sort().forEach(k => { const list = byWeek.get(k); health.push({ week: k, rhr: avg(list, 'rhr'), hrv: avg(list, 'hrv'), sleep: avg(list, 'sleepH') }); });
      }

      const others = (this.completedWorkouts || []).filter(r => !VeloMetrics.isCycling(r) && within(r, fromT, toT)).sort((a, b) => when(b) - when(a))
        .map(r => ({ date: VeloAsk.dayKey(new Date(r.date)), type: r.sportType || r.activityType || 'activity', title: r.title || '', dur: Number(r.duration) || 0 }));
      const ftpChanges = (Array.isArray(p.ftpHistory) ? p.ftpHistory : []).filter(e => { const t = Date.parse(e.date); return t >= fromT && t <= toT; })
        .map(e => ({ date: VeloAsk.dayKey(new Date(e.date)), from: e.from, to: e.ftp }));

      const rideRows = rides.map(r => {
        const pk = this.rideMedalPeaks(r);
        const zs = this.rideZoneSeconds(r);
        const ef = this.rideEf(r);
        const sei = zs ? VeloPower.seiler(zs) : null;
        return {
          date: VeloAsk.dayKey(new Date(r.date)), title: r.title, dur: Number(r.duration) || 0, km: Number(r.distanceKm) || null,
          avgW: Number(r.avgWatts) || null, np: Number(r.np) || null, ifac: parseFloat(r.if) || null, tss: Number(r.tss) || null, kj: Number(r.kj) || null,
          avgHr: Number(r.avgHr) || null, maxHr: Number(r.maxHr) || null, cad: Number(r.avgCadence) || null, left: Number(r.leftBal) > 0 ? Number(r.leftBal) : null,
          ef: ef ? ef.ef : null, drift: this.askDrift(r), p5: pk ? pk[2] : null, p20: pk ? pk[3] : null, zone3: sei ? sei.pct.map(v => Math.round(v)) : null
        };
      });

      const model = this.powerModelAt(toT);
      const r = this.healthReadiness ? this.healthReadiness() : null;
      const readiness = r && r.level && !['none', 'baseline'].includes(r.level) ? `${r.label || r.level}${r.advice ? ` - ${r.advice}` : ''}${Array.isArray(r.reasons) && r.reasons.length ? ` (${r.reasons.join('; ')})` : ''}` : null;
      const prevFrom = new Date(fromT - span), prevTo = new Date(fromT - 1);
      return {
        today: VeloAsk.dayKey(new Date()),
        period: { label: range.label, from: VeloAsk.dayKey(range.from), to: VeloAsk.dayKey(range.to), days: range.days },
        rider: { name: p.name, ftp: p.ftp, weightKg: p.weightKg, maxHr: p.maxHr, lthr: p.lthr },
        form, readiness,
        model: model && model.ok ? { cp: model.cp, w: model.w, pmax: model.pmax, from: VeloAsk.dayKey(new Date(model.from)), to: VeloAsk.dayKey(new Date(model.to)) } : null,
        modelNote: model && model.reason === 'coverage' ? 'needs a ride of 20 min or more with hard efforts in the 90 days up to the end of the period' : 'not enough maximal efforts with power in the 90 days up to the end of the period',
        totals: { cur: totals(rides), prev: range.key === 'all' ? null : totals(prev), prevFrom: VeloAsk.dayKey(prevFrom), prevTo: VeloAsk.dayKey(prevTo) },
        weeks, bests, zones, aerobic, balance, health, others, ftpChanges,
        rides: rideRows,
        meanings: MEANING_KEYS.map(([a, k]) => [a, VeloGlossary.plain(k)])
      };
    },

    /** Heart-rate drift (Pw:HR, %) of a steady ride, or null; cached per ride. */
    askDrift(r) {
      if (!VeloRideSummary.has(r)) return null;
      const cache = this._askDrift || (this._askDrift = new Map());
      const key = `${r.id}|${VeloRideSummary.count(r)}`;
      if (!cache.has(key)) {
        if (cache.size > 2 * (this.completedWorkouts || []).length + 50) cache.clear();
        const d = this.rideDecoupling(r);
        cache.set(key, d && d.status === 'ok' ? d.pct : null);
      }
      return cache.get(key);
    },
  });
})();
