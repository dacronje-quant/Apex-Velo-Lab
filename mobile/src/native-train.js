/**
 * Train tab (docs/ANDROID-UX.md 2.1, workstream U2): the AI Coach chat is the tab's home; the library and the plan
 * are one tap away in the top bar.
 *
 *  train/coach     home: the app's AI Coach chat (js/app-coach-chat.js) - questions about the rider's training,
 *                  workouts and training plans in one conversation - under a one-line Today (today's planned session
 *                  or coach workout with Ride, or Workout for today). train/ask (the old Ask page) opens it too
 *  train/plan      Plan: the week strip and the selected day's session (Start ride, Change workout), the plan from the
 *                  coach view (the block, its weeks, suggested changes, re-plan) and what the coach reads; train/block
 *                  (the earlier plan page) opens it
 *  train/calendar  the app's Calendar view (week, month, year, all time; the recovery strip)
 *  train/workouts  Workouts: a short library list with filter chips and search; a workout opens a sheet (Ride it,
 *                  Fine-tune, Delete)
 *  train/builder   the app's custom interval table (fine-tune the loaded workout, add steps, save as preset)
 *
 * Everything reads the app's own state and calls its own methods; the existing nodes are moved in (ids and
 * bindings intact), never copied. Starting a workout opens the Ride tab's ride screen (rideTab.today.startRide),
 * and so does Ride now on a workout the coach built in the chat.
 */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id) => `<svg class="ic" aria-hidden="true"><use href="#${id}"/></svg>`;
import { workoutName, durationText, labelIntervalFields } from './native-ui.js';


/** Library filters: the desktop's categories, in the phone's words. */
export const FILTERS = [
  { cat: 'all', label: 'All' }, { cat: 'endurance', label: 'Endurance' }, { cat: 'sweetspot', label: 'Sweet spot' },
  { cat: 'threshold', label: 'Threshold' }, { cat: 'vo2', label: 'VO2' }, { cat: 'hardstart', label: 'Hard-start' },
  { cat: 'custom', label: 'Saved' }, { cat: 'assessment', label: 'Tests' }
];
/** The zone colour of a category's dot (a typical % FTP of its work). */
const CAT_PCT = { recovery: 50, endurance: 68, sweetspot: 90, threshold: 100, vo2: 115, assessment: 125 };
const CATEGORY_NAMES = { recovery: 'Recovery', endurance: 'Endurance', sweetspot: 'Sweet spot', threshold: 'Threshold', vo2: 'VO₂ max', hardstart: 'Hard-start', assessment: 'FTP test', custom: 'Saved workout', free: 'Free ride' };

