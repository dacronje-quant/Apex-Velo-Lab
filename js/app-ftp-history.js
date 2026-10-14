/* Analytics view of saved model runs. Calculations remain separate from settings. */
(function () {
  Object.assign(VeloApp.prototype, {
    initFtpMetricsChart() {
      const canvas = document.getElementById('ftpMetricsHistoryCanvas');
      if (!canvas || typeof Chart === 'undefined') return;
      const { INK, axis } = VeloApp.CHART;
      const controls = document.getElementById('ftpMetricsControls');
      this._ftpMetricVisible = new Set(Object.entries(VeloFtpHistory.METRICS).filter(([, v]) => v.main).map(([k]) => k));
      controls.replaceChildren(...Object.entries(VeloFtpHistory.METRICS).filter(([, m]) => m.main).map(([key, m]) => {
        const label = document.createElement('label'), input = document.createElement('input'), dot = document.createElement('i');
        input.type = 'checkbox'; input.checked = this._ftpMetricVisible.has(key); input.dataset.ftpMetric = key;
        input.addEventListener('change', () => { if (input.checked) this._ftpMetricVisible.add(key); else this._ftpMetricVisible.delete(key); this.updateFtpMetricsChart(); });
        dot.style.backgroundColor = m.color; label.append(input, dot, document.createTextNode(m.label)); return label;
      }));
      this.ftpMetricsChart = new Chart(canvas, { type: 'line', data: { datasets: [] }, options: {
        responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
        interaction: { mode: 'nearest', intersect: false },
        scales: { x: axis({ type: 'linear', ticks: { maxTicksLimit: 7, maxRotation: 0, callback: v => new Date(v).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) } }),
          y: axis({ title: { display: true, text: 'Watts', color: INK.muted } }) },
        plugins: { legend: { display: false }, tooltip: { filter: item => !item.dataset.band,
          callbacks: { title: items => { const p = items[0]?.raw; return p ? new Date(p.x).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + (p.dateOnly ? ' · date only' : '') : ''; },
            label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)} W`,
            afterLabel: c => { const p = c.raw, lines = []; if (p.low != null && p.high != null) lines.push(`${p.low}–${p.high} W · ${p.rangeKind || 'conditional model range'}`); if (p.title) lines.push(p.title); if (p.reason) lines.push(p.reason); return lines; } } } }
      } });
      document.getElementById('ftpMetricsBand').addEventListener('change', () => this.updateFtpMetricsChart());
      document.getElementById('ftpMetricsWorkoutDots').addEventListener('change', () => this.updateFtpMetricsChart());
      document.getElementById('btnImportFtpMetrics').addEventListener('click', () => document.getElementById('ftpMetricsFile').click());
      document.getElementById('ftpMetricsFile').addEventListener('change', async e => {
        const file = e.target.files[0]; e.target.value = ''; if (!file) return;
        try {
          if (file.size > 5 * 1024 * 1024) throw new Error('Choose an FTP history export smaller than 5 MB.');
          await this.importFtpMetricHistory(JSON.parse(await file.text()));
          this.showToast('FTP estimate history saved for this rider. Training FTP unchanged.', 'success');
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
      const now = Date.now(), bundle = this._ftpMetricBundle;
      let start = this.anaRangeStart ? this.anaRangeStart(now) : now - 182 * 86400000;
      if (this.anaRange === 'all' && bundle) {
        const dates = Object.values(bundle.series).flat().map(p => p.x); if (dates.length) start = Math.min(start, ...dates);
      }
      const all = { ...(bundle?.series || {}), active: VeloFtpHistory.activeHistory(this.activeProfile, this.cyclingRides(), now) };
      const datasets = [], table = [];
      const bandKey = document.getElementById('ftpMetricsBand').checked ? 'B' : '';
      for (const [key, m] of Object.entries(VeloFtpHistory.METRICS)) {
        if (!this._ftpMetricVisible.has(key)) continue;
        const points = VeloFtpHistory.inRange(all[key] || [], start, now, m.stepped);
        if (key === bandKey) {
          const bounds = points.map(p => ({ x: p.x, y: p.y != null && p.low != null && p.high != null ? p.low : null }));
          const lowerIndex = datasets.length;
          datasets.push({ label: m.label + ' range lower', band: true, data: bounds, borderWidth: 0, pointRadius: 0, spanGaps: false });
          datasets.push({ label: m.label + ' range upper', band: true, data: points.map(p => ({ x: p.x, y: p.y != null && p.low != null && p.high != null ? p.high : null })),
            fill: { target: lowerIndex }, backgroundColor: key === 'B' ? 'rgba(124,200,255,.13)' : 'rgba(177,153,255,.13)', borderWidth: 0, pointRadius: 0, spanGaps: false });
        }
        datasets.push({ label: m.label, metric: key, data: points, borderColor: m.color, backgroundColor: m.color, borderWidth: 2,
          borderDash: m.dash || [], stepped: m.stepped ? 'after' : false, showLine: !m.points, pointStyle: m.points ? 'triangle' : 'circle',
          pointRadius: 0, pointHoverRadius: 5, spanGaps: false });
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
        ? `${estimate.low}–${estimate.high} W · conditional model range` : 'No saved eligible estimate';
      chart.data.datasets = datasets; chart.options.scales.x.min = start; chart.options.scales.x.max = now; chart.update('none');
      const status = document.getElementById('ftpMetricsStatus');
      if (!bundle) status.textContent = this._ftpMetricError || (this._ftpMetricLoading ? 'Loading saved calculation history…' : 'No saved model history for this rider. Import a calculation history to show estimated FTP.');
      else {
        const newer = this.cyclingRides().some(r => Math.max(Date.parse(r.date) || 0, Number(r.completedAt) || 0) > bundle.asOf);
        const changed = ['maxHr', 'lthr', 'age'].some(k => {
          const n = Number(this.activeProfile[k]), current = Number.isFinite(n) && n > 0 ? n : null;
          return current !== bundle.context[k];
        });
        status.textContent = `Experimental saved calculations · snapshot ${new Date(bundle.asOf).toLocaleDateString('en-GB')}. ` +
          (newer ? 'New workouts since this snapshot: refresh the calculation history. ' : '') + (changed ? 'Profile inputs differ from the calculation snapshot. ' : '') + 'Imports never change training FTP.';
      }
      const body = document.getElementById('ftpMetricsTable'); body.replaceChildren();
      table.sort((a, b) => b.x - a.x).forEach(p => {
        const row = document.createElement('tr');
        [new Date(p.x).toLocaleDateString('en-GB'), p.metric, p.y.toFixed(1), p.low != null && p.high != null ? `${p.low}–${p.high}` : '—', p.title || p.reason || ''].forEach(value => {
          const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
        }); body.append(row);
      });
    }
  });
})();
