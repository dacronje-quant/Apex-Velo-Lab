/**
 * Riding with the screen off (the native side is com.apexvelo.lab.ride, plugin "ApexRide").
 *
 * Android may pause the WebView when the screen is off or the app is in the background, and then the JS
 * 1 Hz ride tick (js/app.js tick1Hz) and its ERG writes stop. A native recorder therefore runs next to the
 * page from ride start to save/discard, inside a connectedDevice foreground service with a notification:
 *
 *   - While the page ticks, the page owns the ride exactly as on the desktop (full ERG governor). Every
 *     second it hands the native side its new sample and position (sample()), which keeps the page's lease,
 *     appends the sample to a crash-safe journal file and updates the notification.
 *   - When no sample arrives for the lease (10 s on screen, so a slow phone is not handed over needlessly;
 *     3 s once the page is in the background), the native side takes the ride over: its own GATT clients on the
 *     same trainer, power meter and strap give 1 Hz samples of the same shape, and it follows the page's
 *     plan (step targets as the page computes them, with the PowerMatch trim carried over), writing the FTMS
 *     target at each step change.
 *   - When the page is visible again it takes the ride back (handBack()): the native samples are merged
 *     into recordedSamples by second, the position, distance and analytics are adopted, and a pause, a ramp
 *     test stop or the workout end that happened meanwhile is applied. No second is lost or doubled.
 *   - A page reloaded mid-ride while the app process lived (WebView renderer restart, activity recreated)
 *     restores the live ride from the journal, reconnects its devices and takes the ride back.
 *   - At the next start an unfinished journal (the app was killed) is offered through the existing
 *     "Recover unfinished ride" banner (js/velo-storage.js), as the copy with the most samples.
 */

/** How long the native side waits for a page second before taking over: on screen, then in the background. */
export const LEASE_MS = { visible: 10000, hidden: 3000 };
/** After a page reload mid-ride, the page waits this long for its devices before taking the ride back anyway. */
export const DEVICE_WAIT_MS = 20000;

/** Seconds recorded by the page up to and including `upTo`, then the native seconds after it (sorted, one per second). */
export function mergeSamples(jsSamples, nativeSamples, upTo) {
  const out = jsSamples.filter((s) => s.time <= upTo);
  const seen = new Set(out.map((s) => s.time));
  for (const s of [...nativeSamples].sort((a, b) => a.time - b.time)) {
    if (s.time <= upTo || seen.has(s.time)) continue;
    seen.add(s.time);
    out.push(s);
  }
  return out;
}

const parse = (s) => (typeof s === 'string' ? JSON.parse(s) : s);

/** The ride plan the native side follows: step targets computed exactly as the page does (getCurrentTargetWatts). */
export function planFromApp(app) {
  const w = app.currentWorkout || { intervals: [] };
  const ftp = app.activeProfile.ftp, bias = app.ergBiasMultiplier || 1;
  const Erg = typeof VeloErg !== 'undefined' ? VeloErg : globalThis.VeloErg;
  const steps = w.intervals.map((iv) => ({
    name: String(iv.name || ''), duration: Math.max(1, Math.round(iv.duration || 0)), pctFtp: Number(iv.pctFtp) || 0,
    watts: Math.round(ftp * ((Number(iv.pctFtp) || 0) / 100) * bias),
    test: !!(Erg && Erg.describe(w, iv).test)
  }));
  const ramp = app.rampTestConfig ? app.rampTestConfig() : null;
  const slots = (app.ble && app.ble.slots) || {};
  const dev = (k) => (slots[k] && slots[k].device && slots[k].device.id) || '';
  const range = (app.ble && app.ble.powerRange) || {};
  return {
    steps, ftp, bias, ergOn: !!app.ergModeEnabled,
    rampStepPct: ramp ? Number(ramp.stepPctFtp) || 7 : 0, rampStepSec: ramp ? Number(ramp.stepSeconds) || 60 : 60,
    weightKg: app.activeProfile.weightKg || 75,
    powerMin: Math.max(0, range.min || 0), powerMax: Math.min(2000, range.max || 2000),
    powerSource: app.powerSourcePreference || 'auto',
    trainer: dev('trainer'), pedals: dev('pedals'), hr: dev('hr')
  };
}

