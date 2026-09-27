/**
 * APEX VELO // LAB - Analytics mixin: Chart.js charts, PMC explorer, power-duration
 * curve with scrub tool, monthly peak NP and the weekly progression charts.
 */
(function () {
  // Categorical series colours validated for the dark surface (CVD-safe, >=3:1 contrast).
  const VIZ = { cyan: '#0891b2', amber: '#d97706', rose: '#e11d48', violet: '#7c3aed', lime: '#65a30d', grey: '#64748b' };
  const INK = { primary: '#e6edf7', secondary: '#9aa7bd', muted: '#6b778c', grid: 'rgba(148,163,184,0.10)' };

  function applyChartDefaults() {
    if (typeof Chart === 'undefined' || !Chart.defaults) return;
    try {
      Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
      Chart.defaults.font.size = 11;
      Chart.defaults.color = INK.secondary;
      Chart.defaults.borderColor = INK.grid;
      Chart.defaults.plugins.legend.display = false;
      Object.assign(Chart.defaults.plugins.tooltip, {
        backgroundColor: 'rgba(11, 17, 30, 0.96)', borderColor: 'rgba(148,163,184,0.25)', borderWidth: 1,
        titleColor: INK.primary, bodyColor: INK.secondary, padding: 10, cornerRadius: 8, boxPadding: 4,
        titleFont: { weight: '600' }, bodyFont: { family: "'JetBrains Mono', ui-monospace, monospace", size: 11 }
      });
      Chart.defaults.elements.line.borderWidth = 2;
      Chart.defaults.elements.point.radius = 0;
      Chart.defaults.elements.point.hoverRadius = 4;
    } catch (e) { /* older Chart.js - keep defaults */ }
  }

  const axis = (extra = {}) => ({ grid: { color: INK.grid, drawTicks: false }, border: { display: false }, ticks: { color: INK.muted, padding: 6 }, ...extra });

  /** Chart.js plugin: shaded TSB form-zone bands behind the PMC. */
  const formBandsPlugin = {
    id: 'formBands',
    beforeDatasetsDraw(chart) {
      const y = chart.scales.y;
      const area = chart.chartArea;
      if (!y || !area) return;
      const bands = [
        { from: 5, to: 60, color: 'rgba(34,197,94,0.06)' },
        { from: -10, to: 5, color: 'rgba(148,163,184,0.04)' },
        { from: -25, to: -10, color: 'rgba(8,145,178,0.07)' },
        { from: -40, to: -25, color: 'rgba(217,119,6,0.07)' },
        { from: -200, to: -40, color: 'rgba(225,29,72,0.08)' }
      ];
      const ctx = chart.ctx;
      ctx.save();
      bands.forEach(b => {
        const top = Math.max(area.top, y.getPixelForValue(b.to));
        const bottom = Math.min(area.bottom, y.getPixelForValue(b.from));
        if (bottom > top) { ctx.fillStyle = b.color; ctx.fillRect(area.left, top, area.right - area.left, bottom - top); }
      });
      ctx.restore();
    }
  };

  VeloApp.CHART = { VIZ, INK, axis };

  Object.assign(VeloApp.prototype, {
    // ---------------------------------------------------------------- init --
    initCharts() {
      applyChartDefaults();
      const ctxT = document.getElementById('liveTelemetryChart')?.getContext('2d');
      if (ctxT) {
        this.telemetryChart = new Chart(ctxT, {
          type: 'line',
          data: {
            labels: [],
            datasets: [
              { label: 'Power', data: [], borderColor: VIZ.cyan, backgroundColor: 'rgba(8,145,178,0.14)', fill: true, tension: 0.25, yAxisID: 'y' },
              { label: 'Target', data: [], borderColor: 'rgba(230,237,247,0.55)', borderDash: [4, 4], borderWidth: 1.5, stepped: true, yAxisID: 'y' },
              { label: 'Cadence', data: [], borderColor: VIZ.amber, borderWidth: 1.5, tension: 0.25, yAxisID: 'y1' },
              { label: 'Heart rate', data: [], borderColor: VIZ.rose, borderWidth: 1.5, tension: 0.25, yAxisID: 'y2' }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
            interaction: { mode: 'index', intersect: false },
            scales: {
              x: axis({ ticks: { color: INK.muted, maxTicksLimit: 8, maxRotation: 0 } }),
              y: axis({ position: 'left', beginAtZero: true, suggestedMax: Math.round((this.activeProfile.ftp || 200) * 1.3), title: { display: true, text: 'W', color: INK.muted } }),
              y1: { display: false, min: 40, max: 130 },
              y2: { display: false, min: 60, max: 200 }
            },
            plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${c.parsed.y}${['Power', 'Target'].includes(c.dataset.label) ? ' W' : c.dataset.label === 'Cadence' ? ' rpm' : ' bpm'}` } } }
          }
        });
      }
      this.initPmcChart();
      this.initMmpChart();
      this.initFtpChart();
      if (this.initDriftChart) this.initDriftChart();
      this.initProgressionCharts();
      if (this.initDashboardCharts) this.initDashboardCharts();
    },

    initAnalyticsUi() {
      // One time range for the whole Analytics page (PMC, weekly load, trends).
      document.querySelectorAll('#anaRangePills .ana-range').forEach(p => this.on(p, 'click', () => this.setAnalyticsRange(p.dataset.range)));
      const explore = document.querySelector('#view-analytics .explore-card');
      if (explore) this.on(explore, 'toggle', () => { if (explore.open && this.progScatterChart) requestAnimationFrame(() => this.progScatterChart.resize()); });
      document.querySelectorAll('#progMetricPills .prog-metric').forEach(p => this.on(p, 'click', () => {
        document.querySelectorAll('#progMetricPills .prog-metric').forEach(x => x.classList.toggle('active', x === p));
        this.progMetric = p.dataset.metric;
        this.renderProgression();
      }));
      this.on(document.getElementById('mmpScrubSlider'), 'input', (e) => this.renderMmpScrub(parseInt(e.target.value, 10)));
      const delegateRide = (e) => {
        const el = e.target.closest('[data-ride]');
        if (el) this.showRideSummaryById(el.dataset.ride);
      };
      this.on(document.getElementById('progWeekRides'), 'click', delegateRide);
      this.on(document.getElementById('progRecords'), 'click', delegateRide);
      this.refreshAnalytics();
    },

    /** Sets the page-wide range: '6w' | '3m' | '6m' | '1y' | 'all'. */
    setAnalyticsRange(key) {
      const R = { '6w': [42, 6], '3m': [91, 13], '6m': [182, 26], '1y': [365, 52], all: [0, 0] };
      const v = R[key] || R['6m'];
      this.anaRange = R[key] ? key : '6m';
      this.pmcRange = v[0];
      this.progWeeks = v[1];
      document.querySelectorAll('#anaRangePills .ana-range').forEach(x => x.classList.toggle('active', x.dataset.range === this.anaRange));
      this.recalculatePmc();
      this.renderProgression();
      if (this.renderDashboard) this.renderDashboard();
    },

    /** Recomputes everything derived from history (cheap enough to call after any history change). */
    refreshAnalytics() {
      this.recalculatePmc();
      this.updateFtpChart();
      if (this.updateDriftChart) this.updateDriftChart();
      this.updateMmpChart();
      this.renderProgression();
      if (this.renderDashboard) this.renderDashboard();
      this.updateHeroStats && this.updateHeroStats();
    },

    // ----------------------------------------------------------- telemetry --
    updateTelemetryChart(timeSec, power, cad, hr, target) {
      const chart = this.telemetryChart;
      if (!chart) return;
      chart.data.labels.push(this.fmtTime(timeSec));
      chart.data.datasets[0].data.push(power);
      chart.data.datasets[1].data.push(target);
      chart.data.datasets[2].data.push(cad || null);
      chart.data.datasets[3].data.push(hr || null);
      if (chart.data.labels.length > 120) {
        chart.data.labels.shift();
        chart.data.datasets.forEach(ds => ds.data.shift());
      }
      if (this.activeTab === 'cockpit' && !this.isZenMode) chart.update('none');
    },

    // ------------------------------------------------------------------ PMC --
    pmcDays() {
      if (this.pmcRange === 'ytd') return VeloMetrics.daysYearToDate();
      return Number(this.pmcRange) || 0;
    },

    initPmcChart() {
      const ctx = document.getElementById('pmcChartCanvas')?.getContext('2d');
      if (!ctx) return;
      this.pmcChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: [],
          datasets: [
            { label: 'CTL', data: [], borderColor: VIZ.cyan, backgroundColor: 'rgba(8,145,178,0.12)', fill: 'origin', tension: 0.3, order: 1 },
            { label: 'ATL', data: [], borderColor: VIZ.rose, tension: 0.3, order: 2 },
            { label: 'TSB', data: [], borderColor: VIZ.amber, borderDash: [5, 3], tension: 0.3, order: 3 },
            { label: 'Daily TSS', type: 'bar', data: [], backgroundColor: 'rgba(148,163,184,0.28)', hoverBackgroundColor: 'rgba(148,163,184,0.5)', borderRadius: 2, barPercentage: 0.9, categoryPercentage: 1, order: 4 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: axis({ ticks: { color: INK.muted, maxTicksLimit: 10, maxRotation: 0, autoSkip: true } }),
            y: axis({ title: { display: true, text: 'Load (TSS/day)', color: INK.muted } })
          },
          plugins: {
            tooltip: {
              callbacks: {
                title: (items) => {
                  const k = this._pmcKeys ? this._pmcKeys[items[0].dataIndex] : null;
                  return k ? new Date(k + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : items[0].label;
                },
                label: (c) => ` ${c.dataset.label}: ${c.dataset.label === 'Daily TSS' ? c.parsed.y : (c.parsed.y > 0 && c.dataset.label === 'TSB' ? '+' : '') + c.parsed.y}`,
                footer: (items) => {
                  const tsb = items.find(i => i.dataset.label === 'TSB');
                  return tsb ? `Form: ${VeloMetrics.formZone(tsb.parsed.y).label}` : '';
                }
              }
            }
          }
        },
        plugins: [formBandsPlugin]
      });
      this.recalculatePmc();
    },

    recalculatePmc() {
      const pmc = this.analytics.calculatePmcHistory(this.completedWorkouts, this.pmcDays(), this.pmcOpts());
      if (this.pmcChart) {
        this._pmcKeys = pmc.dateKeys;
        this.pmcChart.data.labels = pmc.labels;
        this.pmcChart.data.datasets[0].data = pmc.ctlData;
        this.pmcChart.data.datasets[1].data = pmc.atlData;
        this.pmcChart.data.datasets[2].data = pmc.tsbData;
        if (this.pmcChart.data.datasets[3]) this.pmcChart.data.datasets[3].data = pmc.tssData;
        this.pmcChart.update();
      }
      const has = this.cyclingRides().length > 0;
      this.setText('pmcValCtl', has ? pmc.currentCtl.toFixed(1) : '--');
      this.setText('pmcValAtl', has ? pmc.currentAtl.toFixed(1) : '--');
      this.setText('pmcValTsb', has ? (pmc.currentTsb >= 0 ? '+' : '') + pmc.currentTsb.toFixed(1) : '--');
      const badge = document.getElementById('pmcFormStatus');
      if (badge) {
        const z = VeloMetrics.formZone(pmc.currentTsb);
        badge.textContent = has ? z.label : '--';
        badge.className = `form-badge ${has ? 'form-' + z.key : ''}`;
        badge.title = has ? z.desc : '';
      }
      return pmc;
    },

    // ------------------------------------------------------------------ MMP --
    getAllTimeMmpBests() {
      const rides = this.cyclingRides();
      if (!rides.length) return [];
      const durations = VeloMetrics.MMP_DURATIONS;
      const archive = (typeof DIVAN_HEALTHFIT_DATA !== 'undefined' && DIVAN_HEALTHFIT_DATA.allTimeMmp && Array.isArray(DIVAN_HEALTHFIT_DATA.allTimeMmp.watts))
        ? DIVAN_HEALTHFIT_DATA.allTimeMmp.watts : null;
      const bests = durations.map((d, i) => (archive && Number(archive[i]) > 0 ? Number(archive[i]) : null));
      rides.forEach(w => {
        if (w.samples && w.samples.length >= 5) {
          const curve = VeloMetrics.mmpCurve(w.samples.map(s => s.power || 0), durations);
          curve.forEach((v, i) => { if (v !== null && (bests[i] === null || v > bests[i])) bests[i] = v; });
        }
      });
      return bests;
    },

    getCurrentRideMmp() {
      if (!this.recordedSamples || this.recordedSamples.length < 5) return [];
      return VeloMetrics.mmpCurve(this.recordedSamples.map(s => s.power || 0));
    },

    initMmpChart() {
      const ctx = document.getElementById('mmpChartCanvas')?.getContext('2d');
      if (!ctx) return;
      this.mmpChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: VeloMetrics.MMP_LABELS.slice(),
          datasets: [
            { label: 'All-time PR', data: this.getAllTimeMmpBests(), borderColor: VIZ.violet, pointBackgroundColor: VIZ.violet, pointBorderColor: '#0b1220', pointBorderWidth: 2, pointRadius: 4, tension: 0.3, spanGaps: true },
            { label: 'This session', data: this.getCurrentRideMmp(), borderColor: VIZ.cyan, backgroundColor: 'rgba(8,145,178,0.14)', fill: true, pointBackgroundColor: VIZ.cyan, pointBorderColor: '#0b1220', pointBorderWidth: 2, pointRadius: 4, tension: 0.3, spanGaps: true }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
          interaction: { mode: 'index', intersect: false },
          onHover: (evt, els) => {
            if (els && els.length) {
              const slider = document.getElementById('mmpScrubSlider');
              if (slider && Number(slider.value) !== els[0].index) { slider.value = els[0].index; this.renderMmpScrub(els[0].index); }
            }
          },
          scales: { x: axis({ ticks: { color: INK.muted } }), y: axis({ title: { display: true, text: 'W', color: INK.muted } }) },
          plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${c.parsed.y === null ? '--' : c.parsed.y + ' W'}` } } }
        }
      });
      this.renderMmpScrub(7);
    },

    updateMmpChart() {
      if (!this.mmpChart) return;
      this.mmpChart.data.datasets[0].data = this.getAllTimeMmpBests();
      this.mmpChart.data.datasets[1].data = this.getCurrentRideMmp();
      this.mmpChart.update();
      const slider = document.getElementById('mmpScrubSlider');
      this.renderMmpScrub(slider ? parseInt(slider.value, 10) : 7);
    },

    /** MMP scrub readout: PR vs this session at one duration, with % of PR and W/kg. */
    renderMmpScrub(idx) {
      const el = document.getElementById('mmpScrubReadout');
      if (!el || !this.mmpChart) return;
      const i = Math.max(0, Math.min(8, Number.isFinite(idx) ? idx : 7));
      const pr = this.mmpChart.data.datasets[0].data[i];
      const cur = this.mmpChart.data.datasets[1].data[i];
      const kg = this.activeProfile.weightKg;
      const pct = (pr && cur) ? Math.round((cur / pr) * 100) : null;
      const radius = VeloMetrics.MMP_DURATIONS.map((_, j) => (j === i ? 7 : 4));
      this.mmpChart.data.datasets.forEach(ds => { ds.pointRadius = radius; });
      this.mmpChart.update('none');
      el.innerHTML = `
        <div class="scrub-cell"><span>Duration</span><b class="num">${VeloMetrics.MMP_LABELS[i]}</b></div>
        <div class="scrub-cell"><span>All-time PR</span><b class="num">${pr ? pr + ' W' : '--'}</b><small class="num">${pr ? (pr / kg).toFixed(2) + ' W/kg' : ''}</small></div>
        <div class="scrub-cell"><span>This session</span><b class="num">${cur ? cur + ' W' : '--'}</b><small class="num">${cur ? (cur / kg).toFixed(2) + ' W/kg' : 'ride longer than ' + VeloMetrics.MMP_LABELS[i]}</small></div>
        <div class="scrub-cell"><span>vs PR</span><b class="num ${pct !== null && pct >= 100 ? 'pos' : ''}">${pct !== null ? pct + '%' : '--'}</b>${pct !== null && pct >= 100 ? '<small>New PR</small>' : ''}</div>`;
    },

    // ------------------------------------------------------ monthly peak NP --
    /**
     * Per month: peak NP (bars), the FTP in use at month end (from the FTP stored with each ride and
     * the profile's FTP-change log) and the best FTP the rides proved (20 min x 0.95 / 60 min).
     */
    getFtpProgressionData() {
      const rides = this.cyclingRides();
      if (!rides.length) return { labels: [], data: [], ftp: [], proven: [] };
      const monthly = new Map();
      const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      [...rides]
        .filter(w => w.date && (w.np > 0 || w.avgWatts > 0))
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .forEach(w => {
          const d = new Date(w.date);
          if (isNaN(d.getTime())) return;
          const key = monthKey(d);
          const val = w.np || w.avgWatts || 0;
          let e = monthly.get(key);
          if (!e) { e = { label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }), maxNp: val, ftp: null, ftpAt: 0, proven: null }; monthly.set(key, e); }
          else if (val > e.maxNp) e.maxNp = val;
          const f = Number(w.ftpAtRide) || 0;
          if (f > 0 && d.getTime() >= e.ftpAt) { e.ftp = f; e.ftpAt = d.getTime(); }
          const ev = this.ftpEvidenceOf ? this.ftpEvidenceOf(w) : null;
          if (ev && ev.estimate > 0 && (e.proven === null || ev.estimate > e.proven)) e.proven = ev.estimate;
        });
      // FTP changes made in the profile (one-click update or manual edit) count from their date.
      const log = Array.isArray(this.activeProfile.ftpHistory) ? this.activeProfile.ftpHistory : [];
      log.forEach(x => {
        const d = new Date(x.date);
        const e = monthly.get(monthKey(d));
        if (e && d.getTime() >= e.ftpAt && Number(x.ftp) > 0) { e.ftp = Number(x.ftp); e.ftpAt = d.getTime(); }
      });
      const labels = [], data = [], ftp = [], proven = [];
      let carry = null;
      monthly.forEach(e => {
        carry = e.ftp || carry;
        // Only efforts that actually tested FTP (within 5% of it, or above): an easy hour only proves a floor.
        const tested = e.proven !== null && (!carry || e.proven >= carry * 0.95);
        labels.push(e.label); data.push(e.maxNp); ftp.push(carry); proven.push(tested ? e.proven : null);
      });
      return { labels, data, ftp, proven };
    },

    initFtpChart() {
      const ctx = document.getElementById('ftpProgressChartCanvas')?.getContext('2d');
      if (!ctx) return;
      const d = this.getFtpProgressionData();
      this.ftpChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: d.labels,
          datasets: [
            { label: 'Peak monthly NP', data: d.data, backgroundColor: 'rgba(124,58,237,0.55)', hoverBackgroundColor: VIZ.violet, borderRadius: 4, maxBarThickness: 36, order: 3 },
            { type: 'line', label: 'FTP in use', data: d.ftp, borderColor: VIZ.amber, backgroundColor: VIZ.amber, borderWidth: 2, stepped: 'middle', pointRadius: 0, spanGaps: true, order: 1 },
            { type: 'line', label: 'FTP your rides proved', data: d.proven, borderColor: VIZ.lime, backgroundColor: VIZ.lime, showLine: false, pointStyle: 'triangle', pointRadius: 6, pointHoverRadius: 8, order: 0 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: { x: axis({ grid: { display: false } }), y: axis({ suggestedMin: 100, title: { display: true, text: 'W', color: INK.muted } }) },
          plugins: {
            legend: { display: true, labels: { color: INK.secondary, boxWidth: 10, usePointStyle: true } },
            tooltip: { callbacks: { label: (c) => c.datasetIndex === 0 ? ` Peak NP: ${c.parsed.y} W (${(c.parsed.y / this.activeProfile.ftp * 100).toFixed(0)}% of FTP)`
              : c.datasetIndex === 1 ? ` FTP in use: ${c.parsed.y} W` : ` Proven by a ride: ${c.parsed.y} W (best 20 min x 0.95 or 60 min)` } }
          }
        }
      });
      this.updateFtpDelta(d);
    },

    updateFtpChart() {
      if (!this.ftpChart) return;
      const d = this.getFtpProgressionData();
      this.ftpChart.data.labels = d.labels;
      this.ftpChart.data.datasets[0].data = d.data;
      if (this.ftpChart.data.datasets[1]) this.ftpChart.data.datasets[1].data = d.ftp;
      if (this.ftpChart.data.datasets[2]) this.ftpChart.data.datasets[2].data = d.proven;
      this.ftpChart.update();
      this.updateFtpDelta(d);
    },

    updateFtpDelta(d) {
      const el = document.getElementById('ftpDeltaLabel');
      if (!el) return;
      // FTP change over the period shown (the FTP in use), else the peak-NP change for rides without FTP.
      const ftps = (d.ftp || []).filter(v => v > 0);
      const series = ftps.length >= 2 ? ftps : d.data;
      if (!series.length || series.length < 2) { el.textContent = ftps.length ? `FTP ${ftps[0]} W` : d.data.length ? `${d.data[0]} W` : '--'; return; }
      const delta = series[series.length - 1] - series[0];
      el.textContent = `${ftps.length >= 2 ? 'FTP ' : ''}${delta >= 0 ? '+' : ''}${delta} W since ${d.labels[0]}`;
      el.classList.toggle('chip-lime', delta > 0);
    },

    // ---------------------------------------------------------- biomechanics --
    // ------------------------------------------------- progression dashboard --
    initProgressionCharts() {
      const ctxW = document.getElementById('progWeeklyChart')?.getContext('2d');
      if (ctxW) {
        this.progWeeklyChart = new Chart(ctxW, {
          type: 'bar',
          data: { labels: [], datasets: [
            { label: 'Weekly', data: [], backgroundColor: [], borderRadius: 4, maxBarThickness: 28, order: 2 },
            { label: '4-week average', type: 'line', data: [], borderColor: VIZ.amber, borderWidth: 2, tension: 0.35, pointRadius: 0, order: 1 }
          ] },
          options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
            interaction: { mode: 'index', intersect: false },
            onClick: (evt, els) => { if (els && els.length) this.showWeekRides(els[0].index); },
            onHover: (evt, els) => { if (evt && evt.native && evt.native.target) evt.native.target.style.cursor = els && els.length ? 'pointer' : 'default'; },
            scales: { x: axis({ grid: { display: false }, ticks: { color: INK.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } }), y: axis({ beginAtZero: true }) },
            plugins: { tooltip: { callbacks: {
              title: (items) => { const w = this._progWeeks && this._progWeeks[items[0].dataIndex]; return w ? `Week of ${w.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''; },
              label: (c) => ` ${c.dataset.label}: ${this.fmtProgMetric(c.parsed.y)}`,
              footer: (items) => { const w = this._progWeeks && this._progWeeks[items[0].dataIndex]; return w ? `${w.rides} ride${w.rides === 1 ? '' : 's'} - click for details` : ''; }
            } } }
          }
        });
      }
      const ctxS = document.getElementById('progScatterChart')?.getContext('2d');
      if (ctxS) {
        this.progScatterChart = new Chart(ctxS, {
          type: 'scatter',
          data: { datasets: [{ label: 'Rides', data: [], pointRadius: 5, pointHoverRadius: 8, pointBackgroundColor: [], pointBorderColor: '#0b1220', pointBorderWidth: 1.5 }] },
          options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
            onClick: (evt, els) => { if (els && els.length) { const p = this._progScatter[els[0].index]; if (p) this.showRideSummaryById(p.id); } },
            onHover: (evt, els) => { if (evt && evt.native && evt.native.target) evt.native.target.style.cursor = els && els.length ? 'pointer' : 'default'; },
            scales: {
              x: axis({ title: { display: true, text: 'Duration (min)', color: INK.muted }, beginAtZero: true }),
              y: axis({ title: { display: true, text: 'NP (W)', color: INK.muted } })
            },
            plugins: { tooltip: { callbacks: {
              title: (items) => { const p = this._progScatter[items[0].dataIndex]; return p ? p.title : ''; },
              label: (c) => { const p = this._progScatter[c.dataIndex]; return p ? [` ${new Date(p.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`, ` ${p.x} min - NP ${p.y} W`, ` TSS ${p.tss}${p.ifac ? ` - IF ${p.ifac.toFixed(2)}` : ''}`] : ''; }
            } } }
          }
        });
      }
    },

    fmtProgMetric(v) {
      if (v === null || v === undefined) return '--';
      switch (this.progMetric) {
        case 'hours': return `${Number(v).toFixed(1)} h`;
        case 'kj': return `${Math.round(v).toLocaleString()} kJ`;
        case 'rides': return `${v}`;
        default: return `${Math.round(v)} TSS`;
      }
    },

    renderProgression() {
      const rides = this.cyclingRides();
      const weeks = VeloProgress.weekly(rides, this.progWeeks);
      this._progWeeks = weeks;
      const metric = this.progMetric || 'tss';
      const titles = { tss: 'Weekly training load (TSS)', hours: 'Weekly riding time', kj: 'Weekly mechanical work', rides: 'Rides per week' };
      this.setText('progWeeklyTitle', titles[metric]);

      if (this.progWeeklyChart) {
        const vals = weeks.map(w => w[metric]);
        const avg = vals.map((_, i) => {
          const slice = vals.slice(Math.max(0, i - 3), i + 1);
          return Math.round((slice.reduce((a, b) => a + b, 0) / slice.length) * 10) / 10;
        });
        this.progWeeklyChart.data.labels = weeks.map(w => w.label);
        this.progWeeklyChart.data.datasets[0].data = vals;
        this.progWeeklyChart.data.datasets[0].label = titles[metric];
        this.progWeeklyChart.data.datasets[0].backgroundColor = weeks.map((w, i) => (i === weeks.length - 1 ? 'rgba(8,145,178,0.95)' : 'rgba(8,145,178,0.5)'));
        this.progWeeklyChart.data.datasets[1].data = avg;
        this.progWeeklyChart.update();
      }

      // KPIs with deltas vs the preceding period of equal length
      const k = VeloProgress.kpis(rides, this.progWeeks);
      const kpiEl = document.getElementById('progKpis');
      if (kpiEl) {
        const delta = (cur, prev, fmt) => {
          if (!k.prev || prev === null || prev === undefined) return '';
          const d = cur - prev;
          if (!prev && !cur) return '<span class="delta flat">--</span>';
          const pct = prev ? Math.round((d / prev) * 100) : null;
          return `<span class="delta ${d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}">${d > 0 ? '+' : ''}${fmt(d)}${pct !== null ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''}</span>`;
        };
        const c = k.cur, p = k.prev || {};
        const tiles = [
          ['Rides', c.rides, delta(c.rides, p.rides, v => v)],
          ['Hours', c.hours.toFixed(1), delta(c.hours, p.hours, v => v.toFixed(1))],
          ['TSS', c.tss.toLocaleString(), delta(c.tss, p.tss, v => Math.round(v))],
          ['Work', `${Math.round(c.kj / 1000 * 10) / 10} MJ`, delta(c.kj / 1000, (p.kj || 0) / 1000, v => v.toFixed(1))],
          ['Avg NP', c.avgNp ? `${c.avgNp} W` : '--', c.avgNp && p.avgNp ? delta(c.avgNp, p.avgNp, v => Math.round(v)) : ''],
          ['Longest', c.longestSec ? this.fmtTime(c.longestSec) : '--', '']
        ];
        kpiEl.innerHTML = tiles.map(([l, v, d]) => `<div class="kpi"><span class="kpi-lbl">${l}</span><span class="kpi-val num">${v}</span>${d || '<span class="delta flat">&nbsp;</span>'}</div>`).join('') +
          `<div class="kpi-caption">${k.prev ? 'vs previous ' + (this.progWeeks >= 52 ? '12 months' : this.progWeeks + ' weeks') : 'all recorded history'}</div>`;
      }

      // Intensity mix (hours by ride IF band)
      const from = this.progWeeks > 0 ? k.start : null;
      const mix = VeloProgress.intensityMix(rides, from);
      const mixEl = document.getElementById('progIntensityMix');
      if (mixEl) {
        const total = mix.bands.reduce((a, b) => a + b.hours, 0);
        mixEl.innerHTML = total > 0 ? mix.bands.map(b => {
          const pct = total ? (b.hours / total) * 100 : 0;
          return `<div class="mix-row" title="${b.rides} rides"><span class="mix-lbl"><i style="background:${b.color}"></i>${b.label}</span><span class="mix-bar"><span style="width:${pct.toFixed(1)}%;background:${b.color}"></span></span><span class="mix-val num">${b.hours.toFixed(1)}h</span></div>`;
        }).join('') + (mix.unknownRides ? `<div class="mix-note">${mix.unknownRides} ride${mix.unknownRides === 1 ? '' : 's'} (${mix.unknownHours.toFixed(1)} h) without recorded power are not classified.</div>` : '')
          : `<div class="mix-note">No rides with recorded power in this period${mix.unknownRides ? ` (${mix.unknownRides} without power data)` : ''}.</div>`;
      }

      // Records
      const rec = VeloProgress.records(rides);
      const recEl = document.getElementById('progRecords');
      if (recEl) {
        const row = (label, r, val) => r ? `<button type="button" class="record-row" data-ride="${VeloApp.esc(r.r.id)}"><svg class="ic ic-xs"><use href="#i-trophy"/></svg><span>${label}</span><b class="num">${val}</b><small>${new Date(r.r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</small></button>` : '';
        recEl.innerHTML = [
          row('Best NP', rec.bestNp, rec.bestNp ? `${rec.bestNp.v} W` : ''),
          row('Longest ride', rec.longest, rec.longest ? this.fmtTime(rec.longest.v) : ''),
          row('Biggest TSS', rec.bigTss, rec.bigTss ? `${rec.bigTss.v}` : ''),
          row('Most work', rec.bigKj, rec.bigKj ? `${rec.bigKj.v} kJ` : ''),
          rec.bestWeek && rec.bestWeek.tss ? `<div class="record-row static"><svg class="ic ic-xs"><use href="#i-trophy"/></svg><span>Biggest week</span><b class="num">${rec.bestWeek.tss} TSS</b><small>${rec.bestWeek.label}</small></div>` : '',
          rec.streak ? `<div class="record-row static"><svg class="ic ic-xs"><use href="#i-trophy"/></svg><span>Longest streak</span><b class="num">${rec.streak} day${rec.streak === 1 ? '' : 's'}</b><small></small></div>` : ''
        ].join('') || '<div class="mix-note">No rides yet.</div>';
      }

      // Scatter
      const pts = VeloProgress.scatter(rides, from);
      this._progScatter = pts;
      if (this.progScatterChart) {
        this.progScatterChart.data.datasets[0].data = pts.map(p => ({ x: p.x, y: p.y }));
        this.progScatterChart.data.datasets[0].pointBackgroundColor = pts.map(p => p.color);
        this.progScatterChart.update();
      }
      const wr = document.getElementById('progWeekRides');
      if (wr && !wr.dataset.week) wr.innerHTML = '';
    },

    showWeekRides(index) {
      const w = this._progWeeks && this._progWeeks[index];
      const el = document.getElementById('progWeekRides');
      if (!w || !el) return;
      el.dataset.week = w.key;
      const rides = this.cyclingRides().filter(r => w.rideIds.includes(r.id)).sort((a, b) => new Date(a.date) - new Date(b.date));
      el.innerHTML = `<div class="week-rides-head">Week of ${w.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: <b class="num">${w.tss} TSS</b> - <b class="num">${w.hours} h</b> - ${w.rides} ride${w.rides === 1 ? '' : 's'}</div>` +
        (rides.length ? rides.map(r => `<button type="button" class="ride-chip" data-ride="${VeloApp.esc(r.id)}"><span>${new Date(r.date).toLocaleDateString('en-US', { weekday: 'short' })}</span><b>${VeloApp.esc(r.title)}</b><small class="num">${this.fmtTime(r.duration)}${r.tss ? ` - ${r.tss} TSS` : ''}</small></button>`).join('') : '<span class="mix-note">Rest week.</span>');
    }
  });
})();
