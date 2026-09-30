/**
 * APEX VELO // LAB - Training block UI (mixin): setup form and block overview in the
 * AI Coach tab, planned sessions on the Calendar, and the review after every ride.
 */
(function () {
  const esc = (s) => VeloApp.esc(s);
  const P = () => VeloBlockPlanner;
  const fmtDay = (k, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => P().parse(k).toLocaleDateString('en-US', opts);
  const OPTIONS_KEY = 'apex_block_options';

  Object.assign(VeloApp.prototype, {
    initTrainingBlockUi() {
      if (!this.blockPlanner) return;
      const days = document.getElementById('blockDays');
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) || 'null'); } catch (e) { /* ignore */ }
      const h = VeloProgress.coachProfile(this.cyclingRides(), (this.activeProfile || {}).ftp || 185);
      const defaults = {
        goal: this.coachGoal || 'ftp', weeks: 8, days: [1, 3, 5, 6], longDay: 6,
        hoursPerWeek: h.hoursPerWeek4w ? Math.max(3, Math.min(20, Math.ceil(h.hoursPerWeek4w * 1.15 * 2) / 2)) : 6
      };
      const o = { ...defaults, ...(saved || {}) };
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };
      set('selectBlockGoal', o.goal);
      set('selectBlockWeeks', o.weeks);
      set('inputBlockHours', o.hoursPerWeek === null || o.aiChoosesHours ? '' : o.hoursPerWeek);
      set('selectBlockLongDay', o.longDay === null || o.longDay === undefined ? '' : o.longDay);
      set('inputBlockStart', P().today());
      if (days) {
        days.querySelectorAll('[data-dow]').forEach(b => b.classList.toggle('active', o.days.includes(Number(b.dataset.dow))));
        this.on(days, 'click', (e) => {
          const b = e.target.closest('[data-dow]');
          if (b) b.classList.toggle('active');
        });
      }
      this.on(document.getElementById('btnBuildBlock'), 'click', () => this.buildTrainingBlock());
      this.on(document.getElementById('btnReplanBlock'), 'click', () => this.replanTrainingBlock());
      this.on(document.getElementById('btnDeleteBlock'), 'click', () => {
        if (!confirm('Delete this training block? Your rides are not affected.')) return;
        this.blockPlanner.clear();
        this.renderTrainingBlock();
        this.renderCalendarView();
        this.showToast('Training block deleted.', 'success');
      });
      this.on(document.getElementById('btnBlockToCalendar'), 'click', () => {
        this.calendarViewPreset = '1week';
        this.calendarWeekOffset = 0;
        document.querySelectorAll('#calPresetPills .preset-pill').forEach(p => p.classList.toggle('active', p.dataset.preset === '1week'));
        this.switchTab('calendar');
      });
      this.on(document.getElementById('trainingBlockCard'), 'click', (e) => {
        const load = e.target.closest('[data-block-load]');
        if (load) { this.loadBlockSession(load.dataset.blockLoad); return; }
        const sg = e.target.closest('[data-sg]');
        if (sg) {
          const accept = sg.dataset.act === 'accept';
          if (this.blockPlanner.resolveSuggestion(sg.dataset.sg, accept)) {
            this.renderTrainingBlock();
            this.renderCalendarView();
            this.showToast(accept ? 'Plan adjusted.' : 'Suggestion dismissed.', accept ? 'success' : 'info');
          }
        }
      });
      this.reviewTrainingBlock({ announce: false });
      this.renderTrainingBlock();
    },

    readBlockOptions() {
      const val = (id) => (document.getElementById(id) || {}).value;
      const days = Array.from(document.querySelectorAll('#blockDays [data-dow].active')).map(b => Number(b.dataset.dow));
      return {
        goal: val('selectBlockGoal') || 'ftp',
        weeks: parseInt(val('selectBlockWeeks') || '8', 10),
        startDate: val('inputBlockStart') || P().today(),
        hoursPerWeek: String(val('inputBlockHours') || '').trim() === '' ? null : parseFloat(val('inputBlockHours')),
        longDay: val('selectBlockLongDay') === '' ? null : Number(val('selectBlockLongDay')),
        days,
        notes: (document.getElementById('inputAiCoachNotes') || {}).value || ''
      };
    },

    async runBlockTask(btn, label, task) {
      const timer = document.getElementById(this.blockPlanner && this.blockPlanner.block ? 'blockThinkTimerView' : 'blockThinkTimer');
      if (btn) { btn.disabled = true; btn.classList.add('is-loading'); }
      const t0 = performance.now();
      if (timer) { timer.hidden = false; timer.innerHTML = `<span class="spinner"></span>${esc(label)}... 0.0 s`; }
      const tick = setInterval(() => { if (timer) timer.innerHTML = `<span class="spinner"></span>${esc(label)}... ${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 100);
      try {
        const res = await task();
        if (timer) timer.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
        return res;
      } catch (e) {
        console.error('Training block error', e);
        this.showToast('Training block error: ' + e.message, 'error');
        if (timer) timer.hidden = true;
        return null;
      } finally {
        clearInterval(tick);
        if (btn) { btn.disabled = false; btn.classList.remove('is-loading'); }
      }
    },

    async buildTrainingBlock() {
      const opts = this.readBlockOptions();
      if (opts.days.length < 2) { this.showToast('Pick at least two days you can ride.', 'warning'); return; }
      if (opts.hoursPerWeek !== null && (!Number.isFinite(opts.hoursPerWeek) || opts.hoursPerWeek < 2 || opts.hoursPerWeek > 25)) {
        this.showToast('Enter weekly hours between 2 and 25, or leave it blank for the coach to choose.', 'warning'); return;
      }
      try { localStorage.setItem(OPTIONS_KEY, JSON.stringify({ goal: opts.goal, weeks: opts.weeks, hoursPerWeek: opts.hoursPerWeek, longDay: opts.longDay, days: opts.days })); } catch (e) { /* ignore */ }
      const c = this.aiCoach;
      const label = c.isLive ? `Planning with ${VeloAiCoach.labelFor(c.model)}` : 'Planning';
      const res = await this.runBlockTask(document.getElementById('btnBuildBlock'), label, () => this.blockPlanner.create(opts));
      if (!res) return;
      this.blockPlanner.review(this.completedWorkouts, this.aiCoach.getPhysiologicalContext('auto', 60, opts.goal));
      this.renderTrainingBlock();
      this.renderCalendarView();
      if (res.apiError) this.showToast(res.apiError, 'warning');
      else this.showToast(`${res.block.weeks.length}-week block ready - sessions are on your Calendar.`, 'success');
    },

    async replanTrainingBlock() {
      const b = this.blockPlanner.block;
      if (!b) return;
      if (!confirm('Re-plan the remaining weeks from today with your current fitness? Completed weeks are kept.')) return;
      const c = this.aiCoach;
      const label = c.isLive ? `Re-planning with ${VeloAiCoach.labelFor(c.model)}` : 'Re-planning';
      const res = await this.runBlockTask(document.getElementById('btnReplanBlock'), label, () => this.blockPlanner.replanFromToday());
      if (!res) return;
      this.blockPlanner.review(this.completedWorkouts, this.aiCoach.getPhysiologicalContext('auto', 60, b.goal));
      this.renderTrainingBlock();
      this.renderCalendarView();
      this.showToast(res.apiError || 'Remaining weeks re-planned from today.', res.apiError ? 'warning' : 'success');
    },

    /** Called after rides change (new ride, import, sync). Announces new suggestions. */
    reviewTrainingBlock({ announce = true } = {}) {
      if (!this.blockPlanner || !this.blockPlanner.block) return [];
      let fresh = [];
      try {
        const ctx = this.aiCoach.getPhysiologicalContext('auto', 60, this.blockPlanner.block.goal);
        fresh = this.blockPlanner.review(this.completedWorkouts, ctx);
      } catch (e) {
        console.warn('Training block review failed', e);
        return [];
      }
      if (announce && fresh.some(s => s.changes.length)) {
        this.showToast(`Training block: ${fresh.length} suggested adjustment${fresh.length === 1 ? '' : 's'} - see AI Coach.`, 'info');
      }
      if (this.activeTab === 'ai-coach') this.renderTrainingBlock();
      return fresh;
    },

    loadBlockSession(id) {
      const w = this.blockPlanner && this.blockPlanner.workoutFor(id);
      if (!w) return;
      this.loadWorkoutObjectIntoCockpit(w);
      this.showToast('Planned session loaded - press START when ready.', 'success');
    },

    blockSessionRow(s, today) {
      const F = P().FOCUS[s.focus] || {};
      const st = s.status === 'done' ? `<span class="chip chip-lime chip-xs">Done${s.actualTss ? ` - ${s.actualTss} TSS` : ''}</span>`
        : s.status === 'missed' ? '<span class="chip chip-xs bs-missed">Missed</span>'
          : s.date === today ? '<span class="chip chip-accent chip-xs">Today</span>' : '';
      const canLoad = s.status === 'planned';
      return `<div class="bs-row ${s.status}" style="--fc:${F.color || '#64748b'}">
        <span class="bs-date num">${esc(fmtDay(s.date))}</span>
        <span class="bs-title"><b>${esc(s.title)}</b>${s.adjusted ? '<span class="chip chip-violet chip-xs">Adjusted</span>' : ''}${st}</span>
        <span class="bs-meta num">${s.durationMin} min - ${s.tss} TSS</span>
        ${canLoad ? `<button type="button" class="btn btn-sm" data-block-load="${esc(s.id)}"><svg class="ic"><use href="#i-play"/></svg>Load</button>` : '<span></span>'}
      </div>`;
    },

    renderTrainingBlock() {
      const setup = document.getElementById('blockSetup');
      const view = document.getElementById('blockView');
      if (!setup || !view || !this.blockPlanner) return;
      const c = this.aiCoach;
      const btnLabel = document.getElementById('btnBuildBlockLabel');
      if (btnLabel) btnLabel.textContent = c.isLive ? `Build block with ${VeloAiCoach.labelFor(c.model)}` : 'Build block (built-in engine)';
      const b = this.blockPlanner.block;
      setup.hidden = !!b;
      view.hidden = !b;
      this.setText('blockHeaderChip', b ? `${b.weeks.length} weeks` : 'Periodised plan');
      if (!b) return;

      const goal = VeloAiCoach.GOALS[b.goal] || VeloAiCoach.GOALS.ftp;
      const today = P().today();
      this.setText('blockTitle', `${goal.label} block`);
      const by = b.source === 'offline_heuristic' ? 'Built-in periodisation engine' : `Designed with ${b.modelLabel || VeloAiCoach.labelFor(b.model)}`;
      this.setText('blockSubtitle', `${fmtDay(b.startDate, { month: 'short', day: 'numeric' })} - ${fmtDay(b.endDate, { month: 'short', day: 'numeric', year: 'numeric' })} - ${b.options.aiChoosesHours ? 'Weekly hours chosen from your training' : `Up to ${b.options.hoursPerWeek} h/week`} - ${by}`);
      const sumEl = document.getElementById('blockSummary');
      if (sumEl) {
        sumEl.innerHTML = esc(b.summary || '') + (b.thinking
          ? `<details class="block-thinking"><summary>Coach reasoning</summary><div>${esc(b.thinking).replace(/\n/g, '<br>')}</div></details>` : '');
      }

      // Suggestions
      const sgEl = document.getElementById('blockSuggestions');
      const pending = this.blockPlanner.pendingSuggestions();
      if (sgEl) {
        sgEl.innerHTML = pending.map(s => `
          <div class="block-sg ${esc(s.type)}">
            <div><b>${esc(s.title)}</b><small>${esc(s.reason)}</small></div>
            <div class="btn-row">
              ${s.changes.length ? `<button type="button" class="btn btn-sm btn-primary" data-sg="${esc(s.id)}" data-act="accept">Apply</button>` : ''}
              <button type="button" class="btn btn-sm" data-sg="${esc(s.id)}" data-act="dismiss">${s.changes.length ? 'Dismiss' : 'OK'}</button>
            </div>
          </div>`).join('');
      }

      // Weeks overview (planned vs done)
      const weeksEl = document.getElementById('blockWeeks');
      if (weeksEl) {
        const maxT = Math.max(1, ...b.weeks.map(w => Math.max(w.plannedTss || 0, w.doneTss || 0)));
        weeksEl.innerHTML = b.weeks.map(w => {
          const end = P().addDays(w.start, 6);
          const isNow = today >= w.start && today <= end;
          const tag = w.type === 'recovery' ? 'Recovery' : w.type === 'test' ? 'Test' : `Load ${w.stage || ''}`;
          return `<div class="bw ${w.type} ${isNow ? 'now' : ''}" title="${esc(w.phase)}${w.notes ? ' - ' + esc(w.notes) : ''}${w.cappedByHours ? ' - limited by your available hours' : ''}">
            <span class="bw-bars"><span class="bw-plan" style="height:${((w.plannedTss || 0) / maxT) * 100}%"></span><span class="bw-done" style="height:${((w.doneTss || 0) / maxT) * 100}%"></span></span>
            <b class="num">W${w.index}</b>
            <small>${esc(tag)}</small>
            <small class="num">${b.options.aiChoosesHours ? `${Math.round(w.plannedMin / 6) / 10} h` : `${w.plannedTss} TSS`}</small>
          </div>`;
        }).join('');
      }
      const legend = document.getElementById('blockPhaseLegend');
      if (legend) {
        const phases = [];
        b.weeks.forEach(w => { const last = phases[phases.length - 1]; if (last && last.name === w.phase) last.to = w.index; else phases.push({ name: w.phase, from: w.index, to: w.index, type: w.type }); });
        legend.innerHTML = phases.map(p => `<span class="chip chip-ghost chip-phase ${p.type}">W${p.from}${p.to !== p.from ? '-' + p.to : ''}: ${esc(p.name)}</span>`).join('');
      }

      // This week (or the first week if the block has not started)
      const cur = this.blockPlanner.weekOf(today) || b.weeks.find(w => w.start > today) || b.weeks[b.weeks.length - 1];
      const listEl = document.getElementById('blockThisWeek');
      if (cur) {
        const tag = cur.type === 'recovery' ? 'recovery week' : cur.type === 'test' ? 'recovery + test week' : `load week ${cur.stage}`;
        this.setText('blockWeekLabel', `Week ${cur.index} - ${cur.phase} (${tag})`);
        this.setText('blockWeekTss', b.options.aiChoosesHours ? `${Math.round(cur.plannedMin / 6) / 10} h planned` : `${cur.doneTss || 0} / ${cur.plannedTss} TSS`);
        this.setText('blockWeekNotes', cur.notes || (cur.cappedByHours ? (b.options.aiChoosesHours ? 'Ride time is kept within the allowance based on your recent training.' : 'This week is limited by the hours you have: the key sessions keep priority.') : ''));
        if (listEl) listEl.innerHTML = cur.sessions.length ? cur.sessions.map(s => this.blockSessionRow(s, today)).join('') : '<div class="empty-state">No sessions this week.</div>';
      }
      const next = b.weeks.find(w => cur && w.index === cur.index + 1);
      const nextEl = document.getElementById('blockNextWeek');
      if (nextEl) {
        nextEl.innerHTML = next ? `<div class="ai-coach-card-title"><span>Next: week ${next.index} - ${esc(next.phase)}</span><span class="chip chip-ghost num">${next.plannedTss} TSS</span></div>
          ${next.sessions.map(s => this.blockSessionRow(s, today)).join('')}` : '';
      }
    },

    /** Calendar card for a planned (not yet ridden) session. */
    plannedCardHtml(s, mini = false) {
      const F = P().FOCUS[s.focus] || {};
      const missed = s.status === 'missed';
      if (mini) {
        return `<div class="calendar-ride-card mini planned ${missed ? 'missed' : ''}" data-planned="${esc(s.id)}" title="Planned: ${esc(s.title)} - ${s.durationMin} min${missed ? ' (missed)' : ''}" style="--zc:${F.color || 'var(--line-strong)'}">
          <div class="crc-row"><span class="crc-title">${esc(s.title)}</span></div>
          <div class="crc-meta num">${missed ? 'Missed' : `Plan - ${s.durationMin}m`}</div></div>`;
      }
      return `<div class="calendar-ride-card planned ${missed ? 'missed' : ''}" data-planned="${esc(s.id)}" style="--zc:${F.color || 'var(--line-strong)'}">
        <div class="crc-row"><span class="crc-title" title="${esc(s.title)}">${esc(s.title)}</span><span class="chip chip-xs ${missed ? 'bs-missed' : 'chip-violet'}">${missed ? 'Missed' : 'Planned'}</span></div>
        <div class="crc-meta num"><span>${s.durationMin} min</span><b>${s.tss} TSS</b></div>
        ${missed ? '' : `<button type="button" class="btn btn-sm crc-load" data-block-load-cal="${esc(s.id)}"><svg class="ic"><use href="#i-play"/></svg>Load</button>`}
      </div>`;
    },

    /** Planned sessions (not done) by date, for the calendar views. */
    plannedByDay() {
      const m = new Map();
      if (!this.blockPlanner || !this.blockPlanner.block) return m;
      this.blockPlanner.allSessions().forEach(s => {
        if (s.status === 'done' || s.status === 'skipped') return;
        if (!m.has(s.date)) m.set(s.date, []);
        m.get(s.date).push(s);
      });
      return m;
    }
  });
})();
