/**
 * Ride tab, first screen ("Today", docs/ANDROID-UX.md 2.1): readiness, the planned or loaded workout with Start
 * ride, Change workout and Free ride, device status, last ride and the week. Plus the devices sheet. Everything
 * reads the app's own state and presses the app's own buttons; the ride screen itself is native-ride-view.js.
 */

import { RideView } from './native-ride-view.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id) => `<svg class="ic" aria-hidden="true"><use href="#${id}"/></svg>`;
const KINDS = [
  { kind: 'trainer', icon: 'i-bolt', label: 'Trainer', status: 'hwTrainerStatusBadge', button: 'btnConnectTrainerModal' },
  { kind: 'pedals', icon: 'i-crank', label: 'Power meter', status: 'hwPedalStatusBadge', button: 'btnConnectPedalsModal' },
  { kind: 'hr', icon: 'i-heart', label: 'Heart rate', status: 'hwHrStatusBadge', button: 'btnConnectHrModal' },
  { kind: 'fan', icon: 'i-refresh', label: 'Fan', status: 'hwFanStatusBadge', button: 'btnConnectFanModal' }
];
/** Cards the app shows at the top of the cockpit (recoveries, first run): they move to Today, ids and bindings intact. */
const NOTICES = ['interruptedRideRecovery', 'earlierBrowserRecovery', 'unsavedChangeRecovery', 'firstRunHelp'];

/** An open-ended ride without targets: one long easy step with ERG off (resistance mode). */
export const FREE_RIDE = { id: 'free_ride', title: 'Free ride', category: 'free', intervals: [{ name: 'Free ride', duration: 4 * 3600, pctFtp: 55 }] };

/** Connected / saved device counts, from the devices panel the app keeps up to date. */
export function deviceSummary(doc) {
  let connected = 0, saved = 0, attention = false;
  for (const k of KINDS) {
    const card = doc.getElementById(`deviceCard-${k.kind}`);
    const badge = doc.getElementById(k.status);
    if (!badge || (card && card.hidden)) continue;
    saved++;
    const state = badge.dataset.state;
    if (state === 'connected') connected++;
    if (['failed', 'reconnecting'].includes(state)) attention = true;
  }
  return { connected, saved, attention };
}

export class TodayScreen {
  constructor({ shell, win = window }) {
    this.shell = shell; this.win = win; this.doc = win.document;
    this.el = this.doc.createElement('div');
    this.el.className = 'av-page-body av-today';
    this.el.innerHTML = `<div class="av-today-notices"></div>
      <div class="card av-ready" hidden></div>
      <div class="card av-plan"></div>
      <div class="av-label">This week</div>
      <div class="card av-list av-week"></div>`;
    this.chip = this.doc.createElement('button');
    this.chip.type = 'button';
    this.chip.id = 'avDevicesChip';
    this.chip.className = 'chip av-devices-chip';
    this.chip.addEventListener('click', () => this.openDevices());
    shell.registerPage('ride', {
      title: 'Today', el: this.el,
      actions: () => this.chip,
      mount: () => this.render()
    });
  }

  get app() { return this.shell.getApp(); }

  /** Moves the app's recovery and welcome cards onto Today (they stay hidden until the app shows them). */
  adoptNotices() {
    const box = this.el.querySelector('.av-today-notices');
    for (const id of NOTICES) { const n = this.doc.getElementById(id); if (n && n.parentNode !== box) box.appendChild(n); }
  }

  render() {
    const app = this.app;
    this.adoptNotices();
    this.renderChip();
    if (!app) { this.shell.whenApp(() => this.render()); return; }
    this.renderReadiness(app);
    this.renderPlan(app);
    this.renderWeek(app);
  }

  renderChip() {
    const s = deviceSummary(this.doc);
    const text = s.connected ? `${s.connected} device${s.connected === 1 ? '' : 's'}` : s.saved ? 'Connect' : 'Devices';
    this.chip.innerHTML = `<span class="av-dot" data-on="${s.connected ? (s.attention ? 'warn' : 'on') : 'off'}"></span>${esc(text)}`;
    this.chip.setAttribute('aria-label', `Devices: ${s.connected} connected`);
  }

  renderReadiness(app) {
    const el = this.el.querySelector('.av-ready');
    const r = app.healthReadiness ? app.healthReadiness() : null;
    el.hidden = !r || r.level === 'none';
    if (el.hidden) return;
    const label = app.readinessText ? app.readinessText(r) : r.label;
    el.innerHTML = `<button type="button" class="av-ready-row" data-level="${esc(r.level)}"><span class="av-ready-dot"></span>
      <span><span class="eyebrow">Readiness</span><b>${esc(label)}</b><small>${esc(r.advice || (r.reasons || []).join(' · '))}</small></span></button>`;
    el.querySelector('button').addEventListener('click', () => app.showReadinessDetail && app.showReadinessDetail());
  }