/** PowerMatch trim as a share of the target, so it scales with each step like VeloErg.prepareTarget does. */
const trimShare = (app) => (app.erg && app.erg.lastBase > 0 ? app.erg.offset / app.erg.lastBase : 0);

/** The page's position after a tick: what the native side continues from. */
export function stateFromApp(app) {
  const iv = app.currentWorkout.intervals[app.intervalIndex] || {};
  return {
    time: app.totalElapsedSeconds, step: app.intervalIndex, remaining: app.intervalSecondsRemaining,
    distanceM: app.totalDistanceMeters, maxSpeed: app.maxSpeedKmh || 0,
    power: app.currentPower || 0, hr: app.currentHeartRate || 0,
    stepName: String(iv.name || ''), target: app.getCurrentTargetWatts(), trim: trimShare(app)
  };
}

/**
 * Takes over what the native side recorded while the page was paused. `snap` is handBack()'s answer:
 * { jsTime, samples: [json], elapsed, step, remaining, distanceM, maxSpeed, extraSteps, paused, event }.
 */
export function adoptSnapshot(app, snap) {
  const native = (snap.samples || []).map(parse);
  const merged = mergeSamples(app.recordedSamples, native, snap.jsTime);
  const added = merged.filter((s) => s.time > snap.jsTime);
  app.recordedSamples = merged;
  if (snap.extraSteps && snap.extraSteps.length) {
    app.currentWorkout = { ...app.currentWorkout, intervals: [...app.currentWorkout.intervals, ...snap.extraSteps] };
  }
  app.totalElapsedSeconds = snap.elapsed;
  app.intervalIndex = Math.min(snap.step, app.currentWorkout.intervals.length - 1);
  app.intervalSecondsRemaining = snap.remaining;
  app.totalDistanceMeters = snap.distanceM;
  app.totalDistanceKm = parseFloat((snap.distanceM / 1000).toFixed(2));
  app.maxSpeedKmh = Math.max(app.maxSpeedKmh || 0, snap.maxSpeed || 0);
  if (added.length) {
    // The analytics (NP, TSS, kJ) and W'bal are rebuilt from the merged ride, as a recovered ride is.
    app.analytics.reset();
    for (const s of merged) { if (s.segmentStart) app.analytics.startSegment(); app.analytics.update(s.power || 0); }
    app.powerBuffer = merged.slice(-120).map((s) => s.power || 0);
    if (app.resetLiveWbal && app.updateLiveWbal) {
      app.resetLiveWbal();
      merged.forEach((s, i) => app.updateLiveWbal(s.power || 0, !!s.segmentStart && i > 0));
    }
    const last = added[added.length - 1];
    Object.assign(app, { currentPower: last.power, currentCadence: last.cadence, currentHeartRate: last.hr, currentSpeed: last.speed });
    if (app.updateTelemetryChart) for (const s of added) app.updateTelemetryChart(s.time, s.power, s.cadence, s.hr, s.target);
  }
  for (const fn of ['updateHudTitles', 'renderIntervalTrack', 'updatePowerSourceBadge']) if (app[fn]) app[fn]();
  return added.length;
}

/** The js/velo-storage.js recovery copy (sqlite_active_ride:...) made from a native journal. */
export function recoverySnapshot(journal) {
  const h = journal.header, st = journal.state || {};
  const byTime = new Map();
  for (const line of journal.samples || []) { const s = parse(line); byTime.set(s.time, s); }
  const samples = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (!h || !samples.length) return null;
  const last = samples[samples.length - 1];
  const workout = { ...h.workout, intervals: [...h.workout.intervals, ...(st.extraSteps || [])] };
  return {
    key: h.key, storeId: h.storeId, at: last.timestamp || Date.now(), profileId: h.profileId, workout, samples,
    elapsed: last.time, step: st.step ?? last.workoutStep, remaining: st.remaining ?? 0,
    startedAt: h.startedAt, distance: st.distanceM ?? (last.dist || 0) * 1000, maxSpeed: st.maxSpeed ?? 0,
    hadHardware: true, sourceChanges: [], fromNativeJournal: true
  };
}

