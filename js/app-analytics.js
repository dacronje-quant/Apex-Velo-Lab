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

  const DAY = 86400000;
  /** Labelled durations on the power duration curve's log axis. */
  const PDC_TICKS = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 3600, 7200, 14400];
  const PDC_TICKS_NARROW = [1, 10, 60, 300, 1200, 3600, 14400];
  /** Durations the CP model curve is drawn at (log-spaced, 1 s to 1 h). */
  const PDC_MODEL_X = [...new Set(Array.from({ length: 61 }, (_, i) => Math.round(Math.pow(3600, i / 60))))];

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
      this.on(document.getElementById('mmpScrubReadout'), 'click', delegateRide);
      this.on(document.getElementById('cpModelBody'), 'click', delegateRide);
      // Power duration curve: watts or W/kg (remembered in this browser).
      try { this.pdcUnit = localStorage.getItem('apex_pdc_unit') === 'wkg' ? 'wkg' : 'w'; } catch (e) { this.pdcUnit = 'w'; }
      const unitPills = document.querySelectorAll('#pdcUnitPills .pdc-unit');
      const syncUnits = () => unitPills.forEach(x => { const on = x.dataset.unit === this.pdcUnit; x.classList.toggle('active', on); x.setAttribute('aria-pressed', String(on)); });
      syncUnits();
      unitPills.forEach(p => this.on(p, 'click', () => {
        this.pdcUnit = p.dataset.unit === 'wkg' ? 'wkg' : 'w';
        try { localStorage.setItem('apex_pdc_unit', this.pdcUnit); } catch (e) { /* storage blocked */ }
        syncUnits();
        this.updateMmpChart();
      }));
      const tableWrap = document.getElementById('pdcTableWrap');
      if (tableWrap) this.on(tableWrap, 'toggle', () => { if (tableWrap.open) document.getElementById('pdcTable').innerHTML = this.pdcTableHtml(); });
      this.initAnalyticsNav();
      this.refreshAnalytics();
    },

    /** Section links under the page header, with the visible section highlighted. */
    initAnalyticsNav() {
      const nav = document.getElementById('anaSectionNav');
      if (!nav) return;
      const btns = [...nav.querySelectorAll('.ana-nav-btn')];
      const setActive = (id) => btns.forEach(b => { const on = b.dataset.target === id; b.classList.toggle('active', on); if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
      btns.forEach(b => this.on(b, 'click', () => {
        const el = document.getElementById(b.dataset.target);
        if (!el) return;
        setActive(b.dataset.target);
        this._anaNavLock = Date.now() + 900;
        el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      }));
      // Scroll spy: the active section is the last one whose heading has passed under the sticky nav.
      const targets = btns.map(b => document.getElementById(b.dataset.target)).filter(Boolean);
      let queued = false;
      const spy = () => {
        queued = false;
        if (this.activeTab !== 'analytics' || Date.now() < (this._anaNavLock || 0)) return;
        const line = nav.getBoundingClientRect().bottom + 40;
        let current = targets[0];
        for (const t of targets) { if (t.getBoundingClientRect().top <= line) current = t; else break; }
        const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
        setActive(atEnd ? targets[targets.length - 1].id : current.id);
      };
      this.on(window, 'scroll', () => { if (!queued) { queued = true; requestAnimationFrame(spy); } }, { passive: true });
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
      this.updateMmpChart();
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
      if (this.renderLiveWbal && !this.isPlaying) this.renderLiveWbal();
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
    /** HealthFit archive bests at VeloMetrics.MMP_DURATIONS (from before the app), or null. */
    archiveMmp() {
      return (typeof DIVAN_HEALTHFIT_DATA !== 'undefined' && DIVAN_HEALTHFIT_DATA.allTimeMmp && Array.isArray(DIVAN_HEALTHFIT_DATA.allTimeMmp.watts))
        ? DIVAN_HEALTHFIT_DATA.allTimeMmp.watts : null;
    },

    /** All-time bests at VeloMetrics.MMP_DURATIONS: archive plus every recorded ride (cached curves). */
    getAllTimeMmpBests() {
      const rides = this.cyclingRides();
      if (!rides.length) return [];
      const archive = this.archiveMmp();
      const bests = VeloMetrics.MMP_DURATIONS.map((d, i) => (archive && Number(archive[i]) > 0 ? Number(archive[i]) : null));
      rides.forEach(w => {
        const curve = this.rideMmp(w);
        if (curve) curve.forEach((v, i) => { if (v !== null && (bests[i] === null || v > bests[i])) bests[i] = v; });
      });
      return bests;
    },

    getCurrentRideMmp() {
      if (!this.recordedSamples || this.recordedSamples.length < 5) return [];
      return VeloMetrics.mmpCurve(this.recordedSamples);
    },

    /** Everything the power duration curve shows, on VeloPower.GRID (envelopes are memoised). */
    pdcData(now = Date.now()) {
      const G = VeloPower.GRID;
      const start = this.anaRangeStart ? this.anaRangeStart(now) : now - 182 * DAY;
      const days = this.anaRangeDays ? this.anaRangeDays() : 182;
      const range = this.powerEnvelope(start, now);
      const prev = days ? this.powerEnvelope(start - (now - start), start) : null;
      const all = this.powerEnvelope(-Infinity, Infinity);
      // All-time includes the HealthFit archive bests (from before the app) at its 9 durations.
      const allTime = { watts: all.watts.slice(), ids: all.ids.slice(), times: all.times.slice(), archive: new Array(G.length).fill(false) };
      const arch = this.archiveMmp();
      if (arch) {
        VeloMetrics.MMP_DURATIONS.forEach((d, i) => {
          const g = VeloPower.gridIndex(d), v = Number(arch[i]);
          if (v > 0 && (allTime.watts[g] === null || v > allTime.watts[g])) { allTime.watts[g] = v; allTime.ids[g] = null; allTime.times[g] = null; allTime.archive[g] = true; }
        });
      }
      const rec = this.recordedSamples || [];
      let live = null;
      if (rec.length >= 5) {
        if (!this._pdcLive || this._pdcLive.n !== rec.length || this._pdcLive.first !== rec[0]) this._pdcLive = { n: rec.length, first: rec[0], curve: VeloPower.mmp(VeloPower.prepare(rec)) };
        live = this._pdcLive.curve;
      }
      return { start, now, days, range, prev, allTime, live, model: this.powerModelAt(now) };
    },

    initMmpChart() {
      const ctx = document.getElementById('mmpChartCanvas')?.getContext('2d');
      if (!ctx) return;
      const self = this;
      // Crosshair at the inspected duration, with a ringed marker on every curve that has a value there.
      const crosshair = {
        id: 'pdcCrosshair',
        afterDatasetsDraw(chart) {
          const sec = self._pdcSel, area = chart.chartArea;
          if (!sec || !area) return;
          const x = chart.scales.x.getPixelForValue(sec);
          if (!(x >= area.left - 1 && x <= area.right + 1)) return;
          const c = chart.ctx;
          c.save();
          c.strokeStyle = 'rgba(230, 237, 247, 0.32)'; c.lineWidth = 1;
          c.beginPath(); c.moveTo(x, area.top); c.lineTo(x, area.bottom); c.stroke();
          chart.data.datasets.forEach((ds, i) => {
            if (!chart.isDatasetVisible(i) || ds.pdcRole === 'model') return;
            const pt = ds.data.find(q => q.x === sec);
            if (!pt) return;
            c.beginPath(); c.arc(x, chart.scales.y.getPixelForValue(pt.y), 4.5, 0, Math.PI * 2);
            c.fillStyle = ds.borderColor; c.fill(); c.lineWidth = 2; c.strokeStyle = '#0b1220'; c.stroke();
          });
          c.restore();
        }
      };
      const rangeFill = (c) => {
        const area = c.chart.chartArea;
        if (!area) return 'rgba(8,145,178,0.12)';
        const g = c.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
        g.addColorStop(0, 'rgba(8,145,178,0.30)'); g.addColorStop(1, 'rgba(8,145,178,0.02)');
        return g;
      };
      this.mmpChart = new Chart(ctx, {
        type: 'line',
        data: { datasets: [
          { label: 'This period', pdcRole: 'range', data: [], borderColor: VIZ.cyan, backgroundColor: rangeFill, fill: 'start', borderWidth: 3.2, tension: 0.25, order: 2 },
          { label: 'All-time best', pdcRole: 'all', data: [], borderColor: VIZ.violet, borderWidth: 1.6, tension: 0.25, order: 1 },
          { label: 'Previous period', pdcRole: 'prev', data: [], borderColor: VIZ.grey, borderWidth: 1.5, borderDash: [4, 4], tension: 0.25, order: 3 },
          { label: 'CP model', pdcRole: 'model', data: [], borderColor: VIZ.amber, borderWidth: 1.5, borderDash: [7, 4], tension: 0, order: 4 },
          { label: 'This session', pdcRole: 'live', data: [], borderColor: VIZ.rose, borderWidth: 2, tension: 0.25, order: 0 }
        ] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: { duration: 250 }, normalized: true,
          events: ['mousemove', 'click', 'touchstart', 'touchmove'],
          onHover: (evt, els, chart) => this.pdcPointer(evt, chart),
          onClick: (evt, els, chart) => this.pdcPointer(evt, chart),
          scales: {
            x: axis({
              type: 'logarithmic', min: 1, max: 3600,
              afterBuildTicks: (ax) => { ax.ticks = (ax.width < 520 ? PDC_TICKS_NARROW : PDC_TICKS).filter(v => v >= ax.min && v <= ax.max).map(v => ({ value: v })); },
              ticks: { color: INK.muted, autoSkip: false, maxRotation: 0, padding: 6, callback: (v) => VeloPower.durLabel(v) }
            }),
            y: axis({ grace: '5%', title: { display: true, text: 'W', color: INK.muted } })
          },
          plugins: { tooltip: { enabled: false } }
        },
        plugins: [crosshair]
      });
      this.updateMmpChart();
    },

    /** Pointer over the curve: inspect the nearest grid duration (log distance). */
    pdcPointer(evt, chart) {
      if (!evt || !chart || !chart.chartArea || evt.x < chart.chartArea.left || evt.x > chart.chartArea.right) return;
      const sec = chart.scales.x.getValueForPixel(evt.x);
      if (!(sec > 0)) return;
      const G = VeloPower.GRID;
      let best = 0;
      G.forEach((t, i) => { if (Math.abs(Math.log(t / sec)) < Math.abs(Math.log(G[best] / sec))) best = i; });
      const slider = document.getElementById('mmpScrubSlider');
      if (slider && Number(slider.value) !== best) { slider.value = best; this.renderMmpScrub(best); }
    },

    updateMmpChart() {
      if (!this.mmpChart) return;
      const d = this.pdcData();
      this._pdc = d;
      const G = VeloPower.GRID;
      const kg = this.pdcUnit === 'wkg' ? Number(this.activeProfile.weightKg) || 0 : 0;
      const conv = (v) => (kg > 0 ? Math.round((v / kg) * 100) / 100 : v);
      const pts = (arr) => (arr ? G.map((t, i) => (arr[i] > 0 ? { x: t, y: conv(arr[i]) } : null)).filter(Boolean) : []);
      const ds = this.mmpChart.data.datasets;
      ds[0].data = pts(d.range.watts);
      ds[1].data = pts(d.allTime.watts);
      ds[2].data = pts(d.prev && d.prev.watts);
      ds[3].data = d.model && d.model.ok ? PDC_MODEL_X.map(t => ({ x: t, y: conv(Math.round(VeloPower.model(t, d.model))) })) : [];
      ds[4].data = pts(d.live);
      const longest = (arr) => { let L = 0; (arr || []).forEach((v, i) => { if (v > 0) L = G[i]; }); return L; };
      this.mmpChart.options.scales.x.max = Math.max(600, longest(d.range.watts), longest(d.allTime.watts), longest(d.live));
      this.mmpChart.options.scales.y.title.text = kg ? 'W/kg' : 'W';
      this.mmpChart.update();
      const label = { 42: 'Last 6 weeks', 91: 'Last 3 months', 182: 'Last 6 months', 365: 'Last year' }[d.days] || (d.days ? `Last ${d.days} days` : 'All rides');
      this.setText('pdcRangeLegend', label);
      const prevWrap = document.getElementById('pdcPrevLegendWrap');
      if (prevWrap) prevWrap.hidden = !ds[2].data.length;
      const liveWrap = document.getElementById('pdcLiveLegendWrap');
      if (liveWrap) liveWrap.hidden = !ds[4].data.length;
      const slider = document.getElementById('mmpScrubSlider');
      if (slider) slider.max = String(G.length - 1);
      this.renderMmpScrub(slider ? parseInt(slider.value, 10) : VeloPower.gridIndex(1200));
      const tableWrap = document.getElementById('pdcTableWrap');
      if (tableWrap && tableWrap.open) document.getElementById('pdcTable').innerHTML = this.pdcTableHtml();
      if (this.renderCpModelCard) this.renderCpModelCard(d);
    },

    /** Readout for one duration: this period, all-time, previous period, the model and this session. */
    renderMmpScrub(idx) {
      const el = document.getElementById('mmpScrubReadout');
      if (!el || !this.mmpChart) return;
      const G = VeloPower.GRID;
      const i = Math.max(0, Math.min(G.length - 1, Number.isFinite(idx) ? idx : VeloPower.gridIndex(1200)));
      const sec = G[i];
      this._pdcSel = sec;
      const d = this._pdc || this.pdcData();
      const kg = Number(this.activeProfile.weightKg) || 0;
      const w = (v) => (v > 0 ? `${v} W` : '--');
      const wkg = (v) => (v > 0 && kg > 0 ? `${(v / kg).toFixed(2)} W/kg` : '');
      const when = (t) => (t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '');
      const ride = (id, t) => (id ? `<button type="button" class="link-btn" data-ride="${VeloApp.esc(id)}" title="Open this ride">${when(t)}</button>` : '');
      const r = d.range.watts[i], a = d.allTime.watts[i], p = d.prev ? d.prev.watts[i] : null, live = d.live ? d.live[i] : null;
      const m = d.model && d.model.ok && sec <= 3600 ? Math.round(VeloPower.model(sec, d.model)) : null;
      const delta = r > 0 && p > 0 ? r - p : null;
      const pctOf = (v, base) => (v > 0 && base > 0 ? Math.round((v / base) * 100) : null);
      const livePct = pctOf(live, a);
      const cells = [
        `<div class="scrub-cell"><span>Duration</span><b class="num">${VeloPower.durLabel(sec)}</b><small>${sec >= 60 ? `${sec} s` : 'sprint range'}</small></div>`,
        `<div class="scrub-cell" data-series="range"><span>This period</span><b class="num">${w(r)}</b><small class="num">${wkg(r)} ${ride(d.range.ids[i], d.range.times[i])}</small></div>`,
        `<div class="scrub-cell" data-series="all"><span>All-time best</span><b class="num">${w(a)}</b><small class="num">${wkg(a)} ${d.allTime.archive[i] ? 'HealthFit archive' : ride(d.allTime.ids[i], d.allTime.times[i])}</small></div>`,
        d.prev ? `<div class="scrub-cell" data-series="prev"><span>vs previous period</span><b class="num ${delta > 0 ? 'pos' : ''}">${delta === null ? '--' : `${delta > 0 ? '+' : ''}${delta} W`}</b><small class="num">${delta === null ? (p > 0 ? 'nothing this period' : 'no rides before') : `${p} W before (${delta >= 0 ? '+' : ''}${Math.round((delta / p) * 100)}%)`}</small></div>` : '',
        `<div class="scrub-cell" data-series="model"><span>CP model</span><b class="num">${m ? `${m} W` : '--'}</b><small class="num">${m && r > 0 ? `this period ${pctOf(r, m)}% of model` : d.model && d.model.ok ? 'model covers 1 s - 1 h' : 'no model yet'}</small></div>`,
        live > 0 || (this.recordedSamples || []).length >= 5 ? `<div class="scrub-cell" data-series="live"><span>This session</span><b class="num ${livePct !== null && livePct >= 100 ? 'pos' : ''}">${w(live)}</b><small class="num">${live > 0 ? (livePct !== null ? `${livePct}% of PR${livePct >= 100 ? ' - New PR' : ''}` : wkg(live)) : `ride longer than ${VeloPower.durLabel(sec)}`}</small></div>` : ''
      ];
      el.innerHTML = cells.join('');
      if (!d.range.watts.some(v => v > 0) && !d.allTime.watts.some(v => v > 0)) {
        el.insertAdjacentHTML('beforeend', '<div class="scrub-empty">No rides with second-by-second power yet. Ride with your power meter, or import FIT / TCX files with power, and your curve appears here.</div>');
      }
      this.mmpChart.draw();
    },

    /** Table view of the curve (accessible twin of the chart). */
    pdcTableHtml() {
      const d = this._pdc;
      if (!d) return '';
      const G = VeloPower.GRID;
      const m = d.model && d.model.ok ? d.model : null;
      const rows = G.map((t, i) => {
        const r = d.range.watts[i], a = d.allTime.watts[i], p = d.prev ? d.prev.watts[i] : null;
        if (!(r > 0) && !(a > 0)) return '';
        return `<tr><td>${VeloPower.durLabel(t)}</td><td class="num">${r > 0 ? r : '--'}</td><td class="num">${a > 0 ? a : '--'}</td>${d.prev ? `<td class="num">${p > 0 ? p : '--'}</td>` : ''}<td class="num">${m && t <= 3600 ? Math.round(VeloPower.model(t, m)) : '--'}</td></tr>`;
      }).join('');
      return `<table class="data-table pdc-table"><thead><tr><th>Duration</th><th>This period (W)</th><th>All-time (W)</th>${d.prev ? '<th>Previous (W)</th>' : ''}<th>Model (W)</th></tr></thead><tbody>${rows}</tbody></table>`;
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
        case 'zones': return `${Number(v).toFixed(1)} h`;
        default: return `${Math.round(v)} TSS`;
      }
    },

    renderProgression() {
      const rides = this.cyclingRides();
      const weeks = VeloProgress.weekly(rides, this.progWeeks);
      this._progWeeks = weeks;
      const metric = this.progMetric || 'tss';
      const titles = { tss: 'Weekly training load (TSS)', hours: 'Weekly riding time', kj: 'Weekly mechanical work', rides: 'Rides per week', zones: 'Weekly time in power zones' };
      this.setText('progWeeklyTitle', titles[metric]);
      this.setText('progWeeklyHint', metric === 'zones' ? 'Hours per zone from 1 Hz power - click a week to list its rides' : 'Click a week to list its rides');

      const chart = this.progWeeklyChart;
      if (chart && metric === 'zones') {
        // Stacked hours per Coggan zone (rides with second-by-second power only).
        if (!this._progBaseDatasets) this._progBaseDatasets = chart.data.datasets;
        const byId = new Map(rides.map(r => [r.id, r]));
        const zoneHours = weeks.map(w => {
          const z = [0, 0, 0, 0, 0, 0, 0];
          w.rideIds.forEach(id => { const zs = byId.has(id) ? this.rideZoneSeconds(byId.get(id)) : null; if (zs) zs.forEach((v, i) => { z[i] += v / 3600; }); });
          return z;
        });
        chart.data.labels = weeks.map(w => w.label);
        chart.data.datasets = VeloMetrics.ZONES.map((Z, i) => ({
          label: `${Z.short} ${Z.name}`, data: zoneHours.map(z => Math.round(z[i] * 100) / 100), backgroundColor: Z.color,
          borderColor: '#0d1424', borderWidth: { top: 2, right: 0, bottom: 0, left: 0 }, borderSkipped: false, maxBarThickness: 28, stack: 'zones'
        }));
        chart.options.scales.x.stacked = true; chart.options.scales.y.stacked = true;
        chart.options.plugins.legend = { display: true, position: 'bottom', labels: { color: INK.secondary, boxWidth: 10, boxHeight: 10, padding: 10 } };
        chart.options.plugins.tooltip.filter = (it) => it.parsed.y > 0;
        chart.update();
      } else if (chart) {
        if (this._progBaseDatasets) { chart.data.datasets = this._progBaseDatasets; this._progBaseDatasets = null; }
        chart.options.scales.x.stacked = false; chart.options.scales.y.stacked = false;
        chart.options.plugins.legend = { display: false };
        chart.options.plugins.tooltip.filter = undefined;
      }

      if (chart && metric !== 'zones') {
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
          ['Rides', c.rides, delta(c.rides, p.rides, v => v), 'gap'],
          ['Hours', c.hours.toFixed(1), delta(c.hours, p.hours, v => v.toFixed(1)), 'gap'],
          ['TSS', c.tss.toLocaleString(), delta(c.tss, p.tss, v => Math.round(v)), 'tss'],
          ['Work', `${Math.round(c.kj / 1000 * 10) / 10} MJ`, delta(c.kj / 1000, (p.kj || 0) / 1000, v => v.toFixed(1)), 'kj'],
          ['Avg NP', c.avgNp ? `${c.avgNp} W` : '--', c.avgNp && p.avgNp ? delta(c.avgNp, p.avgNp, v => Math.round(v)) : '', 'np'],
          ['Longest', c.longestSec ? this.fmtTime(c.longestSec) : '--', '', 'gap']
        ];
        kpiEl.innerHTML = tiles.map(([l, v, d, term]) => `<div class="kpi"${VeloGlossary.tip(term) ? ` title="${VeloApp.esc(VeloGlossary.tip(term))}"` : ''}><span class="kpi-lbl">${l}${VeloGlossary.html(term)}</span><span class="kpi-val num">${v}</span>${d || '<span class="delta flat">&nbsp;</span>'}</div>`).join('') +
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
