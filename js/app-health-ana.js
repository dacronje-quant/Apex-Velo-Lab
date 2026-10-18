/**
 * APEX VELO // LAB - Analytics > Health (mixin on VeloApp).
 *
 * Every daily health value over the page range: tiles (latest, 30-day average and the change from the
 * 30 days before), resting and sleeping heart rate, HRV against its personal normal range, both HRV
 * kinds, sleep stages per night, the sync app's sleep and readiness scores, Baevsky stress index,
 * breathing and SpO2, body, steps, blood pressure / glucose / food, and how next-morning HRV, resting
 * HR and sleep answer the previous day's training. Cards and series without data stay hidden.
 * The numbers come from js/velo-wellness.js; the charts follow the conventions of app-dashboard.js.
 */
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAY = 86400000;
  const W = () => VeloWellness;
  const alpha = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
  const dayLabel = (t) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const shortDay = (day) => new Date(day + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  /**
   * Line cards: each lane is one y scale (stacked lanes share the time axis, never one plot), each
   * series one metric. Colours follow the metric, not its position, so hiding one never repaints another.
   */
  const LINE_CARDS = [
    { card: 'anaCardHealthHr', canvas: 'healthHrCanvas', lanes: [{ unit: 'bpm', series: [['rhr', 'rose'], ['sleepHr', 'amber']] }] },
    { card: 'anaCardHealthHrvBoth', canvas: 'healthHrvBothCanvas', needAll: true, dots: false, lanes: [{ unit: 'ms', series: [['hrvRmssd', 'violet'], ['hrvSdnn', 'cyan']] }] },
    { card: 'anaCardHealthScores', canvas: 'healthScoresCanvas', lanes: [{ unit: 'score', min: 0, max: 100, series: [['sleepScore', 'cyan'], ['icuReadiness', 'lime']] }] },
    { card: 'anaCardHealthStress', canvas: 'healthStressCanvas', lanes: [{ unit: 'SI', series: [['baevsky', 'amber']] }] },
    { card: 'anaCardHealthBreath', canvas: 'healthBreathCanvas', lanes: [{ unit: 'br/min', series: [['resp', 'cyan']] }, { unit: '%', series: [['spo2', 'rose']] }] },
    { card: 'anaCardHealthBody', canvas: 'healthBodyCanvas', lanes: [{ unit: 'kg', series: [['weight', 'cyan']] }, { unit: '%', series: [['bodyFat', 'amber']] }, { unit: 'ml/kg/min', series: [['vo2max', 'lime']] }] },
    { card: 'anaCardHealthVitals', canvas: 'healthVitalsCanvas', lanes: [{ unit: 'mmHg', series: [['bpSys', 'rose'], ['bpDia', 'violet']] }, { unit: 'mmol/L', series: [['glucose', 'amber']] }, { unit: 'kcal', series: [['kcalIn', 'lime']] }] }
  ];
  /** Tiles in this order, for whichever metrics have data. */
  const TILE_KEYS = ['rhr', 'sleepHr', 'hrvRmssd', 'hrvSdnn', 'sleepH', 'deepH', 'remH', 'coreH', 'sleepScore', 'icuReadiness', 'baevsky', 'resp', 'spo2', 'weight', 'bodyFat', 'vo2max', 'steps', 'bpSys', 'glucose'];
  const TILE_SPOT = { rhr: 'anaCardHealthHr', sleepHr: 'anaCardHealthHr', hrvRmssd: 'anaCardHealthHrv', hrvSdnn: 'anaCardHealthHrv', sleepH: 'anaCardHealthSleep', deepH: 'anaCardHealthSleep', remH: 'anaCardHealthSleep', coreH: 'anaCardHealthSleep', sleepScore: 'anaCardHealthScores', icuReadiness: 'anaCardHealthScores', baevsky: 'anaCardHealthStress', resp: 'anaCardHealthBreath', spo2: 'anaCardHealthBreath', weight: 'anaCardHealthBody', bodyFat: 'anaCardHealthBody', vo2max: 'anaCardHealthBody', steps: 'anaCardHealthSteps', bpSys: 'anaCardHealthVitals', glucose: 'anaCardHealthVitals' };
  const TILE_COLOR = { rhr: 'rose', sleepHr: 'amber', hrvRmssd: 'violet', hrvSdnn: 'cyan', sleepH: 'violet', deepH: 'violet', remH: 'amber', coreH: 'cyan', sleepScore: 'cyan', icuReadiness: 'lime', baevsky: 'amber', resp: 'cyan', spo2: 'rose', weight: 'cyan', bodyFat: 'amber', vo2max: 'lime', steps: 'lime', bpSys: 'rose', glucose: 'amber' };
  const STAGES = [['deepH', 'Deep', 'violet'], ['coreH', 'Light (core)', 'cyan'], ['remH', 'REM', 'amber'], ['awakeH', 'Awake', 'grey']];

  const base = VeloApp.prototype.renderDashboard;

  Object.assign(VeloApp.prototype, {
    renderDashboard(...args) {
      const r = base ? base.apply(this, args) : undefined;
      this.renderHealthAnalytics();
      return r;
    },

    /** The whole Health module for the current page range. */
    renderHealthAnalytics() {
      const panel = document.getElementById('ana-panel-health');
      if (!panel || typeof VeloWellness === 'undefined') return;
      const all = this.healthDays || [];
      const now = Date.now();
      const today = this.localDayKey ? this.localDayKey(new Date()) : new Date().toISOString().slice(0, 10);
      const start = this.anaRangeStart ? this.anaRangeStart(now) : now - 182 * DAY;
      const from = this.localDayKey ? this.localDayKey(new Date(start)) : new Date(start).toISOString().slice(0, 10);
      const days = all.filter(d => d.day >= from && d.day <= today);
      const range = { from, to: today, x0: new Date(from + 'T00:00:00').getTime(), x1: new Date(today + 'T23:59:59').getTime(), days: Math.max(1, Math.round((now - start) / DAY)) };
      this._healthRange = range;

      const empty = document.getElementById('anaHealthEmpty');
      if (empty) {
        empty.hidden = days.length > 0;
        this.setText('anaHealthEmptyText', all.length
          ? 'No health days in this time range. Pick a longer range above.'
          : document.documentElement.classList.contains('apex-native')
            ? 'Add your intervals.icu API key in Settings > Health: resting HR, HRV, sleep and the rest of your wellness data appear here.'
            : 'Set up Apple Health in Settings: resting HR, HRV and sleep appear here.');
      }
      this.renderHealthTiles(all, today);
      for (const spec of LINE_CARDS) this.renderHealthLineCard(spec, all, days, range);
      this.renderHealthHrvCard(all, days, range);
      this.renderHealthSleepCard(days, range);
      this.renderHealthStepsCard(days, range);
      this.renderHealthLoadCard(all, range);
      this.renderHealthModStat(all, today);
    },

    /** Latest value, 30-day average and change vs the 30 days before, for each metric with data. */
    renderHealthTiles(all, today) {
      const el = document.getElementById('anaHealthTiles');
      if (!el) return;
      const Wl = W();
      const tiles = TILE_KEYS.map(k => ({ m: Wl.BY_KEY[k], s: Wl.stats(all, k, today, 30) })).filter(t => t.s && t.s.n);
      el.hidden = !tiles.length;
      el.innerHTML = tiles.map(({ m, s }) => {
        const delta = s.prev !== null ? s.avg - s.prev : null;
        const unit = m.unit === 'h' || m.unit.length > 6 ? '' : m.unit; // long units go in the line below
        const step = m.fmt === 'h' ? 0.05 : m.dec === 1 ? 0.1 : 1;
        const moved = delta !== null && Math.abs(delta) >= step;
        const tone = !moved || !m.good ? 'flat' : (m.good === 'up') === (delta > 0) ? 'good' : 'bad';
        const arrow = !moved ? '&rarr;' : delta > 0 ? '&#9650;' : '&#9660;';
        const dTxt = delta === null ? 'no data the 30 days before'
          : `${arrow} ${moved ? (delta > 0 ? '+' : '−') + Wl.fmt(m.key, Math.abs(delta)) : 'no change'} vs prior 30 days`;
        const spark = Wl.trailing(Wl.points(all, m.key).filter(p => p.day > Wl.addDays(today, -90)), 7).map(p => p.v);
        const stale = s.lastDay !== today && s.lastDay < Wl.addDays(today, -1) ? ` · last ${shortDay(s.lastDay)}` : '';
        return `<div class="tile ana-link hl-tile" data-hl-color="${TILE_COLOR[m.key] || 'cyan'}" data-goto="health" data-spot="${TILE_SPOT[m.key]}" role="button" tabindex="0">
          <div class="tile-lbl">${esc(m.label)}</div>
          <div class="tile-row"><div class="tile-val num">${Wl.fmt(m.key, s.avg)}${unit ? `<small>${esc(unit)}</small>` : ''}</div>${spark.length > 1 ? VeloTrends.sparkline(spark, { color: 'currentColor' }) : ''}</div>
          <div class="tile-delta ${tone} num">${dTxt}</div>
          <div class="tile-sub">30-day average · latest ${Wl.fmt(m.key, s.last)}${m.unit && m.unit !== 'h' ? ' ' + esc(m.unit) : ''}${stale}</div>
        </div>`;
      }).join('');
    },

    /** Headline on the dock tab: the 7-day HRV average, else resting HR, else sleep. */
    renderHealthModStat(all, today) {
      const Wl = W();
      const last7 = (k) => { const s = Wl.stats(all, k, today, 7); return s && s.n ? s : null; };
      const hrv = last7('hrv'), rhr = last7('rhr'), sleep = last7('sleepH');
      const set = (stat, sub) => { this.setText('anaModStat-health', stat); this.setText('anaModSub-health', sub); };
      if (hrv) set(`${Math.round(hrv.avg)} ms`, 'HRV · 7 days');
      else if (rhr) set(`${Math.round(rhr.avg)} bpm`, 'resting HR · 7 days');
      else if (sleep) set(Wl.fmt('sleepH', sleep.avg), 'sleep · 7 days');
      else set('--', 'no data yet');
    },

    /** Chart.js scaffolding shared by the cards: one chart per canvas, rebuilt in place on each render. */
    healthChart(canvasId, type) {
      this._healthCharts = this._healthCharts || {};
      if (this._healthCharts[canvasId]) return this._healthCharts[canvasId];
      const ctx = document.getElementById(canvasId)?.getContext('2d');
      if (!ctx || typeof Chart === 'undefined') return null;
      const chart = new Chart(ctx, {
        type,
        data: { datasets: [] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
          interaction: { mode: 'nearest', axis: 'x', intersect: false },
          scales: {},
          plugins: {
            legend: { display: false },
            tooltip: {
              filter: (item) => !item.dataset.hlHidden,
              callbacks: {
                title: (items) => items.length ? (items[0].raw && items[0].raw.week ? `Week of ${dayLabel(items[0].parsed.x)}` : dayLabel(items[0].parsed.x)) : '',
                label: (c) => c.dataset.hlLabel ? c.dataset.hlLabel(c) : ` ${c.dataset.label} ${c.formattedValue}`
              }
            }
          }
        }
      });
      chart.$hl = { visible: {} };
      this._healthCharts[canvasId] = chart;
      if (this.attachBrushZoom) this.attachBrushZoom(chart, 'linear');
      return chart;
    },

    healthTimeAxis(range, extra = {}) {
      const { INK, axis } = VeloApp.CHART;
      return axis({ type: 'linear', min: range.x0, max: range.x1, ticks: { color: INK.muted, maxTicksLimit: 7, callback: (v) => new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) }, ...extra });
    },

    /** Legend chips above a chart; each toggles every dataset of its metric. */
    renderHealthLegend(canvasId, items) {
      const box = document.querySelector(`.hl-legend[data-hl="${canvasId}"]`);
      const chart = this._healthCharts && this._healthCharts[canvasId];
      if (!box) return;
      if (!box._hlBound) {
        box._hlBound = true;
        this.on(box, 'click', (e) => {
          const b = e.target.closest('.lg-toggle');
          const c = this._healthCharts && this._healthCharts[canvasId];
          if (!b || !c) return;
          const key = b.dataset.key, on = b.getAttribute('aria-pressed') !== 'true';
          c.$hl.visible[key] = on;
          c.data.datasets.forEach((ds, i) => { if (ds.hlKey === key) c.setDatasetVisibility(i, on); });
          c.update();
          b.setAttribute('aria-pressed', String(on));
          b.classList.toggle('is-off', !on);
        });
      }
      box.hidden = items.length < 2;
      box.innerHTML = items.map(it => {
        const on = !chart || chart.$hl.visible[it.key] !== false;
        return `<button type="button" class="lg-toggle${on ? '' : ' is-off'}" data-key="${esc(it.key)}" aria-pressed="${on}"><i class="lg" style="background:${it.color}"></i>${esc(it.label)}</button>`;
      }).join('');
    },

    /** Applies the remembered legend visibility after the datasets were replaced. */
    healthApplyVisibility(chart) {
      chart.data.datasets.forEach((ds, i) => { if (ds.hlKey && chart.$hl.visible[ds.hlKey] === false) chart.setDatasetVisibility(i, false); });
    },

    /** Daily dots plus a 7-day average line per metric; one stacked y lane per unit. */
    renderHealthLineCard(spec, all, days, range) {
      const card = document.getElementById(spec.card);
      if (!card) return;
      const Wl = W(), { VIZ, INK, axis } = VeloApp.CHART;
      const lanes = spec.lanes.map(l => ({ ...l, series: l.series.filter(([k]) => days.some(d => Wl.value(d, k) !== null)) })).filter(l => l.series.length);
      const keys = lanes.flatMap(l => l.series.map(([k]) => k));
      const need = spec.lanes.flatMap(l => l.series).length;
      card.hidden = !keys.length || (spec.needAll && keys.length < need);
      if (card.hidden) return;
      const chart = this.healthChart(spec.canvas, 'line');
      if (!chart) return;
      const datasets = [], laneScales = {};
      lanes.forEach((lane, li) => {
        const id = 'y' + li;
        const vals = [];
        laneScales[id] = axis({ stack: 'lanes', stackWeight: 1, offset: lanes.length > 1, position: 'left', min: lane.min, max: lane.max,
          title: { display: true, text: lane.unit, color: INK.muted }, ticks: { color: INK.muted, padding: 6, maxTicksLimit: lanes.length > 1 ? 4 : 6 } });
        for (const [k, c] of lane.series) {
          const m = Wl.BY_KEY[k], color = VIZ[c];
          // The average looks back 7 days from all history, so the first days of the range are averaged too.
          const pts = Wl.points(all, k);
          const avg = Wl.trailing(pts, 7).filter(p => p.t >= range.x0 && p.t <= range.x1);
          const inRange = pts.filter(p => p.t >= range.x0 && p.t <= range.x1);
          inRange.forEach(p => vals.push(p.v));
          const unit = m.unit && m.unit !== 'score' ? ' ' + m.unit : '';
          if (spec.dots !== false) {
            datasets.push({ hlKey: k, label: m.label, data: inRange.map(p => ({ x: p.t, y: p.v })), yAxisID: id, showLine: false,
              pointRadius: range.days > 200 ? 1.5 : 2.5, pointHoverRadius: 5, pointBackgroundColor: alpha(color, 0.45), pointBorderWidth: 0, borderColor: color,
              hlLabel: (cx) => ` ${m.label} ${Wl.fmt(k, cx.parsed.y)}${unit}` });
          }
          datasets.push({ hlKey: k, label: `${m.label} (7-day)`, data: avg.map(p => ({ x: p.t, y: Math.round(p.v * 10) / 10 })), yAxisID: id,
            borderColor: color, backgroundColor: color, borderWidth: 2, tension: 0.3, pointRadius: 0, spanGaps: 8 * DAY,
            hlLabel: (cx) => ` ${m.label} 7-day ${Wl.fmt(k, cx.parsed.y)}${unit}` });
        }
        // Lanes zoom to their own data (a fixed 0-100 lane keeps its range).
        if (lane.min === undefined && vals.length) {
          const lo = Math.min(...vals), hi = Math.max(...vals), pad = Math.max((hi - lo) * 0.12, Math.abs(hi) * 0.02, 1);
          laneScales[id].suggestedMin = lo - pad; laneScales[id].suggestedMax = hi + pad;
        }
      });
      // Chart.js stacks the first-defined lane at the bottom: define them in reverse so the first is on top.
      const scales = { x: this.healthTimeAxis(range) };
      Object.keys(laneScales).reverse().forEach(id => { scales[id] = laneScales[id]; });
      chart.data.datasets = datasets;
      chart.options.scales = scales;
      this.healthApplyVisibility(chart);
      chart.update();
      this.renderHealthLegend(spec.canvas, keys.map(k => ({ key: k, label: Wl.BY_KEY[k].label, color: VIZ[spec.lanes.flatMap(l => l.series).find(([x]) => x === k)[1]] })));
      const n = days.filter(d => keys.some(k => Wl.value(d, k) !== null)).length;
      this.setText(spec.card + 'Chip', `${n} day${n === 1 ? '' : 's'}`);
    },

    /**
     * The HRV the readiness score uses, with its rolling normal range (60 days, mean +/- 0.5 SD on a log
     * scale): the 7-day average inside the band = recovered, below = strain or illness, above = fresh.
     */
    renderHealthHrvCard(all, days, range) {
      const card = document.getElementById('anaCardHealthHrv');
      if (!card) return;
      const Wl = W(), { VIZ, INK, axis } = VeloApp.CHART;
      const inRange = Wl.points(days, 'hrv');
      card.hidden = !inRange.length;
      if (card.hidden) return;
      const last = days.filter(d => Wl.value(d, 'hrv') !== null).pop();
      const kind = last && last.hrvSrc === 'icu' ? (last.hrvKind === 'sdnn' ? 'SDNN' : 'rMSSD') : 'SDNN';
      const chart = this.healthChart('healthHrvCanvas', 'line');
      if (!chart) return;
      const within = (p) => p.t >= range.x0 && p.t <= range.x1;
      const band = Wl.normalBand(all, 'hrv').filter(within);
      const avg = Wl.trailing(Wl.points(all, 'hrv'), 7).filter(within);
      const c = VIZ.violet;
      chart.data.datasets = [
        { hlKey: 'band', hlHidden: true, label: 'Normal low', data: band.map(b => ({ x: b.t, y: Math.round(b.lo) })), borderColor: 'transparent', pointRadius: 0, fill: false, tension: 0.3, spanGaps: 2 * DAY },
        { hlKey: 'band', label: 'Normal range', data: band.map(b => ({ x: b.t, y: Math.round(b.hi), lo: Math.round(b.lo) })), borderColor: alpha(c, 0.35), borderWidth: 1, backgroundColor: alpha(c, 0.12), pointRadius: 0, fill: '-1', tension: 0.3, spanGaps: 2 * DAY,
          hlLabel: (cx) => ` Normal range ${cx.raw.lo}-${cx.raw.y} ms` },
        { hlKey: 'day', label: 'Night', data: inRange.map(p => ({ x: p.t, y: p.v })), showLine: false, pointRadius: range.days > 200 ? 1.5 : 2.5, pointHoverRadius: 5, pointBackgroundColor: alpha(c, 0.5), pointBorderWidth: 0, borderColor: c,
          hlLabel: (cx) => ` ${kind} ${Math.round(cx.parsed.y)} ms` },
        { hlKey: 'avg', label: '7-day average', data: avg.map(p => ({ x: p.t, y: Math.round(p.v * 10) / 10 })), borderColor: c, borderWidth: 2.2, tension: 0.3, pointRadius: 0, spanGaps: 2 * DAY,
          hlLabel: (cx) => ` 7-day average ${Math.round(cx.parsed.y)} ms` }
      ];
      const vals = inRange.map(p => p.v).concat(band.flatMap(b => [b.lo, b.hi]));
      const lo = Math.min(...vals), hi = Math.max(...vals), pad = Math.max((hi - lo) * 0.1, 2);
      chart.options.scales = { x: this.healthTimeAxis(range), y: axis({ suggestedMin: lo - pad, suggestedMax: hi + pad, title: { display: true, text: 'ms', color: INK.muted } }) };
      this.healthApplyVisibility(chart);
      chart.update();
      this.renderHealthLegend('healthHrvCanvas', [{ key: 'day', label: `${kind} per night`, color: alpha(c, 0.6) }, { key: 'avg', label: '7-day average', color: c }, { key: 'band', label: 'Your normal range', color: alpha(c, 0.3) }]);
      this.setText('anaCardHealthHrvChip', `${inRange.length} night${inRange.length === 1 ? '' : 's'} · ${kind}`);
      const lastBand = band[band.length - 1], lastAvg = avg[avg.length - 1];
      const where = !lastBand || !lastAvg ? '' : lastAvg.v < lastBand.lo ? ' Right now the 7-day average is below your normal range: recovery is lagging.'
        : lastAvg.v > lastBand.hi ? ' Right now the 7-day average is above your normal range.' : ' Right now the 7-day average is inside your normal range.';
      this.setText('anaCardHealthHrvNote', `${kind}, the HRV the readiness score uses. The band is your normal range from the 60 days before each day (it needs 14 nights).${where}`);
    },

    /** Stacked bars per night (or week on long ranges): deep, light, REM and awake; total when unstaged. */
    renderHealthSleepCard(days, range) {
      const card = document.getElementById('anaCardHealthSleep');
      if (!card) return;
      const Wl = W(), { VIZ, INK, axis } = VeloApp.CHART;
      const nights = days.filter(d => Wl.value(d, 'sleepH') !== null);
      card.hidden = !nights.length;
      if (card.hidden) return;
      const chart = this.healthChart('healthSleepCanvas', 'bar');
      if (!chart) return;
      const weeklyMode = range.days > 120;
      const tOf = (d) => new Date(d.day + 'T12:00:00').getTime();
      const stageOf = (d, k) => (Number.isFinite(d[k]) ? d[k] : 0);
      const staged = (d) => ['deepH', 'coreH', 'remH'].some(k => Number.isFinite(d[k]));
      // Each night split into its stages; a night without stages is one "sleep" block.
      const rows = nights.map(d => ({ t: tOf(d), total: d.sleepH, deepH: staged(d) ? stageOf(d, 'deepH') : 0, coreH: staged(d) ? stageOf(d, 'coreH') : 0, remH: staged(d) ? stageOf(d, 'remH') : 0,
        awakeH: stageOf(d, 'awakeH'), unstaged: staged(d) ? 0 : d.sleepH }));
      let series = rows;
      if (weeklyMode) {
        const by = new Map();
        for (const r of rows) {
          const w = Wl.weekOf(r.t);
          const e = by.get(w) || { t: w, n: 0, total: 0, deepH: 0, coreH: 0, remH: 0, awakeH: 0, unstaged: 0 };
          e.n++; ['total', 'deepH', 'coreH', 'remH', 'awakeH', 'unstaged'].forEach(k => { e[k] += r[k]; });
          by.set(w, e);
        }
        series = [...by.values()].sort((a, b) => a.t - b.t).map(e => {
          const o = { t: e.t, week: true, n: e.n };
          ['total', 'deepH', 'coreH', 'remH', 'awakeH', 'unstaged'].forEach(k => { o[k] = e[k] / e.n; });
          return o;
        });
      }
      const layers = STAGES.filter(([k]) => series.some(r => r[k] > 0)).map(([k, label, c]) => ({ k, label, color: VIZ[c] }));
      if (series.some(r => r.unstaged > 0)) layers.push({ k: 'unstaged', label: 'Sleep (no stages)', color: alpha(VIZ.violet, 0.45) });
      const fmtH = (h) => Wl.fmt('sleepH', h);
      const barMs = (weeklyMode ? 7 : 1) * DAY;
      chart.data.datasets = layers.map(l => ({
        hlKey: l.k, label: l.label, stack: 'sleep', backgroundColor: l.color, borderColor: 'transparent', borderSkipped: false, borderRadius: 2,
        barPercentage: 0.82, categoryPercentage: 1,
        data: series.map(r => ({ x: r.t, y: Math.round(r[l.k] * 100) / 100, total: r.total, n: r.n, week: r.week })),
        hlLabel: (cx) => ` ${l.label} ${fmtH(cx.parsed.y)}${cx.raw.total ? ` of ${fmtH(cx.raw.total)}` : ''}${cx.raw.week ? ` (average of ${cx.raw.n} nights)` : ''}`
      }));
      chart.options.interaction = { mode: 'index', intersect: false };
      chart.options.scales = {
        x: this.healthTimeAxis(range, { offset: false, min: range.x0 - barMs / 2, max: range.x1 + barMs / 2 }),
        y: axis({ stacked: true, beginAtZero: true, title: { display: true, text: 'hours', color: INK.muted }, ticks: { color: INK.muted, padding: 6, callback: (v) => `${v} h` } })
      };
      chart.options.scales.x.stacked = true;
      // Bars on a linear time axis: width from the spacing of one night (or week).
      chart.options.datasets = { bar: { maxBarThickness: 28 } };
      this.healthApplyVisibility(chart);
      chart.update();
      this.renderHealthLegend('healthSleepCanvas', layers.map(l => ({ key: l.k, label: l.label, color: l.color })));
      this.setText('anaCardHealthSleepChip', `${nights.length} night${nights.length === 1 ? '' : 's'}${weeklyMode ? ' · weekly' : ''}`);

      const mix = Wl.sleepMix(days, range.from, range.to);
      const box = document.getElementById('healthSleepMix');
      if (box) {
        const pct = (v) => (v === null || v === undefined ? '' : ` <small>${Math.round(v * 100)}%</small>`);
        const cell = (label, val, extra = '') => `<div><span>${esc(label)}</span><b class="num">${val}${extra}</b></div>`;
        box.innerHTML = mix ? [
          cell('Average sleep', fmtH(mix.sleepH)),
          mix.deepH !== null ? cell('Deep', fmtH(mix.deepH), pct(mix.share && mix.share.deep)) : '',
          mix.coreH !== null ? cell('Light', fmtH(mix.coreH), pct(mix.share && mix.share.core)) : '',
          mix.remH !== null ? cell('REM', fmtH(mix.remH), pct(mix.share && mix.share.rem)) : '',
          mix.awakeH !== null ? cell('Awake', fmtH(mix.awakeH)) : '',
          cell('Shortest', fmtH(mix.shortest.h), ` <small>${esc(shortDay(mix.shortest.day))}</small>`),
          cell('Longest', fmtH(mix.longest.h), ` <small>${esc(shortDay(mix.longest.day))}</small>`)
        ].join('') : '';
      }
      this.setText('anaCardHealthSleepNote', `${weeklyMode ? 'Each bar is the average night of a week. ' : ''}Adults who train usually do best on 7-9 hours. Deep sleep (often 13-23% of the night) is when most physical repair happens; REM (often 20-25%) helps learning and mood. Wearables estimate stages, so watch your own trend rather than single nights.`);
    },

    /** Daily steps (weekly averages on long ranges) with a 7-day average line. */
    renderHealthStepsCard(days, range) {
      const card = document.getElementById('anaCardHealthSteps');
      if (!card) return;
      const Wl = W(), { VIZ, INK, axis } = VeloApp.CHART;
      const pts = Wl.points(days, 'steps');
      card.hidden = !pts.length;
      if (card.hidden) return;
      const chart = this.healthChart('healthStepsCanvas', 'bar');
      if (!chart) return;
      const weeklyMode = range.days > 120;
      const bars = weeklyMode ? Wl.weekly(pts).map(p => ({ x: p.t, y: Math.round(p.v), week: true, n: p.n })) : pts.map(p => ({ x: p.t, y: p.v }));
      const fmtN = (v) => Math.round(v).toLocaleString('en-GB');
      chart.data.datasets = [
        { hlKey: 'steps', label: 'Steps', data: bars, backgroundColor: alpha(VIZ.lime, 0.55), borderRadius: 2, borderSkipped: false, maxBarThickness: 22,
          hlLabel: (cx) => ` ${fmtN(cx.parsed.y)} steps${cx.raw.week ? ` a day (average of ${cx.raw.n} days)` : ''}` },
        ...(weeklyMode ? [] : [{ type: 'line', hlKey: 'avg', label: '7-day average', data: Wl.trailing(pts, 7).map(p => ({ x: p.t, y: Math.round(p.v) })), borderColor: VIZ.lime, borderWidth: 2, tension: 0.3, pointRadius: 0,
          hlLabel: (cx) => ` 7-day average ${fmtN(cx.parsed.y)}` }])
      ];
      const barMs = (weeklyMode ? 7 : 1) * DAY;
      chart.options.interaction = { mode: 'index', intersect: false };
      chart.options.scales = { x: this.healthTimeAxis(range, { offset: false, min: range.x0 - barMs / 2, max: range.x1 + barMs / 2 }), y: axis({ beginAtZero: true, ticks: { color: INK.muted, padding: 6, callback: (v) => v >= 1000 ? `${v / 1000}k` : v } }) };
      chart.update();
      const box = document.querySelector('.hl-legend[data-hl="healthStepsCanvas"]');
      if (box) box.hidden = true;
      const avg = pts.reduce((a, p) => a + p.v, 0) / pts.length;
      this.setText('anaCardHealthStepsChip', `avg ${fmtN(avg)} / day`);
      this.setText('anaCardHealthStepsNote', weeklyMode ? 'Each bar is the daily average of a week.' : 'Bars are single days, the line is the 7-day average. Easy walking on rest days helps recovery; very high step counts before a key session add fatigue.');
    },

    /** Next-morning HRV, resting HR and sleep grouped by the previous day's TSS. */
    renderHealthLoadCard(all, range) {
      const card = document.getElementById('anaCardHealthLoad');
      const box = document.getElementById('healthLoadTable');
      if (!card || !box) return;
      const Wl = W();
      const rides = this.cyclingRides().map(r => ({ day: this.localDayKey(new Date(r.date)), tss: Number(r.tss) || 0 })).filter(r => r.day);
      const res = Wl.loadResponse(all, rides, { from: range.from, to: range.to, hrvKey: 'hrv' });
      const groups = res ? res.groups.filter(g => g.n) : [];
      card.hidden = !res || groups.length < 2;
      if (card.hidden) return;
      const signed = (v, dec, unit) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(dec)}${unit}`;
      // Text keeps its ink colour; good / bad shows as an arrow and a tone class, never colour alone.
      const delta = (v, dec, unit, good, step) => {
        if (v === null) return '';
        if (Math.abs(v) < step) return '<small class="hl-d flat">≈ average</small>';
        const better = (good === 'up') === (v > 0);
        return `<small class="hl-d ${better ? 'good' : 'bad'}">${v > 0 ? '▲' : '▼'} ${signed(v, dec, unit)}</small>`;
      };
      const fmtH = (h) => Wl.fmt('sleepH', h);
      box.innerHTML = `<table class="hl-load-table">
        <thead><tr><th scope="col">Day before</th><th scope="col" class="num">HRV</th><th scope="col" class="num">Resting HR</th><th scope="col" class="num">Sleep</th></tr></thead>
        <tbody>${groups.map(g => `<tr>
          <th scope="row">${esc(g.label)}<small class="hl-n">${g.n} morning${g.n === 1 ? '' : 's'}</small></th>
          <td class="num">${g.hrv !== null ? `${Math.round(g.hrv)} ms` : '--'} ${delta(g.dHrv, 0, ' ms', 'up', 1)}</td>
          <td class="num">${g.rhr !== null ? `${Math.round(g.rhr)} bpm` : '--'} ${delta(g.dRhr, 1, ' bpm', 'down', 0.5)}</td>
          <td class="num">${g.sleepH !== null ? fmtH(g.sleepH) : '--'} ${g.dSleep !== null && Math.abs(g.dSleep) >= 1 / 12 ? delta(g.dSleep * 60, 0, ' min', 'up', 5) : g.dSleep !== null ? '<small class="hl-d flat">≈ average</small>' : ''}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr><th scope="row">All mornings<small class="hl-n">${res.mornings}</small></th><td class="num">${res.all.hrv !== null ? `${Math.round(res.all.hrv)} ms` : '--'}</td><td class="num">${res.all.rhr !== null ? `${Math.round(res.all.rhr)} bpm` : '--'}</td><td class="num">${res.all.sleepH !== null ? fmtH(res.all.sleepH) : '--'}</td></tr></tfoot>
      </table>`;
      this.setText('anaCardHealthLoadChip', `${res.mornings} mornings`);
      const few = groups.some(g => g.n < 5);
      this.setText('anaCardHealthLoadNote', `Each morning is grouped by the TSS you rode the day before and compared with the average of all mornings in this period. Only mornings after your first recorded ride count.${few ? ' Groups with fewer than 5 mornings are a rough guide only.' : ''}`);
    }
  });
})();