/** Puts a recovery copy (recoverySnapshot) into the app, paused, as the "Recover unfinished ride" button does. */
export function restoreRide(app, snap) {
  if (app.activeProfileId !== snap.profileId && app.profiles.some((p) => p.id === snap.profileId)) app.setActiveProfile(snap.profileId, false);
  app.resetWorkout(false);
  Object.assign(app, {
    currentWorkout: snap.workout, recordedSamples: snap.samples, totalElapsedSeconds: snap.elapsed, intervalIndex: snap.step,
    intervalSecondsRemaining: snap.remaining, sessionStartedAt: snap.startedAt, totalDistanceMeters: snap.distance,
    totalDistanceKm: snap.distance / 1000, maxSpeedKmh: snap.maxSpeed, rideHadHardware: true, _deviceSourceChanges: [],
    _nextSampleStartsSegment: true, isPlaying: false, isWorkoutCompleted: false
  });
  app.analytics.reset();
  for (const s of snap.samples) { if (s.segmentStart) app.analytics.startSegment(); app.analytics.update(s.power || 0); }
  for (const fn of ['updateWorkoutOverview', 'updatePlaybackControlsUi', 'renderIntervalTrack', 'populateCustomIntervalTable', 'updateHudTitles']) if (app[fn]) app[fn]();
}

/**
 * Connects the page's ride to the native recorder. `plugin` has the ApexRide API (registerPlugin('ApexRide')
 * on the phone, a fake in tests). `idbSettings` is the WebView's own settings store (the IndexedDB VeloDB
 * methods js/velo-storage.js keeps its recovery copies in), captured before VeloStorage.boot replaces them.
 */
export class NativeRide {
  constructor({ plugin, win = window, prefs = null }) {
    this.plugin = plugin;
    this.win = win;
    this.prefs = prefs;
    this.active = false;
    this.owner = 'js';
    this.jsTime = 0;
    this.planKey = '';
    this.reclaiming = null;
    this.queue = Promise.resolve();
    this.waitDevices = null; // { kinds, until } after a reload mid-ride
  }

  _call(name, args = {}) {
    // Calls stay in order (start before the first sample, a pause before the next sample).
    const p = this.queue.then(() => this.plugin[name](args));
    this.queue = p.catch(() => {});
    return p;
  }

  visible() { return this.win.document.visibilityState !== 'hidden'; }

  /** The page may take the ride back: it is on screen and (after a reload) its devices are connected again. */
  canReclaim(app) {
    if (!this.visible()) return false;
    const w = this.waitDevices;
    if (!w) return true;
    if (Date.now() < w.until && !w.kinds.every((k) => app.ble.isConnected(k))) return false;
    this.waitDevices = null;
    return true;
  }

  /** A page reloaded mid-ride: the native side is still recording. Restore the ride and take it back. */
  async adoptLive(app, snap, paused) {
    restoreRide(app, snap);
    const V = this.win.VeloStorage;
    if (V) V.rideKey = snap.key;
    Object.assign(this, { active: true, owner: 'native', jsTime: snap.elapsed, planKey: '' });
    // Reconnect the trainer, power meter and strap the page used (the native clients keep the links up).
    const kinds = [];
    try {
      await app.ble.refreshPermitted();
      for (const k of ['trainer', 'pedals', 'hr']) if (app.ble.canReconnect(k)) { kinds.push(k); app.ble.reconnect(k).catch(() => {}); }
    } catch (e) { /* the page takes the ride back after the wait */ }
    this.waitDevices = { kinds, until: Date.now() + DEVICE_WAIT_MS };
    if (!paused) app.togglePlayPause();
    app.showToast('Ride in progress restored. Recording continued meanwhile.', 'info');
  }

