/**
 * APEX VELO // LAB - Analytics progression dashboard (mixin on VeloApp).
 *
 * Today strip (readiness, form, fitness, ramp rate, FTP), six progression tiles (value, trend
 * sparkline over the page range, change vs 6 weeks ago), the power profile table and the
 * efficiency-factor, resting HR / HRV and pedal-balance trend charts. Everything is derived
 * from recorded rides and Apple Health days; a metric without data shows "--", never a guess.
 */
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAY = 86400000;
  const SIX_WEEKS = 42 * DAY;

  Object.assign(VeloApp.prototype, {
    /** Days covered by the page range (0 = all history). */
    anaRangeDays() {
      return { '6w': 42, '3m': 91, '6m': 182, '1y': 365, all: 0 }[this.anaRange || '6m'] ?? 182;
    },

    /** Start of the page range in ms (for "All": the first ride or health day). */
    anaRangeStart(now = Date.now()) {
      const days = this.anaRangeDays();
      if (days) return now - days * DAY;
      const ts = this.cyclingRides().map(r => new Date(r.date).getTime()).filter(Number.isFinite);
      (this.healthDays || []).forEach(d => ts.push(new Date(d.day + 'T12:00:00').getTime()));
      return ts.length ? Math.min(...ts) : now - 182 * DAY;
    },

    initDashboardCharts() {
      const { VIZ, INK, axis } = VeloApp.CHART || {};
      if (typeof Chart === 'undefined' || !VIZ) return;
      const timeAxis = () => axis({ type: 'linear', ticks: { color: INK.muted, maxTicksLimit: 8, callback: (v) => new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) } });
      const tip = (fmt) => ({ callbacks: { title: (items) => new Date(items[0].parsed.x).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }), label: fmt } });
      const ctxE = document.getElementById('efTrendCanvas')?.getContext('2d');
      if (ctxE) {
        this.efChart = new Chart(ctxE, {
          type: 'scatter',
          data: { datasets: [
            { label: 'Ride EF', data: [], pointRadius: 3.5, pointHoverRadius: 6, backgroundColor: 'rgba(8,145,178,0.55)', borderColor: VIZ.cyan },
            { label: '30-day average', type: 'line', data: [], borderColor: VIZ.lime, borderWidth: 2.2, tension: 0.3, pointRadius: 0, spanGaps: true }
          ] },
          options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
            onClick: (evt, els) => { const d = els && els[0] && els[0].datasetIndex === 0 ? this.efChart.data.datasets[0].data[els[0].index] : null; if (d && d.id) this.showRideSummaryById(d.id); },
            scales: { x: timeAxis(), y: axis({ title: { display: true, text: 'W per bpm', color: INK.muted } }) },
            plugins: { tooltip: tip((c) => c.datasetIndex === 0 ? ` EF ${c.raw.y.toFixed(2)} - ${c.raw.np} W @ ${c.raw.hr} bpm - ${c.raw.title || ''}` : ` 30-day avg ${c.parsed.y.toFixed(2)}`) }
          }
        });
      }
      const ctxR = document.getElementById('recoveryTrendCanvas')?.getContext('2d');
      if (ctxR) {
        this.recoveryChart = new Chart(ctxR, {
          type: 'line',
          data: { datasets: [
            { label: 'Resting HR', data: [], borderColor: VIZ.rose, tension: 0.3, pointRadius: 0, spanGaps: true, yAxisID: 'y' },
            { label: 'HRV', data: [], borderColor: VIZ.violet, tension: 0.3, pointRadius: 0, spanGaps: true, yAxisID: 'y1' }
          ] },
          options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 300 }, interaction: { mode: 'index', intersect: false },
            scales: {
              x: timeAxis(),
              y: axis({ position: 'left', title: { display: true, text: 'Resting HR (bpm)', color: VIZ.rose } }),
              y1: axis({ position: 'right', grid: { display: false }, title: { display: true, text: 'HRV (ms)', color: VIZ.violet } })
            },
            plugins: { legend: { display: true, labels: { color: INK.secondary, boxWidth: 10 } }, tooltip: tip((c) => ` ${c.dataset.label} (7-day) ${Math.round(c.parsed.y)} ${c.datasetIndex === 0 ? 'bpm' : 'ms'}`) }
          }
        });
      }
      const ctxB = document.getElementById('balanceTrendCanvas')?.getContext('2d');
      if (ctxB) {
        this.balanceChart = new Chart(ctxB, {
          type: 'scatter',
          data: { datasets: [{ label: 'Left %', data: [], pointRadius: 3.5, pointHoverRadius: 6, backgroundColor: 'rgba(124,58,237,0.6)', borderColor: VIZ.violet }] },
          options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
            onClick: (evt, els) => { const d = els && els[0] ? this.balanceChart.data.datasets[0].data[els[0].index] : null; if (d && d.id) this.showRideSummaryById(d.id); },
            scales: { x: timeAxis(), y: axis({ suggestedMin: 45, suggestedMax: 55, title: { display: true, text: 'Left leg %', color: INK.muted } }) },
            plugins: { tooltip: tip((c) => ` L ${c.raw.y.toFixed(1)}% / R ${(100 - c.raw.y).toFixed(1)}% - ${c.raw.title || ''}`) }
          }
        });
      }
    },

    /** FTP in force at time t: the FTP log first, else the FTP the nearest earlier ride used. */
    ftpAt(t) {
      const p = this.activeProfile || {};
      const log = (Array.isArray(p.ftpHistory) ? p.ftpHistory : []).map(e => ({ t: new Date(e.date).getTime(), ftp: Number(e.ftp), from: Number(e.from) })).filter(e => Number.isFinite(e.t) && e.ftp > 0).sort((a, b) => a.t - b.t);
      if (log.length) {
        const before = log.filter(e => e.t <= t);
        if (before.length) return before[before.length - 1].ftp;
        if (log[0].from > 0) return log[0].from;
      }
      const rides = this.cyclingRides().map(r => ({ t: new Date(r.date).getTime(), ftp: Number(r.ftpAtRide) })).filter(r => Number.isFinite(r.t) && r.ftp > 0 && r.t <= t).sort((a, b) => a.t - b.t);
      return rides.length ? rides[rides.length - 1].ftp : (p.ftp || null);
    },

    /** Everything the dashboard shows, computed once per refresh. */
    dashboardData(now = Date.now()) {
      const rides = this.cyclingRides();
      const start = this.anaRangeStart(now);
      const p = this.activeProfile || {};
      const steps = 12;
      const stepMs = Math.max(DAY, (now - start) / steps);
      const at = Array.from({ length: steps + 1 }, (_, i) => start + i * stepMs);

      // Fitness (CTL) and ramp rate from the full history.
      const pmc = this.analytics.calculatePmcHistory(this.completedWorkouts, 0, this.pmcOpts());
      const ctl = pmc.ctlData || [];
      const keys = pmc.dateKeys || [];
      const ctlAt = (t) => {
        if (!keys.length) return null;
        const k = VeloMetrics.localDateKey(new Date(t));
        let idx = -1;
        for (let i = 0; i < keys.length; i++) { if (keys[i] <= k) idx = i; else break; }
        return idx >= 0 ? ctl[idx] : null;
      };
      const ramp = VeloTrends.rampRate(ctl);

      // Efficiency factor (steady rides).
      const efPts = VeloTrends.efPoints(rides);
      const ef30 = (t) => VeloTrends.rollingMean(efPts, t, 30);

      // 20-min peak, rolling 90 days.
      const peaksOf = (r) => (this.ridePeaks ? this.ridePeaks(r) : null);
      const p20 = (t) => VeloTrends.windowBest(rides, peaksOf, 3, t - 90 * DAY, t);

      // Apple Health: 30-day averages.
      const hd = (this.healthDays || []).map(d => ({ t: new Date(d.day + 'T12:00:00').getTime(), rhr: d.rhr, hrv: d.hrv }));
      const h30 = (t, key) => { const v = VeloTrends.rollingMean(hd.filter(x => x[key] !== null), t, 30, key); return v === null ? null : Math.round(v); };

      const series = (fn) => at.map(fn);
      const tiles = [
        { key: 'ftp', label: 'FTP', unit: 'W', now: this.ftpAt(now), then: this.ftpAt(now - SIX_WEEKS), spark: series(t => this.ftpAt(t)), good: 'up',
          sub: p.weightKg ? `${((this.ftpAt(now) || 0) / p.weightKg).toFixed(2)} W/kg` : '' },
        { key: 'ctl', label: 'Fitness (CTL)', unit: '', now: ctlAt(now), then: ctlAt(now - SIX_WEEKS), spark: series(ctlAt), good: 'up', dec: 1, sub: '42-day training load' },
        { key: 'ef', label: 'Efficiency factor', unit: '', now: ef30(now), then: ef30(now - SIX_WEEKS), spark: series(ef30), good: 'up', dec: 2, sub: '30-day avg, steady rides' },
        { key: 'p20', label: '20-min peak', unit: 'W', now: p20(now), then: p20(now - SIX_WEEKS), spark: series(p20), good: 'up', sub: 'best in 90 days' },
        { key: 'rhr', label: 'Resting HR', unit: 'bpm', now: h30(now, 'rhr'), then: h30(now - SIX_WEEKS, 'rhr'), spark: series(t => h30(t, 'rhr')), good: 'down', sub: '30-day average' },
        { key: 'hrv', label: 'HRV', unit: 'ms', now: h30(now, 'hrv'), then: h30(now - SIX_WEEKS, 'hrv'), spark: series(t => h30(t, 'hrv')), good: 'up', sub: '30-day average (SDNN)' }
      ];
      return { rides, start, now, tiles, ramp, efPts, hd, peaksOf, pmc };
    },

    renderDashboard() {
      const el = document.getElementById('anaTiles');
      if (!el) return;
      const d = this.dashboardData();
      this._dashData = d;

      // Tiles
      const fmt = (v, dec) => (v === null || v === undefined || !Number.isFinite(v) ? '--' : (dec ? v.toFixed(dec) : String(Math.round(v))));
      el.innerHTML = d.tiles.map(t => {
        const has = Number.isFinite(t.now);
        const delta = has && Number.isFinite(t.then) ? t.now - t.then : null;
        const dz = delta !== null && Math.abs(delta) >= (t.dec === 2 ? 0.01 : t.dec === 1 ? 0.1 : 1);
        const better = dz && ((t.good === 'up' && delta > 0) || (t.good === 'down' && delta < 0));
        const cls = !dz ? 'flat' : better ? 'good' : 'bad';
        const arrow = !dz ? '&rarr;' : delta > 0 ? '&#9650;' : '&#9660;';
        const dTxt = delta === null ? 'no data 6 weeks ago' : `${arrow} ${dz ? (delta > 0 ? '+' : '') + fmt(delta, t.dec) : 'no change'} vs 6 weeks ago`;
        return `<div class="tile" data-tile="${t.key}">
          <div class="tile-lbl">${esc(t.label)}</div>
          <div class="tile-row"><div class="tile-val num">${fmt(t.now, t.dec)}${has && t.unit ? `<small>${t.unit}</small>` : ''}</div>${VeloTrends.sparkline(t.spark, { color: 'currentColor' })}</div>
          <div class="tile-delta ${has ? cls : 'flat'} num">${has ? dTxt : (t.key === 'rhr' || t.key === 'hrv' ? 'Set up Apple Health in Settings' : 'Not enough data yet')}</div>
          <div class="tile-sub">${esc(t.sub || '')}</div>
        </div>`;
      }).join('');

      // Ramp rate
      const v = VeloTrends.rampVerdict(d.ramp);
      const rampEl = document.getElementById('anaRampVal');
      if (rampEl) { rampEl.textContent = d.ramp === null ? '--' : `${d.ramp > 0 ? '+' : ''}${d.ramp}`; rampEl.dataset.ramp = v.key; }
      this.setText('anaRampNote', d.ramp === null ? 'CTL change per week' : v.label);
      const r = this.healthReadiness ? this.healthReadiness() : null;
      this.setText('anaReadinessNote', r ? (r.advice || (r.level === 'baseline' ? 'Needs 7 nights of HRV' : r.level === 'none' ? 'Set up Apple Health in Settings' : 'No data from the last 2 days')) : '--');

      this.renderPowerProfile(d);
      this.updateDashboardCharts(d);
    },

    renderPowerProfile(d) {
      const box = document.getElementById('anaPowerProfile');
      if (!box) return;
      const archive = this.medalArchive ? this.medalArchive() : null;
      const rows = VeloTrends.powerProfile(d.rides, d.peaksOf, d.now, archive, (this.activeProfile || {}).weightKg);
      const w = (v) => (v === null ? '--' : `${v}<small>W</small>`);
      box.innerHTML = rows.map(r => `
        <div class="pp-cell">
          <div class="pp-head"><b>${esc(r.label)}</b><span>${esc(r.name)}</span>${r.pr ? '<span class="pp-pr">PR</span>' : ''}</div>
          <div class="pp-val num">${w(r.last)}</div>
          <div class="pp-sub num">${r.wkg !== null ? r.wkg.toFixed(2) + ' W/kg' : '&nbsp;'}</div>
          <div class="pp-delta num ${r.delta === null ? 'flat' : r.delta > 0 ? 'good' : r.delta < 0 ? 'bad' : 'flat'}">${r.delta === null ? (r.prev === null ? 'no rides in the 90 days before' : '--') : r.delta === 0 ? `same as the 90 days before` : `${r.delta > 0 ? '&#9650; +' : '&#9660; '}${r.delta} W vs ${r.prev} W`}</div>
          <div class="pp-sub">all-time ${r.allTime !== null ? r.allTime + ' W' : '--'}</div>
        </div>`).join('');
    },

    updateDashboardCharts(d) {
      const inRange = (t) => t >= d.start && t <= d.now + DAY;
      [this.efChart, this.recoveryChart, this.balanceChart].forEach(c => { if (c) { c.options.scales.x.min = d.start; c.options.scales.x.max = d.now; } });
      if (this.efChart) {
        const pts = d.efPts.filter(p => inRange(p.t));
        this.efChart.data.datasets[0].data = pts.map(p => ({ x: p.t, y: p.ef, np: p.np, hr: p.hr, id: p.id, title: p.title }));
        this.efChart.data.datasets[1].data = VeloTrends.rollingSeries(d.efPts, d.start, d.now, 30, Math.max(1, Math.round((d.now - d.start) / DAY / 40))).filter(x => x.v !== null).map(x => ({ x: x.t, y: Math.round(x.v * 100) / 100 }));
        this.efChart.update();
        const first = VeloTrends.rollingMean(d.efPts, d.start + 30 * DAY, 30), last = VeloTrends.rollingMean(d.efPts, d.now, 30);
        this.setText('efTrendLabel', pts.length ? (first && last ? `${last.toFixed(2)} (${last >= first ? '+' : ''}${(((last - first) / first) * 100).toFixed(1)}% in range)` : `${pts.length} ride${pts.length === 1 ? '' : 's'}`) : 'no steady rides with HR');
      }
      if (this.recoveryChart) {
        const hd = d.hd.filter(x => inRange(x.t));
        const roll = (key) => hd.map(x => ({ x: x.t, y: VeloTrends.rollingMean(d.hd.filter(y => y[key] !== null), x.t, 7, key) })).filter(p => p.y !== null);
        this.recoveryChart.data.datasets[0].data = roll('rhr');
        this.recoveryChart.data.datasets[1].data = roll('hrv');
        this.recoveryChart.update();
        this.setText('recoveryTrendLabel', hd.length ? `${hd.length} day${hd.length === 1 ? '' : 's'}` : 'no Apple Health data yet');
      }
      if (this.balanceChart) {
        const pts = VeloTrends.balancePoints(d.rides).filter(p => inRange(p.t));
        this.balanceChart.data.datasets[0].data = pts.map(p => ({ x: p.t, y: p.v, id: p.id, title: p.title }));
        this.balanceChart.update();
        const avg = pts.length ? pts.reduce((a, p) => a + p.v, 0) / pts.length : null;
        this.setText('balanceTrendLabel', avg === null ? 'no measured balance yet' : `avg ${avg.toFixed(1)} / ${(100 - avg).toFixed(1)}`);
      }
    }
  });
})();
