/**
 * APEX VELO // LAB - AI Coach: engine settings, the engine switchers, the coach's live numbers and the
 * evidence list (mixin on VeloApp). The coach chat itself (questions, workouts and plans in one thread)
 * is js/app-coach-chat.js.
 */
(function () {
  const esc = (s) => VeloApp.esc(s);

  /** Tiny, safe markdown renderer for the reasoning trace (escape first, then format). */
  function renderMarkdown(src) {
    const text = String(src || '').replace(/\r/g, '');
    const blocks = [];
    // Fenced code blocks
    let body = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (m, lang, code) => {
      blocks.push(highlight(code, lang));
      return `\u0000${blocks.length - 1}\u0000`;
    });
    body = esc(body);
    const inline = (s) => s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\b(\d{2,4}\s?W|\d{1,3}%\s?FTP|TSB|CTL|ATL|FTP|VO2\s?max|Z[1-7])\b/g, '<mark>$1</mark>');
    const out = [];
    let list = null;
    body.split('\n').forEach(line => {
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
      const code = line.match(/^\u0000(\d+)\u0000$/);
      if (!li && list) { out.push(`</${list}>`); list = null; }
      if (code) out.push(blocks[Number(code[1])]);
      else if (h) out.push(`<h${Math.min(6, h[1].length + 3)}>${inline(h[2])}</h${Math.min(6, h[1].length + 3)}>`);
      else if (li) {
        const type = /^\s*\d+\./.test(line) ? 'ol' : 'ul';
        if (!list) { list = type; out.push(`<${type}>`); }
        out.push(`<li>${inline(li[1])}</li>`);
      } else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    });
    if (list) out.push(`</${list}>`);
    return out.join('');
  }

  function highlight(code, lang) {
    let h = esc(code);
    if (!lang || /json|js|javascript/i.test(lang)) {
      h = h.replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="tk-key">$1</span>$2')
        .replace(/:\s*(&quot;[^&]*?&quot;)/g, ': <span class="tk-str">$1</span>')
        .replace(/(?<![#\w])(-?\d+(?:\.\d+)?)\b/g, '<span class="tk-num">$1</span>')
        .replace(/\b(true|false|null)\b/g, '<span class="tk-kw">$1</span>');
    }
    return `<pre class="code"><code>${h}</code></pre>`;
  }

  Object.assign(VeloApp.prototype, {
    initAiCoachUi() {
      const providerSelect = document.getElementById('selectCoachProvider');
      const modelSelect = document.getElementById('selectCoachModel');
      const effortSelect = document.getElementById('selectCoachEffort');
      const lookbackSelect = document.getElementById('selectAiCoachLookback');
      if (providerSelect) providerSelect.value = this.aiCoach.provider;
      this.fillCoachModelOptions();
      if (effortSelect) effortSelect.value = this.aiCoach.effortOverride;
      if (lookbackSelect) {
        lookbackSelect.value = String(this.aiCoach.lookbackDays);
        this.on(lookbackSelect, 'change', () => {
          const d = this.aiCoach.setLookback(lookbackSelect.value);
          this.showToast(`Coach will look back ${d} days.`, 'success');
        });
      }
      // Every AI engine switcher, wherever it is (including ones rendered later), changes the engine at once.
      this.on(document, 'change', (e) => {
        const sel = e.target && e.target.closest && e.target.closest('select[data-ai-pick]');
        if (sel) this.pickAiEngine(sel.value);
      });
      // Switching provider applies at once (and resets the model to that provider's default).
      this.on(providerSelect, 'change', () => {
        this.aiCoach.saveConfig({ provider: providerSelect.value, model: '' });
        this.fillCoachModelOptions();
        this.updateCoachEngineStatus();
        const c = this.aiCoach;
        this.showToast(c.isLive ? `Coach switched to ${VeloAiCoach.labelFor(c.model)}.` : `${c.providerLabel} selected, but the server has no ${VeloAiCoach.PROVIDERS[c.provider].keyName} yet - see the AI engine card.`, c.isLive ? 'success' : 'warning');
      });
      try { this.coachGoal = localStorage.getItem('apex_coach_goal') || 'ftp'; } catch (e) { /* ignore */ }
      document.querySelectorAll('#aiCoachGoalPills .goal-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.goal === this.coachGoal);
        this.on(p, 'click', () => {
          document.querySelectorAll('#aiCoachGoalPills .goal-pill').forEach(x => x.classList.toggle('active', x === p));
          this.coachGoal = p.dataset.goal;
          try { localStorage.setItem('apex_coach_goal', this.coachGoal); } catch (e) { /* ignore */ }
          this.updateCoachGoButton();
        });
      });

      // The options under the chat's message box: chip rows for the lengths, kept in step with their selects.
      this.enhanceChipSelects();
      this.on(document.getElementById('coachPlanToday'), 'click', (e) => {
        const load = e.target.closest('[data-block-load]');
        if (load) this.loadBlockSession(load.dataset.blockLoad);
      });
      this.on(document.getElementById('btnSaveAiCoachConfig'), 'click', () => {
        this.aiCoach.saveConfig({
          provider: providerSelect ? providerSelect.value : this.aiCoach.providerOverride,
          model: modelSelect ? modelSelect.value : '',
          effort: effortSelect ? effortSelect.value : ''
        });
        this.updateCoachEngineStatus();
        const m = this.aiCoach.model;
        this.showToast(`Coach set to ${VeloAiCoach.labelFor(m)}${VeloAiCoach.supportsEffort(m) ? `, ${this.aiCoach.effort} effort` : ''}.`, 'success');
      });
      this.on(document.getElementById('btnRecheckAiEngine'), 'click', () => this.refreshCoachEngine(true));

      this.updateCoachEngineStatus();
      if (this.initTrainingBlockUi) this.initTrainingBlockUi();
      this.refreshCoachEngine(false);
    },

    /** Fills the model list for the chosen provider ("Default" = the server's default for that provider). */
    fillCoachModelOptions() {
      const sel = document.getElementById('selectCoachModel');
      if (!sel) return;
      const c = this.aiCoach;
      const p = c.provider;
      const ep = c.engine.providers && c.engine.providers[p];
      const def = (ep && ep.model) || VeloAiCoach.PROVIDERS[p].defaultModel;
      const opts = [`<option value="">Default (${esc(VeloAiCoach.labelFor(def))})</option>`]
        .concat(VeloAiCoach.modelsFor(p).map(id => `<option value="${esc(id)}">${esc(VeloAiCoach.labelFor(id))}</option>`));
      sel.innerHTML = opts.join('');
      sel.value = c.modelOverride && VeloAiCoach.providerOf(c.modelOverride) === p ? c.modelOverride : '';
    },

    // ---------------------------------------------------------------- AI engine picker --
    // One small switcher wherever AI is used (the coach chat, ride breakdowns, settings). It is a native
    // <select>, so a phone shows its own picker. Every copy changes the same choice as Settings > AI engine, and
    // updateCoachEngineStatus() keeps them all in step.

    /** The options: each provider's models (live list when known), the current one selected, then AI settings. */
    aiPickerOptions() {
      const c = this.aiCoach;
      if (!c) return '';
      const cur = c.model;
      // Which keys exist is known once the server answers, and always in the Android app (keys live on the phone).
      const knowsKeys = c.engine.reachable || document.documentElement.classList.contains('apex-native');
      const groups = Object.keys(VeloAiCoach.PROVIDERS).map((p) => {
        const ep = c.engine.providers && c.engine.providers[p];
        const noKey = knowsKeys && !(ep && ep.configured);
        const ids = VeloAiCoach.modelsFor(p);
        if (VeloAiCoach.providerOf(cur) === p && !ids.includes(cur)) ids.unshift(cur);
        const opts = ids.map((id) => `<option value="${esc(id)}"${id === cur ? ' selected' : ''}>${esc(VeloAiCoach.labelFor(id))}${noKey ? ' (no key)' : ''}</option>`).join('');
        return `<optgroup label="${esc(VeloAiCoach.PROVIDERS[p].label)}${noKey ? ' - no API key' : ''}">${opts}</optgroup>`;
      });
      return groups.join('') + '<option value="__settings">AI settings...</option>';
    },

    /** The switcher's markup (`where` names the place, for tests and styles). */
    aiPickerHtml(where = '') {
      return `<label class="ai-pick${this.aiCoach && this.aiCoach.isLive ? ' live' : ''}" title="AI engine for the coach chat and ride breakdowns"><svg class="ic ic-xs" aria-hidden="true"><use href="#i-sparkles"/></svg><span class="sr-only">AI engine</span><select class="ai-pick-select" data-ai-pick="${esc(where)}">${this.aiPickerOptions()}</select></label>`;
    },

    /** Brings every switcher on the page up to date (options, selection, live state). */
    refreshAiPickers() {
      const c = this.aiCoach;
      if (!c) return;
      const html = this.aiPickerOptions();
      document.querySelectorAll('select[data-ai-pick]').forEach((sel) => {
        if (sel._aiOpts !== html) { sel.innerHTML = html; sel._aiOpts = html; }
        sel.value = c.model;
        const wrap = sel.closest('.ai-pick');
        if (wrap) wrap.classList.toggle('live', c.isLive);
      });
    },

    /** A switcher changed: use that model (and its provider) everywhere from now on. */
    pickAiEngine(value) {
      if (value === '__settings') {
        this.refreshAiPickers();
        if (this.openSettings) this.openSettings('ai');
        return;
      }
      const provider = VeloAiCoach.providerOf(value);
      this.aiCoach.saveConfig({ provider, model: value });
      const providerSelect = document.getElementById('selectCoachProvider');
      if (providerSelect) providerSelect.value = provider;
      this.fillCoachModelOptions();
      this.updateCoachEngineStatus();
      const c = this.aiCoach;
      if (c.isLive) this.showToast(`AI engine: ${VeloAiCoach.labelFor(c.model)}.`, 'success');
      else this.showToast(`${c.providerLabel} has no API key yet - add it in ${this.settingsLabel ? this.settingsLabel('ai') : 'Settings > AI engine'}. Until then the built-in engine is used.`, 'warning');
    },

    /** Re-reads the local server's status (which keys are present, default models) and updates the UI. */
    async refreshCoachEngine(announce) {
      await this.aiCoach.detectEngine(3000, !!announce);  // "Re-check server" also re-reads every provider's model list
      const providerSelect = document.getElementById('selectCoachProvider');
      if (providerSelect) providerSelect.value = this.aiCoach.provider;
      this.fillCoachModelOptions();
      this.updateCoachEngineStatus();
      if (!announce) return;
      const c = this.aiCoach;
      if (c.isLive) this.showToast(`${c.providerLabel} ready - ${VeloAiCoach.labelFor(c.model)}.`, 'success');
      else if (c.engine.reachable) this.showToast(`Server found, but no ${VeloAiCoach.PROVIDERS[c.provider].keyName} yet. Add it to .env and restart Launch-Apex-Velo.bat.`, 'warning');
      else this.showToast(`Local server not running - open the app with Launch-Apex-Velo.bat to use ${c.providerLabel}.`, 'warning');
    },

    /** Turns each <select data-chips> into a row of tappable chips; the select stays the source of truth. */
    enhanceChipSelects() {
      document.querySelectorAll('select[data-chips]').forEach(sel => {
        if (sel.dataset.chipsReady) return;
        sel.dataset.chipsReady = '1';
        sel.classList.add('sr-only');
        sel.tabIndex = -1;
        const row = document.createElement('div');
        row.className = 'chip-select';
        row.setAttribute('role', 'radiogroup');
        if (sel.getAttribute('aria-labelledby')) row.setAttribute('aria-labelledby', sel.getAttribute('aria-labelledby'));
        row.innerHTML = Array.from(sel.options).map(o => `<button type="button" role="radio" data-value="${esc(o.value)}" title="${esc(o.textContent)}">${esc(o.dataset.chip || o.textContent)}</button>`).join('');
        const sync = () => row.querySelectorAll('button').forEach(b => {
          const on = b.dataset.value === sel.value;
          b.classList.toggle('active', on);
          b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        this.on(row, 'click', (e) => {
          const b = e.target.closest('button[data-value]');
          if (!b || b.dataset.value === sel.value) return;
          sel.value = b.dataset.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
        this.on(sel, 'change', sync);
        sel.insertAdjacentElement('afterend', row);
        sync();
      });
    },

    /** Beside the chat: today's session from the active plan, ready to load (nothing when the plan has none today). */
    renderCoachPlanToday() {
      const el = document.getElementById('coachPlanToday');
      if (!el) return;
      const bp = this.blockPlanner;
      const today = bp && bp.block ? VeloBlockPlanner.today() : null;
      const s = today ? (bp.sessionsByDate().get(today) || []).find(x => x.status === 'planned') : null;
      el.hidden = !s;
      if (!s) { el.innerHTML = ''; return; }
      el.innerHTML = `<svg class="ic"><use href="#i-calendar"/></svg><div><small>Today in your plan</small><b>${esc(s.title)}</b> <span class="num">${s.durationMin} min</span></div>
        <div class="btn-row btn-row-tight"><button type="button" class="btn btn-sm btn-primary" data-block-load="${esc(s.id)}"><svg class="ic"><use href="#i-play"/></svg>Load</button></div>`;
    },

    updateCoachEngineStatus() {
      this.refreshAiPickers();
      if (this.updateAskEngine) this.updateAskEngine();
      if (this.updateCoachGoButton) this.updateCoachGoButton();
      const el = document.getElementById('aiCoachEngineStatus');
      const detail = document.getElementById('aiCoachEngineDetail');
      const c = this.aiCoach;
      const m = c.model;
      const pLabel = c.providerLabel;
      const keyName = VeloAiCoach.PROVIDERS[c.provider].keyName;
      const modelText = `${VeloAiCoach.labelFor(m)}${VeloAiCoach.supportsEffort(m) ? ` - ${c.effort} effort` : ''}`;
      const state = c.isLive ? 'live' : c.engine.reachable ? 'warn' : '';
      if (el) {
        el.className = `engine-pill ${state}`;
        el.innerHTML = `<span class="status-indicator-dot"></span>${c.isLive ? esc(modelText) : c.engine.reachable ? `${esc(pLabel)}: API key missing` : 'Offline physiology engine'}`;
      }
      if (detail) {
        const keys = Object.entries(c.engine.providers || {})
          .map(([, p]) => `${esc(p.label)} ${p.configured ? 'key found' : 'no key'}`).join(' &middot; ');
        detail.innerHTML = c.isLive
          ? `<strong>Connected.</strong> Requests go to ${esc(modelText)} through the local server. <span style="opacity:.7">(${keys})</span>`
          : c.engine.reachable
            ? `<strong>No ${esc(pLabel)} API key.</strong> Paste your key after <code>${keyName}=</code> in the <code>.env</code> file, then restart <code>Launch-Apex-Velo.bat</code>. <span style="opacity:.7">(${keys})</span>`
            : '<strong>Local server not running.</strong> Open the app with <code>Launch-Apex-Velo.bat</code> (it serves the app and holds your keys). Until then the offline engine is used.';
      }
    },

    updateAiCoachTelemetry() {
      const profile = this.activeProfile;
      const pmc = this.analytics.calculatePmcHistory(this.completedWorkouts, 0, this.pmcOpts());
      this.setText('aiCoachFtpVal', `${profile.ftp}W`);
      this.setText('aiCoachCtlVal', pmc.currentCtl.toFixed(1));
      this.setText('aiCoachAtlVal', pmc.currentAtl.toFixed(1));
      const tsbEl = document.getElementById('aiCoachTsbVal');
      if (tsbEl) {
        tsbEl.textContent = `${pmc.currentTsb > 0 ? '+' : ''}${pmc.currentTsb.toFixed(1)}`;
        tsbEl.dataset.form = VeloMetrics.formZone(pmc.currentTsb).key;
        tsbEl.title = `Form: ${VeloMetrics.formZone(pmc.currentTsb).label}`;
      }
      const since = Date.now() - 7 * 86400000;
      const tss7 = Math.round(this.cyclingRides().filter(w => new Date(w.date).getTime() >= since).reduce((s, w) => s + (w.tss || 0), 0));
      this.setText('aiCoach7DayTssVal', `${tss7} TSS`);

      const h = VeloProgress.coachProfile(this.cyclingRides(), profile.ftp);
      const ins = document.getElementById('aiCoachInsights');
      if (ins) {
        const chip = (label, val) => `<span class="insight"><small>${label}</small><b class="num">${val}</b></span>`;
        ins.innerHTML = [
          chip('4-week volume', `${h.hoursPerWeek4w} h/wk`),
          chip('Rides (28 d)', h.rides28),
          chip('Easy / mid / hard', h.lowIntensityPct === null ? 'n/a' : `${h.lowIntensityPct}/${h.midIntensityPct}/${h.highIntensityPct}%`),
          chip('Last hard ride', h.daysSinceHard === null ? 'none' : `${h.daysSinceHard} d ago`),
          chip('Last 90+ min ride', h.daysSinceLong === null ? 'none' : `${h.daysSinceLong} d ago`),
          h.profileType ? chip('Power profile', h.profileType.split(' [')[0]) : ''
        ].join('');
      }
      this.updateCoachEngineStatus();
    },

    /** "The science behind this": plain-language findings, their evidence grade and the source study. */
    evidenceHtml(list) {
      const S = typeof VeloSportScience !== 'undefined' ? VeloSportScience : null;
      const items = (Array.isArray(list) ? list : []).map(e => {
        const full = S && e.ref ? S.REFERENCES[e.ref] || '' : '';
        const grade = e.grade && S ? `<span class="chip chip-ghost chip-xs" title="Evidence grade ${esc(e.grade)}: ${esc(S.GRADES[e.grade] || '')}">Grade ${esc(e.grade)}</span>` : '';
        const ref = e.ref ? `<small class="evidence-ref" title="${esc(full)}">${esc(e.ref)}</small>` : '';
        return `<li><b>${esc(e.principle)}</b> ${grade}<span class="evidence-why">${esc(e.why)}</span>${ref}</li>`;
      }).join('');
      if (!items) return '';
      const foot = S ? `<p class="evidence-foot">Evidence base reviewed ${esc(S.REVIEWED)}. Grade A: ${esc(S.GRADES.A)}; B: ${esc(S.GRADES.B)}; C: ${esc(S.GRADES.C)}. Hover a source for the full reference.</p>` : '';
      return `<ul class="evidence-list">${items}</ul>${foot}`;
    },

  });

  if (typeof window !== 'undefined') window.VeloMarkdown = { render: renderMarkdown };
})();