  async start(app) {
    const V = this.win.VeloStorage;
    if (V) V.rideKey ||= 'sqlite_active_ride:' + this.win.crypto.randomUUID().replace(/-/g, '_');
    const plan = planFromApp(app);
    this.planKey = JSON.stringify(plan);
    this.active = true;
    this.owner = 'js';
    this.jsTime = app.totalElapsedSeconds;
    const header = {
      key: V ? V.rideKey : 'native_ride', storeId: V ? V.storeId : null, profileId: app.activeProfileId,
      startedAt: app.sessionStartedAt, workout: app.currentWorkout
    };
    // A recovered ride starts its new journal with the seconds it already has.
    const samples = app.recordedSamples.map((x) => JSON.stringify(x));
    await this._call('start', { header: JSON.stringify(header), plan, state: stateFromApp(app), samples }).catch(() => {});
    this.permissionsOnce().catch(() => {});
  }

  /** After each page tick: the new sample, and the plan when it changed (skip, jump, bias, ramp step, easy spin). */
  async sample(app) {
    const s = app.recordedSamples[app.recordedSamples.length - 1];
    if (!s || s.time !== app.totalElapsedSeconds) return;
    const plan = planFromApp(app), key = JSON.stringify(plan);
    const args = { sample: JSON.stringify(s), state: stateFromApp(app) };
    if (key !== this.planKey) { args.plan = plan; this.planKey = key; }
    let r;
    try { r = await this._call('sample', args); } catch (e) { return; }
    if (r && r.accepted) this.jsTime = s.time;
    else if (r) { this.owner = 'native'; if (this.canReclaim(app)) this.reclaim(app); }
  }

  /** The page is ticking again and visible: take back the seconds the native side recorded. */
  reclaim(app) {
    if (this.reclaiming) return this.reclaiming;
    this.reclaiming = (async () => {
      try {
        const snap = await this._call('handBack', { jsTime: this.jsTime });
        this.owner = 'js';
        if (!snap) return 0;
        const n = adoptSnapshot(app, { ...snap, jsTime: this.jsTime });
        this.jsTime = app.totalElapsedSeconds;
        if (snap.event && snap.event.type === 'test-stop') app.finishRampTest({ reason: snap.event.reason, measuredWatts: snap.event.measuredWatts });
        else if (snap.event && snap.event.type === 'end') { app.intervalIndex = app.currentWorkout.intervals.length; app.finishWorkout(true, { fanfare: false }); }
        else if (snap.paused && app.isPlaying) app.togglePlayPause();
        if (n) app.showToast(`${n} s recorded while the screen was off.`, 'info');
        return n;
      } finally { this.reclaiming = null; }
    })();
    return this.reclaiming;
  }

  setPaused(paused) { if (this.active) this._call('setPaused', { paused }).catch(() => {}); }

  stop(saved) {
    if (!this.active) return;
    this.active = false;
    this._call('stop', { saved }).catch(() => {});
  }

