/**
 * APEX VELO // LAB - Ride review: power analysis (mixin on VeloApp).
 *
 * Analysis of one ride with second-by-second power:
 *  - stacked lanes (power + target + CP, W' balance, heart rate, cadence) sharing one time axis,
 *    with an exact per-second readout under the pointer (the drawing is decimated, the readout is not);
 *  - variability index, efficiency factor, work and time above CP, W' depletion, matches, TRIMP;
 *  - time in power and heart-rate zones, the ride's power curve against the 90 days before it,
 *    the power distribution and the pedalling quadrant analysis.
 * W' numbers use the CP model on the ride's date (90 days of best efforts, this ride included).
 */
(function () {
  const DAY = 86400000;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PDC_TICKS = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 3600, 7200, 14400];
  const PDC_TICKS_NARROW = [1, 10, 60, 300, 1200, 3600, 14400];
  const HR_ZONES = ['Z1 Recovery', 'Z2 Aerobic', 'Z3 Tempo', 'Z4 Threshold', 'Z5 Max'];
  const HR_SHADES = ['rgba(255,92,134,0.35)', 'rgba(255,92,134,0.5)', 'rgba(255,92,134,0.65)', 'rgba(255,92,134,0.82)', '#ff5c86'];
  const SURFACE = '#0d1424';

  Object.assign(VeloApp.prototype, {
    /** Analysis of one ride, computed once per review (memoised for the open ride). */
    rideAnalysis(record) {
      if (!VeloInsight.hasSamples(record) || !VeloMetrics.isCycling(record)) return null;
      const key = `${record.id}|${record.samples.length}|${this.historySignature()}|${(this.activeProfile || {}).maxHr}|${(this.activeProfile || {}).crankMm || ''}`;
      if (this._rideAnalysis && this._rideAnalysis.key === key) return this._rideAnalysis.A;
      const t = Date.parse(record.date);
      const at = Number.isFinite(t) ? t : Date.now();
      const p = this.activeProfile || {};
      const prep = VeloPower.prepare(record.samples);
      const model = this.powerModelAt(at);
      const m = model && model.ok ? model : null;
      const ftp = this.rideFtp(record);
      const A = {
        prep, ftp, model: m, modelReason: model ? model.reason : 'no-data',
        wb: m ? VeloPower.wbal(prep, m.cp, m.w) : null,
        metrics: VeloPower.rideMetrics(prep, { maxHr: Number(p.maxHr) || 0 }),
        qa: VeloPower.quadrants(prep, m ? m.cp : ftp, p.crankMm),
        qaRef: m ? 'CP' : 'FTP',
        curve: this.ridePower(record).curve,
        before: this.powerEnvelope(at - 90 * DAY, at - 1),
        zones: this.rideZoneSeconds(record)
      };
      this._rideAnalysis = { key, A };
      return A;
    },

    /** Power analysis block: VI, EF, work above CP, W' depletion, matches, TRIMP. */
    rideAdvancedHtml(record, A) {
      if (!A) return '';
      const np = Number(record.np) || 0, ap = Number(record.avgWatts) || 0;
      const vi = np > 0 && ap > 0 ? np / ap : null;
      const hrAvg = A.metrics && A.metrics.hrAvg;
      const ef = np > 0 && hrAvg ? np / hrAvg : null;
      const wb = A.wb, m = A.model;
      const cell = (lbl, val, sub, accent, term) => `<div class="metric-cell"${accent ? ` data-accent="${accent}"` : ''} title="${esc(VeloGlossary.tip(term))}"><span class="metric-cell-lbl">${lbl}${VeloGlossary.html(term)}</span><span class="metric-cell-val num">${val}</span><span class="metric-cell-sub">${sub}</span></div>`;
      const noModel = A.modelReason === 'coverage' ? 'needs a CP model (see Analytics)' : 'no CP model for this date';
      const cells = [
        cell('Variability (VI)', vi ? vi.toFixed(2) : '--', vi ? (vi <= 1.05 ? 'steady - evenly paced' : vi <= 1.15 ? 'moderately variable' : 'very variable (intervals, surges)') : 'NP / average power', 'cyan', 'vi'),
        cell('Efficiency (EF)', ef ? ef.toFixed(2) : '--', ef ? `W per bpm - NP ${np} W / ${hrAvg} bpm` : 'needs heart rate', 'lime', 'ef'),
        cell('Work above CP', wb ? `${wb.aboveKj} kJ` : '--', wb ? `${this.fmtTime(wb.aboveSec)} above ${m.cp} W` : noModel, 'amber', 'aboveCp'),
        cell('W&prime; low point', wb ? `${(wb.maxDepletion / 1000).toFixed(1)} kJ` : '--', wb ? `${wb.maxDepletionPct}% of ${(m.w / 1000).toFixed(1)} kJ at ${this.fmtTime(A.prep.time[wb.minAt] || wb.minAt)}` : noModel, 'violet', 'wdepl'),
        cell('Matches', wb ? String(wb.matches) : '--', wb ? 'W&prime; drops of 2 kJ or more' : noModel, 'rose', 'matches'),
        cell('TRIMP', A.metrics && A.metrics.trimp !== null ? String(A.metrics.trimp) : '--', A.metrics && A.metrics.trimp !== null ? 'Edwards: HR-zone minutes x 1-5' : 'needs heart rate and max HR', '', 'trimp')
      ];
      const negative = wb && wb.min < -1000;
      return `
        <div class="review-block">
          <div class="sub-title"><span>Power analysis<span class="plain">How the ride used your limits</span></span><span class="hint num">${m ? `CP ${m.cp} W &middot; W&prime; ${(m.w / 1000).toFixed(1)} kJ &middot; model on the ride date` : 'W&prime; analysis needs a CP model from the 90 days up to this ride'}</span></div>
          <div class="ride-adv-grid">${cells.join('')}</div>
          ${negative ? `<p class="footnote warn-note">W&prime; balance went to ${(wb.min / 1000).toFixed(1)} kJ: this ride beat the model, so CP or W&prime; are probably higher than it says. The model updates as more best efforts land in the 90-day window.</p>` : ''}
        </div>`;
    },

    /** Lanes chart holder (power, W' balance, heart rate, cadence). */
    rideLanesHtml(A) {
      const lanes = 1 + (A && A.wb ? 1 : 0) + (A && A.metrics && A.metrics.hrSeconds ? 1 : 0) + (A && A.prep.cad.some(c => c > 0) ? 1 : 0);
      const h = 160 + lanes * 72;
      return `
        <div class="review-block inspector-chart-box">
          <div class="sub-title"><span>Ride plot${VeloGlossary.html('ridePlot')}</span><span id="scrubReadout" class="hint num">Point at the chart to read every channel second by second</span></div>
          <div class="chart-box" style="height:${h}px;"><canvas id="rideScrubCanvas" aria-label="Ride plot: power, W prime balance, heart rate and cadence over time"></canvas></div>
        </div>`;
    },

    /** Time in power zones and heart-rate zones as labelled bars. */
    rideZonesHtml(record, A) {
      const zs = A && A.zones;
      if (!zs) return '';
      const tot = Math.max(1, zs.reduce((a, b) => a + b, 0));
      const maxZ = Math.max(1, ...zs);
      const row = (color, short, name, sec, pct, rel) => `
        <div class="zd-row compact"><span class="zd-lbl"><i style="background:${color}"></i><b>${short}</b><span>${esc(name)}</span></span>
        <span class="zd-bar"><span style="width:${(rel * 100).toFixed(1)}%;background:${color}"></span></span>
        <span class="zd-val num">${this.fmtTime(sec)}</span><span class="zd-pct num">${pct}%</span></div>`;
      const power = VeloMetrics.ZONES.map((Z, i) => row(Z.color, Z.short, Z.name, zs[i], Math.round((zs[i] / tot) * 100), zs[i] / maxZ)).join('');
      const hz = A.metrics && A.metrics.hrZones;
      let hr = '<div class="mix-note">No heart rate recorded on this ride.</div>';
      if (hz) {
        const ht = Math.max(1, hz.reduce((a, b) => a + b, 0)), hm = Math.max(1, ...hz);
        hr = hz.map((v, i) => row(HR_SHADES[i], HR_ZONES[i].slice(0, 2), HR_ZONES[i].slice(3), v, Math.round((v / ht) * 100), v / hm)).join('');
      } else if (A.metrics && A.metrics.hrSeconds) hr = '<div class="mix-note">Set your max heart rate in the rider profile to see heart-rate zones.</div>';
      return `
        <div class="review-block">
          <div class="sub-title"><span>Time in zones${VeloGlossary.html('zones')}</span><span class="hint num">FTP ${A.ftp} W${(this.activeProfile || {}).maxHr ? ` &middot; max HR ${this.activeProfile.maxHr} bpm` : ''}</span></div>
          <div class="review-two">
            <div><div class="mini-title">Power</div><div class="zone-dist">${power}</div></div>
            <div><div class="mini-title">Heart rate</div><div class="zone-dist">${hr}</div></div>
          </div>
        </div>`;
    },

    /** Ride power curve, power distribution and the quadrant analysis (charts drawn after the modal opens). */
    rideChartsHtml(A) {
      if (!A) return '';
      const qa = A.qa;
      const quad = (cls, name, pct, say) => `<div class="qa-quad ${cls}"><b class="num">${pct}%</b><span>${name}</span><small>${say}</small></div>`;
      return `
        <div class="review-two">
          <div class="review-block">
            <div class="sub-title"><span>Ride power curve${VeloGlossary.html('rideCurve')}</span><span class="hint">vs your best of the 90 days before</span></div>
            <div class="chart-box" style="height:230px;"><canvas id="rideMmpCanvas" aria-label="This ride's power duration curve"></canvas></div>
          </div>
          <div class="review-block">
            <div class="sub-title"><span>Power distribution${VeloGlossary.html('hist')}</span><span class="hint">time per 25 W band, coloured by zone</span></div>
            <div class="chart-box" style="height:230px;"><canvas id="rideHistCanvas" aria-label="Power distribution histogram"></canvas></div>
          </div>
        </div>
        ${qa ? `
        <div class="review-block">
          <div class="sub-title"><span>Pedalling &middot; quadrant analysis${VeloGlossary.html('qa')}</span><span class="hint num">split at ${A.qaRef} ${A.model ? A.model.cp : A.ftp} W and your average ${qa.refCad} rpm &middot; crank ${qa.crankMm} mm</span></div>
          <div class="qa-grid">
            <div class="chart-box" style="height:280px;"><canvas id="rideQaCanvas" aria-label="Quadrant analysis: pedal force against pedal speed"></canvas></div>
            <div class="qa-quads">
              ${quad('q2', 'QII &middot; high force, low speed', qa.pct[1], 'Grinding a big gear: climbing seated, low-cadence drills, hard starts.')}
              ${quad('q1', 'QI &middot; high force, high speed', qa.pct[0], 'Sprints and attacks - the most demanding pedalling.')}
              ${quad('q3', 'QIII &middot; low force, low speed', qa.pct[2], 'Easy riding and recovery.')}
              ${quad('q4', 'QIV &middot; low force, high speed', qa.pct[3], 'Spinning: high-cadence endurance and cadence drills.')}
            </div>
          </div>
          <p class="footnote">Each dot is one pedalling second: pedal speed (cadence x crank length) against the average force on the pedals (power / pedal speed). The curve is every force-speed pair that makes ${A.model ? A.model.cp : A.ftp} W. Set your crank length in the rider profile.</p>
        </div>` : ''}`;
    },

    destroyReviewCharts() {
      (this._reviewCharts || []).forEach(c => { try { c.destroy(); } catch (e) { /* already gone */ } });
      this._reviewCharts = [];
    },

    /** Creates every review chart for the open ride. */
    initRideReviewCharts(record) {
      const A = this.rideAnalysis(record);
      if (!A || typeof Chart === 'undefined') return;
      this.destroyReviewCharts();
      this.initRideLanes(A);
      const { VIZ, INK, axis } = VeloApp.CHART;
      const charts = this._reviewCharts;
      const G = VeloPower.GRID;
      const pts = (arr) => (arr ? G.map((t, i) => (arr[i] > 0 ? { x: t, y: arr[i] } : null)).filter(Boolean) : []);
      const mmpCanvas = document.getElementById('rideMmpCanvas');
      if (mmpCanvas) {
        const longest = (() => { let L = 0; A.curve.forEach((v, i) => { if (v > 0) L = G[i]; }); return L; })();
        const modelX = G.filter(t => t <= Math.min(3600, Math.max(60, longest)));
        charts.push(new Chart(mmpCanvas.getContext('2d'), {
          type: 'line',
          data: { datasets: [
            { label: 'This ride', data: pts(A.curve), borderColor: VIZ.cyan, backgroundColor: 'rgba(8,145,178,0.16)', fill: 'start', borderWidth: 2.4, tension: 0.25, pointRadius: 0, pointHitRadius: 10 },
            { label: 'Best of the 90 days before', data: pts(A.before.watts).filter(p => p.x <= longest), borderColor: VIZ.violet, borderWidth: 1.6, tension: 0.25, pointRadius: 0, pointHitRadius: 10 },
            ...(A.model ? [{ label: 'CP model', data: modelX.map(t => ({ x: t, y: Math.round(VeloPower.model(t, A.model)) })), borderColor: VIZ.amber, borderWidth: 1.4, borderDash: [7, 4], tension: 0, pointRadius: 0, pointHitRadius: 10 }] : [])
          ] },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'nearest', axis: 'x', intersect: false },
            scales: {
              x: axis({ type: 'logarithmic', min: 1, max: Math.max(60, longest), afterBuildTicks: (ax) => { ax.ticks = (ax.width < 520 ? PDC_TICKS_NARROW : PDC_TICKS).filter(v => v >= ax.min && v <= ax.max).map(v => ({ value: v })); }, ticks: { color: INK.muted, autoSkip: false, maxRotation: 0, callback: (v) => VeloPower.durLabel(v) } }),
              y: axis({ grace: '5%', title: { display: true, text: 'W', color: INK.muted } })
            },
            plugins: {
              legend: { display: true, position: 'top', align: 'end', labels: { color: INK.secondary, boxWidth: 10, boxHeight: 10, padding: 10 } },
              tooltip: { callbacks: { title: (items) => `Best ${VeloPower.durLabel(items[0].parsed.x)}`, label: (c) => ` ${c.dataset.label}: ${c.parsed.y} W` } }
            }
          }
        }));
      }
      const histCanvas = document.getElementById('rideHistCanvas');
      if (histCanvas && A.metrics) {
        const { bin, counts } = A.metrics.hist;
        let last = counts.length - 1;
        while (last > 0 && counts[last] < 5) last--;
        const rows = counts.slice(0, last + 1);
        charts.push(new Chart(histCanvas.getContext('2d'), {
          type: 'bar',
          data: {
            labels: rows.map((_, i) => String(i * bin)),
            datasets: [{ label: 'Time', data: rows.map(v => Math.round((v / 60) * 10) / 10), backgroundColor: rows.map((_, i) => VeloMetrics.zoneForPct(A.ftp ? (((i + 0.5) * bin) / A.ftp) * 100 : 0).color), borderColor: SURFACE, borderWidth: { left: 1, right: 1, top: 0, bottom: 0 }, borderSkipped: false, borderRadius: { topLeft: 3, topRight: 3 }, categoryPercentage: 1, barPercentage: 1 }]
          },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            scales: {
              x: axis({ grid: { display: false }, ticks: { color: INK.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, title: { display: true, text: 'W', color: INK.muted } }),
              y: axis({ beginAtZero: true, title: { display: true, text: 'min', color: INK.muted } })
            },
            plugins: { tooltip: { callbacks: {
              title: (items) => { const lo = items[0].dataIndex * bin; return `${lo}-${lo + bin - 1} W`; },
              label: (c) => { const lo = c.dataIndex * bin; const z = VeloMetrics.zoneForPct(A.ftp ? ((lo + bin / 2) / A.ftp) * 100 : 0); return ` ${c.parsed.y} min - ${z.short} ${z.name}`; }
            } } }
          }
        }));
      }
      const qaCanvas = document.getElementById('rideQaCanvas');
      if (qaCanvas && A.qa) {
        const qa = A.qa, ref = A.model ? A.model.cp : A.ftp;
        const maxX = Math.max(qa.refCpv * 1.6, ...qa.points.map(p => p.x)) * 1.02;
        const iso = Array.from({ length: 40 }, (_, i) => { const x = qa.refCpv * 0.45 + ((maxX - qa.refCpv * 0.45) * i) / 39; return { x: Math.round(x * 1000) / 1000, y: Math.round((ref / x) * 10) / 10 }; });
        const maxY = Math.max(qa.refAepf * 1.8, ...qa.points.map(p => p.y)) * 1.05;
        const refLines = {
          id: 'qaRefs',
          beforeDatasetsDraw(chart) {
            const { x, y } = chart.scales, a = chart.chartArea, c = chart.ctx;
            c.save(); c.strokeStyle = 'rgba(148,163,184,0.45)'; c.lineWidth = 1; c.setLineDash([4, 4]);
            const px = x.getPixelForValue(qa.refCpv), py = y.getPixelForValue(qa.refAepf);
            c.beginPath(); c.moveTo(px, a.top); c.lineTo(px, a.bottom); c.moveTo(a.left, py); c.lineTo(a.right, py); c.stroke();
            c.setLineDash([]); c.fillStyle = 'rgba(154,167,189,0.85)'; c.font = '600 10.5px Inter, system-ui, sans-serif';
            c.fillText('QII', a.left + 6, a.top + 14); c.fillText('QI', a.right - 22, a.top + 14); c.fillText('QIII', a.left + 6, a.bottom - 6); c.fillText('QIV', a.right - 28, a.bottom - 6);
            c.restore();
          }
        };
        charts.push(new Chart(qaCanvas.getContext('2d'), {
          type: 'scatter',
          data: { datasets: [
            { label: 'Pedalling seconds', data: qa.points, pointRadius: 1.6, pointHoverRadius: 3, backgroundColor: 'rgba(8,145,178,0.35)', borderWidth: 0 },
            { label: `${ref} W`, type: 'line', data: iso, borderColor: VIZ.amber, borderWidth: 1.5, borderDash: [7, 4], pointRadius: 0, tension: 0.3 }
          ] },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            scales: {
              x: axis({ type: 'linear', min: 0, max: Math.round(maxX * 100) / 100, title: { display: true, text: 'Pedal speed (m/s)', color: INK.muted } }),
              y: axis({ min: 0, max: Math.round(maxY), title: { display: true, text: 'Pedal force (N)', color: INK.muted } })
            },
            plugins: {
              legend: { display: true, position: 'top', align: 'end', labels: { color: INK.secondary, boxWidth: 10, boxHeight: 10, padding: 10 } },
              tooltip: { callbacks: { label: (c) => c.datasetIndex === 0 ? ` ${c.parsed.x.toFixed(2)} m/s (${Math.round((c.parsed.x * 60) / (2 * Math.PI * (qa.crankMm / 1000)))} rpm), ${c.parsed.y} N - ${Math.round(c.parsed.x * c.parsed.y)} W` : ` ${ref} W at ${c.parsed.x.toFixed(2)} m/s needs ${c.parsed.y} N` } }
            }
          },
          plugins: [refLines]
        }));
      }
    },

    /**
     * Ride plot: lanes stacked on one time axis. The drawing is decimated (min-max keeps the peaks);
     * the readout reads the exact second from the 1 Hz arrays.
     */
    initRideLanes(A) {
      const canvas = document.getElementById('rideScrubCanvas');
      if (!canvas) return;
      const { VIZ, INK, axis } = VeloApp.CHART;
      const prep = A.prep, n = prep.n, wb = A.wb, m = A.model;
      const hasHr = !!(A.metrics && A.metrics.hrSeconds);
      const hasCad = prep.cad.some(c => c > 0);
      const hasTarget = prep.target.some(t => t > 0);
      // Missing readings are NaN, not null: Chart.js skips NaN when sizing an axis (null counts as 0).
      const series = (arr, keepZero = true) => { const out = new Array(n); for (let i = 0; i < n; i++) { const v = arr[i]; out[i] = { x: prep.time[i], y: keepZero || v > 0 ? Math.round(v * 10) / 10 : NaN }; } return out; };
      const range = (arr, positiveOnly) => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) { const v = arr[i]; if (positiveOnly && !(v > 0)) continue; if (v < lo) lo = v; if (v > hi) hi = v; } return [lo, hi]; };
      const lane = (weight, extra = {}) => axis({ stack: 'ride', stackWeight: weight, offset: true, position: 'left', ...extra });
      // Lanes are declared bottom-up: Chart.js stacks the first-declared axis at the bottom.
      const scales = {
        x: axis({ type: 'linear', min: prep.time[0], max: prep.time[n - 1], ticks: { color: INK.muted, maxTicksLimit: 9, maxRotation: 0, callback: (v) => this.fmtTime(v) } })
      };
      if (hasCad) { const [, hi] = range(prep.cad, true); scales.yC = lane(1, { min: 0, max: Math.max(100, Math.ceil(hi / 20) * 20), ticks: { color: INK.muted, maxTicksLimit: 3 }, title: { display: true, text: 'rpm', color: INK.muted } }); }
      if (hasHr) { const [lo, hi] = range(prep.hr, true); scales.yH = lane(1.2, { min: Math.max(0, Math.floor((lo - 5) / 10) * 10), max: Math.ceil((hi + 5) / 10) * 10, ticks: { color: INK.muted, maxTicksLimit: 3 }, title: { display: true, text: 'bpm', color: INK.muted } }); }
      if (wb) scales.yW = lane(1.3, { min: Math.min(0, Math.floor(wb.min / 1000)), max: Math.ceil(m.w / 1000), ticks: { color: INK.muted, maxTicksLimit: 3 }, title: { display: true, text: 'W′ kJ', color: INK.muted } });
      const [, pHi] = range(prep.power, false);
      scales.yP = lane(3, { min: 0, max: Math.max(100, Math.ceil((pHi * 1.04) / 50) * 50), ticks: { color: INK.muted, maxTicksLimit: 5 }, title: { display: true, text: 'W', color: INK.muted } });
      const datasets = [
        { label: 'Power', data: series(prep.power), borderColor: VIZ.cyan, backgroundColor: 'rgba(8,145,178,0.16)', fill: 'origin', borderWidth: 1.2, yAxisID: 'yP' }
      ];
      if (hasTarget) datasets.push({ label: 'Target', data: series(prep.target, false), borderColor: 'rgba(230,237,247,0.5)', borderWidth: 1, borderDash: [4, 4], stepped: true, spanGaps: false, yAxisID: 'yP' });
      if (wb) {
        const bal = new Array(n);
        for (let i = 0; i < n; i++) bal[i] = { x: prep.time[i], y: Math.round(wb.bal[i] / 100) / 10 };
        datasets.push({ label: 'W′ balance', data: bal, borderColor: VIZ.violet, backgroundColor: 'rgba(124,58,237,0.18)', fill: 'origin', borderWidth: 1.4, yAxisID: 'yW' });
      }
      if (hasHr) datasets.push({ label: 'Heart rate', data: series(prep.hr, false), borderColor: VIZ.rose, borderWidth: 1.3, spanGaps: 5, yAxisID: 'yH' });
      if (hasCad) datasets.push({ label: 'Cadence', data: series(prep.cad), borderColor: '#65a30d', borderWidth: 1, yAxisID: 'yC' });
      const self = this;
      const overlay = {
        id: 'rideOverlay',
        afterDatasetsDraw(chart) {
          const c = chart.ctx, a = chart.chartArea, yP = chart.scales.yP;
          c.save();
          if (m && yP) {
            const y = yP.getPixelForValue(m.cp);
            if (y > yP.top && y < yP.bottom) {
              c.strokeStyle = VIZ.amber; c.lineWidth = 1; c.setLineDash([7, 4]);
              c.beginPath(); c.moveTo(a.left, y); c.lineTo(a.right, y); c.stroke(); c.setLineDash([]);
              c.fillStyle = '#e6edf7'; c.font = '600 10.5px Inter, system-ui, sans-serif';
              c.fillText(`CP ${m.cp} W`, a.right - 64, y - 4);
            }
          }
          if (self._laneHover !== null && self._laneHover !== undefined) {
            const x = chart.scales.x.getPixelForValue(self._laneHover);
            if (x >= a.left && x <= a.right) { c.strokeStyle = 'rgba(230,237,247,0.4)'; c.lineWidth = 1; c.beginPath(); c.moveTo(x, a.top); c.lineTo(x, a.bottom); c.stroke(); }
          }
          c.restore();
        }
      };
      this._laneHover = null;
      const readout = (evt, chart) => {
        if (!evt || !chart.chartArea || evt.x < chart.chartArea.left || evt.x > chart.chartArea.right) return;
        const t = chart.scales.x.getValueForPixel(evt.x);
        let lo = 0, hi = n - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (prep.time[mid] < t) lo = mid + 1; else hi = mid; }
        const i = lo > 0 && Math.abs(prep.time[lo - 1] - t) < Math.abs(prep.time[lo] - t) ? lo - 1 : lo;
        this._laneHover = prep.time[i];
        const parts = [this.fmtTime(prep.time[i]), `${Math.round(prep.power[i])} W${prep.target[i] > 0 ? ` (target ${Math.round(prep.target[i])})` : ''}`];
        if (wb) parts.push(`W′ ${(wb.bal[i] / 1000).toFixed(1)} kJ`);
        if (hasHr) parts.push(prep.hr[i] > 0 ? `${Math.round(prep.hr[i])} bpm` : '-- bpm');
        if (hasCad) parts.push(`${Math.round(prep.cad[i])} rpm`);
        const ro = document.getElementById('scrubReadout');
        if (ro) ro.textContent = parts.join(' · ');
        chart.draw();
      };
      this.currentScrubChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { datasets },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false, normalized: true, parsing: false,
          elements: { point: { radius: 0, hoverRadius: 0 }, line: { tension: 0 } },
          events: ['mousemove', 'mouseout', 'touchstart', 'touchmove'],
          onHover: (evt, els, chart) => readout(evt, chart),
          scales,
          plugins: {
            decimation: { enabled: true, algorithm: 'min-max' },
            legend: { display: true, position: 'top', align: 'end', labels: { color: INK.secondary, boxWidth: 10, boxHeight: 10, padding: 12 } },
            tooltip: { enabled: false }
          }
        },
        plugins: [overlay]
      });
    }
  });
})();
