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
  /** Plain-English subtext for each progression tile (js/velo-glossary.js). */
  const TILE_TERMS = { ftp: 'ftp', ctl: 'ctl', ef: 'ef', p20: 'peak20', rhr: 'rhr', hrv: 'hrv' };

  /** Trailing `days`-day mean of field `key` at each point that has it (two pointers, O(n)). */
  function trailingMeans(points, key, days) {
    const list = (points || []).filter(p => p[key] !== null && p[key] !== undefined && Number.isFinite(p[key])).sort((a, b) => a.t - b.t);
    const out = [];
    let lo = 0, sum = 0;
    for (let hi = 0; hi < list.length; hi++) {
      sum += list[hi][key];
      while (list[lo].t <= list[hi].t - days * DAY) { sum -= list[lo][key]; lo++; }
      out.push({ x: list[hi].t, y: Math.round((sum / (hi - lo + 1)) * 10) / 10 });
    }
    return out;
  }

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
      const legend = { display: true, position: 'top', align: 'end', labels: { color: INK.secondary, boxWidth: 10, boxHeight: 10, usePointStyle: true, padding: 12 } };
      // Lanes: two measures with different units share the time axis but never one plot (no dual axis).
      const lane = (weight, extra = {}) => axis({ stack: 'lanes', stackWeight: weight, offset: true, position: 'left', ...extra });
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
            { label: 'Resting HR (bpm)', data: [], borderColor: VIZ.rose, backgroundColor: VIZ.rose, tension: 0.3, pointRadius: 0, spanGaps: true, yAxisID: 'y' },
            { label: 'HRV (ms)', data: [], borderColor: VIZ.violet, backgroundColor: VIZ.violet, tension: 0.3, pointRadius: 0, spanGaps: true, yAxisID: 'y1' }
          ] },
          options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 300 }, interaction: { mode: 'index', intersect: false },
            scales: {
              x: timeAxis(),
              y: lane(1, { title: { display: true, text: 'bpm', color: INK.muted } }),
              y1: lane(1, { title: { display: true, text: 'ms', color: INK.muted } })
            },
            plugins: { legend, tooltip: tip((c) => ` ${c.dataset.label.replace(/ \(.*/, '')} (7-day) ${Math.round(c.parsed.y)} ${c.datasetIndex === 0 ? 'bpm' : 'ms'}`) }
          }
        });
      }
      const ctxB = document.getElementById('balanceTrendCanvas')?.getContext('2d');
      if (ctxB) {
        // Shaded 48-52% band: the usual left/right range.
        const band = {
          id: 'balanceBand',
          beforeDatasetsDraw(chart) {
            const y = chart.scales.y, a = chart.chartArea;
            if (!y || !a) return;
            const top = Math.max(a.top, y.getPixelForValue(52)), bottom = Math.min(a.bottom, y.getPixelForValue(48));
            if (bottom <= top) return;
            chart.ctx.save(); chart.ctx.fillStyle = 'rgba(148,163,184,0.08)'; chart.ctx.fillRect(a.left, top, a.right - a.left, bottom - top);
            chart.ctx.strokeStyle = 'rgba(148,163,184,0.22)'; chart.ctx.lineWidth = 1;
            const mid = y.getPixelForValue(50);
            if (mid > a.top && mid < a.bottom) { chart.ctx.beginPath(); chart.ctx.moveTo(a.left, mid); chart.ctx.lineTo(a.right, mid); chart.ctx.stroke(); }
            chart.ctx.restore();
          }
        };
        this.balanceChart = new Chart(ctxB, {
          type: 'scatter',
          data: { datasets: [
            { label: 'Ride', data: [], pointRadius: 3.5, pointHoverRadius: 6, backgroundColor: 'rgba(124,58,237,0.5)', borderColor: VIZ.violet },
            { label: '10-ride average', type: 'line', data: [], borderColor: VIZ.violet, borderWidth: 2, tension: 0.3, pointRadius: 0, spanGaps: true }
          ] },
          options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
            onClick: (evt, els) => { const d = els && els[0] && els[0].datasetIndex === 0 ? this.balanceChart.data.datasets[0].data[els[0].index] : null; if (d && d.id) this.showRideSummaryById(d.id); },
            scales: { x: timeAxis(), y: axis({ suggestedMin: 46, suggestedMax: 54, title: { display: true, text: 'Left leg %', color: INK.muted } }) },
            plugins: { legend, tooltip: tip((c) => c.datasetIndex === 0 ? ` L ${c.raw.y.toFixed(1)}% / R ${(100 - c.raw.y).toFixed(1)}% - ${c.raw.title || ''}` : ` 10-ride avg L ${c.parsed.y.toFixed(1)}%`) }
          },
          plugins: [band]
        });
      }
      const ctxC = document.getElementById('cpHistoryCanvas')?.getContext('2d');
      if (ctxC) {
        this.cpHistoryChart = new Chart(ctxC, {
          type: 'line',
          data: { datasets: [
            { label: 'CP', data: [], borderColor: VIZ.cyan, backgroundColor: VIZ.cyan, borderWidth: 2.2, tension: 0.3, pointRadius: 2.5, pointHoverRadius: 5, spanGaps: false, yAxisID: 'y' },
            { label: 'FTP in use', data: [], borderColor: 'rgba(148,163,184,0.75)', backgroundColor: 'rgba(148,163,184,0.75)', borderWidth: 1.5, borderDash: [5, 4], stepped: 'before', pointRadius: 0, spanGaps: true, yAxisID: 'y' },
            { label: "W'", data: [], borderColor: VIZ.violet, backgroundColor: VIZ.violet, borderWidth: 2, tension: 0.3, pointRadius: 2.5, pointHoverRadius: 5, spanGaps: false, yAxisID: 'y1' }
          ] },
          options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 300 }, interaction: { mode: 'index', intersect: false },
            scales: {
              x: timeAxis(),
              y: lane(2, { title: { display: true, text: 'W', color: INK.muted }, grace: '8%' }),
              y1: lane(1, { title: { display: true, text: 'kJ', color: INK.muted }, grace: '15%' })
            },
            plugins: { tooltip: tip((c) => {
              if (c.parsed.y === null || c.parsed.y === undefined) return '';
              const kg = (this.activeProfile || {}).weightKg;
              if (c.datasetIndex === 0) return ` CP ${c.parsed.y} W${kg ? ` (${(c.parsed.y / kg).toFixed(2)} W/kg)` : ''}`;
              if (c.datasetIndex === 1) return ` FTP in use ${c.parsed.y} W`;
              return ` W' ${c.parsed.y.toFixed(1)} kJ`;
            }) }
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
      const efPts = VeloTrends.efPoints(rides, (r) => this.rideEf(r));
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
        { key: 'ctl', label: 'Fitness (CTL)', unit: '', now: ctlAt(now), then: ctlAt(now - SIX_WEEKS), spark: series(ctlAt), good: 'up', dec: 1, sub: 'builds slowly with steady training' },
        { key: 'ef', label: 'Efficiency (EF)', unit: '', now: ef30(now), then: ef30(now - SIX_WEEKS), spark: series(ef30), good: 'up', dec: 2, sub: '30-day avg, steady rides' },
        { key: 'p20', label: '20-min peak', unit: 'W', now: p20(now), then: p20(now - SIX_WEEKS), spark: series(p20), good: 'up', sub: p.weightKg && p20(now) ? `${(p20(now) / p.weightKg).toFixed(2)} W/kg` : '' },
        { key: 'rhr', label: 'Resting HR', unit: 'bpm', now: h30(now, 'rhr'), then: h30(now - SIX_WEEKS, 'rhr'), spark: series(t => h30(t, 'rhr')), good: 'down', sub: '30-day average' },
        { key: 'hrv', label: 'HRV', unit: 'ms', now: h30(now, 'hrv'), then: h30(now - SIX_WEEKS, 'hrv'), spark: series(t => h30(t, 'hrv')), good: 'up', sub: '30-day average' }
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
          <div class="tile-lbl" title="${esc(VeloGlossary.tip(TILE_TERMS[t.key]))}">${esc(t.label)}${VeloGlossary.html(TILE_TERMS[t.key])}</div>
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
      [this.efChart, this.recoveryChart, this.balanceChart, this.cpHistoryChart].forEach(c => { if (c) { c.options.scales.x.min = d.start; c.options.scales.x.max = d.now; } });
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
        this.recoveryChart.data.datasets[0].data = trailingMeans(d.hd, 'rhr', 7).filter(p => inRange(p.x));
        this.recoveryChart.data.datasets[1].data = trailingMeans(d.hd, 'hrv', 7).filter(p => inRange(p.x));
        this.recoveryChart.update();
        this.setText('recoveryTrendLabel', hd.length ? `${hd.length} day${hd.length === 1 ? '' : 's'}` : 'no Apple Health data yet');
      }
      if (this.balanceChart) {
        const all = VeloTrends.balancePoints(d.rides);
        const pts = all.filter(p => inRange(p.t));
        this.balanceChart.data.datasets[0].data = pts.map(p => ({ x: p.t, y: p.v, id: p.id, title: p.title }));
        this.balanceChart.data.datasets[1].data = all.map((p, i) => {
          const win = all.slice(Math.max(0, i - 9), i + 1);
          return { x: p.t, y: Math.round((win.reduce((a, q) => a + q.v, 0) / win.length) * 10) / 10 };
        }).filter(p => inRange(p.x));
        this.balanceChart.update();
        const avg = pts.length ? pts.reduce((a, p) => a + p.v, 0) / pts.length : null;
        this.setText('balanceTrendLabel', avg === null ? 'no measured balance yet' : `avg ${avg.toFixed(1)} / ${(100 - avg).toFixed(1)}`);
      }
      if (this.cpHistoryChart) {
        const days = Math.max(1, (d.now - d.start) / DAY);
        const hist = this.powerModelHistory(d.start, d.now, Math.max(7, Math.round(days / 26)));
        this.cpHistoryChart.data.datasets[0].data = hist.map(h => ({ x: h.t, y: h.ok ? h.cp : null }));
        this.cpHistoryChart.data.datasets[1].data = hist.map(h => ({ x: h.t, y: this.ftpAt(h.t) || null }));
        this.cpHistoryChart.data.datasets[2].data = hist.map(h => ({ x: h.t, y: h.ok ? Math.round(h.w / 100) / 10 : null }));
        this.cpHistoryChart.update();
        const ok = hist.filter(h => h.ok);
        const note = document.getElementById('cpHistoryNote');
        if (note) {
          const base = 'Each point is the model fitted to the best efforts of the 90 days before it. CP rising = more sustainable power; W′ rising = more punch above CP.';
          const signed = (v, dec) => { const r = Number(v.toFixed(dec)); return r === 0 ? `±${(0).toFixed(dec)}` : `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(dec)}`; };
          note.textContent = ok.length >= 2
            ? `CP ${signed(ok[ok.length - 1].cp - ok[0].cp, 0)} W and W′ ${signed((ok[ok.length - 1].w - ok[0].w) / 1000, 1)} kJ over this period. ${base}`
            : ok.length ? base : 'No CP model in this period yet: it needs rides with power of 20 min or more, including hard 3-5 min and 12-20 min efforts. Gaps mean no model for those 90 days.';
        }
      }
      this.renderIntensity(d);
    },

    /** Critical power model card: CP, W', Pmax, CP vs FTP, VO2max estimate and pacing above CP. */
    renderCpModelCard(pdc) {
      const body = document.getElementById('cpModelBody');
      if (!body) return;
      const m = pdc && pdc.model;
      const p = this.activeProfile || {};
      const kg = Number(p.weightKg) || 0;
      const fmtDay = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      if (!m || !m.ok) {
        this.setText('cpModelChip', 'no model');
        const why = !m || m.reason === 'no-data' ? 'No rides with second-by-second power in the last 90 days.'
          : m.reason === 'coverage' ? 'The model needs a ride of 20 minutes or more and some short hard efforts in the last 90 days.'
            : 'Your recent best efforts do not follow a power-duration shape yet - usually only steady riding. A few all-out efforts (3-5 min and 12-20 min) fix that.';
        body.innerHTML = `<div class="cp-empty"><svg class="ic ic-lg"><use href="#i-bolt"/></svg><div><b>No critical power model yet</b><p>${why}</p><p class="dim">With a model you get CP, W′ and Pmax, live W′ balance in the cockpit and W′ analysis of every ride.</p></div></div>`;
        return;
      }
      this.setText('cpModelChip', `${fmtDay(m.from)} - ${fmtDay(m.to)}`);
      const ftp = Number(p.ftp) || 0;
      const vsFtp = ftp ? Math.round(((m.cp - ftp) / ftp) * 100) : null;
      const env = m.env || { watts: [], ids: [], times: [] };
      const g5 = VeloPower.gridIndex(300);
      const p5 = env.watts[g5];
      const vo2 = VeloPower.vo2maxEstimate(p5, kg);
      const pace = [1.05, 1.1, 1.2, 1.3, 1.5].map(f => {
        const watts = Math.round(m.cp * f);
        return { f, watts, sec: Math.round(m.w / (watts - m.cp)) };
      });
      body.innerHTML = `
        <div class="cp-hero">
          <div class="cp-stat cp-main" title="${esc(VeloGlossary.tip('cp'))}"><span class="cp-lbl">CP${VeloGlossary.html('cp')}</span><b class="cp-val">${m.cp}<small>W</small></b><span class="cp-sub num">${kg ? (m.cp / kg).toFixed(2) + ' W/kg' : '&nbsp;'}</span></div>
          <div class="cp-stat" title="${esc(VeloGlossary.tip('wprime'))}"><span class="cp-lbl">W&prime;${VeloGlossary.html('wprime')}</span><b class="cp-val">${(m.w / 1000).toFixed(1)}<small>kJ</small></b><span class="cp-sub num">${kg ? Math.round(m.w / kg) + ' J/kg' : '&nbsp;'}</span></div>
          <div class="cp-stat" title="${esc(VeloGlossary.tip('pmax'))}"><span class="cp-lbl">Pmax${VeloGlossary.html('pmax')}</span><b class="cp-val">${m.pmax}<small>W</small></b><span class="cp-sub num">${kg ? (m.pmax / kg).toFixed(1) + ' W/kg' : '&nbsp;'}</span></div>
        </div>
        <div class="cp-rows">
          <div class="cp-row"><span>CP vs your FTP <small class="num">${ftp ? ftp + ' W' : ''}</small><span class="plain">Your limit vs your setting</span></span><b class="num ${vsFtp !== null && vsFtp > 5 ? 'pos' : ''}">${vsFtp === null ? '--' : `${vsFtp > 0 ? '+' : ''}${vsFtp}%`}</b></div>
          <div class="cp-row"><span>Estimated VO2max <small class="num">${p5 ? `best 5 min ${p5} W` : ''}</small>${VeloGlossary.html('vo2max')}</span><b class="num">${vo2 !== null ? `${vo2}<small> ml/kg/min</small>` : '--'}</b></div>
          <div class="cp-row"><span>Fit <small>${m.used} of ${m.points} best efforts (3-20 min)</small>${VeloGlossary.html('fit')}</span><b class="num">&plusmn;${m.rmsePct}%</b></div>
        </div>
        <div class="sub-title cp-pace-title"><span>Above CP: how long W&prime; lasts${VeloGlossary.html('pace')}</span><span class="hint">from full</span></div>
        <div class="cp-pace">${pace.map(x => `<div class="cp-pace-cell"><span class="num">${Math.round(x.f * 100)}% CP</span><b class="num">${x.watts} W</b><small class="num">${this.fmtTime(x.sec)}</small></div>`).join('')}</div>
        <p class="footnote">${vsFtp !== null && vsFtp > 5 ? 'CP is well above your FTP - your FTP may be set low. ' : vsFtp !== null && vsFtp < -5 ? 'CP is under your FTP: the last 90 days may lack all-out efforts, or your FTP is set high. ' : ''}${m.lowW ? 'Few all-out short efforts in this window, so W′ is probably underestimated. ' : ''}FTP usually sits at 95-100% of CP. Model: work-time fit of your 3-20 min bests (submaximal efforts down-weighted), Pmax from the short end.</p>`;
    },

    /** Time in power zones over the page range, the 3-zone split and the polarization index. */
    renderIntensity(d) {
      const box = document.getElementById('anaZoneDist'), sb = document.getElementById('anaSeiler');
      if (!box || !sb) return;
      const rides = d.rides.filter(r => { const t = Date.parse(r.date); return t >= d.start && t <= d.now + DAY; });
      const z = [0, 0, 0, 0, 0, 0, 0];
      let withPower = 0, without = 0;
      rides.forEach(r => { const zs = this.rideZoneSeconds(r); if (zs) { withPower++; zs.forEach((v, i) => { z[i] += v; }); } else without++; });
      const tot = z.reduce((a, b) => a + b, 0);
      const h = (sec) => (sec >= 36000 ? `${Math.round(sec / 3600)} h` : sec >= 3600 ? `${(sec / 3600).toFixed(1)} h` : `${Math.round(sec / 60)} min`);
      if (!tot) {
        box.innerHTML = '<div class="mix-note">No rides with second-by-second power in this period.</div>';
        sb.innerHTML = '';
        this.setText('zoneDistLabel', '--');
        this.setText('zoneDistNote', without ? `${without} ride${without === 1 ? '' : 's'} in this period ha${without === 1 ? 's' : 've'} no power stream, so zone time cannot be measured.` : 'From second-by-second power. Rides without power data are not included.');
        return;
      }
      const max = Math.max(...z);
      box.innerHTML = VeloMetrics.ZONES.map((Z, i) => `
        <div class="zd-row" title="${esc(Z.short + ' ' + Z.name)}: ${h(z[i])}">
          <span class="zd-lbl"><i style="background:${Z.color}"></i><b>${Z.short}</b><span>${esc(Z.name)}</span></span>
          <span class="zd-bar"><span style="width:${((z[i] / max) * 100).toFixed(1)}%;background:${Z.color}"></span></span>
          <span class="zd-val num">${h(z[i])}</span><span class="zd-pct num">${Math.round((z[i] / tot) * 100)}%</span>
        </div>`).join('');
      const s = VeloPower.seiler(z);
      const say = {
        polarized: 'Mostly easy riding plus a solid dose of hard work, with little in between.',
        pyramidal: 'Mostly easy, some tempo / threshold and a little high intensity - the most common pattern in endurance training.',
        threshold: 'Most of the time sits in tempo / threshold. Productive short term, but tiring; more easy volume usually helps.',
        high: 'Most of the time is above threshold - hard to sustain. Add easy volume.',
        mixed: 'No single pattern dominates in this period.'
      }[s.type];
      const names = ['Low', 'Moderate', 'High'];
      sb.innerHTML = `
        <div class="seiler-bar" role="img" aria-label="Low ${s.pct[0]}%, moderate ${s.pct[1]}%, high ${s.pct[2]}%">${s.pct.map((p, i) => (p > 0 ? `<span class="sb-seg sb-${i}" style="flex-grow:${p}"></span>` : '')).join('')}</div>
        <div class="seiler-legend">${s.pct.map((p, i) => `<span><i class="sb-${i}"></i>${names[i]} <b class="num">${p}%</b></span>`).join('')}</div>
        <div class="seiler-verdict"><span class="chip chip-accent">${esc(s.label)}</span><span title="${esc(VeloGlossary.tip('pi'))}">Polarization index <b class="num">${s.pi === null ? '--' : s.pi.toFixed(2)}</b>${VeloGlossary.html('pi')}</span></div>
        <p class="seiler-note">${say} <span class="dim">Polarized = low &gt; high &gt; moderate with an index above 2.0 (Treff et al. 2019).</span></p>`;
      this.setText('zoneDistLabel', `${h(tot)} · ${withPower} ride${withPower === 1 ? '' : 's'}`);
      this.setText('zoneDistNote', `From second-by-second power of ${withPower} ride${withPower === 1 ? '' : 's'} in this period${without ? `; ${without} without a power stream ${without === 1 ? 'is' : 'are'} not included` : ''}. Zones use the FTP each ride was recorded with.`);
    }
  });
})();
