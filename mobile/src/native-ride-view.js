/**
 * The phone ride screen (docs/ANDROID-UX.md 2.1 and 2.5):
 *  - ride/live     the simple full-screen view: power against target, step countdown, next step, tiles, End/Pause/Skip
 *  - ride/cockpit  "Show all metrics": the app's own cockpit view, laid out for the phone
 *  - Controls      a sheet with every ride control (intensity, ERG, step, smoothing, audio, devices, simulator, ...)
 *  - Customise     every panel, tile and graph line on or off and in any order, in both views, saved per rider,
 *                  with Minimal / Standard / Everything presets and Reset.
 * Nothing here computes ride data or drives the trainer: values are read from the outputs js/app.js keeps up to
 * date (#valInstantPower, #hudIntervalCountdown, ...) and the controls press the app's own buttons.
 */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id) => `<svg class="ic" aria-hidden="true"><use href="#${id}"/></svg>`;

/**
 * Tiles: a label and where the value comes from (an element js/app.js updates). `sub` is a second line.
 * Values that already carry their unit (val1sPower = "263W") have none here.
 */
export const TILES = {
  power: { label: 'Power', src: 'valInstantPower', unit: 'W', sub: 'hudPowerHeroLabel' },
  p1s: { label: 'Power 1 s', src: 'val1sPower' },
  p3s: { label: 'Power 3 s', src: 'val3sPower' },
  p30s: { label: 'Power 30 s', src: 'val30sPower' },
  target: { label: 'Target', src: 'valTargetPower' },
  wkg: { label: 'W/kg', src: 'valWkg' },
  hr: { label: 'Heart rate', src: 'valHeartRate', unit: 'bpm', sub: 'valHrZone' },
  cadence: { label: 'Cadence', src: 'valCadence', unit: 'rpm', sub: 'valCadenceSub' },
  wbal: { label: 'W′ balance', src: 'wbalValue', unit: 'kJ', sub: 'wbalPct' },
  lr: { label: 'L / R balance', src: ['valLeftBalance', 'valRightBalance'], sub: 'balanceDataStatus' },
  speed: { label: 'Speed', src: 'valSpeed', unit: 'km/h' },
  distance: { label: 'Distance', src: 'valDistance', unit: 'km' },
  avg: { label: 'Avg power', src: 'valAvgPower', unit: 'W' },
  np: { label: 'NP', src: 'valNormPower', unit: 'W' },
  if: { label: 'IF', src: 'valIntensityFactor' },
  tss: { label: 'TSS', src: 'valTss', sub: 'valTotalKj' },
  elapsed: { label: 'Elapsed', src: 'hudTotalElapsed' },
  stepLeft: { label: 'Step left', src: 'hudIntervalCountdown' },
  zone: { label: 'Zone', src: 'ssZoneLabel' },
  deviation: { label: 'Vs target', src: 'hudCompliancePill' },
  intensity: { label: 'Intensity', src: 'biasValueDisplay' },
  erg: { label: 'ERG', src: 'hudErgStatusPill' },
  source: { label: 'Power source', src: 'hudPowerSourceBadge' },
  powermatch: { label: 'PowerMatch', src: 'hwPowerMatchTrimBadge' },
  readiness: { label: 'Readiness', src: 'cockpitReadinessChip', strip: /^Readiness:\s*/ },
  zoneTime: { label: 'Zone now', src: 'currentZoneBadge' },
  hrDrift: { label: 'HR drift (Pw:HR)', fn: (v) => v.hrDrift() }
};

/** Panels of the simple view (built here) and of the all-metrics view (FULL_BUILT here, FULL_PANELS the cockpit's own parts). */
export const SIMPLE_PANELS = {
  hero: 'Power and step countdown',
  profile: 'Workout profile with progress',
  next: 'Next step',
  coach: 'Coach and pedalling tips'
};
export const FULL_BUILT = {
  istrip: 'Interval strip (step, target, time left, next)',
  rideGraph: 'Ride graph (power, HR, cadence over the workout)'
};
export const FULL_PANELS = {
  now: ['Current step, readiness, rider', '.ss-now'],
  hero: ['Power ring, smoothing, intensity', '.ss-hero'],
  hr: ['Heart rate (last 60 s)', '.ss-right > .metric-cell:not(#metricCellCadence)'],
  cadence: ['Cadence (last 60 s)', '#metricCellCadence'],
  wbal: ['W′ balance', '#wbalCard'],
  overview: ['Workout, elapsed, distance, speed', '.ss-tl-head'],
  speed: ['Speed', '.ss-stats > .metric-cell:nth-child(1)'],
  distance: ['Distance', '.ss-stats > .metric-cell:nth-child(2)'],
  avg: ['Avg power', '.ss-stats > .metric-cell:nth-child(3)'],
  np: ['Normalized power', '.ss-stats > .metric-cell:nth-child(4)'],
  if: ['Intensity factor', '.ss-stats > .metric-cell:nth-child(5)'],
  tss: ['TSS and kJ', '.ss-stats > .metric-cell:nth-child(6)'],
  profile: ['Workout profile', '#intervalTrackWrap'],
  queue: ['Interval queue (tap to jump)', '#upcomingIntervalsStrip'],
  stepControls: ['Step controls (reset, Stand 30s, ±30 s)', '.timeline-controls > .control-btn-group:nth-child(1)'],
  biasControls: ['Fine ERG bias (±1 %, reset)', '.timeline-controls > .control-btn-group:nth-child(2)'],
  views: ['Zen, Mini-HUD and Focus buttons', '.timeline-controls > .control-views'],
  ergResponse: ['ERG response', '.erg-response-control'],
  graph: ['Live graph (last 2 min)', '#liveTelemetryChart'], // its card
  lr: ['Left / right balance', '.polar-card'],
  zones: ['Time in zone', '.zone-distribution-wrap']
};
/** The live graph's lines, by the label of their Chart.js dataset. */
export const LINES = { power: 'Power', target: 'Target', cadence: 'Cadence', hr: 'Heart rate' };

const ALL_SIMPLE = [...Object.keys(SIMPLE_PANELS).map((k) => 'panel:' + k), ...Object.keys(TILES).map((k) => 'tile:' + k)];
const FULL_TILES = Object.keys(TILES).map((k) => 'ftile:' + k);
const ALL_FULL = [...Object.keys(FULL_BUILT), ...FULL_TILES, ...Object.keys(FULL_PANELS)];
const list = (order, on) => order.map((id) => ({ id, on: on.includes(id) }));
/** All metrics, compact (mock-up e): the strip, the ride graph and twelve tiles; the cockpit's controls stay on below. */
const COMPACT_TILES = ['power', 'p30s', 'target', 'avg', 'np', 'tss', 'hr', 'cadence', 'wbal', 'lr', 'if', 'wkg'].map((k) => 'ftile:' + k);
const COMPACT = ['istrip', 'rideGraph', ...COMPACT_TILES];
const fullOrder = (first) => [...first, ...ALL_FULL.filter((x) => !first.includes(x))];
export const PRESETS = {
  minimal: {
    simple: list(['panel:hero', 'panel:next', 'tile:hr', 'tile:cadence', ...ALL_SIMPLE], ['panel:hero', 'panel:next', 'tile:hr', 'tile:cadence']),
    full: list(fullOrder(COMPACT), ['istrip', 'rideGraph', ...COMPACT_TILES.slice(0, 6)]),
    lines: { power: true, target: true, cadence: false, hr: false }
  },
  standard: {
    simple: list(['panel:hero', 'panel:profile', 'panel:next', 'tile:hr', 'tile:cadence', 'tile:wbal', ...ALL_SIMPLE], ['panel:hero', 'panel:profile', 'panel:next', 'tile:hr', 'tile:cadence', 'tile:wbal']),
    full: list(fullOrder([...COMPACT, 'stepControls', 'biasControls', 'views', 'ergResponse', 'queue']), [...COMPACT, 'stepControls', 'biasControls', 'views', 'ergResponse', 'queue']),
    lines: { power: true, target: true, cadence: true, hr: true }
  },
  everything: {
    simple: list(['panel:hero', 'panel:profile', 'panel:next', 'panel:coach', ...ALL_SIMPLE], ALL_SIMPLE),
    full: list(fullOrder(COMPACT), ALL_FULL),
    lines: { power: true, target: true, cadence: true, hr: true }
  }
};

