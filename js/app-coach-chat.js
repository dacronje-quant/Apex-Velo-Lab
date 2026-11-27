/**
 * APEX VELO // LAB - AI Coach chat: one conversation for everything AI (mixin on VeloApp).
 *
 * The rider ticks what they want above the message box and types in their own words:
 *  - Ask about my riding: the question, the conversation and the period's data summary go to /api/ask
 *    (js/app-ask.js builds the summary); the answer is a message in the thread.
 *  - Create a workout: the coach (js/velo-ai-coach.js, /api/coach, or the built-in engine without a key)
 *    builds one session from the rider's form, the options and their words; it shows as a workout card
 *    in the thread to ride, save, change or rebuild.
 *  - Plan my training: the block planner (js/velo-block-planner.js) builds a 4-12 week plan from the
 *    options and their words; it shows as a plan card, and the full plan sits beside the chat.
 * Every turn sees the conversation so far (js/velo-coach-chat.js), so a question can become a workout
 * ("Make it a workout"), and "make it shorter" changes the last one. The thread stays on this device
 * (apex_ask_v1, shared with the period), and the same view is the phone's Train > Coach page.
 */
(function () {
  const STORE_KEY = 'apex_ask_v1';
  const INTENT_KEY = 'apex_coach_intent';
  const ASK_URL = 'api/ask';
  const TIMEOUT_MS = 190000;
  const MAX_STORED = 60;
  const MAX_TEXT = 4000;
  const ROLES = ['user', 'assistant', 'note', 'workout', 'plan'];
  const DAY = 86400000;
  const CC = () => VeloCoachChat;
  const newMsgId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (id, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
  const $ = (id) => document.getElementById(id);
  const md = (t) => (window.VeloMarkdown ? window.VeloMarkdown.render(t) : `<p>${esc(t)}</p>`);
  const fmtDay = (k) => { const d = new Date(`${k}T12:00:00`); return Number.isNaN(d.getTime()) ? String(k || '') : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
  const WORKOUT_EXAMPLES = [
    { text: '', label: "Today's workout from my form" },
    { text: '45 min sweet spot', label: '45 min sweet spot' },
    { text: '5x3 min VO2 max with 3 min easy between', label: '5x3 min VO2 max' },
    { text: 'Easy 60 min spin, my legs are tired', label: 'Easy spin, legs tired' }
  ];
  const PLAN_EXAMPLES = ['8 weeks to raise my FTP', 'Gran fondo in 10 weeks, 4 rides a week', '6 hours a week, no rides on Friday'];
  const ASK_EXAMPLES = [0, 1, 3, 7];  // indexes into VeloAsk.SUGGESTIONS

  /** Keeps stored messages the thread can show; anything else (an older version's leftovers) is dropped. */
  function storedMessage(m) {
    if (!m || !ROLES.includes(m.role)) return false;
    if (m.role === 'workout') return !!(m.workout && Array.isArray(m.workout.intervals) && m.workout.intervals.length);
    if (m.role === 'plan') return !!(m.plan && typeof m.plan === 'object');
    return typeof m.content === 'string';
  }

  Object.assign(VeloApp.prototype, {
    initCoachChat() {
      this.askMessages = [];
      this.askClearedAt = 0;
      try {
        const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
        if (s && Array.isArray(s.messages)) this.askMessages = s.messages.filter(storedMessage).slice(-MAX_STORED).map(m => (m.id ? m : { ...m, id: newMsgId() }));
        if (s && Number.isFinite(Number(s.clearedAt))) this.askClearedAt = Number(s.clearedAt);
      } catch (e) { /* storage unavailable: start empty */ }
      let intent = null;
      try { intent = localStorage.getItem(INTENT_KEY); } catch (e) { /* ignore */ }
      this.coachIntent = CC().INTENTS[intent] ? intent : 'chat';
      this._coachReady = true;

      const form = $('askForm'), input = $('askInput');
      if (form) {
        this.on(form, 'submit', (e) => { e.preventDefault(); this.sendCoachMessage(input ? input.value : ''); });
        this.on(form, 'keydown', (e) => {
          if (e.key !== 'Escape' || $('coachTray')?.hidden) return;
          e.preventDefault();
          this.toggleCoachOptions(false);
          $('btnCoachOptions')?.focus();
        });
      }
      if (input) {
        this.on(input, 'keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.sendCoachMessage(input.value); } });
        this.on(input, 'input', () => { this.sizeAskInput(); this.updateCoachGoButton(); });
      }
      const intents = $('coachIntents');
      if (intents) {
        this.on(intents, 'click', (e) => { const b = e.target.closest('[data-intent]'); if (b) this.setCoachIntent(b.dataset.intent, { focus: true }); });
        // A radio group: arrow keys move the tick.
        this.on(intents, 'keydown', (e) => {
          const keys = CC().INTENT_KEYS, i = keys.indexOf(this.coachIntent);
          const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
          if (!step) return;
          e.preventDefault();
          this.setCoachIntent(keys[(i + step + keys.length) % keys.length]);
          intents.querySelector(`[data-intent="${this.coachIntent}"]`)?.focus();
        });
      }
      this.on($('btnCoachOptions'), 'click', () => this.toggleCoachOptions());
      const tray = $('coachTray');
      if (tray) {
        this.on(tray, 'change', () => this.updateCoachGoButton());
        this.on(tray, 'input', () => this.updateCoachGoButton());
        // The day and goal buttons have their own handlers (deeper in the tray), so their state is already toggled here.
        this.on(tray, 'click', (e) => { if (e.target.closest('[data-dow], .goal-pill')) { this.syncCoachOptionStates(); this.updateCoachGoButton(); } });
      }
      this.on($('btnAskStop'), 'click', () => this.stopCoach());
      this.on($('btnAskClear'), 'click', () => {
        if (this.askMessages.length && confirm('Clear this chat? The questions, answers, workouts and plan cards are removed from this device (a plan stays on your Calendar).')) this.newAskChat();
      });
      this.on($('btnCoachShowPlan'), 'click', () => this.openTrainingPlan());
      const thread = $('askThread');
      if (thread) this.on(thread, 'click', (e) => this.onCoachThreadClick(e));
      // Ways in from the rest of the app: "Create with the coach", a plan's empty card, a ride's "Discuss with the coach".
      this.on(document, 'click', (e) => {
        const open = e.target.closest && e.target.closest('[data-coach-open]');
        if (open) { e.preventDefault(); this.openCoach(open.dataset.coachOpen); return; }
        const ride = e.target.closest && e.target.closest('[data-coach-discuss]');
        if (ride) { e.preventDefault(); this.discussRideWithCoach(ride.dataset.coachDiscuss); }
      });
      this.syncCoachOptionStates();
      this._coachShown = this.askMessages.length;  // a saved chat appears as it was; only new turns ease in
      this.setCoachIntent(this.coachIntent, { persist: false });
      this.renderAskThread();
    },

    /** Ride days are toggle buttons and the goals a radio group: their ARIA state follows what is picked. */
    syncCoachOptionStates() {
      document.querySelectorAll('#blockDays [data-dow]').forEach((b) => b.setAttribute('aria-pressed', String(b.classList.contains('active'))));
      document.querySelectorAll('#aiCoachGoalPills .goal-pill').forEach((b) => { b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(b.classList.contains('active'))); });
    },

    /** One short line for screen readers (the thread itself is redrawn, so it is not a live region). */
    coachAnnounce(text) {
      const el = $('coachStatus');
      if (!el) return;
      el.textContent = '';
      requestAnimationFrame(() => { el.textContent = text; });
    },

    /** The Coach tab opened: fresh numbers, the cards drawn at their size, the message box ready on a desktop. */
    onCoachTab() {
      if (!this._coachReady) return;
      this.renderAskPeriod();
      this.updateAskEngine();
      this.updateCoachGoButton();
      this.renderAskThread();
      const input = $('askInput');
      const desktop = !document.documentElement.classList.contains('apex-native') && window.matchMedia && window.matchMedia('(pointer: fine)').matches;
      if (input && desktop && !this._askBusy) requestAnimationFrame(() => input.focus({ preventScroll: true }));
    },

    /** Ticks what the coach should do with the next message: 'chat', 'workout' or 'plan'. */
    setCoachIntent(intent, { persist = true, focus = false } = {}) {
      const I = CC().INTENTS;
      if (!I[intent]) intent = 'chat';
      this.coachIntent = intent;
      this.coachMode = intent === 'workout' ? 'session' : intent;  // the older name, for callers that still read it
      const view = $('view-ai-coach');
      if (view) view.dataset.intent = intent;
      document.querySelectorAll('#coachIntents [data-intent]').forEach((b) => {
        const on = b.dataset.intent === intent;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      });
      document.querySelectorAll('#coachTray .coach-pane').forEach((p) => { p.hidden = !String(p.dataset.pane || '').split(/\s+/).includes(intent); });
      this.syncCoachOptionStates();
      const input = $('askInput');
      const narrow = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
      if (input) input.placeholder = (narrow && I[intent].placeholderShort) || I[intent].placeholder;
      const use = $('coachSendIcon');
      if (use) use.setAttribute('href', `#${I[intent].icon}`);
      if (persist) try { localStorage.setItem(INTENT_KEY, intent); } catch (e) { /* ignore */ }
      this.updateAskEngine();
      this.updateCoachGoButton();
      this.renderCoachPlanToday && this.renderCoachPlanToday();
      if (!this.askMessages.length && !this._askBusy) this.renderAskThread();
      if (focus && input) requestAnimationFrame(() => input.focus({ preventScroll: true }));
    },

    /** Older callers: 'session' (one workout) or 'plan'. */
    setCoachMode(mode) { this.setCoachIntent(mode === 'plan' ? 'plan' : 'workout'); },

    /**
     * Opens the coach with `intent` ticked; `text` goes in the message box, `send` sends it at once.
     * Every AI entry point of the app comes here.
     */
    openCoach(intent = 'chat', { text = null, send = false, focus = true } = {}) {
      if (this.activeTab !== 'ai-coach') this.switchTab('ai-coach');
      this.setCoachIntent(intent);
      const input = $('askInput');
      if (input && text !== null) { input.value = text; this.sizeAskInput(); this.updateCoachGoButton(); }
      if (send) { this.sendCoachMessage(input ? input.value : String(text || '')); return; }
      if (focus && input) requestAnimationFrame(() => { input.focus({ preventScroll: true }); const n = input.value.length; try { input.setSelectionRange(n, n); } catch (e) { /* ignore */ } });
    },

    /** Shows the whole plan: beside the chat (the phone opens its own plan page through onOpenTrainingPlan). */
    openTrainingPlan() {
      if (typeof this.onOpenTrainingPlan === 'function' && this.onOpenTrainingPlan() === true) return;
      if (this.activeTab !== 'ai-coach') this.switchTab('ai-coach');
      const card = $(this.blockPlanner && this.blockPlanner.block ? 'trainingBlockCard' : 'planWelcomeCard');
      if (!card) return;
      requestAnimationFrame(() => {
        card.scrollIntoView({ block: 'start', behavior: 'smooth' });
        card.classList.add('coach-flash');
        setTimeout(() => card.classList.remove('coach-flash'), 1400);
      });
    },

    toggleCoachOptions(open = null) {
      const tray = $('coachTray'), btn = $('btnCoachOptions');
      if (!tray) return;
      const show = open === null ? tray.hidden : !!open;
      if (show) this.syncCoachOptionStates();
      tray.hidden = !show;
      if (btn) btn.setAttribute('aria-expanded', String(show));
      const view = $('view-ai-coach');
      if (view) view.classList.toggle('coach-tray-open', show);
    },

    selectedBlockDays() { return [...document.querySelectorAll('#blockDays [data-dow].active')].map((b) => Number(b.dataset.dow)); },

    /** The line under the ticks: what the next message will do with the options (and what the message itself sets). */
    updateCoachGoButton() {
      if (!this._coachReady || !this.aiCoach) return;
      const c = this.aiCoach;
      const I = CC().INTENTS;
      const intent = this.coachIntent;
      const val = (id) => String(($(id) || {}).value || '');
      const input = $('askInput');
      const parsed = CC().parseRequest(input ? input.value : '', intent, { days: this.selectedBlockDays() });
      const engine = esc(c.isLive ? VeloAiCoach.labelFor(c.model) : 'built-in coach');
      const mine = (s) => `<b title="From your message">${esc(s)}</b>`;
      const goal = esc((VeloAiCoach.GOALS[this.coachGoal] || VeloAiCoach.GOALS.ftp).label);
      const narrow = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
      let hint = '', send = narrow ? I[intent].sendShort : I[intent].send;
      if (intent === 'chat') {
        const r = this.askRange ? this.askRange() : null;
        const n = r ? this.cyclingRides().filter((x) => { const t = Date.parse(x.date); return t >= r.from.getTime() && t <= r.to.getTime(); }).length : 0;
        hint = r ? `Looking at ${esc(r.label.toLowerCase())} · ${n} ride${n === 1 ? '' : 's'} · ${engine}` : engine;
      } else if (intent === 'workout') {
        const dur = val('selectAiCoachDuration');
        const focusSel = $('selectAiCoachFocus');
        const focus = focusSel && focusSel.value !== 'auto' ? ` · ${esc(focusSel.options[focusSel.selectedIndex].textContent.split(' (')[0])}` : '';
        const len = parsed.durationMin ? mine(`${parsed.durationMin} min`) : dur === 'auto' ? 'coach picks the length' : `${esc(dur)} min`;
        hint = `${goal} · ${len}${focus} · ${engine}`;
      } else {
        const weeks = parsed.weeks ? mine(`${parsed.weeks} weeks`) : `${parseInt(val('selectBlockWeeks') || '8', 10)} weeks`;
        const dayCount = (parsed.days || this.selectedBlockDays()).length;
        const days = parsed.days ? mine(`${dayCount} days a week`) : `${dayCount} days a week`;
        const typed = val('inputBlockHours').trim();
        const hours = parsed.hoursPerWeek ? mine(`up to ${parsed.hoursPerWeek} h`) : typed ? `up to ${esc(typed)} h` : 'coach picks the hours';
        const existing = this.blockPlanner && this.blockPlanner.block;
        hint = `${goal} · ${weeks} · ${days} · ${hours} · ${engine}${existing ? ' · replaces your plan' : ''}`;
        if (existing && !narrow) send = 'Build new plan';
      }
      const el = $('coachGoHint');
      if (el) el.innerHTML = hint;
      const trayHint = $('coachTrayHint');
      if (trayHint) trayHint.innerHTML = hint;
      this.setText('coachSendLabel', send);
      // A question needs words; a workout or plan can be left to the coach.
      const btn = $('btnAskSend');
      if (btn && !this._askBusy) btn.disabled = intent === 'chat' && !String(input ? input.value : '').trim();
      this.setText('coachTrayHelp', intent === 'chat'
        ? 'Pick the period the coach reads. It sees the summary below, not your raw files.'
        : c.isLive
          ? 'Your own words come first: the coach builds what you ask for and says so if your data argues against it. Lengths you type set these options.'
          : 'Without an AI key the built-in coach builds from your form and these options; it cannot read your words. Add a key in AI settings for workouts and plans built from what you ask.');
    },

    /** Sets the options from what the rider typed ("10 weeks", "60 min", "no rides on Friday"), so both agree. */
    applyCoachRequest(text, intent) {
      const parsed = CC().parseRequest(text, intent, { days: this.selectedBlockDays() });
      const setSel = (id, v) => {
        const el = $(id);
        if (!el || v === undefined || v === null || String(el.value) === String(v)) return;
        el.value = String(v);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      if (intent === 'workout' && parsed.durationOption) setSel('selectAiCoachDuration', parsed.durationOption);
      if (intent === 'plan') {
        if (parsed.weeks) setSel('selectBlockWeeks', parsed.weeks);
        if (parsed.hoursPerWeek) { const h = $('inputBlockHours'); if (h) h.value = String(parsed.hoursPerWeek); }
        if (parsed.days) { document.querySelectorAll('#blockDays [data-dow]').forEach((b) => b.classList.toggle('active', parsed.days.includes(Number(b.dataset.dow)))); this.syncCoachOptionStates(); }
        if (parsed.longDay !== undefined) setSel('selectBlockLongDay', parsed.longDay);
      }
      return parsed;
    },

    // ------------------------------------------------------------------------------------------ sending --

    sendCoachMessage(raw) {
      this.toggleCoachOptions(false);
      if (this.coachIntent === 'workout') return this.coachBuildWorkout(raw);
      if (this.coachIntent === 'plan') return this.coachBuildPlan(raw);
      return this.sendAsk(raw);
    },

    /** The conversation as user / assistant turns for /api/ask (workouts and plans count as the coach's turns). */
    askHistoryForApi() { return CC().historyForApi(this.askMessages); },

    coachTakeInput() {
      const input = $('askInput');
      if (input) { input.value = ''; this.sizeAskInput(); }
    },

    coachBusy(intent, label, stoppable = true) {
      this._askBusy = true;
      this._askBusyInfo = { intent, label, stoppable };
      this._askStarted = performance.now();
      clearInterval(this._askTick);
      this._askTick = setInterval(() => this.setText('askElapsed', `${Math.round((performance.now() - this._askStarted) / 1000)} s`), 1000);
      this.setAskBusyUi(true);
      this.renderAskThread();
      this.coachAnnounce(`${label}...`);
    },

    coachIdle() {
      clearInterval(this._askTick);
      this._askBusy = false;
      this._askBusyInfo = null;
      this._askAbort = null;
      this.setAskBusyUi(false);
      this.updateCoachGoButton();
      const last = (this.askMessages || [])[this.askMessages.length - 1];
      if (last) this.coachAnnounce(last.role === 'workout' ? `Workout ready: ${String(last.workout.title || '').replace(/^AI Coach:\s*/i, '')}` : last.role === 'plan' ? `Plan ready: ${last.plan.title}` : last.role === 'error' ? last.content : last.role === 'assistant' ? 'The coach answered.' : '');
    },

    /** Stop: a question is cancelled; a workout being built is left behind (a plan cannot be stopped half-way). */
    stopCoach() {
      if (this._askAbort) { this._askAbort.abort('stop'); return; }
      if (this._askBusy && this._askBusyInfo && this._askBusyInfo.stoppable) {
        this._coachRun = (this._coachRun || 0) + 1;
        this.coachIdle();
        this.askMessages.push({ id: newMsgId(), role: 'note', content: 'Stopped', at: Date.now() });
        this.renderAskThread();
        this.saveAsk();
      }
    },

    async sendAsk(raw) {
      const text = String(raw || '').trim();
      const input = $('askInput');
      if (!text || this._askBusy) return;
      if (text.length > MAX_TEXT) { this.showToast(`Please keep a message under ${MAX_TEXT} characters.`, 'warning'); return; }
      const range = this.askRange();
      let context;
      try { context = this.askContext(range); } catch (e) { context = ''; console.warn('Coach chat: could not build the data summary', e); }
      this.askMessages.push({ id: newMsgId(), role: 'user', content: text, intent: 'chat', at: Date.now() });
      this.coachTakeInput();
      this.saveAsk();
      const c = this.aiCoach;
      const ac = new AbortController();
      this._askAbort = ac;
      this.coachBusy('chat', 'Looking through your data');
      const timer = setTimeout(() => ac.abort('timeout'), TIMEOUT_MS);
      try {
        const res = await fetch(ASK_URL, {
          method: 'POST', cache: 'no-store', signal: ac.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: this.askHistoryForApi(), context, provider: c.provider, model: c.model, effort: c.effort, useTools: !!(window.VeloStorage && window.VeloStorage.enabled) })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw Object.assign(new Error(data.error || `The local server answered ${res.status}.`), { server: true });
        const secs = ((performance.now() - this._askStarted) / 1000).toFixed(1);
        const toolCount = Array.isArray(data.toolsUsed) ? data.toolsUsed.length : 0;
        const toolNote = toolCount ? ` · ${toolCount} DB ${toolCount === 1 ? 'query' : 'queries'}` : '';
        this.askMessages.push({ id: newMsgId(), role: 'assistant', content: String(data.text || '').trim() || 'No answer came back - try asking again.', meta: `${VeloAiCoach.labelFor(data.model || c.model)} · ${secs} s${toolNote}`, at: Date.now() });
      } catch (e) {
        const reason = ac.signal.aborted ? ac.signal.reason : null;
        const last = this.askMessages[this.askMessages.length - 1];
        if (last && last.role === 'user') this.askMessages.pop();
        if (input && !input.value) { input.value = text; this.sizeAskInput(); }
        const msg = reason === 'stop' ? null
          : reason === 'timeout' ? 'No answer after 3 minutes. Try again, or ask a shorter question.'
            : e.server ? e.message
              : 'Can\'t reach the local server. Open the app with Launch-Apex-Velo.bat - questions need it for your API key.';
        if (msg) this.askMessages.push({ role: 'error', content: msg });
      } finally {
        clearTimeout(timer);
        this.coachIdle();
        this.renderAskThread();
        this.saveAsk();
      }
    },

    /** "Create a workout": the coach builds one session from the form, the options and the rider's words. */
    async coachBuildWorkout(raw, { focusIndex = -1 } = {}) {
      const text = String(raw || '').trim();
      if (this._askBusy || !this.aiCoach) return;
      if (text.length > MAX_TEXT) { this.showToast(`Please keep a message under ${MAX_TEXT} characters.`, 'warning'); return; }
      const parsed = this.applyCoachRequest(text, 'workout');
      // The chat so far goes with a request (so "make it shorter" knows what "it" is); "leave it to the coach" goes alone.
      const earlier = text || focusIndex >= 0 ? CC().brief(this.askMessages, { focus: focusIndex }) : '';
      const notes = CC().requestNotes(text, earlier);
      this.askMessages.push({ id: newMsgId(), role: 'user', content: text, intent: 'workout', said: parsed.said, at: Date.now() });
      this.coachTakeInput();
      this.saveAsk();
      const c = this.aiCoach;
      const run = this._coachRun = (this._coachRun || 0) + 1;
      this.coachBusy('workout', c.isLive ? `Building your workout with ${VeloAiCoach.labelFor(c.model)}` : 'Building your workout from your form');
      try {
        const focus = ($('selectAiCoachFocus') || {}).value || 'auto';
        const durVal = ($('selectAiCoachDuration') || {}).value || '45';
        const rec = await c.generateRecommendation(focus, durVal === 'auto' ? 'auto' : parseInt(durVal, 10), this.coachGoal, notes);
        if (run !== this._coachRun) return;
        this.askMessages.push(this.coachWorkoutMessage(rec, { wordsUnread: !!text && rec.source === 'offline_heuristic' && !rec.apiError }));
      } catch (e) {
        if (run !== this._coachRun) return;
        console.error('Coach chat: workout failed', e);
        this.askMessages.push({ role: 'error', content: `Could not build the workout: ${e.message}` });
      } finally {
        if (run === this._coachRun) {
          this.coachIdle();
          this.renderAskThread();
          this.saveAsk();
        }
      }
    },

    /** "Plan my training": a 4-12 week plan from the options and the rider's words, placed on the Calendar. */
    async coachBuildPlan(raw) {
      const text = String(raw || '').trim();
      if (this._askBusy || !this.blockPlanner) return;
      if (text.length > MAX_TEXT) { this.showToast(`Please keep a message under ${MAX_TEXT} characters.`, 'warning'); return; }
      const parsed = this.applyCoachRequest(text, 'plan');
      const opts = this.readBlockOptions();
      const problem = this.blockOptionsProblem(opts);
      if (problem) {
        this.toggleCoachOptions(true);
        this.askMessages.push({ role: 'error', content: problem });
        this.renderAskThread();
        return;
      }
      const current = this.blockPlanner.block;
      if (current && !confirm(`Replace your current ${current.weeks.length}-week plan with a new one? Your rides are not affected.`)) return;
      const earlier = text ? CC().brief(this.askMessages) : '';
      this.askMessages.push({ id: newMsgId(), role: 'user', content: text, intent: 'plan', said: parsed.said, at: Date.now() });
      this.coachTakeInput();
      this.saveAsk();
      const c = this.aiCoach;
      this.coachBusy('plan', c.isLive ? `Planning ${opts.weeks} weeks with ${VeloAiCoach.labelFor(c.model)}` : `Planning ${opts.weeks} weeks`, false);
      try {
        const res = await this.buildTrainingBlock(CC().requestNotes(text, earlier), { confirmReplace: false });
        if (res && res.block) this.askMessages.push(this.coachPlanMessage(res, { wordsUnread: !!text && res.block.source === 'offline_heuristic' && !res.apiError }));
      } catch (e) {
        console.error('Coach chat: plan failed', e);
        this.askMessages.push({ role: 'error', content: `Could not build the plan: ${e.message}` });
      } finally {
        this.coachIdle();
        this.renderAskThread();
        this.saveAsk();
      }
    },

    /** A coach recommendation as a workout message for the thread (kept on this device). */
    coachWorkoutMessage(rec, extra = {}) {
      const w = rec.workout || {};
      return {
        id: newMsgId(), role: 'workout', at: Date.now(),
        // The card, the cockpit and the library all show the same name (the built-in coach prefixes "AI Coach:").
        workout: { id: w.id || `ai_rec_${Date.now()}`, title: String(w.title || 'Workout').replace(/^AI Coach:\s*/i, ''), category: w.category, desc: w.desc || '', durationMin: w.durationMin, tss: w.tss, if: w.if, intervals: w.intervals || [] },
        assessment: rec.coachAssessment || {}, evidence: Array.isArray(rec.evidence) ? rec.evidence : [],
        thoughts: String(rec.coachThoughts || '').slice(0, 8000),
        source: rec.source || 'offline_heuristic', model: rec.model || '', modelLabel: rec.modelLabel || '', goal: rec.goal || this.coachGoal,
        lookbackDays: rec.lookbackDays || null, apiError: rec.apiError || '', elapsedMs: rec.elapsedMs || 0, thinkingLevel: rec.thinkingLevel || '',
        ...extra
      };
    },

    /** A new plan as a plan message for the thread; the plan itself lives in the block planner. */
    coachPlanMessage(res, extra = {}) {
      const b = res.block;
      const goal = VeloAiCoach.GOALS[b.goal] || VeloAiCoach.GOALS.ftp;
      return {
        id: newMsgId(), role: 'plan', at: Date.now(),
        plan: {
          id: b.id, title: `${goal.label} block`, goal: b.goal, weekCount: b.weeks.length, startDate: b.startDate, endDate: b.endDate,
          hours: b.options && b.options.aiChoosesHours ? 'weekly hours chosen from your training' : `up to ${b.options ? b.options.hoursPerWeek : '?'} h a week`,
          by: b.source === 'offline_heuristic' ? 'Built-in periodisation engine' : (b.modelLabel || VeloAiCoach.labelFor(b.model)),
          summary: String(b.summary || '').slice(0, 1500),
          weeks: b.weeks.map((w) => ({ index: w.index, type: w.type, phase: w.phase, plannedTss: w.plannedTss, plannedMin: w.plannedMin }))
        },
        apiError: res.apiError || '',
        ...extra
      };
    },

    /** Shows a recommendation made elsewhere (or by a test) as a workout card in the chat. */
    renderAiCoachRecommendation(rec) {
      if (!rec || !rec.workout) return;
      const last = this.askMessages[this.askMessages.length - 1];
      if (!(last && last.role === 'workout' && last.workout.id === rec.workout.id)) this.askMessages.push(this.coachWorkoutMessage(rec));
      this.renderAskThread();
      this.saveAsk();
    },

    /** "Discuss with the coach" on a ride: the period covers it and the question is ready to send. */
    discussRideWithCoach(id) {
      const r = (this.completedWorkouts || []).find((x) => x.id === id);
      if (!r) return;
      const t = Date.parse(r.date);
      const range = this.askRange();
      if (!(t >= range.from.getTime() && t <= range.to.getTime())) {
        const age = (Date.now() - t) / DAY;
        const fit = VeloAsk.PERIODS.find((p) => p.days && p.days >= age + 1);
        this.setAskPeriod(fit ? fit.key : 'all');
      }
      if (this.closeModal) this.closeModal('rideSummaryModal');
      const when = Number.isFinite(t) ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'that day';
      this.openCoach('chat', { text: `Talk me through my ride "${r.title || 'Ride'}" on ${when}: how it went, what stands out in the numbers, and what it means for my next sessions.` });
    },

    // ------------------------------------------------------------------------------------------ thread --

    onCoachThreadClick(e) {
      const chip = e.target.closest('[data-suggest]');
      if (chip) { this.setCoachIntent('chat'); this.sendAsk(chip.dataset.suggest); return; }
      const ex = e.target.closest('[data-example]');
      if (ex) { this.setCoachIntent(ex.dataset.example); this.sendCoachMessage(ex.dataset.text || ''); return; }
      const pick = e.target.closest('[data-coach-pick]');
      if (pick) { this.setCoachIntent(pick.dataset.coachPick, { focus: true }); return; }
      const load = e.target.closest('[data-block-load]');
      if (load) { this.loadBlockSession(load.dataset.blockLoad); return; }
      const copy = e.target.closest('[data-copy]');
      if (copy) {
        const m = this.askMessages[Number(copy.dataset.copy)];
        if (m && this.copyText) this.copyText(m.content, 'Answer copied.');
        return;
      }
      const act = e.target.closest('[data-coach-act]');
      if (act) this.coachCardAction(act.dataset.coachAct, Number(act.dataset.i), act);
    },

    coachCardAction(act, i, el) {
      const m = this.askMessages[i];
      if (!m) return;
      const input = $('askInput');
      if (act === 'ride' && m.workout) {
        const before = this.currentWorkout;
        this.loadWorkoutObjectIntoCockpit(m.workout);
        if (this.currentWorkout !== before) this.showToast('Workout loaded - press START when ready.', 'success');
      } else if (act === 'save' && m.workout) {
        if (this.saveWorkoutPermanently(m.workout)) { m.saved = true; this.saveAsk(); el.disabled = true; el.textContent = 'Saved'; }
      } else if (act === 'change') {
        this.setCoachIntent('workout', { focus: true });
        if (input) input.placeholder = window.matchMedia && window.matchMedia('(max-width: 640px)').matches ? 'How should it change?' : 'How should it change? e.g. shorter, harder, more cadence work';
      } else if (act === 'again') {
        // One-off actions on a card build a workout without moving the rider's tick (the next message goes as they left it).
        let text = '';
        for (let j = i - 1; j >= 0; j--) if (this.askMessages[j].role === 'user') { text = this.askMessages[j].content; break; }
        this.coachBuildWorkout(text);
      } else if (act === 'to-workout') {
        this.coachBuildWorkout('Build the session you just described as a workout for the trainer.', { focusIndex: i });
      } else if (act === 'settings') { if (this.openSettings) this.openSettings('ai'); }
      else if (act === 'plan') this.openTrainingPlan();
      else if (act === 'calendar') { const b = $('btnBlockToCalendar'); if (b) b.click(); }
    },

    setAskBusyUi(busy) {
      const send = $('btnAskSend'), stop = $('btnAskStop');
      const stoppable = !!(this._askBusyInfo && this._askBusyInfo.stoppable);
      if (send) { send.hidden = busy && stoppable; send.disabled = busy; }
      if (stop) stop.hidden = !(busy && stoppable);
      const input = $('askInput');
      if (input) input.setAttribute('aria-busy', String(busy));
      const view = $('view-ai-coach');
      if (view) view.classList.toggle('coach-busy', busy);
    },

    newAskChat() {
      if (this._askAbort) this._askAbort.abort('stop');
      if (this._askBusy) { this._coachRun = (this._coachRun || 0) + 1; this.coachIdle(); }
      this.askMessages = [];
      this.askClearedAt = Date.now();
      this.saveAsk();
      this.renderAskThread();
      const input = $('askInput');
      if (input) input.focus({ preventScroll: true });
    },

    saveAsk() {
      try {
        const keep = (this.askMessages || []).filter((m) => m.role !== 'error').slice(-MAX_STORED);
        // Reasoning is the bulk of a workout card: the five newest keep theirs.
        const recent = new Set(keep.filter((m) => m.role === 'workout').slice(-5));
        const messages = keep.map((m) => {
          let next = m.id ? m : { ...m, id: newMsgId() };
          if (next.role === 'workout' && !recent.has(m) && next.thoughts) next = { ...next, thoughts: '' };
          return next;
        });
        localStorage.setItem(STORE_KEY, JSON.stringify({ period: this.askPeriod, from: this.askFrom, to: this.askTo, clearedAt: this.askClearedAt || 0, messages }));
        if (this.onCoachChatSaved) this.onCoachChatSaved();
      } catch (e) { /* storage full or blocked: the chat lives in memory only */ }
    },

    sizeAskInput() {
      const input = $('askInput');
      if (!input) return;
      input.style.height = 'auto';
      input.style.height = `${Math.min(160, input.scrollHeight)}px`;
    },

    renderAskThread() {
      const thread = $('askThread');
      if (!thread || !this._coachReady) return;
      const has = this.askMessages.length > 0;
      const clearBtn = $('btnAskClear');
      if (clearBtn) clearBtn.hidden = !has;
      const view = $('view-ai-coach');
      if (view) view.classList.toggle('coach-has-chat', has);
      if (!has && !this._askBusy) { thread.innerHTML = this.coachWelcomeHtml(); this._coachShown = 0; return; }
      thread.innerHTML = this.askMessages.map((m, i) => this.coachMessageHtml(m, i)).join('') + (this._askBusy ? `
          <div class="ask-msg ask-ai pending">
            <div class="ask-avatar" aria-hidden="true">${icon('i-sparkles')}</div>
            <div class="ask-body"><div class="ask-bubble"><span class="ask-dots" aria-hidden="true"><i></i><i></i><i></i></span> ${esc((this._askBusyInfo && this._askBusyInfo.label) || 'Thinking')}<span class="ask-elapsed num" id="askElapsed">${Math.round((performance.now() - (this._askStarted || performance.now())) / 1000)} s</span></div></div>
          </div>` : '');
      const before = this._coachShown || 0;
      this._coachShown = this.askMessages.length;
      if (this.askMessages.length > before) [...thread.children].slice(before - this.askMessages.length - (this._askBusy ? 1 : 0)).forEach((n) => n.classList.add('coach-enter'));
      else if (this._askBusy && thread.lastElementChild) thread.lastElementChild.classList.add('coach-enter');
      thread.querySelectorAll('canvas[data-coach-profile]').forEach((cv) => {
        const m = this.askMessages[Number(cv.dataset.coachProfile)];
        if (m && m.workout) requestAnimationFrame(() => this.drawMiniProfile(cv, m.workout.intervals, { height: 84 }));
      });
      // A new answer or card is read from its top; anything else (a question, the "thinking" line) just comes into view.
      const last = thread.lastElementChild;
      const lastMsg = this.askMessages[this.askMessages.length - 1];
      const fromTop = !this._askBusy && lastMsg && ['assistant', 'workout', 'plan'].includes(lastMsg.role);
      if (last && this.activeTab === 'ai-coach') requestAnimationFrame(() => last.scrollIntoView({ block: fromTop ? 'start' : 'nearest', behavior: 'smooth' }));
    },

    coachWelcomeHtml() {
      const I = CC().INTENTS;
      const ask = ASK_EXAMPLES.slice(0, 3).map((n) => VeloAsk.SUGGESTIONS[n]).filter(Boolean)
        .map((s) => `<button type="button" class="ask-chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join('');
      const work = WORKOUT_EXAMPLES.slice(0, 3).map((x) => `<button type="button" class="ask-chip" data-example="workout" data-text="${esc(x.text)}">${esc(x.label)}</button>`).join('');
      const plan = PLAN_EXAMPLES.map((x) => `<button type="button" class="ask-chip" data-example="plan" data-text="${esc(x)}">${esc(x)}</button>`).join('');
      const card = (k, chips) => `<section class="coach-start-card${k === this.coachIntent ? ' active' : ''}" data-intent-card="${k}">
          <button type="button" class="coach-start-head" data-coach-pick="${k}">${icon(I[k].icon)}<span><b>${esc(I[k].label)}</b><small>${esc(I[k].help)}</small></span></button>
          <div class="coach-start-chips">${chips}</div></section>`;
      return `<div class="coach-welcome">
          <div class="ask-empty-icon" aria-hidden="true">${icon('i-sparkles')}</div>
          <h3>What shall we work on?</h3>
          <p>Choose <b>Ask</b>, <b>Workout</b> or <b>Plan</b> below and say it in your own words, or start from an example.</p>
          <div class="coach-start">${card('chat', ask)}${card('workout', work)}${card('plan', plan)}</div>
        </div>`;
    },

    coachMessageHtml(m, i) {
      const I = CC().INTENTS;
      if (m.role === 'note') return `<div class="ask-note"><span>${esc(m.content)}</span></div>`;
      if (m.role === 'error') return `<div class="ask-msg ask-error" role="alert"><div class="ask-bubble">${esc(m.content)}</div></div>`;
      if (m.role === 'user') {
        const intent = I[m.intent] ? m.intent : 'chat';
        const text = String(m.content || '').trim();
        const tag = intent !== 'chat' ? `<span class="coach-user-tag">${icon(I[intent].icon, 'ic ic-xs')}${esc(I[intent].short)}</span>` : '';
        const said = Array.isArray(m.said) && m.said.length ? `<small class="coach-user-said">Set from your message: ${esc(m.said.join(', '))}</small>` : '';
        return `<div class="ask-msg ask-user" data-intent="${intent}"><div class="coach-user-col">${tag}<div class="ask-bubble">${text ? esc(text).replace(/\n/g, '<br>') : `<em>${esc(CC().EMPTY_REQUEST[intent] || '')}</em>`}</div>${said}</div></div>`;
      }
      const body = m.role === 'workout' ? this.coachWorkoutCardHtml(m, i)
        : m.role === 'plan' ? this.coachPlanCardHtml(m, i)
          : `<div class="ask-bubble md">${md(m.content)}</div>
             <div class="ask-meta"><span>${esc(m.meta || '')}</span><button type="button" class="link-btn" data-copy="${i}">Copy</button>${CC().looksLikeSession(m.content) ? `<button type="button" class="coach-chip-action coach-to-workout" data-coach-act="to-workout" data-i="${i}">${icon('i-bolt', 'ic ic-xs')}Make it a workout</button>` : ''}</div>`;
      return `<div class="ask-msg ask-ai${m.role === 'assistant' ? '' : ' coach-result'}">
          <div class="ask-avatar" aria-hidden="true">${icon('i-sparkles')}</div>
          <div class="ask-body">${body}</div>
        </div>`;
    },

    /**
     * A workout as a short card: what it is (title, time, load, peak, profile) and how to ride it, then the actions.
     * The description, steps, why, the evidence and the reasoning are all under one Details.
     */
    coachWorkoutCardHtml(m, i) {
      const w = m.workout;
      const a = m.assessment || {};
      const ftp = (this.activeProfile && this.activeProfile.ftp) || 200;
      const ivs = w.intervals || [];
      const peak = Math.max(0, ...ivs.map((iv) => Number(iv.pctFtp) || 0));
      const live = m.source && m.source !== 'offline_heuristic';
      const who = live ? (m.modelLabel || VeloAiCoach.labelFor(m.model)) : 'Built-in coach';
      const title = String(w.title || 'Workout').replace(/^AI Coach:\s*/i, '');
      const rows = ivs.map((iv, n) => {
        const z = VeloMetrics.zoneForPct(iv.pctFtp);
        const cad = iv.cadence || (this.getCurrentTargetCadence ? this.getCurrentTargetCadence(iv) : '');
        return `<tr><td class="num">${n + 1}</td><td>${esc(iv.name || 'Step')}</td><td><span class="zone-dot" style="--zc:${z.color}"></span><span class="num">${iv.pctFtp}%</span> <small>${esc(z.short)}</small></td><td class="num">${Math.round((ftp * iv.pctFtp) / 100)} W</td><td class="num">${cad ? `${cad} rpm` : '-'}</td><td class="num">${this.fmtTime(iv.duration)}</td></tr>`;
      }).join('');
      const lead = a.trainingAdvice || w.desc || '';
      const evidence = this.evidenceHtml ? this.evidenceHtml(m.evidence) : '';
      const why = [a.formZone ? `<p><b>Form today.</b> ${esc(a.formZone)}.</p>` : '', a.fitnessDiagnosis ? `<p><b>Fitness &amp; load.</b> ${esc(a.fitnessDiagnosis)}</p>` : '', a.fatigueStatus ? `<p><b>Fatigue &amp; recovery.</b> ${esc(a.fatigueStatus)}</p>` : ''].join('');
      const details = [
        a.trainingAdvice && w.desc ? `<p>${esc(w.desc)}</p>` : '',
        `<h4>Steps (${ivs.length}) · IF ${esc(w.if)}</h4><div class="table-scroll"><table class="data-table cc-steps"><thead><tr><th>#</th><th>Step</th><th>Intensity</th><th>Target</th><th>Cadence</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table></div>`,
        why ? `<h4>Why this workout</h4>${why}` : '',
        evidence ? `<h4>The science behind this</h4>${evidence}` : '',
        m.thoughts ? `<h4>Coach reasoning</h4><div class="thinking-trace-body md">${md(m.thoughts)}</div>` : ''
      ].join('');
      const unread = m.wordsUnread ? ` · from your form and options · <button type="button" class="link-btn" data-coach-act="settings" data-i="${i}">Add an AI key</button> to use your own words` : '';
      return `<article class="coach-card coach-workout">
          <div class="cc-eyebrow">${icon('i-bolt', 'ic ic-xs')}Workout · ${esc(who)}</div>
          <h3 class="cc-title">${esc(title)}</h3>
          <p class="cc-meta num"><b>${esc(w.durationMin)} min</b> · <span data-term-tip="tss">${esc(w.tss)} TSS</span> · peak ${Math.round((ftp * peak) / 100)} W</p>
          <canvas class="cc-profile" data-coach-profile="${i}" aria-hidden="true"></canvas>
          ${lead ? `<p class="cc-lead">${esc(lead)}</p>` : ''}
          ${m.apiError ? `<p class="cc-warn">${esc(m.apiError)}</p>` : ''}
          <details class="cc-more"><summary>Details</summary>${details}</details>
          <div class="btn-row cc-actions">
            <button type="button" class="btn btn-start" data-coach-act="ride" data-i="${i}">${icon('i-play')}Ride now</button>
            <button type="button" class="btn" data-coach-act="save" data-i="${i}"${m.saved ? ' disabled' : ''}>${icon('i-save')}${m.saved ? 'Saved' : 'Save'}</button>
            <button type="button" class="btn btn-ghost" data-coach-act="change" data-i="${i}">${icon('i-edit')}Change it</button>
            <button type="button" class="btn btn-ghost cc-icon-btn" data-coach-act="again" data-i="${i}" aria-label="Another one" title="Another one">${icon('i-refresh')}</button>
          </div>
        </article>
        <div class="ask-meta"><span>${esc(who)}${live && m.thinkingLevel ? ` · ${esc(m.thinkingLevel)}` : ''}${live && m.elapsedMs ? ` · ${(m.elapsedMs / 1000).toFixed(1)} s` : ''}${m.lookbackDays ? ` · ${esc(m.lookbackDays)} days of history` : ''}${unread}</span></div>`;
    },

    /** A plan as a short card: what it is, its weeks at a glance and the summary; the sessions are on the plan itself. */
    coachPlanCardHtml(m, i) {
      const p = m.plan || {};
      const bp = this.blockPlanner;
      const live = !!(bp && bp.block && bp.block.id === p.id);
      const weeks = Array.isArray(p.weeks) ? p.weeks : [];
      const maxT = Math.max(1, ...weeks.map((w) => Number(w.plannedTss) || 0));
      const bars = weeks.map((w) => `<span class="cc-wk ${esc(w.type)}" title="Week ${esc(w.index)}: ${esc(w.phase || w.type)} - ${esc(w.plannedTss)} TSS"><i style="height:${Math.max(8, ((Number(w.plannedTss) || 0) / maxT) * 100)}%"></i><small class="num">W${esc(w.index)}</small></span>`).join('');
      const unread = m.wordsUnread ? `<div class="ask-meta"><span>Built from the options · <button type="button" class="link-btn" data-coach-act="settings" data-i="${i}">Add an AI key</button> to use your own words</span></div>` : '';
      return `<article class="coach-card coach-plan">
          <div class="cc-eyebrow">${icon('i-calendar', 'ic ic-xs')}Training plan · ${esc(p.by || '')}</div>
          <h3 class="cc-title">${esc(p.title || 'Training plan')}</h3>
          <p class="cc-meta num"><b>${esc(p.weekCount)} weeks</b> · ${esc(fmtDay(p.startDate))} - ${esc(fmtDay(p.endDate))}${p.hours ? ` · ${esc(p.hours)}` : ''}</p>
          <div class="cc-weeks" aria-hidden="true">${bars}</div>
          ${p.summary ? `<p class="cc-lead cc-clamp">${esc(p.summary)}</p>` : ''}
          ${m.apiError ? `<p class="cc-warn">${esc(m.apiError)}</p>` : ''}
          ${live ? `<div class="btn-row cc-actions">
            <button type="button" class="btn btn-primary" data-coach-act="plan" data-i="${i}">${icon('i-calendar')}View plan</button>
            <button type="button" class="btn btn-ghost" data-coach-act="calendar" data-i="${i}">Calendar</button>
          </div>` : '<p class="cc-note">A newer plan replaced this one.</p>'}
        </article>${unread}`;
    }
  });
})();