/** A small, responsive profile built from the workout itself; does not need a canvas or hover. */
export function workoutProfile(intervals = [], zoneFor) {
  const steps = intervals.filter((iv) => Number(iv.duration) > 0);
  const total = steps.reduce((sum, iv) => sum + Number(iv.duration), 0) || 1;
  const ceiling = Math.max(130, ...steps.map((iv) => Number(iv.pctFtp) || 0));
  let x = 0;
  const blocks = steps.map((iv) => {
    const width = Number(iv.duration) / total * 320;
    const height = Math.max(5, Math.min(52, (Number(iv.pctFtp) || 0) / ceiling * 52));
    const color = zoneFor ? zoneFor(Number(iv.pctFtp) || 0)?.color : '#78caff';
    const rect = `<rect x="${x.toFixed(2)}" y="${(60-height).toFixed(2)}" width="${Math.max(.5,width-1.5).toFixed(2)}" height="${height.toFixed(2)}" rx="2" fill="${esc(color || '#78caff')}"/>`;
    x += width;
    return rect;
  }).join('');
  return `<svg class="av-workout-profile" viewBox="0 0 320 64" preserveAspectRatio="none" aria-hidden="true"><path d="M0 20H320M0 40H320M0 61H320" stroke="currentColor" stroke-width=".5" opacity=".3"/>${blocks}</svg>`;
}
/** Rows shown before "Show all", so the Workouts root fits on the screen. */
export const LIST_CAP = 4;

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
    this.cat = 'all'; this.query = ''; this.showAll = false; this.day = null; this.searching = true; this.maxMinutes = 0;
    this.planEl = this.page('av-train-plan');
    this.planEl.innerHTML = '<div class="av-plan-week"></div><div class="av-plan-rail"></div>';
    this.workoutsEl = this.page('av-train-workouts');
    this.builderEl = this.page('av-train-builder');
    this.todayEl = this.doc.createElement('div');
    this.todayEl.className = 'card av-today-line';
    this.todayEl.id = 'avToday';
    const redirect = (to) => () => this.win.setTimeout(() => shell.go(to, { replace: true }), 0);
    shell.registerTab('train', { root: 'train/coach' });
    // Home: the coach chat. The library and the plan are labelled buttons in the top bar.
    shell.registerPage('train/coach', {
      title: 'Train', view: 'ai-coach', parent: null, mount: () => this.mountCoach(),
      actions: () => [this.topAction('i-book', 'Workouts', 'avTopWorkouts', 'train/workouts'), this.topAction('i-calendar', 'Plan', 'avTopPlan', 'train/plan')]
    });
    // The old Ask page and the earlier plan page land on their new homes (saved links, the app's own switchTab('ask')).
    shell.registerPage('train/ask', { title: 'Train', view: 'ai-coach', parent: null, mount: redirect('train/coach') });
    shell.registerPage('train/block', { title: 'Plan', el: this.page('av-train-redirect'), parent: 'train/coach', mount: redirect('train/plan') });
    shell.registerPage('train/plan', {
      title: 'Plan', el: this.planEl, parent: 'train/coach',
      mount: () => this.renderPlan(), unmount: () => { if (this._restoreSide) this._restoreSide(); this._restoreSide = null; }
    });
    shell.registerPage('train/workouts', { title: 'Workouts', el: this.workoutsEl, parent: 'train/coach', mount: () => this.renderWorkouts() });
    shell.registerPage('train/calendar', { title: 'Calendar', view: 'calendar', parent: 'train/plan' });
    shell.registerPage('train/builder', {
      title: 'Custom workout', el: this.builderEl, parent: 'train/workouts',
      mount: () => this.mountBuilder(), unmount: () => { if (this._restoreBuilder) this._restoreBuilder(); this._restoreBuilder = null; }
    });
    // The app's own tab switches (Calendar button on a block, the AI Coach link, "Discuss with the coach") land here.
    shell.mapView('ai-coach', 'train/coach');
    shell.mapView('calendar', 'train/calendar');
    shell.mapView('workouts', 'train/workouts');
    shell.mapView('ask', 'train/coach');
    shell.whenApp(() => {
      // "View full plan" in the chat (and the app's other plan links) open the phone's Plan page.
      this.app.onOpenTrainingPlan = () => { this.shell.go('train/plan'); return true; };
    });
    this.watchCoachRide();
  }

  get app() { return this.shell.getApp(); }
  get App() { return this.win.VeloApp || (typeof VeloApp !== 'undefined' ? VeloApp : null); /* global VeloApp */ }

  page(cls) {
    const el = this.doc.createElement('div');
    el.className = `av-page-body ${cls}`;
    return el;
  }

  /** A labelled top-bar button that opens `route`. */
  topAction(ic, label, id, route) {
    const b = this.shell.button({ icon: ic, label, id, onClick: () => this.shell.go(route) });
    b.classList.add('av-labelled-action');
    b.insertAdjacentHTML('beforeend', `<span>${esc(label)}</span>`);
    return b;
  }

  /** A ride is under way: playing, or paused with time on the clock and not yet finished (a saved ride is not). */
  riding() { const app = this.app; return !!(app && (app.isPlaying || (app.totalElapsedSeconds > 0 && !app.isWorkoutCompleted))); }

  /** Loads a workout (`load(app)`; none: the loaded one) and opens the ride screen with it (the Ride tab's flow). */
  ride(load = null) {
    const app = this.app;
    if (!app) return;
    // A ride in progress is never replaced without a confirm (the app itself asks only after 10 s).
    if (load && this.riding() && !(app.totalElapsedSeconds > 10) && !this.win.confirm('Replace the current ride with this workout?')) return;
    const before = app.currentWorkout;
    if (load) load(app);
    // "Cancel" on the app's own question keeps the ride and nothing starts.
    if (load && app.currentWorkout === before) return;
    this.startRide();
  }

  startRide() {
    this.shell.closeSheet();
    if (this.rideTab && this.rideTab.today) this.rideTab.today.startRide();
    else this.shell.go('ride/live');
  }

  // ------------------------------------------------------------------------------------------------ Plan --
  // One page for the schedule: this week (Calendar in its header), the selected day's session, then the plan from
  // the coach view (the block, suggested changes, re-plan, or Plan my training) and what the coach reads.

  plan() {
    const app = this.app;
    const bp = app && app.blockPlanner;
    return bp && bp.block ? bp : null;
  }

  renderPlan() {
    const app = this.app;
    const el = this.planEl.querySelector('.av-plan-week');
    if (!app) { el.innerHTML = '<p class="av-note">Loading…</p>'; this.shell.whenApp(() => this.renderPlan()); return; }
    if (!this._restoreSide) this._restoreSide = borrow(this.doc.getElementById('coachSide'), this.planEl.querySelector('.av-plan-rail'));
    if (app.renderTrainingBlock) app.renderTrainingBlock();
    if (app.updateAiCoachTelemetry) app.updateAiCoachTelemetry();
    this.renderWeek();
  }

  renderWeek() {
    const app = this.app;
    const el = this.planEl.querySelector('.av-plan-week');
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
        <span>${esc(name)}</span><b>${dateOf(k).getDate()}</b>${colour ? `<i style="color:${esc(colour)}" aria-label="${done || s?.status === 'done' ? 'Completed' : 'Planned'}">${done || s?.status === 'done' ? '✓' : '○'}</i>` : '<i class="none"></i>'}</button>`;
    }).join('');
    el.innerHTML = `<div class="av-plan-head"><span class="eyebrow">This week</span><button type="button" class="link-btn" id="avOpenCalendar">Calendar ${icon('i-right')}</button></div>
      <div class="av-week-strip" role="group" aria-label="This week">${days}</div>
      <div class="card av-day-card" id="avPlanDay"></div>`;
    el.querySelectorAll('[data-av-day]').forEach((b) => b.addEventListener('click', () => { this.day = b.dataset.avDay; this.renderWeek(); }));
    el.querySelector('#avOpenCalendar').addEventListener('click', () => this.shell.go('train/calendar'));
    this.renderDay(app, planned.get(this.day) || [], rides.get(this.day) || [], this.day === today);
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
    } else body = `<h3 class="av-plan-title">${this.plan() ? 'Rest day' : 'No workout planned'}</h3><p class="av-note">${this.plan() ? 'No session planned for this day.' : 'Choose a session for today.'}</p>`;
    const canRide = s && s.status === 'planned';
    const riding = this.riding();
    el.innerHTML = `<span class="eyebrow">${esc(when)}</span>${body}
      <div class="btn-row av-plan-more">
        ${canRide ? `<button type="button" class="btn btn-start btn-grow" id="avPlanRide">${icon('i-play')}${riding ? 'Return to ride' : 'Start ride'}</button>`
          : rides.length && !s ? `<button type="button" class="btn btn-grow" id="avPlanSeeRide">See ride</button>`
            : `<button type="button" class="btn btn-primary btn-grow" id="avPlanAskCoach">${icon('i-search')}Find a workout</button>`}
        ${canRide || rides.length ? `<button type="button" class="btn btn-ghost btn-grow" id="avPlanSwap">${canRide ? 'Change workout' : 'Workouts'}</button>` : ''}
      </div>`;
    const on = (id, fn) => { const b = el.querySelector(id); if (b) b.addEventListener('click', fn); };
    // During a ride this only goes back to it; the planned session is loaded once the ride has ended.
    on('#avPlanRide', () => (this.riding() ? this.shell.go('ride/live') : this.ride((a) => { a.loadBlockSession(s.id); })));
    on('#avPlanSeeRide', () => this.shell.go('history/' + encodeURIComponent(rides[0].id)));
    on('#avPlanAskCoach', () => this.shell.go('train/workouts'));
    on('#avPlanSwap', () => this.shell.go('train/workouts'));
  }

  // ---------------------------------------------------------------------------------------- Coach (home) --
  // The chat is the Train home. Above it, one line says what today is (a planned session or the coach's workout,
  // with Ride; a ride under way; or Workout for today, which asks the coach at once). Tap it for the Plan page.

  /** The newest workout the coach built in the chat today, if any. */
  todaysCoachWorkout() {
    const list = (this.app && this.app.askMessages) || [];
    const today = dayKeyOf(new Date());
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m && m.role === 'workout' && m.workout && dayKeyOf(m.at) === today) return m.workout;
    }
    return null;
  }

  mountCoach() {
    const app = this.app;
    if (!app) { this.shell.whenApp(() => { if (this.shell.current && this.shell.current.route === 'train/coach') this.mountCoach(); }); return; }
    const doc = this.doc;
    const main = doc.querySelector('#view-ai-coach .coach-main'), thread = doc.getElementById('askThread');
    if (main && thread && this.todayEl.parentNode !== main) main.insertBefore(this.todayEl, thread);
    // The engine is set once: on the phone it lives with the other options (the gear), not above the chat.
    const pick = doc.getElementById('btnAskEngine'), tray = doc.getElementById('coachTray');
    if (pick && tray && !tray.contains(pick)) {
      const row = doc.createElement('div');
      row.className = 'av-tray-engine';
      row.innerHTML = '<span class="ctrl-label">AI engine</span>';
      row.appendChild(pick);
      const hint = doc.getElementById('coachTrayHint');
      if (hint) hint.after(row); else tray.prepend(row);
    }
    // Today follows the chat: a workout the coach builds becomes today's, a cleared chat drops it.
    if (thread && !this._todayWatch) {
      this._todayWatch = new this.win.MutationObserver(() => { if (this.shell.current && this.shell.current.route === 'train/coach') this.renderToday(); });
      this._todayWatch.observe(thread, { childList: true });
    }
    this.renderToday();
  }

  renderToday() {
    const app = this.app;
    const el = this.todayEl;
    if (!app) return;
    const today = dayKeyOf(new Date());
    const bp = this.plan();
    const s = bp ? (bp.sessionsByDate().get(today) || []).find((x) => x.status === 'planned') : null;
    const w = s ? null : this.todaysCoachWorkout();
    const ridden = (app.completedWorkouts || []).filter((r) => dayKeyOf(r.date) === today);
    let t;
    if (this.riding()) t = { label: 'Riding now', title: workoutName((app.currentWorkout && app.currentWorkout.title) || 'Your ride'), cls: 'btn-start', ic: 'i-play', go: 'Back to ride', act: () => this.shell.go('ride/live') };
    else if (s) t = { label: 'Today in your plan', title: s.title, meta: `${fmtMin(s.durationMin)} · TSS ${s.tss}`, cls: 'btn-start', ic: 'i-play', go: 'Ride', act: () => this.ride((a) => { a.loadBlockSession(s.id); }) };
    else if (w) t = { label: "Today's coach workout", title: workoutName(w.title), meta: `${fmtMin(w.durationMin)} · TSS ${w.tss}`, cls: 'btn-start', ic: 'i-play', go: 'Ride', act: () => this.ride((a) => { a.loadWorkoutObjectIntoCockpit(w); }) };
    else if (ridden.length) t = { label: 'Ridden today', title: ridden[0].title || 'Ride', meta: fmtMin((ridden[0].duration || 0) / 60), cls: 'btn-ghost', ic: 'i-history', go: 'See ride', act: () => this.shell.go('history/' + encodeURIComponent(ridden[0].id)) };
    else t = { label: 'Today', title: bp ? 'Rest day in your plan' : 'Nothing planned yet', cls: 'btn-ai', ic: 'i-bolt', go: 'Workout for today', act: () => this.openCoach('workout', { send: true }) };
    el.innerHTML = `<button type="button" class="av-today-main" id="avTodayOpen" aria-label="${esc(`${t.label}: ${t.title}. Open your plan`)}">
        <small>${esc(t.label)}</small><b>${esc(t.title)}</b>${t.meta ? `<span class="num">${esc(t.meta)}</span>` : ''}</button>
      <button type="button" class="btn ${t.cls}" id="avTodayGo"${app._askBusy && t.cls === 'btn-ai' ? ' disabled' : ''}>${icon(t.ic)}<span>${esc(t.go)}</span></button>`;
    el.querySelector('#avTodayOpen').addEventListener('click', () => this.shell.go('train/plan'));
    el.querySelector('#avTodayGo').addEventListener('click', t.act);
  }

  /**
   * Opens the coach chat with `intent` ticked ('chat', 'workout' or 'plan'); `send` sends what is in the box at
   * once (an empty workout request leaves it to the coach). 'session' is the older name for 'workout'.
   */
  openCoach(intent = 'chat', { text = null, send = false } = {}) {
    const app = this.app;
    if (intent === 'session') intent = 'workout';
    this.shell.go('train/coach');
    if (!app || !app.openCoach) return;
    // On the phone the keyboard opens only when the rider is about to type.
    app.openCoach(intent, { text, send, focus: !send });
  }

  /** Ride now on a workout in the chat opens the ride screen, the same as Start ride everywhere else on the phone. */
  watchCoachRide() {
    let before;
    const hit = (e) => e.target.closest && e.target.closest('#view-ai-coach [data-coach-act="ride"]');
    this.doc.addEventListener('click', (e) => {
      if (!hit(e)) return;
      const app = this.app;
      before = app && app.currentWorkout;
      // The app itself asks only after 10 s of riding; the phone never swaps a ride in progress without asking.
      if (app && this.riding() && !(app.totalElapsedSeconds > 10) && !this.win.confirm('Replace the current ride with this workout?')) { e.stopPropagation(); before = undefined; }
    }, true);
    this.doc.addEventListener('click', (e) => {
      if (!hit(e) || before === undefined) return;
      const app = this.app;
      if (app && app.currentWorkout !== before) this.startRide();
      before = undefined;
    });
  }

  // -------------------------------------------------------------------------------------------- Workouts --

  toggleSearch() {
    this.searching = true;
    this.renderWorkouts();
    if (this.searching) this.workoutsEl.querySelector('#avWorkoutSearch')?.focus();
  }

  renderWorkouts() {
    const app = this.app;
    const el = this.workoutsEl;
    if (!app) { el.innerHTML = '<p class="av-note">Loading…</p>'; this.shell.whenApp(() => this.renderWorkouts()); return; }
    if (!el.querySelector('.av-wk-chips')) {
      el.innerHTML = `<div class="av-wk-filters"><label class="av-wk-search"><span class="sr-only">Search workouts</span><input type="search" id="avWorkoutSearch" class="input-field" placeholder="Search workouts" autocomplete="off"></label>
        <label class="av-wk-duration"><span class="sr-only">Maximum duration</span><select class="input-field" id="avWorkoutDuration"><option value="0">Any length</option><option value="30">≤ 30 min</option><option value="45">≤ 45 min</option><option value="60">≤ 1 hour</option></select></label></div>
        <div class="av-wk-chips" role="group" aria-label="Workout type">${FILTERS.map((f) => `<button type="button" class="chip" data-av-cat="${f.cat}">${esc(f.label)}</button>`).join('')}</div>
        <div class="av-workout-grid av-wk-list" id="avWorkoutList"></div>
        <div class="card av-list av-wk-tools"></div>`;
      el.querySelectorAll('[data-av-cat]').forEach((b) => b.addEventListener('click', () => { this.cat = b.dataset.avCat; this.showAll = false; this.renderWorkouts(); }));
      const input = el.querySelector('#avWorkoutSearch');
      el.querySelector('#avWorkoutDuration').addEventListener('change', (e) => { this.maxMinutes = Number(e.target.value); this.showAll = false; this.renderList(); });
      input.addEventListener('input', () => { this.query = input.value; this.showAll = false; this.renderList(); });
      const tools = el.querySelector('.av-wk-tools');
      tools.appendChild(this.shell.row({ icon: 'i-plus', id: 'avOpenBuilder', title: 'Build your own', sub: 'Fine-tune the loaded workout step by step, save it', onClick: () => this.shell.go('train/builder') }));
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
    const list = filterWorkouts(app.workoutLibrary, this.cat, this.query, this.App).filter((w) => !this.maxMinutes || (Number(w.durationMin) || (w.intervals || []).reduce((s, v) => s + Number(v.duration || 0), 0) / 60) <= this.maxMinutes);
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = `<p class="av-note av-empty">${this.cat === 'custom' && !this.query ? 'No saved workouts yet. Save one from the coach chat or Build your own.' : 'No workouts match. Try another type, or ask the coach for one.'}</p>`;
      return;
    }
    const M = this.win.VeloMetrics;
    const ftp = (app.activeProfile && app.activeProfile.ftp) || 200;
    const shown = this.showAll ? list : list.slice(0, LIST_CAP);
    for (const w of shown) {
      const maxPct = Math.max(0, ...(w.intervals || []).map((iv) => iv.pctFtp || 0));
      const test = app.rampTestConfig && app.rampTestConfig(w);
      const seconds = (w.intervals || []).reduce((sum, iv) => sum + Number(iv.duration || 0), 0);
      const category = CATEGORY_NAMES[w.category] || 'Workout';
      const sub = test ? `${fmtMin(w.durationMin || seconds / 60)} max · sets your FTP` : `${durationText(seconds || Number(w.durationMin) * 60)} · ${(w.intervals || []).length} steps`;
      const row = this.shell.row({ title: workoutName(w.title), sub, onClick: () => this.openWorkout(w.id) });
      row.classList.add('av-workout-card');
      row.title = w.title;
      row.dataset.avWorkout = w.id;
      const loaded = app.currentWorkout && app.currentWorkout.id === w.id;
      if (loaded) row.classList.add('av-wk-loaded');
      const accent = M ? M.zoneForPct(CAT_PCT[w.category] || maxPct).color : '#78caff';
      row.style.setProperty('--workout-accent', accent);
      row.querySelector('.av-row-chevron')?.remove();
      row.insertAdjacentHTML('afterbegin', `<span class="av-workout-card-head"><span class="av-workout-type">${icon(test ? 'i-target' : 'i-bolt')}${esc(category)}</span>${loaded ? '<span class="av-workout-selected">Selected</span>' : ''}</span>`);
      row.insertAdjacentHTML('beforeend', `${workoutProfile(w.intervals, M ? (pct) => M.zoneForPct(pct) : null)}<span class="av-workout-open">View workout ${icon('i-right')}</span>`);
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
      <button type="button" class="btn btn-start av-big" id="avWorkoutRide">${icon('i-play')}Start ride</button>
      <div class="btn-row av-plan-more">
        <button type="button" class="btn btn-ghost btn-grow" id="avWorkoutEdit"${this.riding() ? ' disabled' : ''}>Edit workout</button>
        ${custom ? `<button type="button" class="btn btn-danger btn-grow" id="avWorkoutDelete">${icon('i-trash')}Delete</button>` : ''}
      </div>${this.riding() ? '<p class="av-note">A ride is under way: finish it to fine-tune another workout.</p>' : ''}`;
    this.shell.openSheet(box, { title: workoutName(w.title) });
    const canvas = box.querySelector('canvas');
    if (app.drawMiniProfile) this.win.requestAnimationFrame(() => app.drawMiniProfile(canvas, w.intervals, { height: 64 }));
    box.querySelector('#avWorkoutRide').addEventListener('click', () => this.ride((a) => { a.loadWorkoutIntoCockpit(w.id); }));
    box.querySelector('#avWorkoutEdit').addEventListener('click', () => { if (this.riding()) return; this.shell.closeSheet(); app.selectWorkoutById(w.id); this.shell.go('train/builder'); });
    box.querySelector('#avWorkoutDelete')?.addEventListener('click', () => {
      const n = app.workoutLibrary.length;
      app.deleteWorkout(w.id);
      if (app.workoutLibrary.length !== n) { this.shell.closeSheet(); this.renderList(); }
    });
  }

  // --------------------------------------------------------------------------------------------- Builder --

  mountBuilder() {
    const app = this.app;
    const el = this.builderEl;
    if (!app) { this.shell.whenApp(() => { if (this.shell.current && this.shell.current.route === 'train/builder') this.mountBuilder(); }); return; }
    if (!el.querySelector('.av-builder-head')) {
      el.innerHTML = `<div class="card av-builder-head"><span class="eyebrow">Your workout</span><h3 class="av-plan-title" id="avBuilderTitle"></h3><p class="av-note" id="avBuilderMeta"></p><div id="avBuilderProfile"></div>
        <button type="button" class="btn btn-start av-big" id="avBuilderRide">${icon('i-play')}Start ride</button></div>
        <div class="av-builder-table"></div>
        <p class="av-note">Edit each step, then Save workout to keep your changes.</p>`;
      el.querySelector('#avBuilderRide').addEventListener('click', () => this.ride());
    }
    const w = app.currentWorkout || { title: '', intervals: [] };
    el.querySelector('#avBuilderTitle').textContent = workoutName(w.title);
    el.querySelector('#avBuilderProfile').innerHTML = workoutProfile(w.intervals, this.win.VeloMetrics ? (pct) => this.win.VeloMetrics.zoneForPct(pct) : null);
    const secs = (w.intervals || []).reduce((a, iv) => a + (Number(iv.duration) || 0), 0);
    el.querySelector('#avBuilderMeta').textContent = `${w.intervals.length} steps · ${fmtMin(secs / 60)}`;
    if (!this._restoreBuilder) this._restoreBuilder = borrow(this.doc.getElementById('customWorkoutTableSection'), el.querySelector('.av-builder-table'));
    if (app.populateCustomIntervalTable) app.populateCustomIntervalTable();
    labelIntervalFields(this.doc);
  }
}

export function installTrainTab({ shell, rideTab = null, win = window }) {
  return new TrainTab({ shell, rideTab, win });
}