/** Puts a stored item list in catalog terms: unknown ids dropped, duplicates removed, new items added (off) at the end. */
export function normalizeItems(items, all) {
  const seen = new Set(), out = [];
  for (const it of Array.isArray(items) ? items : []) if (it && all.includes(it.id) && !seen.has(it.id)) { seen.add(it.id); out.push({ id: it.id, on: !!it.on }); }
  for (const id of all) if (!seen.has(id)) out.push({ id, on: false });
  return out;
}

/** Ride-screen layouts, one per rider profile, in localStorage (no secrets in it). */
export class RideLayouts {
  /** `storage` is a localStorage-like object, or a function returning one (read when used). */
  constructor(storage, key = 'apex_ride_layout_v1') { this._storage = storage; this.key = key; }
  get storage() { return typeof this._storage === 'function' ? this._storage() : this._storage; }
  all() { try { return JSON.parse(this.storage.getItem(this.key) || '{}') || {}; } catch (e) { return {}; } }
  get(profileId) {
    const l = this.all()[profileId] || PRESETS.standard;
    return {
      simple: normalizeItems(l.simple, ALL_SIMPLE),
      full: normalizeItems(l.full, ALL_FULL),
      lines: { ...PRESETS.standard.lines, ...(l.lines || {}) }
    };
  }
  set(profileId, layout) {
    const all = this.all();
    all[profileId] = layout;
    try { this.storage.setItem(this.key, JSON.stringify(all)); } catch (e) { /* storage full: the layout still applies now */ }
  }
  preset(profileId, name) { const p = JSON.parse(JSON.stringify(PRESETS[name])); this.set(profileId, p); return this.get(profileId); }
  reset(profileId) { const all = this.all(); delete all[profileId]; try { this.storage.setItem(this.key, JSON.stringify(all)); } catch (e) { /* ignore */ } return this.get(profileId); }
}

export class RideView {
  constructor({ shell, win = window, storage = () => win.localStorage }) {
    this.shell = shell; this.win = win; this.doc = win.document;
    this.layouts = new RideLayouts(storage);
    this.timer = null;
    this.buildSimple();
    shell.registerPage('ride/live', {
      el: this.simple, fullscreen: true, parent: 'ride',
      mount: () => { this.mountSimple(); },
      unmount: () => this.leave(),
      onBack: () => this.onBack()
    });
    shell.registerPage('ride/cockpit', {
      view: 'cockpit', fullscreen: true, parent: 'ride/live',
      mount: () => this.mountFull(),
      unmount: () => this.leave(),
      onBack: () => { this.shell.go('ride/live', { replace: true }); return true; }
    });
    this.summary = this.doc.createElement('div');
    this.summary.className = 'av-summary';
    shell.registerPage('ride/summary/:rideId', {
      el: this.summary, fullscreen: true, parent: 'ride',
      mount: (el, { rideId }) => this.mountSummary(rideId)
    });
  }

  get app() { return this.shell.getApp(); }
  $(id) { return this.doc.getElementById(id); }
  text(id) { const n = this.$(id); return n ? n.textContent.trim() : ''; }
  layout() { const app = this.app; return this.layouts.get((app && app.activeProfileId) || 'default'); }
  saveLayout(l) { const app = this.app; this.layouts.set((app && app.activeProfileId) || 'default', l); }

  // ------------------------------------------------------------------------------------------ simple view --

  buildSimple() {
    const el = this.simple = this.doc.createElement('div');
    el.className = 'av-ride';
    el.id = 'avRide';
    el.innerHTML = `
      <div class="av-ride-top">
        <span class="chip av-ride-step" id="avRideStep">Ready</span>
        <span class="av-ride-clock num" id="avRideClock">00:00</span>
        <button type="button" class="icon-btn av-icon-btn" id="avRideControls" aria-label="Controls and settings">${icon('i-gear')}</button>
      </div>
      <div class="av-ride-progress" aria-hidden="true"><i id="avRideProgress"></i></div>
      <div class="av-ride-banner" id="avRideBanner" hidden role="status"></div>
      <div class="av-ride-grid" id="avRideGrid">
        <div class="av-ride-hero" data-av-item="panel:hero">
          <small class="av-ride-target" id="avRideTarget"></small>
          <b class="av-ride-power num" id="avRidePower">--</b>
          <small class="av-ride-unit"><span id="avRideUnit">W</span> <span class="av-ride-dev" id="avRideDev"></span></small>
          <div class="av-devbar" id="avDevBar" aria-hidden="true"><i class="av-devbar-ok"></i><i class="av-devbar-mark" id="avDevMark"></i></div>
          <div class="av-hrz" id="avHrZones" hidden aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
          <span class="av-ride-countdown num" id="avRideCountdown">0:00</span>
          <small class="av-ride-left">left in this step</small>
        </div>
        <div class="av-ride-profile" data-av-item="panel:profile"></div>
        <div class="av-ride-next" data-av-item="panel:next"><span class="av-ride-next-dot"></span><div><b id="avRideNext">--</b><small id="avRideNextSub"></small></div><span class="num" id="avRideNextIn"></span></div>
        <div class="av-ride-coach" data-av-item="panel:coach"><b>Coach</b> <span id="avRideCoach"></span></div>
        ${Object.entries(TILES).map(([id, t]) => `<div class="av-tile" data-av-item="tile:${id}" data-tile="${id}"><span class="av-tile-lbl">${esc(t.label)}</span><span class="av-tile-val num"></span><span class="av-tile-sub"></span></div>`).join('')}
      </div>
      <div class="av-ride-ctrl">
        <button type="button" class="btn btn-stop" id="avRideEnd">End</button>
        <button type="button" class="btn btn-pause" id="avRidePause">${icon('i-pause')}<span>Pause</span></button>
        <button type="button" class="btn" id="avRideSkip">${icon('i-skip')}<span>Skip</span></button>
      </div>`;
    el.querySelector('#avRideControls').addEventListener('click', () => this.openControls());
    el.querySelector('#avRideEnd').addEventListener('click', () => this.confirmEnd());
    el.querySelector('#avRidePause').addEventListener('click', () => { this.$('btnPlayPause')?.click(); this.update(); });
    el.querySelector('#avRideSkip').addEventListener('click', () => { this.$('btnSkipInterval')?.click(); this.update(); });
  }

