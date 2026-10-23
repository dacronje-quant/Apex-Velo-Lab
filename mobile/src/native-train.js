/**
 * Train tab (docs/ANDROID-UX.md 2.1, workstream U2): one segmented control, Plan | Workouts | Ask coach.
 *
 *  train/plan      the week strip, the selected day's session (Ride it, Swap), the training block (Re-plan) and
 *                  rows to the coach and the calendar
 *  train/coach     the app's AI Coach view (one workout or a multi-week plan)
 *  train/calendar  the app's Calendar view (week, month, year, all time; the recovery strip)
 *  train/workouts  a short library list with filter chips and search; a workout opens a sheet (Ride it, Fine-tune,
 *                  Delete); Describe a workout opens the app's describe box in a sheet
 *  train/builder   the app's custom interval table (fine-tune the loaded workout, add steps, save as preset)
 *  train/ask       the app's Ask view (the chat and its saved history)
 *
 * Everything reads the app's own state and calls its own methods; the existing nodes are moved in (ids and
 * bindings intact), never copied. Starting a workout opens the Ride tab's ride screen (rideTab.today.startRide).
 */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id) => `<svg class="ic" aria-hidden="true"><use href="#${id}"/></svg>`;

export const SEG = [{ route: 'train/plan', label: 'Plan' }, { route: 'train/workouts', label: 'Workouts' }, { route: 'train/ask', label: 'Ask coach' }];

/** Library filters: the desktop's categories, in the phone's words. */
export const FILTERS = [
  { cat: 'all', label: 'All' }, { cat: 'endurance', label: 'Endurance' }, { cat: 'sweetspot', label: 'Sweet spot' },
  { cat: 'threshold', label: 'Threshold' }, { cat: 'vo2', label: 'VO2' }, { cat: 'hardstart', label: 'Hard-start' },
  { cat: 'custom', label: 'Saved' }, { cat: 'assessment', label: 'Tests' }
];
/** The zone colour of a category's dot (a typical % FTP of its work). */
const CAT_PCT = { recovery: 50, endurance: 68, sweetspot: 90, threshold: 100, vo2: 115, assessment: 125 };
/** Rows shown before "Show all", so the Workouts root fits on the screen. */
export const LIST_CAP = 8;

/** The app's own library filter (js/app.js renderWorkoutCatalog). */
export function filterWorkouts(library, cat = 'all', query = '', App_ = null) {
  const q = String(query || '').trim().toLowerCase();
  const hard = (w) => (App_ && App_.isHardStart ? App_.isHardStart(w) : /^(hardstart_|billat_)/.test(w.id || ''));
  const custom = (w) => (App_ && App_.isCustomWorkout ? App_.isCustomWorkout(w) : !!w.isCustom);
  return (library || []).filter((w) => {
    const okCat = cat === 'all' ? true : cat === 'hardstart' ? hard(w) : cat === 'custom' ? custom(w) : w.category === cat;
    return okCat && (!q || String(w.title || '').toLowerCase().includes(q) || String(w.desc || '').toLowerCase().includes(q));
  });
}

