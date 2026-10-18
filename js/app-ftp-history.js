/*
 * Analytics > FTP over time. Shows either the estimates calculated in the app from this device's rides
 * (js/velo-ftp-model.js, recalculated after every ride) or an imported research history. Neither ever
 * changes the training FTP.
 */
(function () {
  // The uncertainty band is painted by this plugin rather than by extra datasets, so hovering near
  // its edge can never take over the tooltip from the estimate line.
  const bandPlugin = {
    id: 'ftpBand',
    beforeDatasetsDraw(chart, args, opts) {
      if (!opts?.enabled) return;
      const ds = chart.data.datasets.find(d => d.metric === 'B'); if (!ds) return;
      const { ctx, chartArea: a, scales: { x, y } } = chart;
      const px = p => x.getPixelForValue(p.x), py = v => y.getPixelForValue(v);
      ctx.save(); ctx.beginPath(); ctx.rect(a.left, a.top, a.width, a.height); ctx.clip(); ctx.fillStyle = opts.color || 'rgba(124,200,255,.13)';
      let seg = [];
      const flush = () => {
        if (seg.length === 1) { const p = seg[0]; ctx.fillRect(px(p) - 3, py(p.high), 6, py(p.low) - py(p.high)); }
        else if (seg.length > 1) {
          ctx.beginPath(); seg.forEach((p, i) => i ? ctx.lineTo(px(p), py(p.high)) : ctx.moveTo(px(p), py(p.high)));
          for (let i = seg.length - 1; i >= 0; i--) ctx.lineTo(px(seg[i]), py(seg[i].low));
          ctx.closePath(); ctx.fill();
        }
        seg = [];
      };
      for (const p of ds.data) { if (p.y != null && p.low != null && p.high != null) seg.push(p); else flush(); }
      flush(); ctx.restore();
    }
  };
  const SOURCE_KEY = 'apex_ftp_source';
  Object.assign(VeloApp.prototype, {
    /** FTP history source: 'app' (calculated here) or 'import' (saved research history). */
    ftpMetricSource() {
      try { return localStorage.getItem(SOURCE_KEY) === 'import' ? 'import' : 'app'; } catch (e) { return 'app'; }
    },

    /**
     * The five estimate histories calculated from the rides on this device, in the imported bundle's shape.
     * Each ride's power-heart-rate reading is cached by ride, samples, threshold HR and FTP; the bundle by
     * the ride history and profile inputs.
     */
    appFtpBundle() {
      if (typeof VeloFtpModel === 'undefined' || !this.activeProfile) return null;
      const p = this.activeProfile, thr = VeloFtpModel.thresholdHr(p);
      const sig = `${this.historySignature()}|${this.activeProfileId}|${p.lthr || ''}|${p.maxHr || ''}|${p.ftp}|${new Date().toDateString()}`;
      if (this._appFtpBundle && this._appFtpBundle.sig === sig) return this._appFtpBundle.bundle;
      const now = Date.now();
      const steps = VeloFtpHistory.activeHistory(p, this.cyclingRides(), now);
      const ftpAt = (t) => { let v = steps.length ? steps[0].y : Number(p.ftp) || null; for (const s of steps) { if (s.x <= t) v = s.y; else break; } return v; };
      const cache = this._hrPowerCache || (this._hrPowerCache = new Map());
      const rides = this.cyclingRides().filter(VeloInsight.hasSamples).map(r => {
        const t = Date.parse(r.date), ftp = this.rideFtp(r) || ftpAt(t);
        const key = `${r.id}|${r.samples.length}|${thr ? thr.hr : ''}|${ftp}`;
        if (!cache.has(key)) cache.set(key, thr ? VeloFtpModel.hrPowerEstimate(VeloPower.prepare(r.samples), thr.hr, ftp) : null);
        return { id: r.id, t, title: r.title, curve: this.ridePower(r).curve, hrp: cache.get(key) };
      }).filter(r => Number.isFinite(r.t));
      if (!rides.length) { this._appFtpBundle = { sig, bundle: null }; return null; }
      const built = VeloFtpModel.build({ rides, ftpAt, now, thr });
      const bundle = { schema: 'apex-ftp-history', version: 1, profileId: this.activeProfileId, asOf: now, series: built.series, modelVersion: VeloFtpModel.MODEL_VERSION, context: null, app: true, stats: built.stats };
      this._appFtpBundle = { sig, bundle };
      return bundle;
    },

    initFtpMetricsChart() {
      const canvas = document.getElementById('ftpMetricsHistoryCanvas');
      if (!canvas || typeof Chart === 'undefined') return;
      const { INK, axis } = VeloApp.CHART;
      const controls = document.getElementById('ftpMetricsControls');
      this._ftpMetricVisible = new Set(Object.entries(VeloFtpHistory.METRICS).filter(([, v]) => v.main).map(([k]) => k));
      // Every series can be drawn; FTP in Use and Power + Heart Rate start ticked.
      controls.replaceChildren(...Object.entries(VeloFtpHistory.METRICS).map(([key, m]) => {
        const label = document.createElement('label'), input = document.createElement('input'), dot = document.createElement('i');
        input.type = 'checkbox'; input.checked = this._ftpMetricVisible.has(key); input.dataset.ftpMetric = key;
        input.addEventListener('change', () => { if (input.checked) this._ftpMetricVisible.add(key); else this._ftpMetricVisible.delete(key); this.updateFtpMetricsChart(); });
        dot.style.backgroundColor = m.color; label.append(input, dot, document.createTextNode(m.label)); return label;
      }));
      this.ftpMetricsChart = new Chart(canvas, { type: 'line', data: { datasets: [] }, plugins: [bandPlugin], options: {
        responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
        interaction: { mode: 'nearest', intersect: false },
        scales: { x: axis({ type: 'linear', ticks: { maxTicksLimit: 7, maxRotation: 0, callback: v => new Date(v).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) } }),
          y: axis({ title: { display: true, text: 'Watts', color: INK.muted } }) },
        plugins: { legend: { display: false }, ftpBand: { enabled: true }, tooltip: {
          callbacks: { title: items => { const p = items[0]?.raw; return p ? VeloFtpHistory.formatDate(p.x, p.dateOnly, { day: 'numeric', month: 'short', year: 'numeric' }) + (p.dateOnly ? ' · date only' : '') : ''; },
            label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)} W`,
            afterLabel: c => { const p = c.raw, lines = []; if (p.low != null && p.high != null) lines.push(`${p.low}–${p.high} W · ${p.rangeKind || 'conditional model range'}`); if (p.title) lines.push(p.title); if (p.reason) lines.push(p.reason); return lines; } } } }
      } });
      const source = document.getElementById('ftpMetricsSource');
      if (source) {
        source.value = this.ftpMetricSource();
        source.addEventListener('change', () => { try { localStorage.setItem(SOURCE_KEY, source.value); } catch (e) { /* not kept */ } this.updateFtpMetricsChart(); });
      }
      document.getElementById('ftpMetricsBand').addEventListener('change', () => this.updateFtpMetricsChart());
      document.getElementById('ftpMetricsWorkoutDots').addEventListener('change', () => this.updateFtpMetricsChart());
      document.getElementById('ftpMetricsDetails').addEventListener('toggle', e => { if (e.target.open) this.renderFtpMetricsTable(); });
      document.getElementById('btnImportFtpMetrics').addEventListener('click', () => document.getElementById('ftpMetricsFile').click());
      document.getElementById('ftpMetricsFile').addEventListener('change', async e => {
        const file = e.target.files[0]; e.target.value = ''; if (!file) return;
        try {
          if (file.size > 5 * 1024 * 1024) throw new Error('Choose an FTP history export smaller than 5 MB.');
          await this.importFtpMetricHistory(JSON.parse(await file.text()));
          this.showToast('FTP estimate history saved for this rider and shown. Training FTP unchanged.', 'success');
        } catch (err) { this.showToast(err.message || 'Could not import FTP history.', 'error'); }
      });
      this.updateFtpMetricsChart();
    },
    async importFtpMetricHistory(input) {
      const id = this.activeProfileId, bundle = VeloFtpHistory.normalize(input, id);
      const key = VeloFtpHistory.key(id);
      if (!await VeloDB.putSetting({ key, bundle: VeloFtpHistory.exportBundle(bundle) })) throw new Error('FTP history could not be saved.');
      if (id !== this.activeProfileId) return;
      this._ftpMetricProfile = id; this._ftpMetricBundle = bundle; this._ftpMetricLoading = null;
      // A fresh import is what the rider wants to see.
      try { localStorage.setItem(SOURCE_KEY, 'import'); } catch (e) { /* not kept */ }
      const src = document.getElementById('ftpMetricsSource'); if (src) src.value = 'import';
      this.updateFtpMetricsChart();
    },
    async loadFtpMetricHistory(id) {
      this._ftpMetricLoading = id;
      try {
        const record = await VeloDB.getSetting(VeloFtpHistory.key(id));
        if (id !== this.activeProfileId || this._ftpMetricLoading !== id) return;
        this._ftpMetricBundle = record?.bundle ? VeloFtpHistory.normalize(record.bundle, id) : null;
      } catch (err) { if (id === this.activeProfileId) this._ftpMetricError = err.message; }
      finally {
        if (id === this.activeProfileId && this._ftpMetricLoading === id) {
          this._ftpMetricProfile = id; this._ftpMetricLoading = null; this.updateFtpMetricsChart();
          if (location.hash === '#ftp-metrics' && !this._ftpMetricsOpened) {
            this._ftpMetricsOpened = true; this.switchTab('analytics');
            if (this.showAnalyticsPanel) this.showAnalyticsPanel('ftp', { instant: true, remember: false });
            requestAnimationFrame(() => document.getElementById('ftpMetricsHistoryCard').scrollIntoView({ block: 'start' }));
          }
        }
      }
    },
    updateFtpMetricsChart() {
      const chart = this.ftpMetricsChart; if (!chart) return;
      const id = this.activeProfileId;
      if (this._ftpMetricProfile !== id) {
        this._ftpMetricBundle = null; this._ftpMetricError = null;
        if (this._ftpMetricLoading !== id) this.loadFtpMetricHistory(id);
      }
      const now = Date.now(), imported = this._ftpMetricBundle;
      const wrap = document.getElementById('ftpMetricsSourceWrap');
      if (wrap) wrap.hidden = !imported;
      const bundle = imported && this.ftpMetricSource() === 'import' ? imported : this.appFtpBundle();
      let start = this.anaRangeStart ? this.anaRangeStart(now) : now - 182 * 86400000;
      if (this.anaRange === 'all' && bundle) {
        // Only series that are actually drawn may widen the axis (not the preserved benchmark or hidden model series).
        for (const key of this._ftpMetricVisible) for (const p of bundle.series[key] || []) if (p.x < start) start = p.x;
      }
      const all = { ...(bundle?.series || {}), active: VeloFtpHistory.activeHistory(this.activeProfile, this.cyclingRides(), now) };
      const datasets = [], table = [];
      let bandLow = Infinity, bandHigh = -Infinity;
      for (const [key, m] of Object.entries(VeloFtpHistory.METRICS)) {
        if (!this._ftpMetricVisible.has(key)) continue;
        const points = VeloFtpHistory.inRange(all[key] || [], start, now, m.stepped);
        if (key === 'B') for (const p of points) if (p.y != null && p.low != null && p.high != null) { bandLow = Math.min(bandLow, p.low); bandHigh = Math.max(bandHigh, p.high); }
        datasets.push({ label: m.label, metric: key, data: points, borderColor: m.color, backgroundColor: m.color, borderWidth: 2,
          borderDash: m.dash || [], stepped: m.stepped ? 'after' : false, showLine: !m.points, pointStyle: m.points ? 'triangle' : 'circle',
          pointRadius: m.points ? 5 : 0, pointHoverRadius: m.points ? 7 : 5, pointHitRadius: m.points ? 8 : 1, spanGaps: false });
      }
      if (document.getElementById('ftpMetricsWorkoutDots').checked) {
        const dots = VeloFtpHistory.inRange(all.B || [], start, now).filter(p => p.workoutImplied != null).map(p => ({
          ...p, y: p.workoutImplied, low: null, high: null, reason: 'Single-workout estimate at the assumed threshold heart rate; not the history-based FTP estimate.'
        }));
        if (dots.length) datasets.push({ label: 'Workout-implied FTP', metric: 'workoutImplied', data: dots, showLine: false,
          borderColor: '#7cc8ff', backgroundColor: '#7cc8ff', pointRadius: 3, pointHoverRadius: 6, pointHitRadius: 8 });
      }
      for (const [key, m] of Object.entries(VeloFtpHistory.METRICS)) {
        VeloFtpHistory.inRange(all[key] || [], start, now, m.stepped).forEach(p => {
          if (p.y != null) table.push({ ...p, metric: m.label });
        });
      }
      document.getElementById('ftpMetricsActiveValue').textContent = `${Math.round(this.activeProfile.ftp)} W`;
      const estimate = (all.B || []).filter(p => p.y != null && p.x <= now).at(-1);
      document.getElementById('ftpMetricsEstimateValue').textContent = estimate ? `${Math.round(estimate.y)} W` : '—';
      document.getElementById('ftpMetricsEstimateRange').textContent = estimate?.low != null && estimate?.high != null
        ? `${estimate.low}–${estimate.high} W · conditional model range` : bundle && bundle.app ? 'No eligible workout yet' : 'No saved eligible estimate';
      const bandOn = document.getElementById('ftpMetricsBand').checked;
      chart.options.plugins.ftpBand = { enabled: bandOn, color: 'rgba(124,200,255,.13)' };
      // The band is painted outside the datasets, so make the Watts axis reach its edges while it is shown.
      chart.options.scales.y.suggestedMin = bandOn && Number.isFinite(bandLow) ? Math.floor(bandLow - 5) : undefined;
      chart.options.scales.y.suggestedMax = bandOn && Number.isFinite(bandHigh) ? Math.ceil(bandHigh + 5) : undefined;
      chart.data.datasets = datasets; chart.options.scales.x.min = start; chart.options.scales.x.max = now; chart.update('none');
      const status = document.getElementById('ftpMetricsStatus');
      if (!bundle) status.textContent = this._ftpMetricError || 'No rides with power yet: estimates appear after your first rides.';
      else if (bundle.app) {
        const st = bundle.stats || {}, thr = st.thr;
        status.textContent = `Calculated in the app from ${st.rides || 0} ride${st.rides === 1 ? '' : 's'} with power; ${st.hrRides || 0} gave a Power + Heart Rate reading. ` +
          (thr ? `Threshold heart rate ${thr.hr} bpm${thr.assumed ? ' (assumed: 90% of max HR - set your LTHR in the rider profile for a better reading)' : ' (your LTHR)'}. ` : 'Set max HR or LTHR in the rider profile for the Power + Heart Rate estimate. ') +
          'Experimental and uncalibrated: the app\'s own versions of the research models, so values differ from an imported history. Never changes training FTP.' +
          (imported ? ' An imported research history is available under Source.' : '');
      } else {
        const newer = this.cyclingRides().filter(r => Math.max(Date.parse(r.date) || 0, Number(r.completedAt) || 0) > bundle.asOf).length;
        const changed = !!bundle.context && ['maxHr', 'lthr', 'age'].some(k => {
          const n = Number(this.activeProfile[k]), current = Number.isFinite(n) && n > 0 ? n : null;
          return current !== bundle.context[k];
        });
        status.textContent = `Experimental saved calculations · snapshot ${new Date(bundle.asOf).toLocaleDateString('en-GB')}. ` +
          (newer ? `${newer} new workout${newer === 1 ? '' : 's'} since this snapshot: refresh the calculation history. ` : '') + (changed ? 'Profile inputs differ from the calculation snapshot. ' : '') + 'Imports never change training FTP.';
      }
      // Thousands of rows are only worth building while the supporting table is open.
      this._ftpMetricRows = table.sort((a, b) => b.x - a.x);
      if (document.getElementById('ftpMetricsDetails')?.open) this.renderFtpMetricsTable();
    },
    renderFtpMetricsTable() {
      const body = document.getElementById('ftpMetricsTable'); if (!body) return;
      const rows = document.createDocumentFragment();
      for (const p of this._ftpMetricRows || []) {
        const row = document.createElement('tr');
        [VeloFtpHistory.formatDate(p.x, p.dateOnly), p.metric, p.y.toFixed(1), p.low != null && p.high != null ? `${p.low}–${p.high}` : '—', p.title || p.reason || ''].forEach(value => {
          const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
        });
        rows.append(row);
      }
      body.replaceChildren(rows);
    }
  });
})();