  /** Notification permission (Android 13+) and the one-time battery explanation, at the first ride. */
  async permissionsOnce() {
    if (this.plugin.askNotifications) await this.plugin.askNotifications().catch(() => {});
    const key = 'apex_ride_battery_asked';
    const doc = this.win.document;
    if (!this.plugin.batteryStatus || (this.prefs && await this.prefs.get(key))) return;
    const { ignoring } = await this.plugin.batteryStatus();
    if (ignoring || doc.getElementById('apexBatteryNote')) return;
    if (this.prefs) await this.prefs.set(key, '1');
    const note = doc.createElement('div');
    note.id = 'apexBatteryNote';
    note.className = 'easy-spin-offer';
    note.setAttribute('role', 'dialog');
    note.innerHTML = `<div class="eso-title">Keep recording with the screen off</div>
      <div class="eso-sub">Apex Velo keeps recording your ride and controlling the trainer when the screen is off. Some phones still stop apps in the background to save battery. To keep long rides safe, you can set Apex Velo to "Unrestricted" (or "Don't optimise") in the battery settings. You only see this once.</div>
      <div class="eso-actions"><button type="button" class="btn btn-start" data-bn="open">Open battery settings</button>
      <button type="button" class="btn btn-ghost" data-bn="no">Not now</button></div>`;
    note.addEventListener('click', (e) => {
      const b = e.target.closest('[data-bn]');
      if (!b) return;
      if (b.dataset.bn === 'open') this.plugin.openBatterySettings().catch(() => {});
      note.remove();
    });
    doc.body.appendChild(note);
  }

  /** Hooks into VeloApp's ride methods (the desktop code is unchanged). */
  install(P, V, idbSettings) {
    const ride = this;
    const toggle = P.togglePlayPause, tick = P.tick1Hz, finish = P.finishWorkout, reset = P.resetWorkout;
    P.togglePlayPause = function (...a) {
      const r = toggle.apply(this, a);
      if (this.isPlaying && !ride.active) ride.start(this);
      else ride.setPaused(!this.isPlaying);
      return r;
    };
    P.tick1Hz = function (...a) {
      if (ride.active && ride.owner === 'native') { if (ride.canReclaim(this)) ride.reclaim(this); return; }
      const r = tick.apply(this, a);
      if (ride.active && this.isPlaying) ride.sample(this);
      return r;
    };
    P.finishWorkout = function (...a) {
      const r = finish.apply(this, a);
      if (this.isWorkoutCompleted) ride.stop(true);
      return r;
    };
    P.resetWorkout = function (...a) {
      const before = this.totalElapsedSeconds;
      const r = reset.apply(this, a);
      if (this.totalElapsedSeconds === 0 && (before > 0 || ride.active)) ride.stop(false);
      return r;
    };
    const app = () => this.win.app;
    this.win.document.addEventListener('visibilitychange', () => {
      if (!ride.active) return;
      ride._call('visibility', { visible: ride.visible() }).catch(() => {});
      const a = app();
      if (ride.owner === 'native' && a && ride.canReclaim(a)) ride.reclaim(a);
    });
    if (this.plugin.addListener) {
      // Pause / Resume pressed in the notification while the page owns the ride.
      this.plugin.addListener('control', ({ paused }) => {
        const a = app();
        if (a && ride.active && ride.owner === 'js' && paused === a.isPlaying) a.togglePlayPause();
      });
    }
    if (V && idbSettings) {
      // A ride still recording natively (the page was reloaded) is taken back live. A journal left by a ride
      // the app was killed in goes to the recovery banner, when it holds more than the page's own 5 s
      // checkpoint of the same ride.
      const init = V.initRecovery;
      V.initRecovery = async function (a) {
        try {
          const j = await ride.plugin.recovery();
          const snap = j && j.header ? recoverySnapshot({ header: parse(j.header), samples: j.samples, state: j.state && parse(j.state) }) : null;
          if (snap && j.live && !a.hasUnsavedRide()) {
            await ride.adoptLive(a, snap, !!j.paused);
            const r = await init.call(this, a);
            // The page's own checkpoint of this same ride is not an unfinished ride: it is running.
            const banner = ride.win.document.getElementById && ride.win.document.getElementById('interruptedRideRecovery');
            if (banner) banner.hidden = true;
            return r;
          }
          if (snap && snap.storeId === V.storeId) {
            const old = await idbSettings.getSetting(snap.key).catch(() => null);
            if (!old || !old.samples || old.samples.length < snap.samples.length) await idbSettings.putSetting(snap);
          }
          if (j && j.header) await ride.plugin.discardRecovery();
        } catch (e) { /* the page's own checkpoint still works */ }
        return init.call(this, a);
      };
    }
  }
}