export const fmtMin = (m) => { m = Math.round(Number(m) || 0); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`; };

/** Monday-first date keys (YYYY-MM-DD, local) of the week holding `d`. */
export function weekKeys(d = new Date()) {
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(mon); x.setDate(mon.getDate() + i);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  });
}
const dayKeyOf = (date) => { const x = new Date(date); return Number.isNaN(x.getTime()) ? '' : weekKeys(x)[(x.getDay() + 6) % 7]; };
const dateOf = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };

/** Moves an existing node into `into` and returns a function that puts it back where it was. */
function borrow(node, into) {
  if (!node || node.parentNode === into) return () => {};
  const marker = node.ownerDocument.createComment('av-train');
  if (node.parentNode) node.parentNode.insertBefore(marker, node);
  into.appendChild(node);
  return () => { if (marker.parentNode) { marker.parentNode.insertBefore(node, marker); marker.remove(); } };
}

export class TrainTab {
  constructor({ shell, rideTab = null, win = window }) {
    this.shell = shell; this.rideTab = rideTab; this.win = win; this.doc = win.document;
    this.cat = 'all'; this.query = ''; this.showAll = false; this.day = null;
    this.planEl = this.page('av-train-plan');
    this.workoutsEl = this.page('av-train-workouts');
    this.builderEl = this.page('av-train-builder');
    const seg = SEG;
    shell.registerTab('train', { root: 'train/plan' });
    shell.registerPage('train/plan', { title: 'Train', el: this.planEl, seg, parent: null, mount: () => this.renderPlan() });
    shell.registerPage('train/workouts', {
      title: 'Train', el: this.workoutsEl, seg, parent: null,
      actions: () => shell.button({ icon: 'i-search', label: 'Search workouts', id: 'avWorkoutSearchBtn', onClick: () => this.toggleSearch() }),
      mount: () => this.renderWorkouts()
    });
    shell.registerPage('train/ask', { title: 'Train', view: 'ask', seg, parent: null });
    shell.registerPage('train/coach', { title: 'Coach', view: 'ai-coach', parent: 'train/plan', mount: () => this.foldCoachInsights(),
      actions: () => shell.button({ icon: 'i-sparkles', label: 'Build it', id: 'avCoachGo', onClick: () => this.coachGo() }) });
    shell.registerPage('train/calendar', { title: 'Calendar', view: 'calendar', parent: 'train/plan' });
    shell.registerPage('train/builder', {
      title: 'Custom workout', el: this.builderEl, parent: 'train/workouts',
      mount: () => this.mountBuilder(), unmount: () => { if (this._restoreBuilder) this._restoreBuilder(); this._restoreBuilder = null; }
    });
    // The app's own tab switches (Calendar button on a block, "View plan", the AI Coach link) land here.
    shell.mapView('ai-coach', 'train/coach');
    shell.mapView('calendar', 'train/calendar');
    shell.mapView('workouts', 'train/workouts');
    shell.mapView('ask', 'train/ask');
  }

  get app() { return this.shell.getApp(); }
  get App() { return this.win.VeloApp || (typeof VeloApp !== 'undefined' ? VeloApp : null); /* global VeloApp */ }

  page(cls) {
    const el = this.doc.createElement('div');
    el.className = `av-page-body ${cls}`;
    return el;
  }

  /** Loads a workout (`load(app)`; none: the loaded one) and opens the ride screen with it (the Ride tab's flow). */
  ride(load = null) {
    const app = this.app;
    if (!app) return;
    const before = app.currentWorkout;
    if (load) load(app);
    // A ride in progress asks before it is replaced; "Cancel" keeps it and nothing starts.
    if (load && app.currentWorkout === before) return;
    this.shell.closeSheet();
    if (this.rideTab && this.rideTab.today) this.rideTab.today.startRide();
    else this.shell.go('ride/live');
  }

  // ------------------------------------------------------------------------------------------------ Plan --

  plan() {
    const app = this.app;
    const bp = app && app.blockPlanner;
    return bp && bp.block ? bp : null;
  }

  renderPlan() {
    const app = this.app;
    const el = this.planEl;
    if (!app) { el.innerHTML = '<p class="av-note">Loading…</p>'; this.shell.whenApp(() => this.renderPlan()); return; }
    const keys = weekKeys();
    const today = keys[(new Date().getDay() + 6) % 7];
    if (!this.day || !keys.includes(this.day)) this.day = today;
    const bp = this.plan();
    const planned = bp ? bp.sessionsByDate() : new Map();
    const FOCUS = (this.win.VeloBlockPlanner && this.win.VeloBlockPlanner.FOCUS) || {};
    const rides = new Map();
    for (const r of app.completedWorkouts || []) { const k = dayKeyOf(r.date); if (keys.includes(k)) { if (!rides.has(k)) rides.set(k, []); rides.get(k).push(r); } }
    const days = keys.map((k) => {
      const s = (planned.get(k) || [])[0];
      const done = rides.get(k);
      const colour = s ? (FOCUS[s.focus] || {}).color || 'var(--cyan)' : done ? 'var(--lime)' : '';
      const name = dateOf(k).toLocaleDateString(undefined, { weekday: 'short' });
      return `<button type="button" class="av-day${k === this.day ? ' on' : ''}${k === today ? ' today' : ''}" data-av-day="${k}" aria-pressed="${k === this.day}">
        <span>${esc(name)}</span>${colour ? `<i style="background:${esc(colour)}"${s && s.status === 'done' ? ' class="done"' : ''}></i>` : '<i class="none"></i>'}</button>`;
    }).join('');
    el.innerHTML = `<div class="av-week-strip" role="group" aria-label="This week">${days}</div>
      <div class="card av-day-card" id="avPlanDay"></div>
      <div class="card av-block-card" id="avPlanBlock"></div>
      <div class="card av-list av-train-rows"></div>`;
    el.querySelectorAll('[data-av-day]').forEach((b) => b.addEventListener('click', () => { this.day = b.dataset.avDay; this.renderPlan(); }));
    this.renderDay(app, planned.get(this.day) || [], rides.get(this.day) || [], this.day === today);
    this.renderBlock(app, bp);
    const rows = el.querySelector('.av-train-rows');
    rows.appendChild(this.shell.row({ icon: 'i-sparkles', id: 'avOpenCoach', title: 'Coach', sub: 'One workout for today, or a 4-12 week plan', onClick: () => this.openCoach('session') }));
    rows.appendChild(this.shell.row({ icon: 'i-calendar', id: 'avOpenCalendar', title: 'Calendar', sub: 'Week, month, year · load and recovery', onClick: () => this.shell.go('train/calendar') }));
  }

  renderDay(app, sessions, rides, isToday) {
    const el = this.planEl.querySelector('#avPlanDay');
    const when = isToday ? 'Today' : dateOf(this.day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
    const s = sessions.find((x) => x.status === 'planned') || sessions[0];
    let body = '';
    if (s) {
      const status = s.status === 'done' ? ' · done' : s.status === 'missed' ? ' · missed' : '';
      body = `<h3 class="av-plan-title">${esc(s.title)}</h3><p class="av-note">${esc(fmtMin(s.durationMin))} · TSS ${esc(s.tss)} · from your plan${status}</p>`;
    } else if (rides.length) {
      body = `<h3 class="av-plan-title">${esc(rides[0].title || 'Ride')}</h3><p class="av-note">Ridden${rides.length > 1 ? ` (+${rides.length - 1} more)` : ''} · ${esc(fmtMin((rides[0].duration || 0) / 60))}${rides[0].tss ? ` · TSS ${Math.round(rides[0].tss)}` : ''}</p>`;
    } else body = `<h3 class="av-plan-title">${this.plan() ? 'Rest day' : 'Nothing planned'}</h3><p class="av-note">${this.plan() ? 'No session in your plan for this day.' : 'Ask the coach for today\'s workout or a training plan, or pick one from Workouts.'}</p>`;
    const canRide = s && s.status === 'planned';
    el.innerHTML = `<span class="eyebrow">${esc(when)}</span>${body}
      <div class="btn-row av-plan-more">
        ${canRide ? `<button type="button" class="btn btn-start btn-grow" id="avPlanRide">${icon('i-play')}${isToday ? 'Ride it today' : 'Ride it now'}</button>`
          : rides.length && !s ? `<button type="button" class="btn btn-grow" id="avPlanSeeRide">See ride</button>`
            : `<button type="button" class="btn btn-ai btn-grow" id="avPlanAskCoach">${icon('i-sparkles')}Today's workout</button>`}
        <button type="button" class="btn btn-ghost btn-grow" id="avPlanSwap">${canRide ? 'Swap' : 'Workouts'}</button>
      </div>`;
    const on = (id, fn) => { const b = el.querySelector(id); if (b) b.addEventListener('click', fn); };
    on('#avPlanRide', () => this.ride((a) => { a.loadBlockSession(s.id); }));
    on('#avPlanSeeRide', () => this.shell.go('history/' + encodeURIComponent(rides[0].id)));
    on('#avPlanAskCoach', () => this.openCoach('session'));
    on('#avPlanSwap', () => this.shell.go('train/workouts'));
  }

  renderBlock(app, bp) {
    const el = this.planEl.querySelector('#avPlanBlock');
    if (!bp) {
      el.innerHTML = `<span class="eyebrow">Your plan</span><h3 class="av-plan-title">No training plan yet</h3>
        <p class="av-note">A 4-12 week plan from your history: mostly easy rides, progressing hard days, easier weeks and a test at the end.</p>
        <button type="button" class="btn btn-ai av-big" id="avPlanBuild">${icon('i-calendar')}Build a plan</button>`;
      el.querySelector('#avPlanBuild').addEventListener('click', () => this.openCoach('plan'));
      return;
    }
    const b = bp.block;
    const C = this.win.VeloAiCoach;
    const goal = (C && C.GOALS && (C.GOALS[b.goal] || C.GOALS.ftp)) || { label: 'Training' };
    const P = this.win.VeloBlockPlanner;
    const today = P ? P.today() : weekKeys()[0];
    const i = b.weeks.findIndex((w) => today >= w.start && (!P || today <= P.addDays(w.start, 6)));
    const week = i >= 0 ? b.weeks[i] : null;
    const pending = (b.suggestions || []).filter((x) => !x.resolved && x.changes && x.changes.length).length;
    const where = week ? `Week ${i + 1} of ${b.weeks.length}${week.phase ? ` · ${week.phase}` : ''}` : today < b.startDate ? `Starts ${b.startDate} · ${b.weeks.length} weeks` : `Finished · ${b.weeks.length} weeks`;
    el.innerHTML = `<span class="eyebrow">Your block</span><h3 class="av-plan-title">${esc(goal.label)} block</h3>
      <p class="av-note">${esc(where)}${b.options && b.options.hoursPerWeek && !b.options.aiChoosesHours ? ` · up to ${esc(b.options.hoursPerWeek)} h / week` : ''}</p>
      ${pending ? `<button type="button" class="btn btn-grow av-plan-suggest" id="avPlanSuggestions">${pending} suggested change${pending === 1 ? '' : 's'} · review</button>` : ''}
      <div class="btn-row av-plan-more">
        <button type="button" class="btn btn-ai btn-grow" id="avPlanReplan">${icon('i-sparkles')}Re-plan</button>
        <button type="button" class="btn btn-ghost btn-grow" id="avPlanOpen">Open plan</button>
      </div>`;
    el.querySelector('#avPlanReplan').addEventListener('click', () => { this.openCoach('plan'); this.doc.getElementById('btnReplanBlock')?.click(); });
    el.querySelector('#avPlanOpen').addEventListener('click', () => this.openCoach('plan'));
    el.querySelector('#avPlanSuggestions')?.addEventListener('click', () => this.openCoach('plan', 'blockSuggestions'));
  }

  /** The coach's insight chips (volume, intensity mix, power profile) fold under "More" so the builder shows first. */
  foldCoachInsights() {
    const strip = this.doc.getElementById('aiCoachInsights');
    if (!strip || strip.closest('.av-coach-insights')) return;
    const more = this.doc.createElement('details');
    more.className = 'av-more av-coach-insights';
    more.innerHTML = '<summary>More about your training</summary>';
    strip.parentNode.insertBefore(more, strip);
    more.appendChild(strip);
  }

  /** The coach's main button (Prescribe today's workout / Build plan), from the top bar; then shows the result. */
  coachGo() {
    const go = this.doc.getElementById('btnGenerateAiCoachRecommendation');
    if (!go || go.disabled) return;
    go.click();
    this.doc.querySelector('#view-ai-coach .coach-results')?.scrollIntoView({ block: 'start' });
  }

  /** Opens the AI Coach view in "One workout" (session) or "Training plan" (plan) mode. */
  openCoach(mode, scrollTo = '') {
    this.shell.go('train/coach');
    const tile = this.doc.querySelector(`#coachModePills [data-coach-mode="${mode}"]`);
    if (tile && !tile.classList.contains('active')) tile.click();
    const target = this.doc.getElementById(scrollTo || (mode === 'plan' && this.plan() ? 'trainingBlockCard' : ''));
    if (target) this.win.requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
  }

  // -------------------------------------------------------------------------------------------- Workouts --

  toggleSearch() {
    this.searching = !this.searching;
    if (!this.searching) this.query = '';
    this.renderWorkouts();
    if (this.searching) this.workoutsEl.querySelector('#avWorkoutSearch')?.focus();
  }

  renderWorkouts() {
    const app = this.app;
    const el = this.workoutsEl;
    if (!app) { el.innerHTML = '<p class="av-note">Loading…</p>'; this.shell.whenApp(() => this.renderWorkouts()); return; }
    if (!el.querySelector('.av-wk-chips')) {
      el.innerHTML = `<label class="av-wk-search" hidden><span class="sr-only">Search workouts</span><input type="search" id="avWorkoutSearch" class="input-field" placeholder="Search workouts" autocomplete="off"></label>
        <div class="av-wk-chips" role="group" aria-label="Workout type">${FILTERS.map((f) => `<button type="button" class="chip" data-av-cat="${f.cat}">${esc(f.label)}</button>`).join('')}</div>
        <div class="card av-list av-wk-list" id="avWorkoutList"></div>
        <button type="button" class="btn btn-ai av-big" id="avDescribe">${icon('i-sparkles')}Describe a workout</button>
        <div class="card av-list av-wk-tools"></div>`;
      el.querySelectorAll('[data-av-cat]').forEach((b) => b.addEventListener('click', () => { this.cat = b.dataset.avCat; this.showAll = false; this.renderWorkouts(); }));
      const input = el.querySelector('#avWorkoutSearch');
      input.addEventListener('input', () => { this.query = input.value; this.showAll = false; this.renderList(); });
      el.querySelector('#avDescribe').addEventListener('click', () => this.openDescribe());
      const tools = el.querySelector('.av-wk-tools');
      tools.appendChild(this.shell.row({ icon: 'i-plus', id: 'avOpenBuilder', title: 'Build your own', sub: 'Fine-tune the loaded workout step by step, save it', onClick: () => this.shell.go('train/builder') }));
      tools.appendChild(this.shell.row({ icon: 'i-sparkles', id: 'avWorkoutCoach', title: 'Workout from the coach', sub: 'Built for today from your history and form', onClick: () => this.openCoach('session') }));
    }
    const search = el.querySelector('.av-wk-search');
    search.hidden = !this.searching;
    const input = el.querySelector('#avWorkoutSearch');
    if (input.value !== this.query) input.value = this.query;
    el.querySelectorAll('[data-av-cat]').forEach((b) => { const on = b.dataset.avCat === this.cat; b.classList.toggle('chip-accent', on); b.setAttribute('aria-pressed', String(on)); });
    this.renderList();
  }

  renderList() {
    const app = this.app;
    const box = this.workoutsEl.querySelector('#avWorkoutList');
    const list = filterWorkouts(app.workoutLibrary, this.cat, this.query, this.App);
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = `<p class="av-note av-empty">${this.cat === 'custom' && !this.query ? 'No saved workouts yet. Save one from the coach, Describe a workout or Build your own.' : 'No workouts match. Try another type, or describe one.'}</p>`;
      return;
    }
    const M = this.win.VeloMetrics;
    const ftp = (app.activeProfile && app.activeProfile.ftp) || 200;
    const shown = this.showAll ? list : list.slice(0, LIST_CAP);
    for (const w of shown) {
      const maxPct = Math.max(0, ...(w.intervals || []).map((iv) => iv.pctFtp || 0));
      const test = app.rampTestConfig && app.rampTestConfig(w);
      const sub = test ? `${fmtMin(w.durationMin)} max · until your limit · sets your FTP` : `${fmtMin(w.durationMin)} · TSS ${w.tss}${maxPct ? ` · peak ${Math.round(ftp * maxPct / 100)} W` : ''}`;
      const dot = this.doc.createElement('span');
      dot.className = 'av-wk-dot';
      dot.style.background = M ? M.zoneForPct(CAT_PCT[w.category] || maxPct).color : 'var(--cyan)';
      const row = this.shell.row({ title: w.title, sub, onClick: () => this.openWorkout(w.id) });
      row.dataset.avWorkout = w.id;
      if (app.currentWorkout && app.currentWorkout.id === w.id) row.classList.add('av-wk-loaded');
      row.insertBefore(dot, row.firstChild);
      box.appendChild(row);
    }
    if (list.length > shown.length) {
      const more = this.doc.createElement('button');
      more.type = 'button'; more.className = 'btn btn-ghost av-wk-all'; more.id = 'avWorkoutsAll';
      more.textContent = `Show all ${list.length}`;
      more.addEventListener('click', () => { this.showAll = true; this.renderList(); });
      box.appendChild(more);
    }
  }

  /** A workout's sheet: profile, description, Ride it, Fine-tune and (saved ones) Delete. */
  openWorkout(id) {
    const app = this.app;
    const w = app && app.workoutLibrary.find((x) => x.id === id);
    if (!w) return;
    const App_ = this.App;
    const custom = App_ && App_.isCustomWorkout ? App_.isCustomWorkout(w) : !!w.isCustom;
    const test = app.rampTestConfig && app.rampTestConfig(w);
    const box = this.doc.createElement('div');
    box.className = 'av-wk-sheet';
    box.id = 'avWorkoutSheet';
    box.innerHTML = `<div class="w-card-tags"><span class="w-card-tag tag-${esc(w.category)}">${esc(String(w.category).toUpperCase())}</span>${App_ && App_.isHardStart && App_.isHardStart(w) ? '<span class="w-card-tag tag-hardstart">HARD-START</span>' : ''}${custom ? '<span class="w-card-tag tag-custom">SAVED</span>' : ''}</div>
      <canvas class="av-wk-profile" aria-hidden="true"></canvas>
      <p class="av-note av-wk-meta num">${test ? `Until your limit · auto finish and save · sets your FTP` : `${esc(fmtMin(w.durationMin))} · TSS ${esc(w.tss)} · IF ${esc(w.if)}`}</p>
      <p class="av-wk-desc">${esc(w.desc || '')}</p>
      <button type="button" class="btn btn-start av-big" id="avWorkoutRide">${icon('i-play')}Ride it</button>
      <div class="btn-row av-plan-more">
        <button type="button" class="btn btn-ghost btn-grow" id="avWorkoutEdit">Fine-tune</button>
        ${custom ? `<button type="button" class="btn btn-danger btn-grow" id="avWorkoutDelete">${icon('i-trash')}Delete</button>` : ''}
      </div>`;
    this.shell.openSheet(box, { title: w.title });
    const canvas = box.querySelector('canvas');
    if (app.drawMiniProfile) this.win.requestAnimationFrame(() => app.drawMiniProfile(canvas, w.intervals, { height: 64 }));
    box.querySelector('#avWorkoutRide').addEventListener('click', () => this.ride((a) => { a.loadWorkoutIntoCockpit(w.id); }));
    box.querySelector('#avWorkoutEdit').addEventListener('click', () => { this.shell.closeSheet(); app.selectWorkoutById(w.id); this.shell.go('train/builder'); });
    box.querySelector('#avWorkoutDelete')?.addEventListener('click', () => {
      const n = app.workoutLibrary.length;
      app.deleteWorkout(w.id);
      if (app.workoutLibrary.length !== n) { this.shell.closeSheet(); this.renderList(); }
    });
  }

  /** The app's Describe a workout box (AI or built-in parser), in a sheet; its Ride and Save buttons stay the app's. */
  openDescribe() {
    const box = this.doc.getElementById('describeBox');
    if (!box) return;
    this.shell.openSheet(box, { title: 'Describe a workout', className: 'av-describe-sheet', onClose: () => this.renderList() });
    this.win.requestAnimationFrame(() => this.doc.getElementById('describeInput')?.focus({ preventScroll: true }));
  }

  // --------------------------------------------------------------------------------------------- Builder --

  mountBuilder() {
    const app = this.app;
    const el = this.builderEl;
    if (!app) { this.shell.whenApp(() => { if (this.shell.current && this.shell.current.route === 'train/builder') this.mountBuilder(); }); return; }
    if (!el.querySelector('.av-builder-head')) {
      el.innerHTML = `<div class="card av-builder-head"><span class="eyebrow">Loaded workout</span><h3 class="av-plan-title" id="avBuilderTitle"></h3><p class="av-note" id="avBuilderMeta"></p>
        <button type="button" class="btn btn-start av-big" id="avBuilderRide">${icon('i-play')}Ride it</button></div>
        <div class="av-builder-table"></div>
        <p class="av-note">Change a step's name, % FTP or length, add or remove steps, then Save as preset to keep it under Saved.</p>`;
      el.querySelector('#avBuilderRide').addEventListener('click', () => this.ride());
    }
    const w = app.currentWorkout || { title: '', intervals: [] };
    el.querySelector('#avBuilderTitle').textContent = w.title || 'Workout';
    const secs = (w.intervals || []).reduce((a, iv) => a + (Number(iv.duration) || 0), 0);
    el.querySelector('#avBuilderMeta').textContent = `${w.intervals.length} steps · ${fmtMin(secs / 60)}`;
    if (!this._restoreBuilder) this._restoreBuilder = borrow(this.doc.getElementById('customWorkoutTableSection'), el.querySelector('.av-builder-table'));
    if (app.populateCustomIntervalTable) app.populateCustomIntervalTable();
  }
}

export function installTrainTab({ shell, rideTab = null, win = window }) {
  return new TrainTab({ shell, rideTab, win });
}