  /** Today's session from the plan when there is one, else the loaded workout. */
  plannedToday(app) {
    const bp = app.blockPlanner;
    const P = this.win.VeloBlockPlanner;
    if (!bp || !bp.block || !P) return null;
    return (bp.sessionsByDate().get(P.today()) || []).find((x) => x.status === 'planned') || null;
  }

  renderPlan(app) {
    const el = this.el.querySelector('.av-plan');
    const planned = this.plannedToday(app);
    const w = app.currentWorkout || { title: '', intervals: [] };
    const loadedIsPlanned = planned && (w.blockSessionId === planned.id || w.title === planned.title);
    const riding = app.isPlaying || app.totalElapsedSeconds > 0;
    const title = planned && !loadedIsPlanned && !riding ? planned.title : w.title;
    const eyebrow = riding ? 'Ride in progress' : planned ? 'Planned today' : 'Ready to ride';
    const meta = planned && !loadedIsPlanned && !riding ? `${planned.durationMin} min · from your plan`
      : `${this.text('hudWorkoutDuration')} · ${this.text('hudWorkoutAvgPower')} expected avg${loadedIsPlanned ? ' · from your plan' : ''}`;
    const total = w.intervals.reduce((a, iv) => a + (Number(iv.duration) || 0), 0) || 1;
    const M = this.win.VeloMetrics;
    const bars = (planned && !loadedIsPlanned && !riding) ? '' : w.intervals.slice(0, 80).map((iv) => {
      const z = M ? M.zoneForPct(iv.pctFtp) : null;
      return `<i style="flex:${(Number(iv.duration) || 0) / total};height:${Math.max(12, Math.min(100, iv.pctFtp / 1.3))}%;background:${z ? z.color : 'var(--cyan)'}"></i>`;
    }).join('');
    el.innerHTML = `<span class="eyebrow">${esc(eyebrow)}</span>
      <h3 class="av-plan-title">${esc(title || 'Workout')}</h3>
      <p class="av-note">${esc(meta)}</p>
      ${bars ? `<div class="av-profile" aria-hidden="true">${bars}</div>` : ''}
      <button type="button" class="btn btn-start av-big" id="avStartRide">${icon('i-play')}${riding ? 'Back to ride' : 'Start ride'}</button>
      <div class="btn-row av-plan-more">
        <button type="button" class="btn btn-ghost btn-grow" id="avChangeWorkout">Change workout</button>
        <button type="button" class="btn btn-ghost btn-grow" id="avFreeRide">Free ride</button>
      </div>`;
    el.querySelector('#avStartRide').addEventListener('click', () => {
      if (!riding && planned && !loadedIsPlanned && app.loadBlockSession) app.loadBlockSession(planned.id);
      this.startRide();
    });
    el.querySelector('#avChangeWorkout').addEventListener('click', () => this.shell.go('train/workouts'));
    el.querySelector('#avFreeRide').addEventListener('click', () => this.freeRide());
    el.querySelector('#avFreeRide').disabled = el.querySelector('#avChangeWorkout').disabled = riding;
  }

  text(id) { const n = this.doc.getElementById(id); return n ? n.textContent.trim() : ''; }

  /** Opens the ride screen and starts (or arms) the loaded workout; a ride in progress is only reopened. */
  startRide() {
    const app = this.app;
    this.shell.go('ride/live');
    if (app && !app.isPlaying && !(app.totalElapsedSeconds > 0)) this.doc.getElementById('btnPlayPause')?.click();
  }

  freeRide() {
    const app = this.app;
    if (!app) return;
    app.loadWorkoutObjectIntoCockpit(FREE_RIDE);
    if (app.ergModeEnabled && app.toggleErgMode) app.toggleErgMode();
    this.startRide();
  }