  mountSimple() {
    const wrap = this.$('intervalTrackWrap');
    const slot = this.simple.querySelector('.av-ride-profile');
    if (wrap && wrap.parentNode !== slot) {
      if (!this._trackHome) { this._trackHome = this.doc.createComment('av-track'); wrap.parentNode.insertBefore(this._trackHome, wrap); }
      slot.appendChild(wrap);
    }
    this.applySimpleLayout();
    this.redrawTrack();
    this.start();
  }

  applySimpleLayout() {
    const l = this.layout();
    l.simple.forEach((it, i) => {
      const n = this.simple.querySelector(`[data-av-item="${it.id}"]`);
      if (n) { n.hidden = !it.on; n.style.order = String(i); }
    });
  }

  /** The cockpit's workout profile canvas follows its container's size. */
  redrawTrack() {
    const app = this.app;
    if (!app) return;
    this.win.requestAnimationFrame(() => { if (app.trackCache) app.trackCache.key = ''; if (app.renderIntervalTrack) app.renderIntervalTrack(); });
  }

  /** Puts the moved cockpit parts back and stops the refresh. */
  leave() {
    this.stop();
    const wrap = this.$('intervalTrackWrap');
    if (this._trackHome && wrap && wrap.previousSibling !== this._trackHome) this._trackHome.parentNode.insertBefore(wrap, this._trackHome.nextSibling);
    this.doc.body.classList.remove('av-full-ride');
  }

  start() { this.stop(); this.update(); this.timer = this.win.setInterval(() => this.update(), 250); }
  stop() { if (this.timer) this.win.clearInterval(this.timer); this.timer = null; }

