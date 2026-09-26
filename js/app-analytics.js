/**
 * APEX VELO // LAB - Analytics mixin: Chart.js charts, PMC explorer, power-duration
 * curve with scrub tool, monthly peak NP, biomechanics charts and the progression dashboard.
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
      this.initBiomechStudioCharts();
      this.initProgressionCharts();
    },

    initAnalyticsUi() {
      document.querySelectorAll('#pmcRangePills .range-pill').forEach(p => this.on(p, 'click', () => {
        document.querySelectorAll('#pmcRangePills .range-pill').forEach(x => x.classList.toggle('active', x === p));
        this.pmcRange = p.dataset.range === 'ytd' ? 'ytd' : (p.dataset.range === 'all' ? 0 : parseInt(p.dataset.range, 10));
        this.recalculatePmc();
      }));
      document.querySelectorAll('#progRangePills .prog-range').forEach(p => this.on(p, 'click', () => {
        document.querySelectorAll('#progRangePills .prog-range').forEach(x => x.classList.toggle('active', x === p));
        this.progWeeks = parseInt(p.dataset.weeks, 10) || 0;
        this.renderProgression();
      }));
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

    /** Recomputes everything derived from history (cheap enough to call after any history change). */
    refreshAnalytics() {
      this.recalculatePmc();
      this.updateFtpChart();
      this.updateMmpChart();
      this.renderProgression();
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
      const pmc = this.analytics.calculatePmcHistory(this.completedWorkouts, this.pmcDays());
      if (this.pmcChart) {
        this._pmcKeys = pmc.dateKeys;
        this.pmcChart.data.labels = pmc.labels;
        this.pmcChart.data.datasets[0].data = pmc.ctlData;
        this.pmcChart.data.datasets[1].data = pmc.atlData;
        this.pmcChart.data.datasets[2].data = pmc.tsbData;
        if (this.pmcChart.data.datasets[3]) this.pmcChart.data.datasets[3].data = pmc.tssData;
        this.pmcChart.update();
      }
      const has = this.completedWorkouts.length > 0;
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
      if (!this.completedWorkouts || this.completedWorkouts.length === 0) return [];
      const durations = VeloMetrics.MMP_DURATIONS;
      const archive = (typeof DIVAN_HEALTHFIT_DATA !== 'undefined' && DIVAN_HEALTHFIT_DATA.allTimeMmp && Array.isArray(DIVAN_HEALTHFIT_DATA.allTimeMmp.watts))
        ? DIVAN_HEALTHFIT_DATA.allTimeMmp.watts : null;
      const bests = durations.map((d, i) => (archive && Number(archive[i]) > 0 ? Number(archive[i]) : null));
      this.completedWorkouts.forEach(w => {
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
    getFtpProgressionData() {
      if (!this.completedWorkouts || this.completedWorkouts.length === 0) return { labels: [], data: [] };
      const monthly = new Map();
      [...this.completedWorkouts]
        .filter(w => w.date && (w.np > 0 || w.avgWatts > 0))
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .forEach(w => {
          const d = new Date(w.date);
          if (isNaN(d.getTime())) return;
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          const val = w.np || w.avgWatts || 0;
          const e = monthly.get(key);
          if (!e) monthly.set(key, { label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }), maxNp: val });
          else if (val > e.maxNp) e.maxNp = val;
        });
      const labels = [], data = [];
      monthly.forEach(e => { labels.push(e.label); data.push(e.maxNp); });
      return { labels, data };
    },

    initFtpChart() {
      const ctx = document.getElementById('ftpProgressChartCanvas')?.getContext('2d');
      if (!ctx) return;
      const d = this.getFtpProgressionData();
      this.ftpChart = new Chart(ctx, {
        type: 'bar',
        data: { labels: d.labels, datasets: [{ label: 'Peak monthly NP', data: d.data, backgroundColor: 'rgba(124,58,237,0.55)', hoverBackgroundColor: VIZ.violet, borderRadius: 4, maxBarThickness: 36 }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: { x: axis({ grid: { display: false } }), y: axis({ suggestedMin: 100, title: { display: true, text: 'W', color: INK.muted } }) },
          plugins: { tooltip: { callbacks: { label: (c) => ` Peak NP: ${c.parsed.y} W (${(c.parsed.y / this.activeProfile.ftp * 100).toFixed(0)}% of FTP)` } } }
        }
      });
      this.updateFtpDelta(d);
    },

    updateFtpChart() {
      if (!this.ftpChart) return;
      const d = this.getFtpProgressionData();
      this.ftpChart.data.labels = d.labels;
      this.ftpChart.data.datasets[0].data = d.data;
      this.ftpChart.update();
      this.updateFtpDelta(d);
    },

    updateFtpDelta(d) {
      const el = document.getElementById('ftpDeltaLabel');
      if (!el) return;
      if (!d.data.length || d.data.length < 2) { el.textContent = d.data.length ? `${d.data[0]} W` : '--'; return; }
      const delta = d.data[d.data.length - 1] - d.data[0];
      el.textContent = `${delta >= 0 ? '+' : ''}${delta} W since ${d.labels[0]}`;
      el.classList.toggle('chip-lime', delta > 0);
    },

    // ---------------------------------------------------------- biomechanics --
    initBiomechStudioCharts() {
      const ctxT = document.getElementById('chartTorqueSmoothness')?.getContext('2d');
      if (ctxT) {
        this.torqueChart = new Chart(ctxT, {
          type: 'bar',
          data: {
            labels: ['Torque effectiveness (%)', 'Pedal smoothness (%)'],
            datasets: [
              { label: 'Left', data: [0, 0], backgroundColor: VIZ.amber, borderRadius: 4, maxBarThickness: 48 },
              { label: 'Right', data: [0, 0], backgroundColor: VIZ.cyan, borderRadius: 4, maxBarThickness: 48 }
            ]
          },
          options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { y: axis({ min: 0, max: 100 }), x: axis({ grid: { display: false } }) }, plugins: { legend: { display: true, labels: { color: INK.secondary, boxWidth: 10 } } } }
        });
      }
      const ctxA = document.getElementById('chartPowerPhaseAngle')?.getContext('2d');
      if (ctxA) {
        this.angleChart = new Chart(ctxA, {
          type: 'line',
          data: {
            labels: ['0°', '30°', '60°', '90°', '120°', '150°', '180°', '210°', '240°', '270°', '300°', '330°'],
            datasets: [
              { label: 'Left (N·m)', data: [], borderColor: VIZ.amber, tension: 0.35 },
              { label: 'Right (N·m)', data: [], borderColor: VIZ.cyan, tension: 0.35 }
            ]
          },
          options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { y: axis(), x: axis() }, plugins: { legend: { display: true, labels: { color: INK.secondary, boxWidth: 10 } } } }
        });
      }
    },

    resetBiomechStudioCharts() {
      if (this.torqueChart) {
        this.torqueChart.data.datasets[0].data = [0, 0];
        this.torqueChart.data.datasets[1].data = [0, 0];
        this.torqueChart.update('none');
      }
      if (this.angleChart) {
        this.angleChart.data.datasets[0].data = [];
        this.angleChart.data.datasets[1].data = [];
        this.angleChart.update('none');
      }
      this.setText('torqueSourceBadge', '--');
      this.setText('angleSourceBadge', '--');
    },

    /**
     * Torque effectiveness / smoothness and crank-angle torque are not part of the
     * Bluetooth CPS stream. With real hardware these charts stay empty ("not reported");
     * in simulator mode they show the simulator's model, clearly labelled.
     */
    updateBiomechStudioCharts(power, cadence, leftBal, rightBal) {
      if (!this.torqueChart || !this.angleChart) return;
      if (this.activePowerSource !== 'SIMULATOR') {
        if (this._biomechMode !== 'hw') {
          this._biomechMode = 'hw';
          this.resetBiomechStudioCharts();
          this.setText('torqueSourceBadge', 'NOT REPORTED BY CPS');
          this.setText('angleSourceBadge', 'NOT REPORTED BY CPS');
        }
        return;
      }
      this._biomechMode = 'sim';
      this.setText('torqueSourceBadge', 'SIMULATOR MODEL');
      this.setText('angleSourceBadge', 'SIMULATOR MODEL');
      this.torqueChart.data.datasets[0].data = [this.simulator.leftTorque, this.simulator.leftSmoothness];
      this.torqueChart.data.datasets[1].data = [this.simulator.rightTorque, this.simulator.rightSmoothness];
      const cad = Math.max(40, cadence || 90);
      const meanTorque = (Math.max(0, power) * 60) / (2 * Math.PI * cad);
      const lf = ((leftBal || 50) / 50), rf = ((rightBal || 50) / 50);
      const angles = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
      this.angleChart.data.datasets[0].data = angles.map(d => +(Math.max(0.05, Math.sin(((d - 180) * Math.PI) / 180)) * meanTorque * 1.6 * lf).toFixed(1));
      this.angleChart.data.datasets[1].data = angles.map(d => +(Math.max(0.05, Math.sin((d * Math.PI) / 180)) * meanTorque * 1.6 * rf).toFixed(1));
      if (this.activeTab === 'biomechanics') {
        this.torqueChart.update('none');
        this.angleChart.update('none');
      }
    },

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
      const rides = this.completedWorkouts || [];
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
      const rides = this.completedWorkouts.filter(r => w.rideIds.includes(r.id)).sort((a, b) => new Date(a.date) - new Date(b.date));
      el.innerHTML = `<div class="week-rides-head">Week of ${w.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: <b class="num">${w.tss} TSS</b> - <b class="num">${w.hours} h</b> - ${w.rides} ride${w.rides === 1 ? '' : 's'}</div>` +
        (rides.length ? rides.map(r => `<button type="button" class="ride-chip" data-ride="${VeloApp.esc(r.id)}"><span>${new Date(r.date).toLocaleDateString('en-US', { weekday: 'short' })}</span><b>${VeloApp.esc(r.title)}</b><small class="num">${this.fmtTime(r.duration)}${r.tss ? ` - ${r.tss} TSS` : ''}</small></button>`).join('') : '<span class="mix-note">Rest week.</span>');
    }
  });
})();