  renderWeek(app) {
    const el = this.el.querySelector('.av-week');
    el.innerHTML = '';
    const rides = (app.completedWorkouts || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const last = rides[0];
    if (last) {
      const when = new Date(last.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      const mins = Math.round((last.duration || 0) / 60) || last.durationMin || 0;
      const bits = [when, mins ? `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')}` : '', last.np ? `${last.np} W NP` : '', last.tss ? `TSS ${Math.round(last.tss)}` : ''].filter(Boolean);
      el.appendChild(this.shell.row({ icon: 'i-history', id: 'avLastRide', title: `Last ride · ${last.title || 'Ride'}`, sub: bits.join(' · '), onClick: () => this.shell.go('history/' + encodeURIComponent(last.id)) }));
    }
    const monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const week = rides.filter((r) => new Date(r.date) >= monday);
    const tss = Math.round(week.reduce((a, r) => a + (Number(r.tss) || 0), 0));
    const secs = week.reduce((a, r) => a + (Number(r.duration) || 0), 0);
    el.appendChild(this.shell.row({ icon: 'i-calendar', id: 'avWeek', title: `${week.length} ride${week.length === 1 ? '' : 's'} this week`, sub: `${Math.floor(secs / 3600)} h ${String(Math.round(secs / 60) % 60).padStart(2, '0')} · TSS ${tss} · see your plan`, onClick: () => this.shell.go('train/plan') }));
  }

  // ------------------------------------------------------------------------------------------- devices --

  /** The devices sheet: one row per saved device with its state and Connect; tap a row for its details. */
  openDevices() {
    const list = this.doc.createElement('div');
    list.className = 'av-devices';
    list.id = 'avDevicesSheet';
    const render = () => {
      const app = this.app;
      if (app && app.renderDevicesPanel && !this._rendering) { this._rendering = true; try { app.renderDevicesPanel(); } finally { this._rendering = false; } }
      list.innerHTML = '<div class="card av-list"></div>';
      const box = list.firstChild;
      let any = false;
      for (const k of KINDS) {
        const card = this.doc.getElementById(`deviceCard-${k.kind}`);
        const badge = this.doc.getElementById(k.status);
        if (!badge || (card && card.hidden)) continue;
        any = true;
        const btn = this.doc.getElementById(k.button);
        const name = this.text(`deviceName-${k.kind}`) || k.label;
        const state = badge.dataset.state;
        let end;
        if (state === 'connected') { end = this.doc.createElement('span'); end.className = 'chip chip-lime'; end.textContent = 'On'; }
        else if (btn) {
          end = this.doc.createElement('button');
          end.type = 'button';
          end.className = 'btn btn-sm';
          end.textContent = /pair/i.test(btn.textContent) ? 'Pair' : /retry/i.test(btn.textContent) ? 'Retry' : 'Connect';
          end.disabled = btn.disabled;
          end.dataset.avConnect = k.kind;
          end.addEventListener('click', (e) => { e.stopPropagation(); btn.click(); setTimeout(render, 300); });
        }
        const row = this.shell.row({ icon: k.icon, title: name, sub: badge.textContent.trim(), end, onClick: () => this.openDeviceDetails() });
        row.dataset.avDevice = k.kind;
        box.appendChild(row);
      }
      if (!any) box.innerHTML = '<p class="av-note av-empty">No devices yet. Pair your trainer, power meter or heart-rate strap.</p>';
      const all = this.doc.getElementById('btnConnectSavedDevices');
      const actions = this.doc.createElement('div');
      actions.className = 'av-device-actions';
      actions.innerHTML = `${all && !all.disabled ? '<button type="button" class="btn btn-grow" id="avConnectAll">Connect saved devices</button>' : ''}
        <button type="button" class="btn btn-primary av-big" id="avPairDevice">${icon('i-plus')}Pair a new device</button>
        <p class="av-note">Calibration, PowerMatch, power and cadence sources, the fan and renaming are in each device's details.</p>`;
      list.appendChild(actions);
      const ca = actions.querySelector('#avConnectAll');
      if (ca) ca.addEventListener('click', () => { all.click(); setTimeout(render, 300); });
      actions.querySelector('#avPairDevice').addEventListener('click', () => this.openDeviceDetails(true));
    };
    render();
    const timer = this.win.setInterval(render, 1000);
    this.shell.openSheet(list, { title: 'Devices', onClose: () => { this.win.clearInterval(timer); this.renderChip(); } });
  }

  /** The app's full Devices panel (details, calibration, PowerMatch, fan, pairing). */
  openDeviceDetails(pair = false) {
    this.shell.closeSheet();
    const app = this.app;
    if (!app) return;
    app.openHardwareLab();
    if (pair) { const add = this.doc.getElementById('deviceAddSection'); if (add) { add.open = true; add.scrollIntoView({ block: 'start' }); } }
  }
}

/**
 * The Ride tab: Today, the ride screen and its sheets. When the app ends a ride (End, or the workout finishing),
 * the ride screen gives way to Today under the app's ride summary.
 */
export function installRideTab({ shell, win = window }) {
  const today = new TodayScreen({ shell, win });
  const ride = new RideView({ shell, win });
  ride.today = today;
  win.addEventListener('DOMContentLoaded', () => {
    /* global VeloApp */
    const App_ = typeof VeloApp !== 'undefined' ? VeloApp : win.VeloApp;
    const P = App_ && App_.prototype;
    if (!P || !P.finishWorkout || P.finishWorkout.__avShell) return;
    const finish = P.finishWorkout;
    P.finishWorkout = function (...args) {
      const r = finish.apply(this, args);
      const cur = shell.current && shell.current.route;
      if (this.isWorkoutCompleted && (cur === 'ride/live' || cur === 'ride/cockpit')) shell.go('ride', { replace: true });
      return r;
    };
    P.finishWorkout.__avShell = true;
  });
  return { today, ride };
}