  /** Reads the app's outputs into the open view. */
  update() {
    const app = this.app;
    if (!app || !app.currentWorkout) return;
    const ivs = app.currentWorkout.intervals || [], i = app.intervalIndex || 0, iv = ivs[i];
    const route = this.shell.current && this.shell.current.route;
    const M = this.win.VeloMetrics;
    const target = app.getCurrentTargetWatts ? app.getCurrentTargetWatts() : 0;
    const free = app.currentWorkout.id === 'free_ride';
    const running = !!app.isPlaying, started = app.totalElapsedSeconds > 0;
    const finished = app.isWorkoutCompleted || i >= ivs.length;
    const remaining = Number(app.intervalSecondsRemaining) || 0;
    // Pause / Resume / Start, as the app's own button says.
    const label = running ? 'Pause' : finished ? 'Restart' : started ? 'Resume' : 'Start';
    for (const b of this.doc.querySelectorAll('#avRidePause, #avFullPause')) {
      b.className = running ? 'btn btn-pause' : 'btn btn-start';
      b.innerHTML = `${icon(running ? 'i-pause' : 'i-play')}<span>${label}</span>`;
    }
    const step = this.$('avRideStep');
    if (!step) return;
    const z = iv && M ? M.zoneForPct(iv.pctFtp * (app.ergBiasMultiplier || 1)) : null;
    const ramp = app.rampTestConfig && app.rampTestConfig();
    step.textContent = !iv ? 'Finished' : !running && started ? 'Paused' : free ? 'Free ride' : `${iv.name} · ${ramp ? `step ${i + 1}` : `${i + 1}/${ivs.length}`}${z ? ' · ' + z.short : ''}`;
    this.setText('avRideClock', this.text('hudTotalElapsed'));
    this.setText('avFullClock', this.text('hudTotalElapsed'));
    const total = ivs.reduce((a, x) => a + (Number(x.duration) || 0), 0) || 1;
    const done = ivs.slice(0, i).reduce((a, x) => a + (Number(x.duration) || 0), 0) + (iv ? (Number(iv.duration) || 0) - remaining : 0);
    const bar = this.$('avRideProgress');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, done / total * 100))}%`;
    // A visual pulse when the step changes (the app plays its own audio cues).
    if (running && this._lastStep != null && this._lastStep !== i) this.flash();
    this._lastStep = i;
    if (route === 'ride/cockpit') { this.updateFull(app, { ivs, i, iv, z, target, free, remaining }); this.updateBanner(app); return; }
    if (route !== 'ride/live') { this.updateBanner(app); return; }
    // Hero: power against target, deviation, step countdown (pulses in the last 3 s before a step change).
    const power = Number(this.text('valInstantPower')) || 0;
    const hrOnly = this.hrOnly(app);
    this.simple.classList.toggle('av-hr-only', hrOnly);
    const hrz = this.$('avHrZones');
    hrz.hidden = !hrOnly;
    if (hrOnly) {
      // No power source (mock-up d): heart rate is the hero, with its zone.
      const hr = Number(this.text('valHeartRate')) || 0;
      const zh = M && M.hrZone ? M.hrZone(hr, (app.activeProfile && app.activeProfile.maxHr) || 0) : { idx: 0, label: '--', pct: 0 };
      this.setText('avRideTarget', 'Heart rate');
      this.setText('avRidePower', hr ? String(hr) : '--');
      this.setText('avRideUnit', `bpm${zh.idx ? ` · ${zh.label} · ${zh.pct} % of max` : ''}`);
      [...hrz.children].forEach((n, k) => n.classList.toggle('on', k + 1 === zh.idx));
    } else {
      this.setText('avRideTarget', free ? 'Free ride · no target' : target ? `Target ${target} W${iv ? ` · ${Math.round(iv.pctFtp * (app.ergBiasMultiplier || 1))}% FTP` : ''}` : '');
      this.setText('avRidePower', started || running ? String(power) : '--');
      this.setText('avRideUnit', `W${z && !free ? ' · ' + z.name : ''}`);
    }
    // Deviation from target: a chip (+12 W / on target) and a bar with the ±5 % band (TrainerRoad-style).
    const dev = this.$('avRideDev');
    const diff = power - target;
    const band = target ? Math.max(5, target * 0.05) : 0;
    const showDev = !free && !hrOnly && target && running;
    dev.textContent = showDev ? (Math.abs(diff) <= band ? 'on target' : `${diff > 0 ? '+' : '−'}${Math.abs(diff)} W`) : '';
    dev.dataset.dev = !showDev ? '' : diff > band ? 'over' : diff < -band ? 'under' : 'on';
    const devBar = this.$('avDevBar');
    devBar.hidden = !showDev;
    if (showDev) {
      this.$('avDevMark').style.left = `${50 + Math.max(-1, Math.min(1, diff / (target * 0.2))) * 50}%`;
      devBar.dataset.dev = dev.dataset.dev;
    }
    this.setText('avRideCountdown', this.text('hudIntervalCountdown'));
    const hero = this.simple.querySelector('.av-ride-hero');
    hero.classList.toggle('av-pulse', running && remaining > 0 && remaining <= 3 && i < ivs.length - 1);
    hero.dataset.state = !running && started ? 'paused' : running ? 'running' : 'ready';
    // Next step.
    const nx = ivs[i + 1];
    const F = (app.activeProfile && app.activeProfile.ftp) || 0;
    this.setText('avRideNext', nx ? `Next · ${nx.name} ${app.fmtTime(nx.duration)}` : ramp ? 'Next · another ramp step' : 'Last step · bring it home');
    this.setText('avRideNextSub', nx ? `${Math.round(F * nx.pctFtp / 100 * (app.ergBiasMultiplier || 1))} W · ${nx.pctFtp}% FTP` : '');
    this.setText('avRideNextIn', nx ? `in ${app.fmtTime(remaining)}` : '');
    this.setText('avRideCoach', this.text('valBiomechFeedback'));
    for (const n of this.simple.querySelectorAll('.av-tile:not([hidden])')) this.fillTile(n);
    this.updateBanner(app);
  }

  /** True when no power source sends watts (no fresh pedal or trainer reading, simulator off) but heart rate does. */
  hrOnly(app) {
    if (!(app.totalElapsedSeconds > 0) || (app.simulator && app.simulator.enabled)) return false;
    const fresh = app.devicePowerFresh ? app.devicePowerFresh() : { pedals: true };
    return !fresh.pedals && !fresh.trainer && (Number(this.text('valHeartRate')) || 0) > 0;
  }

  /** Live Pw:HR decoupling of this ride so far (js/velo-insight.js; it needs 20 steady minutes with HR). */
  hrDrift() {
    const app = this.app, I = this.win.VeloInsight;
    if (!app || !I || !Array.isArray(app.recordedSamples)) return '--';
    const now = Math.floor(Date.now() / 5000);
    if (this._driftAt === now) return this._drift;
    this._driftAt = now;
    const d = I.decoupling(app.recordedSamples);
    this._drift = d.status === 'ok' ? `${d.pct > 0 ? '+' : ''}${Number(d.pct).toFixed(1)}%` : d.status === 'no-hr' ? 'no HR' : d.status === 'too-short' ? 'after 20 min' : 'not steady';
    return this._drift;
  }

  flash() {
    for (const n of [this.simple, this.$('view-cockpit')]) {
      if (!n) continue;
      n.classList.remove('av-flash');
      void n.offsetWidth; // restart the animation
      n.classList.add('av-flash');
    }
  }

  fillTile(n) {
    const t = TILES[n.dataset.tile];
    if (!t) return;
    let v = t.fn ? t.fn(this) : Array.isArray(t.src) ? t.src.map((s) => this.text(s)).join(' / ') : this.text(t.src);
    if (t.strip) v = v.replace(t.strip, '');
    n.querySelector('.av-tile-val').innerHTML = `${esc(v || '--')}${t.unit ? ` <small>${t.unit}</small>` : ''}`;
    n.querySelector('.av-tile-sub').textContent = t.sub ? this.text(t.sub) : '';
  }

  setText(id, v) { const n = this.$(id); if (n && n.textContent !== v) n.textContent = v; }

  /** A device dropping out shows as a banner (mock-up g), with the app's own retry text. */
  updateBanner(app) {
    const banner = this.$('avRideBanner');
    if (!banner || !app.ble || !app.ble.getDiagnostics) return;
    const names = { trainer: 'Trainer', pedals: 'Power meter', hr: 'Heart-rate strap' };
    const lost = Object.keys(names).find((k) => { const d = app.ble.getDiagnostics(k); return d && ['reconnecting', 'failed'].includes(d.state); });
    const hrOnly = !lost && this.shell.current && this.shell.current.route === 'ride/live' && this.hrOnly(app);
    banner.hidden = !lost && !hrOnly;
    const key = lost ? `lost:${lost}:${this.text(`deviceError-${lost}`)}:${app.ble.isConnected && app.ble.isConnected('trainer')}:${app.powerSourcePreference}:${!!app.isPlaying}` : hrOnly ? 'hr-only' : '';
    if (banner.dataset.key === key) return;
    banner.dataset.key = key;
    banner.dataset.kind = lost ? 'lost' : hrOnly ? 'info' : '';
    if (lost) {
      // Pedals gone but the trainer still measures power (mock-up g): carry on with the trainer's power.
      const canSwitch = lost === 'pedals' && app.ble.isConnected && app.ble.isConnected('trainer') && app.powerSourcePreference !== 'trainer' && app.setDeviceSource;
      const paused = !app.isPlaying && app.totalElapsedSeconds > 0 && !app.isWorkoutCompleted;
      banner.innerHTML = `<b>${names[lost]} lost</b><span>${esc(this.text(`deviceError-${lost}`) || 'Reconnecting…')}</span>${canSwitch ? `<button type="button" class="btn av-big" id="avUseTrainerPower">${paused ? 'Use trainer power and resume' : 'Use trainer power instead'}</button>` : ''}`;
      const b = banner.querySelector('#avUseTrainerPower');
      if (b) b.addEventListener('click', () => {
        app.setDeviceSource('power', 'trainer');
        if (!app.isPlaying && app.totalElapsedSeconds > 0 && !app.isWorkoutCompleted) this.$('btnPlayPause')?.click();
        banner.dataset.key = '';
        this.update();
      });
    } else if (hrOnly) {
      banner.innerHTML = '<button type="button" class="av-banner-btn" id="avNoPowerBanner"><span>No power source. Connect pedals or a trainer for watts.</span></button>';
      banner.querySelector('button').addEventListener('click', () => this.today && this.today.openDevices());
    } else banner.innerHTML = '';
  }

  /** End stays away from Pause and asks first, so a stray tap never ends a ride. */
  confirmEnd() {
    const app = this.app;
    if (!app) return;
    if (!(app.totalElapsedSeconds > 0)) { this.shell.go('ride'); return; }
    const box = this.doc.createElement('div');
    box.className = 'av-confirm';
    box.innerHTML = `<p>Your ride is saved to History, with a summary next.</p>
      <button type="button" class="btn btn-stop av-big" id="avEndConfirm">End and save ride</button>
      <button type="button" class="btn av-big" id="avEndCancel">Keep riding</button>`;
    box.querySelector('#avEndConfirm').addEventListener('click', () => { this.shell.closeSheet(); this.$('btnEndWorkout')?.click(); });
    box.querySelector('#avEndCancel').addEventListener('click', () => this.shell.closeSheet());
    this.shell.openSheet(box, { title: 'End this ride?' });
  }

  /** Android back on the ride screen: during a ride it asks before ending; otherwise back to Today. */
  onBack() {
    const app = this.app;
    if (app && (app.isPlaying || app.totalElapsedSeconds > 0) && !app.isWorkoutCompleted) { this.confirmEnd(); return true; }
    return false;
  }

  // ------------------------------------------------------------------------------------- all-metrics view --

  /** The cockpit view, flattened so every part can be shown, hidden and ordered; a ride bar on top and bottom. */
  mountFull() {
    const view = this.$('view-cockpit');
    if (!view) return;
    this.doc.body.classList.add('av-full-ride');
    if (!this._fullBuilt) {
      this._fullBuilt = true;
      for (const [id, [, sel]] of Object.entries(FULL_PANELS)) {
        const n = id === 'graph' ? view.querySelector(sel)?.closest('.card') : view.querySelector(sel);
        if (n) n.dataset.avFull = id;
      }
      const top = this.doc.createElement('div');
      top.className = 'av-full-top';
      top.innerHTML = `<button type="button" class="btn btn-ghost" id="avSimpleView">${icon('i-left')}Simple view</button><span class="av-ride-clock num" id="avFullClock"></span>`;
      top.querySelector('#avSimpleView').addEventListener('click', () => this.shell.go('ride/live', { replace: true }));
      view.insertBefore(top, view.firstChild);
      // Compact all metrics (mock-up e): interval strip, ride graph and tiles, built here, ordered with the cockpit's parts.
      const strip = this.doc.createElement('div');
      strip.className = 'av-istrip';
      strip.dataset.avFull = 'istrip';
      strip.innerHTML = `<div class="av-istrip-now"><span class="av-zdot"></span><b id="avIstripName"></b><span id="avIstripTarget"></span></div><b class="num av-istrip-left" id="avIstripLeft"></b><div class="av-istrip-next" id="avIstripNext"></div>`;
      const graph = this.doc.createElement('div');
      graph.className = 'av-gcard';
      graph.dataset.avFull = 'rideGraph';
      graph.innerHTML = `<canvas id="avRideGraph" aria-label="Power, heart rate and cadence over the workout profile"></canvas>
        <div class="av-legend"><span data-legend="power"><i class="lg-power"></i>Power</span><span data-legend="hr"><i class="lg-hr"></i>HR</span><span data-legend="cadence"><i class="lg-cad"></i>Cadence</span><span><i class="lg-ftp"></i>FTP</span><span class="num av-legend-time" id="avGraphTime"></span></div>`;
      const after = top.nextSibling;
      view.insertBefore(strip, after);
      view.insertBefore(graph, after);
      for (const k of Object.keys(TILES)) {
        const t = this.doc.createElement('div');
        t.className = 'av-tile av-ftile';
        t.dataset.avFull = 'ftile:' + k;
        t.dataset.tile = k;
        t.innerHTML = `<span class="av-tile-lbl">${esc(TILES[k].label)}</span><span class="av-tile-val num"></span><span class="av-tile-sub"></span>`;
        view.insertBefore(t, after);
      }
      const bar = this.doc.createElement('div');
      bar.className = 'av-full-ctrl';
      bar.innerHTML = `<button type="button" class="btn btn-stop" id="avFullEnd">End</button>
        <button type="button" class="btn btn-pause" id="avFullPause">${icon('i-pause')}<span>Pause</span></button>
        <button type="button" class="btn" id="avFullSkip">Skip</button>
        <button type="button" class="btn" id="avFullControls">${icon('i-gear')}Controls</button>`;
      bar.querySelector('#avFullEnd').addEventListener('click', () => this.confirmEnd());
      bar.querySelector('#avFullPause').addEventListener('click', () => { this.$('btnPlayPause')?.click(); this.update(); });
      bar.querySelector('#avFullSkip').addEventListener('click', () => { this.$('btnSkipInterval')?.click(); this.update(); });
      bar.querySelector('#avFullControls').addEventListener('click', () => this.openControls());
      view.appendChild(bar);
    }
    this.applyFullLayout();
    this.redrawTrack();
    this.start();
  }

  /** The compact all-metrics parts: strip, tiles and (once a second) the ride graph. */
  updateFull(app, { ivs, i, iv, z, target, free, remaining }) {
    this.setText('avIstripName', !iv ? 'Finished' : free ? 'Free ride' : `${iv.name} ${i + 1} / ${ivs.length}`);
    this.setText('avIstripTarget', free || !target ? '' : ` · target ${target} W`);
    this.setText('avIstripLeft', this.text('hudIntervalCountdown'));
    const nx = ivs[i + 1], F = (app.activeProfile && app.activeProfile.ftp) || 0;
    this.setText('avIstripNext', nx ? `Next ${nx.name} ${app.fmtTime(nx.duration)} · ${Math.round(F * nx.pctFtp / 100 * (app.ergBiasMultiplier || 1))} W` : 'Last step');
    const dot = this.doc.querySelector('.av-istrip .av-zdot');
    if (dot && z) dot.style.background = z.color;
    const view = this.$('view-cockpit');
    for (const n of view.querySelectorAll('.av-ftile:not(.av-off)')) this.fillTile(n);
    const g = this.$('avRideGraph');
    const n = (app.recordedSamples || []).length;
    if (g && !g.closest('.av-off') && (this._graphN !== n || this._graphW !== g.clientWidth)) {
      this._graphN = n; this._graphW = g.clientWidth;
      drawRideGraph(g, { intervals: ivs, samples: app.recordedSamples || [], ftp: F, bias: app.ergBiasMultiplier || 1, maxHr: (app.activeProfile && app.activeProfile.maxHr) || 190, lines: this.layout().lines, zoneFor: this.win.VeloMetrics && ((p) => this.win.VeloMetrics.zoneForPct(p)) });
      const total = ivs.reduce((a, x) => a + (Number(x.duration) || 0), 0);
      this.setText('avGraphTime', `${this.text('hudTotalElapsed')} / ${app.fmtTime(total)}`);
    }
  }

  applyFullLayout() {
    const view = this.$('view-cockpit');
    const l = this.layout();
    l.full.forEach((it, i) => {
      const n = view && view.querySelector(`[data-av-full="${it.id}"]`);
      if (n) { n.classList.toggle('av-off', !it.on); n.style.order = String(i + 1); }
    });
    this.applyLines(l.lines);
    this._graphN = -1;
    for (const n of this.doc.querySelectorAll('.av-legend [data-legend]')) n.hidden = !l.lines[n.dataset.legend];
    const app = this.app;
    if (app && app.telemetryChart) this.win.requestAnimationFrame(() => app.telemetryChart.resize());
  }

  applyLines(lines) {
    const chart = this.app && this.app.telemetryChart;
    if (!chart || !chart.data) return;
    for (const [k, label] of Object.entries(LINES)) {
      const ds = chart.data.datasets.find((d) => d.label && d.label.toLowerCase().startsWith(label.toLowerCase()));
      if (ds) ds.hidden = !lines[k];
    }
    chart.update('none');
  }

  // ------------------------------------------------------------------------------------------- controls --

  /** Every ride control in one sheet: each row presses the app's own control. */
  openControls() {
    const app = this.app;
    if (!app) return;
    const box = this.doc.createElement('div');
    box.className = 'av-controls';
    box.id = 'avControlsSheet';
    const S = this.shell;
    const sw = (id, on, onToggle) => {
      const b = this.doc.createElement('button');
      b.type = 'button'; b.className = 'av-switch'; b.id = id;
      b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(!!on));
      b.addEventListener('click', (e) => { e.stopPropagation(); onToggle(); b.setAttribute('aria-checked', String(b.getAttribute('aria-checked') !== 'true')); });
      return b;
    };
    const press = (id) => () => { this.$(id)?.click(); refresh(); };
    const group = (title) => { const d = this.doc.createElement('div'); d.className = 'card av-list'; if (title) box.insertAdjacentHTML('beforeend', `<div class="av-label">${esc(title)}</div>`); box.appendChild(d); return d; };
    const steps = (ids) => { const d = this.doc.createElement('span'); d.className = 'av-steps'; for (const [id, t] of ids) { const b = this.doc.createElement('button'); b.type = 'button'; b.className = 'btn'; b.dataset.avPress = id; b.textContent = t; b.addEventListener('click', (e) => { e.stopPropagation(); press(id)(); }); d.appendChild(b); } return d; };

    const ride = group('');
    const intensityRow = S.row({ icon: 'i-target', title: 'Intensity', sub: `Workout at ${this.text('biasValueDisplay')}`, end: steps([['btnBiasMinus5', '−5'], ['btnBiasMinus1', '−1'], ['btnBiasPlus1', '+1'], ['btnBiasPlus5', '+5']]) });
    intensityRow.id = 'avIntensityRow';
    ride.appendChild(intensityRow);
    ride.appendChild(S.row({ icon: 'i-reset', title: 'Reset intensity to 100%', onClick: press('btnBiasReset'), id: 'avBiasReset' }));
    ride.appendChild(S.row({ icon: 'i-bolt', title: 'ERG mode', sub: 'On: the trainer holds the target. Off: free resistance, targets as guidance.', end: sw('avErgSwitch', app.ergModeEnabled, () => app.toggleErgMode()) }));
    ride.appendChild(S.row({ icon: 'i-skip', title: 'This step', sub: 'Shorten or extend by 30 s', end: steps([['btnShortenInterval', '−30 s'], ['btnExtendInterval', '+30 s']]) }));
    ride.appendChild(S.row({ icon: 'i-footsteps', title: this.text('btnStandText') || 'Stand 30s', sub: 'Eases ERG 5% for 30 s out of the saddle; tap again to end early', onClick: press('btnStand'), id: 'avStand' }));
    ride.appendChild(S.row({ icon: 'i-reset', title: 'Restart the workout from step 1', onClick: press('btnResetWorkout'), id: 'avResetWorkout' }));

    const show = group('Display');
    const smooth = this.$('powerSmoothingPills');
    const smoothRow = S.row({ icon: 'i-activity', title: 'Power smoothing' });
    smoothRow.id = 'avSmoothingRow';
    show.appendChild(smoothRow);
    if (smooth) { const holder = this.doc.createElement('div'); holder.className = 'av-row av-row-sub'; show.appendChild(holder); holder.dataset.avMoved = '1'; this._smoothHome = this._smoothHome || smooth.parentNode; holder.appendChild(smooth); }
    const erg = this.doc.querySelector('.erg-response-control');
    if (erg) { const holder = this.doc.createElement('div'); holder.className = 'av-row av-row-sub'; show.appendChild(holder); this._ergHome = this._ergHome || erg.parentNode; this._ergNext = this._ergNext || erg.nextSibling; holder.appendChild(erg); }
    const full = this.shell.current && this.shell.current.route === 'ride/cockpit';
    show.appendChild(S.row({ icon: 'i-grid', title: full ? 'Simple view' : 'Show all metrics', sub: full ? 'Power, countdown and your tiles' : 'Live graph, L/R, W′ balance, every number', id: 'avToggleFull', onClick: () => { S.closeSheet(); S.go(full ? 'ride/live' : 'ride/cockpit', { replace: true }); } }));
    show.appendChild(S.row({ icon: 'i-zen', title: 'Zen cockpit', sub: 'The full-screen Zen view; Exit or back returns here', id: 'avZen', onClick: () => { S.closeSheet(); this.$('btnToggleZenMode')?.click(); } }));
    show.appendChild(S.row({ icon: 'i-focus', title: 'Focus mode', sub: 'All metrics with only the essentials', end: sw('avFocusSwitch', this.doc.body.classList.contains('focus-mode'), () => {
      this.$('btnToggleFocusMode')?.click();
      if (this.doc.body.classList.contains('focus-mode') && !full) { S.closeSheet(); S.go('ride/cockpit', { replace: true }); }
    }) }));
    show.appendChild(S.row({ icon: 'i-edit', title: 'Customise this screen', sub: 'Tiles, panels and graph lines; presets', id: 'avCustomise', onClick: () => { S.closeSheet(); this.openCustomise(full ? 'full' : 'simple'); } }));
    const pip = this.$('btnTogglePip');
    if (pip && this.doc.pictureInPictureEnabled) show.appendChild(S.row({ icon: 'i-pip', title: 'Mini-HUD (picture in picture)', onClick: press('btnTogglePip'), id: 'avPip' }));

    const more = group('Sound, devices and setup');
    const audio = this.$('btnToggleAudio');
    more.appendChild(S.row({ icon: 'i-volume', title: 'Audio cues', sub: 'Step changes, countdowns and the finish', end: sw('avAudioSwitch', app.audio ? !app.audio.muted : audio && audio.classList.contains('active'), () => audio && audio.click()) }));
    more.appendChild(S.row({ icon: 'i-bluetooth', title: 'Devices', sub: this.text('devicesSummary'), id: 'avControlsDevices', onClick: () => { S.closeSheet(); if (this.today) this.today.openDevices(); } }));
    more.appendChild(S.row({ icon: 'i-gear', title: 'Device details', sub: 'Calibrate, PowerMatch, power and cadence source, fan (KICKR HEADWIND)', id: 'avDeviceDetails', onClick: () => { S.closeSheet(); app.openHardwareLab(); } }));
    const sim = this.$('simToggleBtn');
    if (sim) more.appendChild(S.row({ icon: 'i-sparkles', title: 'Simulator', sub: 'Used only when no device sends power', end: sw('avSimSwitch', sim.classList.contains('active'), () => sim.click()) }));
    more.appendChild(S.row({ icon: 'i-user', title: 'Rider', sub: this.text('hudRiderProfileName'), id: 'avRider', onClick: () => { S.closeSheet(); app.openModal('profileManagerModal'); } }));

    const refresh = () => {
      const r = this.$('avIntensityRow');
      if (r) r.querySelector('small').textContent = `Workout at ${this.text('biasValueDisplay')}`;
      const st = this.$('avStand');
      if (st) st.querySelector('b').textContent = this.text('btnStandText') || 'Stand 30s';
      this.update();
    };
    const sheet = S.openSheet(box, { title: 'During this ride', onClose: () => this.restoreMoved() });
    sheet.classList.add('av-controls-sheet');
  }

  /** Puts the smoothing pills and the ERG response control back in the cockpit. */
  restoreMoved() {
    const smooth = this.$('powerSmoothingPills');
    if (smooth && this._smoothHome && smooth.parentNode !== this._smoothHome) this._smoothHome.appendChild(smooth);
    const erg = this.doc.querySelector('.erg-response-control');
    if (erg && this._ergHome && erg.parentNode !== this._ergHome) this._ergHome.insertBefore(erg, this._ergNext && this._ergNext.parentNode === this._ergHome ? this._ergNext : null);
  }

  // ------------------------------------------------------------------------------------------ customise --

  openCustomise(which = 'simple') {
    const box = this.doc.createElement('div');
    box.className = 'av-customise';
    box.id = 'avCustomiseSheet';
    const pid = () => (this.app && this.app.activeProfileId) || 'default';
    const render = () => {
      const l = this.layout();
      const items = which === 'simple' ? l.simple : l.full;
      const name = (id) => which === 'simple' ? (id.startsWith('panel:') ? SIMPLE_PANELS[id.slice(6)] : `Tile · ${TILES[id.slice(5)].label}`)
        : id.startsWith('ftile:') ? `Tile · ${TILES[id.slice(6)].label}` : FULL_BUILT[id] || FULL_PANELS[id][0];
      box.innerHTML = `<div class="av-seg" role="group" aria-label="Screen">
          <button type="button" data-which="simple" class="${which === 'simple' ? 'on' : ''}">Simple view</button>
          <button type="button" data-which="full" class="${which === 'full' ? 'on' : ''}">All metrics</button></div>
        <div class="av-presets"><button type="button" class="btn" data-preset="minimal">Minimal</button><button type="button" class="btn" data-preset="standard">Standard</button><button type="button" class="btn" data-preset="everything">Everything</button><button type="button" class="btn btn-ghost" data-preset="reset">Reset</button></div>
        <p class="av-note">Saved for ${esc(this.text('hudRiderProfileName') || 'this rider')}. Switch items on or off and move them up or down.</p>
        <div class="card av-list av-cust-list"></div>
        ${which === 'full' ? `<div class="av-label">Live graph lines</div><div class="card av-list av-cust-lines"></div>` : ''}`;
      const listEl = box.querySelector('.av-cust-list');
      items.forEach((it, i) => {
        const end = this.doc.createElement('span');
        end.className = 'av-cust-end';
        end.innerHTML = `<button type="button" class="icon-btn av-icon-btn" data-move="-1" aria-label="Move ${esc(name(it.id))} up"${i === 0 ? ' disabled' : ''}>▲</button><button type="button" class="icon-btn av-icon-btn" data-move="1" aria-label="Move ${esc(name(it.id))} down"${i === items.length - 1 ? ' disabled' : ''}>▼</button><button type="button" class="av-switch" role="switch" aria-checked="${it.on}" aria-label="Show ${esc(name(it.id))}" data-toggle></button>`;
        const row = this.shell.row({ title: name(it.id), end });
        row.dataset.avCust = it.id;
        listEl.appendChild(row);
      });
      if (which === 'full') {
        const lines = box.querySelector('.av-cust-lines');
        for (const k of Object.keys(LINES)) {
          const end = this.doc.createElement('button');
          end.type = 'button'; end.className = 'av-switch'; end.setAttribute('role', 'switch'); end.setAttribute('aria-checked', String(!!l.lines[k])); end.dataset.line = k;
          end.setAttribute('aria-label', `Show the ${LINES[k]} line`);
          lines.appendChild(this.shell.row({ title: LINES[k], end }));
        }
      }
    };
    box.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      const l = this.layout();
      const items = which === 'simple' ? l.simple : l.full;
      if (t.dataset.which) { which = t.dataset.which; render(); return; }
      if (t.dataset.preset) { if (t.dataset.preset === 'reset') this.layouts.reset(pid()); else this.layouts.preset(pid(), t.dataset.preset); }
      else if (t.dataset.line) l.lines[t.dataset.line] = !l.lines[t.dataset.line];
      else {
        const row = t.closest('[data-av-cust]');
        if (!row) return;
        const i = items.findIndex((x) => x.id === row.dataset.avCust);
        if (t.dataset.toggle != null) items[i].on = !items[i].on;
        else if (t.dataset.move) { const j = i + Number(t.dataset.move); if (j < 0 || j >= items.length) return; [items[i], items[j]] = [items[j], items[i]]; }
        else return;
      }
      if (!t.dataset.preset) this.saveLayout(l);
      render();
      this.applySimpleLayout();
      this.applyFullLayout();
    });
    render();
    this.shell.openSheet(box, { title: 'Customise ride screen' });
  }
}

/**
 * Draws a ride on a canvas (mock-up e): the workout profile as zone-coloured blocks, the FTP line, then power,
 * heart rate and cadence from the recorded samples, and the current position. Pure drawing, no ride logic.
 */
export function drawRideGraph(canvas, { intervals = [], samples = [], ftp = 0, bias = 1, maxHr = 190, lines = {}, zoneFor = null }) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const planned = intervals.reduce((a, iv) => a + (Number(iv.duration) || 0), 0);
  const last = samples.length ? Number(samples[samples.length - 1].time) || samples.length : 0;
  const total = Math.max(planned, last, 60);
  const peakTarget = Math.max(0, ...intervals.map((iv) => (ftp * iv.pctFtp / 100) * bias));
  const peakPower = Math.max(0, ...samples.map((s) => Number(s.power) || 0));
  const top = Math.max(ftp * 1.5, peakTarget * 1.15, peakPower * 1.05, 100);
  const X = (t) => (t / total) * w, Y = (p) => h - (Math.max(0, p) / top) * h;
  let t0 = 0;
  for (const iv of intervals) {
    const d = Number(iv.duration) || 0, p = ftp * iv.pctFtp / 100 * bias;
    const z = zoneFor ? zoneFor(iv.pctFtp * bias) : null;
    g.globalAlpha = 0.24; g.fillStyle = (z && z.color) || '#7cc8ff';
    g.fillRect(X(t0), Y(p), Math.max(1, X(d) - 0.5), h - Y(p));
    t0 += d;
  }
  g.globalAlpha = 1;
  if (ftp) { g.setLineDash([3, 4]); g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, Y(ftp)); g.lineTo(w, Y(ftp)); g.stroke(); g.setLineDash([]); }
  // Downsample to about one point per pixel.
  const step = Math.max(1, Math.floor(samples.length / w));
  const pts = [];
  for (let k = 0; k < samples.length; k += step) {
    const chunk = samples.slice(k, k + step), n = chunk.length;
    const avg = (f) => chunk.reduce((a, s) => a + (Number(s[f]) || 0), 0) / n;
    pts.push({ t: Number(chunk[n - 1].time) || k, power: avg('power'), hr: avg('hr'), cad: avg('cadence') });
  }
  const zoneA = getComputedStyle(canvas).getPropertyValue('--zone-a').trim() || '#7cc8ff';
  if (lines.power !== false && pts.length > 1) {
    g.beginPath(); g.moveTo(X(pts[0].t), h);
    for (const p of pts) g.lineTo(X(p.t), Y(p.power));
    g.lineTo(X(pts[pts.length - 1].t), h); g.closePath();
    g.globalAlpha = 0.35; g.fillStyle = zoneA; g.fill(); g.globalAlpha = 1;
    g.beginPath(); pts.forEach((p, k) => (k ? g.lineTo : g.moveTo).call(g, X(p.t), Y(p.power)));
    g.strokeStyle = zoneA; g.lineWidth = 1.6; g.stroke();
  }
  const line = (key, max, color) => {
    const good = pts.filter((p) => p[key] > 0);
    if (good.length < 2) return;
    g.beginPath(); good.forEach((p, k) => (k ? g.lineTo : g.moveTo).call(g, X(p.t), h - (p[key] / max) * h * 0.9));
    g.strokeStyle = color; g.lineWidth = 1.5; g.stroke();
  };
  if (lines.hr !== false) line('hr', Math.max(maxHr, 100), '#ff6b8a');
  if (lines.cadence !== false) line('cad', 160, '#7cc8ff');
  if (last) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(X(last), 0); g.lineTo(X(last), h); g.stroke(); }
}

/** The end-of-ride summary (mock-up h): the ride is already saved; name it, send it, review it or discard it. */
RideView.prototype.mountSummary = function (rideId) {
  const natural = !!(this._finished && this._finished.id === rideId && this._finished.natural);
  const app = this.app, el = this.summary;
  if (!app) { this.shell.whenApp(() => this.mountSummary(rideId)); return; }
  const ride = (app.completedWorkouts || []).find((r) => r.id === rideId);
  if (!ride) { el.innerHTML = '<div class="av-page-body"><p class="av-note">This ride is no longer in your history.</p><button type="button" class="btn av-big" id="avSummaryDone">Done</button></div>'; el.querySelector('#avSummaryDone').addEventListener('click', () => this.shell.go('ride')); return; }
  const planned = (app.currentWorkout && app.currentWorkout.title === ride.title ? app.currentWorkout.intervals : []).reduce((a, iv) => a + (Number(iv.duration) || 0), 0);
  const done = planned ? Math.min(100, Math.round((ride.duration || 0) / planned * 100)) : null;
  const when = new Date(ride.date);
  const kpi = (l, v) => `<div class="av-kpi"><span>${esc(l)}</span><b class="num">${esc(v == null || v === '' ? '--' : v)}</b></div>`;
  // Same rule as the app's own review dialog: a natural end, or a ride saved by the cockpit moments ago.
  const autosaved = natural || (ride.source === 'APEX VELO Cockpit' && ride.completedAt && Date.now() - ride.completedAt < 25000);
  el.innerHTML = `<header class="av-summary-top"><h1 class="av-title">Nice ride!</h1></header>
    <div class="av-page-body">
      <span class="eyebrow${autosaved ? ' eyebrow-lime' : ''}" id="avSummaryEyebrow">${autosaved ? 'Workout completed &amp; autosaved' : 'Saved to your history'}</span>
      <p class="av-note">${esc(ride.title || 'Ride')} · ${esc(when.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))} ${esc(when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}${done != null ? ` · completed ${done} %` : ''}</p>
      <div class="av-kpis">${kpi('Time', app.fmtTime(ride.duration || 0))}${kpi('NP', ride.np ? `${ride.np} W` : '')}${kpi('TSS', ride.tss != null ? Math.round(ride.tss) : '')}${kpi('Avg HR', ride.avgHr || '')}${kpi('kJ', ride.kj != null ? Math.round(ride.kj) : '')}${kpi('IF', ride.if || '')}</div>
      <div class="av-summary-insight" id="avSummaryInsight"></div>
      <div class="card av-summary-graph"><canvas id="avSummaryGraph" aria-label="This ride's power, heart rate and cadence"></canvas></div>
      <label class="av-field"><span>Name</span><input class="input-field" id="avSummaryName" maxlength="120"></label>
      <div class="card av-list" id="avSummarySync"></div>
      <button type="button" class="btn btn-start av-big" id="avSummaryDone">${icon('i-check')}Done</button>
      <button type="button" class="btn av-big" id="avSummaryAnalysis">${icon('i-activity')}Full analysis</button>
      <button type="button" class="btn btn-ghost av-big av-discard" id="avSummaryDiscard">Discard ride</button>
    </div>`;
  // The ramp-test result and the app's ride insight (FTP suggestion with Accept / Not now, medals, Pw:HR drift).
  const insight = el.querySelector('#avSummaryInsight');
  const renderInsight = () => {
    insight.innerHTML = `${ride.rampTest ? `<p class="av-ramp-result" id="avRampResult">${esc(ride.rampTest.message || 'Ramp test complete.')}</p>` : ''}${app.rideInsightHtml ? app.rideInsightHtml(ride) : ''}`;
  };
  renderInsight();
  if (app.bindInsightActions) app.bindInsightActions(insight);
  // After Accept or Not now the app updates FTP (or the dismissals); show the insight again without the suggestion.
  insight.addEventListener('click', (e) => { if (e.target.closest('[data-ftp]')) this.win.setTimeout(renderInsight, 0); });
  const name = el.querySelector('#avSummaryName');
  name.value = ride.title || '';
  name.addEventListener('change', () => {
    const v = name.value.trim();
    if (!v || v === ride.title) return;
    ride.title = v;
    if (app.saveHistory) app.saveHistory();
    if (app.renderHistoryTable) app.renderHistoryTable();
  });
  const sync = el.querySelector('#avSummarySync');
  const S = this.shell, N = this.win.ApexNative || {};
  const renderSync = async () => {
    sync.innerHTML = '';
    const st = ride.strava && ride.strava.state;
    const can = app.canSendToStrava ? app.canSendToStrava(ride) : false;
    let end = null;
    if (can && !['sent', 'duplicate', 'sending', 'queued'].includes(st)) {
      end = this.doc.createElement('button'); end.type = 'button'; end.className = 'btn btn-sm'; end.id = 'avSendStrava'; end.textContent = 'Send';
      end.addEventListener('click', async () => { end.disabled = true; await app.sendRideToStrava(ride.id); renderSync(); });
    }
    const where = (typeof app.settingsLabel === 'function' && app.settingsLabel('strava')) || 'You › Connections';
    sync.appendChild(S.row({ icon: 'i-upload', title: 'Strava', sub: st === 'sent' || st === 'duplicate' ? 'On Strava' : st === 'queued' || st === 'sending' ? 'Sending…' : st === 'failed' ? 'Not sent - tap Send to try again' : can ? `Not sent (auto-upload is in ${where})` : `Connect Strava in ${where} to send rides`, end }));
    if (N.healthConnect && N.uploads) {
      const row = await N.uploads.state(ride.id, 'healthconnect').catch(() => null);
      let hcEnd = null;
      if (!row || !['sent', 'queued'].includes(row.status)) {
        hcEnd = this.doc.createElement('button'); hcEnd.type = 'button'; hcEnd.className = 'btn btn-sm'; hcEnd.id = 'avSaveHc'; hcEnd.textContent = 'Save';
        hcEnd.addEventListener('click', async () => { hcEnd.disabled = true; await N.uploads.enqueue(ride, 'healthconnect').then(() => N.uploads.run()).catch(() => {}); renderSync(); });
      }
      sync.appendChild(S.row({ icon: 'i-heart', title: 'Health Connect', sub: row && row.status === 'sent' ? 'Saved as a cycling session' : row && row.status === 'queued' ? 'Saving…' : 'Not saved', end: hcEnd }));
    }
  };
  renderSync();
  el.querySelector('#avSummaryDone').addEventListener('click', () => this.shell.go('ride'));
  el.querySelector('#avSummaryAnalysis').addEventListener('click', () => this.shell.go('history/' + encodeURIComponent(ride.id)));
  el.querySelector('#avSummaryDiscard').addEventListener('click', async () => {
    const before = app.completedWorkouts.length;
    await app.deleteCompletedRide(ride.id); // asks first
    if (app.completedWorkouts.length < before) this.shell.go('ride');
  });
  this.win.requestAnimationFrame(() => drawRideGraph(el.querySelector('#avSummaryGraph'), {
    intervals: [], samples: Array.isArray(ride.samples) ? ride.samples : [], ftp: (app.activeProfile && app.activeProfile.ftp) || 0,
    maxHr: (app.activeProfile && app.activeProfile.maxHr) || 190, lines: this.layout().lines
  }));
};
