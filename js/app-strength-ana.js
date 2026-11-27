/**
 * APEX VELO // LAB - Strength analytics panel (mixin on VeloApp).
 *
 * Drives the Analytics > Strength tab: KPIs, weekly/monthly volume/sets/load chart,
 * clean single-metric exercise progression chart (dots + 5-session trend + PR line),
 * muscle group split, lifting PRs, and the canonicalized exercise leaderboard.
 */
(function () {
  const S = () => VeloStrengthAnalytics;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function verticalGrad(ctx, cTop, cBottom) {
    const area = ctx.chart && ctx.chart.chartArea;
    if (!area) return cTop;
    const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0, cTop);
    g.addColorStop(1, cBottom);
    return g;
  }

  function compactTick(v) {
    if (Math.abs(v) >= 1000) {
      const k = v / 1000;
      return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
    }
    return String(v);
  }

  Object.assign(VeloApp.prototype, {
    initStrengthAnalytics() {
      this.strMetric = 'volume';
      this.strMuscleMode = 'sets';
      this.strLiftMetric = 'e1rm';
      this.strSelectedLift = null;

      const pills = document.getElementById('strWeeklyPills');
      if (pills) {
        this.on(pills, 'click', (e) => {
          const b = e.target.closest('[data-str-metric]');
          if (!b) return;
          this.strMetric = b.dataset.strMetric;
          pills.querySelectorAll('[data-str-metric]').forEach(x => {
            const on = x === b;
            x.classList.toggle('active', on);
            x.setAttribute('aria-pressed', String(on));
          });
          this.renderStrengthAnalytics();
        });
      }

      const mPills = document.getElementById('strMusclePills');
      if (mPills) {
        this.on(mPills, 'click', (e) => {
          const b = e.target.closest('[data-str-muscle]');
          if (!b) return;
          this.strMuscleMode = b.dataset.strMuscle;
          mPills.querySelectorAll('[data-str-muscle]').forEach(x => {
            const on = x === b;
            x.classList.toggle('active', on);
            x.setAttribute('aria-pressed', String(on));
          });
          this.renderStrengthAnalytics();
        });
      }

      const lPills = document.getElementById('strLiftMetricPills');
      if (lPills) {
        this.on(lPills, 'click', (e) => {
          const b = e.target.closest('[data-str-lift-metric]');
          if (!b) return;
          this.strLiftMetric = b.dataset.strLiftMetric;
          lPills.querySelectorAll('[data-str-lift-metric]').forEach(x => {
            const on = x === b;
            x.classList.toggle('active', on);
            x.setAttribute('aria-pressed', String(on));
          });
          this.renderStrengthLiftChart();
        });
      }

      const sel = document.getElementById('strLiftSelect');
      if (sel) {
        this.on(sel, 'change', () => {
          this.strSelectedLift = sel.value || null;
          this.renderStrengthLiftChart();
        });
      }

      const liftPills = document.getElementById('strLiftPills');
      if (liftPills) {
        this.on(liftPills, 'click', (e) => {
          const b = e.target.closest('[data-lift]');
          if (!b) return;
          this.strSelectedLift = b.dataset.lift;
          if (sel) sel.value = this.strSelectedLift;
          this.renderStrengthLiftChart();
        });
      }

      const weekChips = document.getElementById('strWeekSessions');
      if (weekChips) {
        this.on(weekChips, 'click', (e) => {
          const b = e.target.closest('[data-ride]');
          if (b) this.showRideSummaryById(b.dataset.ride);
        });
      }

      const recList = document.getElementById('strRecordsList');
      if (recList) {
        this.on(recList, 'click', (e) => {
          const b = e.target.closest('[data-ride]');
          if (b) this.showRideSummaryById(b.dataset.ride);
        });
      }

      const exTable = document.getElementById('strExerciseTableBody');
      if (exTable) {
        this.on(exTable, 'click', (e) => {
          const tr = e.target.closest('tr[data-lift]');
          if (!tr) return;
          this.strSelectedLift = tr.dataset.lift;
          if (sel) sel.value = this.strSelectedLift;
          this.renderStrengthLiftChart();
          document.getElementById('anaCardStrLift')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      }

      const theme = VeloApp.CHART || {
        VIZ: { cyan: '#4aa8ff', amber: '#ffae3d', rose: '#ff5c86', violet: '#9b7bff', lime: '#3ddc97' },
        INK: { muted: '#6f7894', grid: 'rgba(255,255,255,0.06)' },
        axis: (extra = {}) => ({ grid: { color: 'rgba(255,255,255,0.06)', drawTicks: false }, border: { display: false }, ticks: { color: '#6f7894', padding: 6 }, ...extra })
      };

      const ctxW = document.getElementById('strWeeklyCanvas')?.getContext('2d');
      if (ctxW && typeof Chart !== 'undefined') {
        this.strWeeklyChart = new Chart(ctxW, {
          type: 'bar',
          data: {
            labels: [],
            datasets: [
              {
                label: 'Total',
                data: [],
                backgroundColor: (c) => {
                  const arr = c.chart.data.datasets[0].data || [];
                  const isLast = c.dataIndex === arr.length - 1;
                  return verticalGrad(c, isLast ? 'rgba(255, 92, 134, 0.92)' : 'rgba(255, 92, 134, 0.62)', isLast ? 'rgba(255, 92, 134, 0.35)' : 'rgba(255, 92, 134, 0.14)');
                },
                hoverBackgroundColor: theme.VIZ.rose,
                borderRadius: 6,
                borderSkipped: 'bottom',
                maxBarThickness: 28,
                order: 2
              },
              {
                label: '4-period avg',
                data: [],
                type: 'line',
                borderColor: '#f1f4ff',
                borderWidth: 2,
                tension: 0.35,
                pointRadius: 0,
                pointHoverRadius: 4,
                order: 1
              }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
            onClick: (evt, els) => { if (els && els.length) this.showStrengthWeekSessions(els[0].index); },
            onHover: (evt, els) => { if (evt?.native?.target) evt.native.target.style.cursor = els?.length ? 'pointer' : 'default'; },
            scales: {
              x: theme.axis({ grid: { display: false }, ticks: { color: theme.INK.muted, maxTicksLimit: 8, maxRotation: 0 } }),
              y: theme.axis({ beginAtZero: true, ticks: { color: theme.INK.muted, maxTicksLimit: 6, callback: compactTick } })
            },
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${this.fmtStrMetric(c.parsed.y)}` } }
            }
          }
        });
      }

      const ctxL = document.getElementById('strLiftCanvas')?.getContext('2d');
      if (ctxL && typeof Chart !== 'undefined') {
        this.strLiftChart = new Chart(ctxL, {
          type: 'line',
          data: {
            datasets: [
              {
                label: 'Trend (5-session avg)',
                data: [],
                borderColor: theme.VIZ.rose,
                backgroundColor: (c) => verticalGrad(c, 'rgba(255, 92, 134, 0.24)', 'rgba(255, 92, 134, 0.01)'),
                borderWidth: 2.25,
                fill: true,
                tension: 0.35,
                pointRadius: 0,
                pointHoverRadius: 5,
                order: 2
              },
              {
                label: 'Session',
                data: [],
                showLine: false,
                borderColor: '#0b1220',
                borderWidth: 1.5,
                backgroundColor: theme.VIZ.cyan,
                pointRadius: 4,
                pointHoverRadius: 7,
                order: 1
              },
              {
                label: 'Period best',
                data: [],
                borderColor: 'rgba(255, 174, 61, 0.7)',
                borderDash: [5, 5],
                borderWidth: 1.5,
                fill: false,
                pointRadius: 0,
                pointHoverRadius: 0,
                order: 3
              }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 280 },
            interaction: { mode: 'nearest', intersect: true },
            onClick: (evt, els) => {
              if (!els || !els.length || !this._strLiftPoints) return;
              const hit = els.find(e => e.datasetIndex === 1) || els[0];
              const pt = this._strLiftPoints[hit.index];
              if (pt && pt.workoutId) this.showRideSummaryById(pt.workoutId);
            },
            onHover: (evt, els) => { if (evt?.native?.target) evt.native.target.style.cursor = els?.length ? 'pointer' : 'default'; },
            scales: {
              x: {
                type: 'linear',
                grid: { display: false },
                border: { display: false },
                ticks: {
                  color: theme.INK.muted,
                  maxTicksLimit: 7,
                  maxRotation: 0,
                  callback: (val) => {
                    const d = new Date(val);
                    if (isNaN(d)) return '';
                    return this.progWeeks === 0
                      ? d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
                      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                  }
                }
              },
              y: theme.axis({ grace: '10%', ticks: { color: theme.INK.muted, maxTicksLimit: 6, callback: compactTick }, title: { display: true, text: 'kg', color: theme.INK.muted } })
            },
            plugins: {
              legend: { display: true, position: 'bottom', labels: { color: '#a4acc6', boxWidth: 10, boxHeight: 10, padding: 12, usePointStyle: true } },
              tooltip: {
                filter: (item) => item.datasetIndex !== 2,
                callbacks: {
                  title: (items) => {
                    const item = items && items[0];
                    const pt = item && this._strLiftPoints && this._strLiftPoints[item.dataIndex];
                    if (!pt) return '';
                    const d = new Date(pt.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
                    return `${d} · ${pt.title}`;
                  },
                  label: (c) => {
                    if (c.datasetIndex === 0) return ` 5-session trend: ${Math.round(c.parsed.y * 10) / 10} kg`;
                    const pt = this._strLiftPoints && this._strLiftPoints[c.dataIndex];
                    if (!pt) return '';
                    const lines = [];
                    if (pt.e1rmKg > 0) lines.push(` Est. 1RM: ${pt.e1rmKg} kg`);
                    if (pt.bestSetLabel) lines.push(` Best set: ${pt.bestSetLabel}`);
                    if (pt.sets) lines.push(` Working sets: ${pt.sets}${pt.avgRpe ? ` · avg RPE ${pt.avgRpe}` : ''}`);
                    if (pt.volumeKg > 0) lines.push(` Volume: ${pt.volumeKg.toLocaleString('en-US')} kg`);
                    return lines;
                  }
                }
              }
            }
          }
        });
      }

      this.renderStrengthAnalytics();
    },

    fmtStrMetric(v) {
      if (v === null || v === undefined) return '--';
      switch (this.strMetric) {
        case 'sets': return `${Math.round(v)} sets`;
        case 'load': return `${Math.round(v)} load`;
        case 'sessions': return `${Math.round(v * 10) / 10} sessions`;
        default: return `${Math.round(v).toLocaleString('en-US')} kg`;
      }
    },

    renderStrengthAnalytics() {
      if (typeof VeloStrengthAnalytics === 'undefined') return;
      const all = S().strengthWorkouts(this.completedWorkouts);
      const emptyEl = document.getElementById('anaStrengthEmpty');
      const bodyEls = ['strAnaKpis', 'anaCardStrWeekly', 'anaCardStrLift', 'strAnaSplitRow', 'anaMore-strength'];
      const hasData = all.length > 0;
      if (emptyEl) emptyEl.hidden = hasData;
      bodyEls.forEach(id => { const el = document.getElementById(id); if (el) el.hidden = !hasData; });
      if (!hasData) return;

      const days = Number(this.pmcRange) || 0;
      const weeks = this.progWeeks === 0 ? 0 : (Number(this.progWeeks) || 26);

      // 1. KPIs
      const kpi = S().kpis(all, days);
      const kpiEl = document.getElementById('strAnaKpis');
      if (kpiEl) {
        const fmtVol = (kg) => kg >= 10000 ? `${(kg / 1000).toFixed(1)} t` : `${Math.round(kg).toLocaleString('en-US')} kg`;
        const delta = (cur, prev, fmt) => {
          if (!kpi.prev || prev === null || prev === undefined) return '<span class="delta flat">&nbsp;</span>';
          const d = cur - prev;
          if (!prev && !cur) return '<span class="delta flat">--</span>';
          const pct = prev ? Math.round((d / prev) * 100) : null;
          return `<span class="delta ${d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}">${d > 0 ? '+' : ''}${fmt(d)}${pct !== null ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''}</span>`;
        };
        const c = kpi.cur, p = kpi.prev || {};
        const tiles = [
          ['Sessions', `${c.sessions}`, delta(c.sessions, p.sessions, v => v)],
          ['Per week', `${c.sessionsPerWeek.toFixed(1)}`, delta(c.sessionsPerWeek, p.sessionsPerWeek, v => v.toFixed(1))],
          ['Volume', fmtVol(c.volumeKg), delta(c.volumeKg, p.volumeKg, fmtVol)],
          ['Working sets', `${c.sets.toLocaleString('en-US')}`, delta(c.sets, p.sets, v => Math.round(v))],
          ['Gym time', `${c.hours.toFixed(1)} h`, delta(c.hours, p.hours, v => `${v.toFixed(1)} h`)],
          ['Heavy leg days', `${c.heavyLegDays}`, delta(c.heavyLegDays, p.heavyLegDays, v => v)]
        ];
        kpiEl.innerHTML = tiles.map(([lbl, val, d]) =>
          `<div class="kpi"><span class="kpi-lbl">${lbl}</span><span class="kpi-val num">${val}</span>${d}</div>`
        ).join('') + `<div class="kpi-caption">${kpi.prev ? 'vs previous ' + (weeks >= 52 ? '12 months' : weeks + ' weeks') : 'all recorded strength history'}</div>`;
      }

      // 2. Weekly / Monthly chart (switch to monthly when 'All' spans > 60 weeks)
      const weeklyBuckets = S().weekly(all, weeks);
      const useMonthly = weeks === 0 && weeklyBuckets.length > 60;
      const buckets = useMonthly ? S().monthly(all) : weeklyBuckets;
      this._strWeeks = buckets;
      this._strPeriodUnit = useMonthly ? 'month' : 'week';
      const metric = this.strMetric || 'volume';
      const fieldMap = { volume: 'volumeKg', sets: 'sets', load: 'load', sessions: 'sessions' };
      const prefix = useMonthly ? 'Monthly' : 'Weekly';
      const titleMap = {
        volume: `${prefix} lifting volume (kg)`,
        sets: `${prefix} working sets`,
        load: `${prefix} strength load`,
        sessions: `Strength sessions per ${this._strPeriodUnit}`
      };
      this.setText('strWeeklyTitle', titleMap[metric] || titleMap.volume);
      if (this.strWeeklyChart) {
        const vals = buckets.map(w => w[fieldMap[metric] || 'volumeKg']);
        const avg = vals.map((_, i) => {
          const sl = vals.slice(Math.max(0, i - 3), i + 1);
          return Math.round((sl.reduce((a, b) => a + b, 0) / sl.length) * 10) / 10;
        });
        this.strWeeklyChart.data.labels = buckets.map(w => w.label);
        this.strWeeklyChart.data.datasets[0].data = vals;
        this.strWeeklyChart.data.datasets[0].label = titleMap[metric] || titleMap.volume;
        this.strWeeklyChart.data.datasets[1].label = useMonthly ? '4-month avg' : '4-week avg';
        this.strWeeklyChart.data.datasets[1].data = avg;
        this.strWeeklyChart.update();
      }
      const wsEl = document.getElementById('strWeekSessions');
      if (wsEl && !wsEl.dataset.week) wsEl.innerHTML = '';

      // 3. Exercise catalog, quick pills, select & lift chart
      const catalog = S().exerciseCatalog(all, days);
      this._strCatalog = catalog;
      const sel = document.getElementById('strLiftSelect');
      if (sel) {
        if (!this.strSelectedLift || !catalog.some(e => e.title === this.strSelectedLift)) {
          this.strSelectedLift = catalog[0] ? catalog[0].title : null;
        }
        sel.innerHTML = catalog.map(e => `<option value="${esc(e.title)}">${esc(e.title)} (${e.sessions})</option>`).join('');
        if (this.strSelectedLift) sel.value = this.strSelectedLift;
      }
      const pillWrap = document.getElementById('strLiftPills');
      if (pillWrap) {
        pillWrap.innerHTML = catalog.slice(0, 5).map(e =>
          `<button type="button" class="preset-pill${e.title === this.strSelectedLift ? ' active' : ''}" data-lift="${esc(e.title)}">${esc(e.title.replace(/\s*\([^)]*\)$/, ''))}</button>`
        ).join('');
      }
      this.renderStrengthLiftChart();

      // 4. Muscle split
      const split = S().muscleSplit(all, days);
      const mEl = document.getElementById('strMuscleMix');
      if (mEl) {
        const useVol = this.strMuscleMode === 'volume' && split.totalVolumeKg > 0;
        const rows = split.groups.filter(g => (useVol ? g.volumeKg : g.sets) > 0).sort((a, b) => (useVol ? b.volumeKg - a.volumeKg : b.sets - a.sets));
        const maxVal = rows.length ? Math.max(...rows.map(g => (useVol ? g.volumeKg : g.sets))) : 1;
        mEl.innerHTML = rows.length
          ? rows.map(g => {
            const val = useVol ? g.volumeKg : g.sets;
            const pct = useVol ? g.volumePct : g.setsPct;
            const w = Math.round((val / maxVal) * 100);
            const labelVal = useVol
              ? `${g.volumeKg >= 1000 ? (g.volumeKg / 1000).toFixed(1) + 't' : g.volumeKg + 'kg'} (${pct}%)`
              : `${g.sets} (${pct}%)`;
            return `<div class="mix-row" title="${g.sets} sets · ${g.volumeKg.toLocaleString('en-US')} kg"><span class="mix-lbl"><i style="background:${g.color}"></i>${esc(g.label)}</span><span class="mix-bar"><span style="width:${w}%;background:${g.color}"></span></span><span class="mix-val num">${labelVal}</span></div>`;
          }).join('')
          : '<div class="mix-note">No exercise sets recorded in this period.</div>';
      }

      // 5. All-time Strength PRs
      const rec = S().records(all);
      const recEl = document.getElementById('strRecordsList');
      if (recEl) {
        const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
        const row = (lbl, r, val, sub) => r ? `<button type="button" class="record-row" data-ride="${esc(r.id)}"><svg class="ic ic-xs"><use href="#i-trophy"/></svg><span>${esc(lbl)}</span><b class="num">${esc(val)}</b><small>${esc(sub || fmtDate(r.date))}</small></button>` : '';
        const rows = [];
        rec.topLifts.slice(0, 4).forEach(l => {
          const val = l.e1rmKg > 0 ? `${l.setLabel} · e1RM ${l.e1rmKg} kg` : l.setLabel;
          rows.push(row(l.name, l.r, val, fmtDate(l.r.date)));
        });
        if (rec.biggestVolume) rows.push(row('Biggest session volume', rec.biggestVolume.r, `${rec.biggestVolume.v.toLocaleString('en-US')} kg`, fmtDate(rec.biggestVolume.r.date)));
        if (rec.mostSets) rows.push(row('Most sets in a session', rec.mostSets.r, `${rec.mostSets.v} sets`, fmtDate(rec.mostSets.r.date)));
        if (rec.bestWeekVolume) rows.push(`<div class="record-row static"><svg class="ic ic-xs"><use href="#i-trophy"/></svg><span>Biggest week</span><b class="num">${rec.bestWeekVolume.volumeKg.toLocaleString('en-US')} kg</b><small>${esc(rec.bestWeekVolume.label)}</small></div>`);
        if (rec.weekStreak) rows.push(`<div class="record-row static"><svg class="ic ic-xs"><use href="#i-trophy"/></svg><span>Longest streak</span><b class="num">${rec.weekStreak} week${rec.weekStreak === 1 ? '' : 's'}</b><small></small></div>`);
        recEl.innerHTML = rows.join('') || '<div class="mix-note">No strength records yet.</div>';
      }

      // 6. Exercise leaderboard table
      const tb = document.getElementById('strExerciseTableBody');
      if (tb) {
        const gLabel = new Map(S().MUSCLE_GROUPS.map(g => [g.key, g.label]));
        tb.innerHTML = catalog.slice(0, 60).map(e => {
          const dHtml = e.deltaPct === null ? '--' : `<span class="delta ${e.deltaPct > 0 ? 'up' : e.deltaPct < 0 ? 'down' : 'flat'}">${e.deltaPct > 0 ? '+' : ''}${e.deltaPct}%</span>`;
          return `<tr data-lift="${esc(e.title)}" title="Click to plot ${esc(e.title)}">
            <td><b>${esc(e.title)}</b></td>
            <td class="muted">${esc(gLabel.get(e.muscleGroup) || 'Other')}</td>
            <td class="num">${e.sessions}</td>
            <td class="num">${e.totalSets}</td>
            <td class="num">${e.totalVolumeKg ? e.totalVolumeKg.toLocaleString('en-US') + ' kg' : '--'}</td>
            <td class="num">${esc(e.bestSetLabel || '--')}</td>
            <td class="num strong">${e.bestE1rmKg ? e.bestE1rmKg + ' kg' : '--'}</td>
            <td class="num">${dHtml}</td>
          </tr>`;
        }).join('') || '<tr><td colspan="8" class="empty-cell">No exercises logged in this period.</td></tr>';
      }
    },

    renderStrengthLiftChart() {
      if (typeof VeloStrengthAnalytics === 'undefined') return;
      const all = S().strengthWorkouts(this.completedWorkouts);
      const days = Number(this.pmcRange) || 0;
      const title = this.strSelectedLift;
      document.querySelectorAll('#strLiftPills .preset-pill').forEach(b => b.classList.toggle('active', b.dataset.lift === title));

      const pts = S().exerciseProgression(all, title, days);
      this._strLiftPoints = pts;
      const metric = this.strLiftMetric || 'e1rm';
      const valOf = (p) => (metric === 'weight' ? p.bestWeightKg : metric === 'volume' ? p.volumeKg : p.e1rmKg);

      const chip = document.getElementById('strLiftChip');
      if (chip) {
        const bestE1 = pts.reduce((m, p) => Math.max(m, p.e1rmKg || 0), 0);
        const bestW = pts.reduce((m, p) => Math.max(m, p.bestWeightKg || 0), 0);
        chip.textContent = bestE1 > 0 ? `Best e1RM ${bestE1} kg · top ${bestW} kg (${pts.length} sessions)` : `${pts.length} session${pts.length === 1 ? '' : 's'}`;
      }
      if (!this.strLiftChart) return;

      const valid = pts.map(p => ({ x: Date.parse(p.date), y: valOf(p) })).filter(d => Number.isFinite(d.x) && d.y > 0);
      const trend = valid.map((d, i) => {
        const sl = valid.slice(Math.max(0, i - 4), i + 1);
        const avg = sl.reduce((a, b) => a + b.y, 0) / sl.length;
        return { x: d.x, y: Math.round(avg * 10) / 10 };
      });
      const prVal = valid.length ? Math.max(...valid.map(d => d.y)) : 0;
      const prLine = valid.length >= 2 && prVal > 0
        ? [{ x: valid[0].x, y: prVal }, { x: valid[valid.length - 1].x, y: prVal }]
        : [];

      const radius = valid.length > 80 ? 2.2 : valid.length > 30 ? 3 : 4.5;
      const lblMap = { e1rm: 'Session est. 1RM', weight: 'Session top weight', volume: 'Session volume' };
      this.strLiftChart.data.datasets[0].label = 'Trend (5-session avg)';
      this.strLiftChart.data.datasets[0].data = trend;
      this.strLiftChart.data.datasets[1].label = lblMap[metric] || 'Session';
      this.strLiftChart.data.datasets[1].data = pts.map(p => ({ x: Date.parse(p.date), y: valOf(p) > 0 ? valOf(p) : null }));
      this.strLiftChart.data.datasets[1].pointRadius = radius;
      this.strLiftChart.data.datasets[2].label = prVal > 0 ? `Period best (${Math.round(prVal).toLocaleString('en-US')} kg)` : 'Period best';
      this.strLiftChart.data.datasets[2].data = prLine;
      this.strLiftChart.options.scales.y.beginAtZero = metric === 'volume';
      this.strLiftChart.update();
    },

    showStrengthWeekSessions(index) {
      const w = this._strWeeks && this._strWeeks[index];
      const el = document.getElementById('strWeekSessions');
      if (!w || !el) return;
      el.dataset.week = w.key;
      const list = (this.completedWorkouts || []).filter(r => w.sessionIds.includes(r.id)).sort((a, b) => new Date(a.date) - new Date(b.date));
      const headLbl = this._strPeriodUnit === 'month'
        ? w.start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
        : `Week of ${w.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
      el.innerHTML = `<div class="week-rides-head">${headLbl}: <b class="num">${w.volumeKg.toLocaleString('en-US')} kg</b> - <b class="num">${w.sets} sets</b> - ${w.sessions} session${w.sessions === 1 ? '' : 's'}</div>` +
        (list.length ? list.map(r => `<button type="button" class="ride-chip" data-ride="${esc(r.id)}"><span>${new Date(r.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span><b>${esc(r.title)}</b><small class="num">${this.fmtTime(r.duration)}${r.hevy && r.hevy.volumeKg ? ` - ${r.hevy.volumeKg.toLocaleString('en-US')} kg` : ''}</small></button>`).join('') : '<span class="mix-note">No strength sessions in this period.</span>');
    }
  });
})();
