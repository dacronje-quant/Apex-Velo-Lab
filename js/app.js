/**
 * APEX VELO // LAB - Application orchestrator.
 *
 * Owns session state, the 1 Hz workout engine, hardware telemetry fusion
 * (Assioma pedals = power/cadence/balance truth, KICKR SHIFT = speed/distance/ERG),
 * PowerMatch, the cockpit HUD, Zen mode and the single 60 fps render loop.
 *
 * Feature areas live in prototype mixins loaded after this file:
 *   app-analytics.js  - Chart.js charts, PMC explorer, MMP, progression dashboard
 *   app-history.js    - history table, ride review, exports, imports, calendar
 *   app-coach.js      - AI coach UI and the workout-architect preview
 * Pure math lives in velo-metrics / velo-analytics / velo-progress / velo-export.
 */
class VeloApp {
  constructor() {
    this._el = new Map();
    this.profiles = this.loadProfiles();
    this.activeProfileId = this.loadActiveProfileId();
    this.activeProfile = this.getActiveProfile();

    // Telemetry smoothing & speed / distance
    this.smoothingWindow = 3;
    this.powerBuffer = [];
    this.currentSpeed = 0;
    this.totalDistanceMeters = 0;
    this.totalDistanceKm = 0;
    this.maxSpeedKmh = 0;

    // Calendar state
    this.calendarViewPreset = '1week';
    this.calendarWeekOffset = 0;
    this.calendarMonthOffset = 0;
    this.calendarYearOffset = 0;

    // Library & active workout
    this.workoutLibrary = [...this.loadSavedWorkouts(), ...JSON.parse(JSON.stringify(DEFAULT_WORKOUT_LIBRARY))];
    this.currentWorkout = JSON.parse(JSON.stringify(this.workoutLibrary[0]));
    this.intervalIndex = 0;
    this.intervalSecondsRemaining = this.currentWorkout.intervals[0].duration;
    this.totalElapsedSeconds = 0;
    this.ergBiasMultiplier = 1.0;
    this.ergModeEnabled = true;
    this.ergResponse = 'auto';
    this.isPlaying = false;
    this.isWorkoutCompleted = false;
    this.sessionStartedAt = null;
    this.previewAiWorkout = null;

    // Live values
    this.currentPower = 0;
    this.currentCadence = 0;
    this.currentHeartRate = 0;
    this.currentLeftBal = null;
    this.currentRightBal = null;
    this.activePowerSource = 'SIMULATOR';
    this.lastInstantPower = 0;
    this.lastCadence = 0;
    this.lastHr = 0;

    // BLE telemetry caches
    this.blePedal = { name: 'Power meter', watts: null, cadence: null, leftPct: null, rightPct: null, torque: null, lastTime: -1e9 };
    this.bleTrainer = { name: 'Smart trainer', watts: null, cadence: null, speed: null, distanceMeters: null, lastTime: -1e9 };
    this.bleHr = { hr: null, contact: null, lastTime: -1e9 };
    this.bleBattery = { trainer: null, pedals: null, hr: null };
    this.lowBatteryWarned = { trainer: false, pedals: false, hr: false };
    this.rideHadHardware = false;

    // PowerMatch closed loop (+/-45 W trim, 2 W/s slew)
    this.powerMatchEnabled = true;
    this.powerMatchOffset = 0;   // mirror of this.erg.offset for the UI
    this.lastCommandedErgWatts = null;
    this.erg = new VeloErg();     // soft start, anti-stall, step lead and PowerMatch
    this.trainerOdoLast = null;      // last KICKR odometer reading (m); null = re-sync on the next one
    this.hardwareSpeedSource = 'SIMULATOR';
    this.hardwareDistanceSource = 'SIMULATOR';
    this.calibrationCountdownSec = 3;
    this.calibration = { phase: 'idle', timeout: null };

    // Modules
    this.audio = new VeloSoundEngine();
    this.pip = new VeloPip(this);
    this.folderSync = new VeloFolderSync(this);
    this.simulator = new VeloSimulator();
    this.analytics = new VeloAnalytics(this.activeProfile.ftp, this.activeProfile.weightKg);
    this.ble = new VeloBle((d) => this.handleBleTelemetry(d));
    this.aiCoach = new VeloAiCoach(this);
    this.blockPlanner = typeof VeloBlockPlanner === 'function' ? new VeloBlockPlanner(this.aiCoach) : null;
    // Every tick is pushed to the phone view straight away, so the phone never trails the PC by a second.
    this.clock = new VeloClock(() => { this.tick1Hz(); if (this.publishSoon) this.publishSoon(); });
    this.workoutTimer = null; // legacy handle; VeloClock owns the 1 Hz tick

    this.recordedSamples = [];
    this.completedWorkouts = this.loadHistory();
    this.historySortColumn = 'date';
    this.historySortDirection = 'desc';
    this.isZenMode = false;
    this.zenCadenceHalo = true;
    this.activeTab = 'cockpit';

    this.telemetryChart = null;
    this.pmcChart = null;
    this.mmpChart = null;
    this.ftpChart = null;
    this.currentScrubChart = null;
    this.progWeeklyChart = null;
    this.progScatterChart = null;
    this.pmcRange = 182;
    this.progWeeks = 26;
    this.anaRange = '6m';
    this.progMetric = 'tss';
    this.coachGoal = 'ftp';

    this.trackCache = { canvas: null, key: '' };
    this.animFrameId = null;
    this._disposers = [];

    this.initDoms();
    // Plain-English subtext under every acronym / metric label (js/velo-glossary.js).
    if (typeof VeloGlossary !== 'undefined') VeloGlossary.apply(document);
    if (this.initDevicesUi) this.initDevicesUi();
    this.initCharts();
    this.initKeyboardShortcuts();
    this.initCalendarEvents();
    this.initAiCoachUi();
    if (this.initAskUi) this.initAskUi();
    if (this.initStravaUi) this.initStravaUi();
    if (this.initStravaSyncUi) this.initStravaSyncUi();
    if (this.bindInsightActions) this.bindInsightActions(document.getElementById('modalRideDetails'));
    if (this.initAutoBackup) this.initAutoBackup();
    if (this.initRemoteView) this.initRemoteView();
    if (this.initHealth) this.initHealth();
    if (this.initSettings) this.initSettings();
    this.initAnalyticsUi();
    this.updateProfileUi();
    this.audio.updateUi();
    this.renderWorkoutCatalog();
    this.renderIntervalTrack();
    this.populateCustomIntervalTable();
    this.renderHistoryTable();
    this.renderCalendarView();
    this.updateHeroStats();
    this.updatePlaybackControlsUi();
    this.updatePowerSourceBadge();
    this.updateHudTitles();
    this.start60FpsLoop();
    this.initDevicePreview();
    this.initIndexedDb();
  }

  // ------------------------------------------------------------ utilities --
  /** Cached getElementById for static elements. */
  $(id) {
    let el = this._el.get(id);
    if (!el || !el.isConnected) {
      el = document.getElementById(id);
      if (el) this._el.set(id, el);
    }
    return el;
  }

  setText(id, text) {
    const el = this.$(id);
    if (el && el.textContent !== String(text)) el.textContent = text;
  }

  static esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  on(target, event, handler, opts) {
    if (!target) return;
    target.addEventListener(event, handler, opts);
    this._disposers.push(() => target.removeEventListener(event, handler, opts));
  }

  fmtTime(seconds) {
    seconds = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  showToast(msg, type = 'info') {
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    while (container.children.length >= 4) container.firstElementChild.remove();
    const toast = document.createElement('div');
    toast.className = `toast-msg toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.innerHTML = `<span class="toast-dot"></span><span>${VeloApp.esc(msg)}</span>`;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 260);
    }, type === 'error' ? 6000 : 3600);
  }

  openModal(id) { this.$(id)?.classList.add('open'); }

  closeModal(id) {
    const m = this.$(id);
    if (!m) return;
    m.classList.remove('open');
    if (id === 'hardwareModal' && this.closeDevicesFocus) this.closeDevicesFocus();
    if (id === 'rideSummaryModal') this.destroyScrubChart();
  }

  // ------------------------------------------------------------- profiles --
  loadProfiles() {
    let loaded = null;
    try {
      const raw = localStorage.getItem('apex_velo_profiles');
      if (raw) loaded = JSON.parse(raw);
    } catch (e) { /* ignore */ }
    if (Array.isArray(loaded)) loaded = loaded.filter(p => p.id !== 'prof_1' && p.id !== 'prof_2');
    if (!loaded || !loaded.length || !loaded.some(p => p.id === 'prof_divan')) {
      const divan = { id: 'prof_divan', name: 'Divan (HealthFit)', ftp: 185, weightKg: 75.0, maxHr: 175 };
      loaded = [divan, ...(loaded || []).filter(p => p.id !== 'prof_divan')];
    }
    try { localStorage.setItem('apex_velo_profiles', JSON.stringify(loaded)); } catch (e) { /* ignore */ }
    return loaded;
  }

  saveProfiles() {
    try {
      localStorage.setItem('apex_velo_profiles', JSON.stringify(this.profiles));
      localStorage.setItem('apex_velo_active_prof_id', this.activeProfileId);
    } catch (e) { /* ignore */ }
    if (this.scheduleAutoBackup) this.scheduleAutoBackup();
  }

  loadActiveProfileId() {
    let saved = null;
    try { saved = localStorage.getItem('apex_velo_active_prof_id'); } catch (e) { /* ignore */ }
    return (!saved || saved === 'prof_1' || saved === 'prof_2') ? 'prof_divan' : saved;
  }

  getActiveProfile() {
    return this.profiles.find(p => p.id === this.activeProfileId) || this.profiles[0];
  }

  applyProfileChange() {
    this.activeProfile = this.getActiveProfile();
    this.analytics.ftp = this.activeProfile.ftp;
    this.analytics.weightKg = this.activeProfile.weightKg;
    this.saveProfiles();
    this.updateProfileUi();
    this.updateHudTitles();
    this.renderIntervalTrack();
    this.populateCustomIntervalTable();
    this.renderWorkoutCatalog(this.currentCatalogFilter || 'all', this.currentCatalogSearch || '');
  }

  setActiveProfile(id, notify = true) {
    this.activeProfileId = id;
    this.applyProfileChange();
    if (notify) this.showToast(`Active rider: ${this.activeProfile.name} (${this.activeProfile.ftp} W FTP)`, 'success');
  }

  updateProfileUi() {
    const p = this.activeProfile;
    const select = this.$('headerProfileSelect');
    if (select) {
      select.innerHTML = this.profiles.map(x => `<option value="${VeloApp.esc(x.id)}"${x.id === this.activeProfileId ? ' selected' : ''}>${VeloApp.esc(x.name)} - ${x.ftp}W</option>`).join('') +
        '<option value="__manage__">Manage profiles...</option>';
    }
    this.setText('headerProfileAvatar', p.name.charAt(0).toUpperCase());
    this.setText('headerProfileName', `${p.name} (${p.ftp}W)`);
    this.setText('hudRiderProfileName', `${p.name} (${p.ftp}W)`);
    this.setText('pmcValFtp', p.ftp + ' W');
    this.setText('pmcValWkg', `${(p.ftp / p.weightKg).toFixed(2)} W/kg (${p.weightKg} kg)`);
    this.setText('tableFtpDisplay', p.ftp + 'W');
    this.renderProfileModalList();
  }

  renderProfileModalList() {
    const container = this.$('profileListContainer');
    if (!container) return;
    container.innerHTML = this.profiles.map(p => {
      const isActive = p.id === this.activeProfileId;
      const canDelete = this.profiles.length > 1 && !isActive;
      return `
        <div class="profile-item-row${isActive ? ' active-profile' : ''}">
          <div class="profile-item-main">
            <div class="profile-item-name">${VeloApp.esc(p.name)} ${isActive ? '<span class="chip chip-lime">Active</span>' : ''}</div>
            <div class="profile-item-meta num">FTP <b>${p.ftp}W</b> &middot; ${p.weightKg} kg &middot; <b>${(p.ftp / p.weightKg).toFixed(2)}</b> W/kg &middot; HR max ${p.maxHr}${p.lthr ? ` &middot; LTHR ${p.lthr}` : ''}</div>
          </div>
          <div class="btn-row btn-row-tight">
            ${isActive ? '' : `<button type="button" class="btn btn-primary btn-sm" data-act="select" data-id="${VeloApp.esc(p.id)}">Activate</button>`}
            <button type="button" class="btn btn-sm" data-act="edit" data-id="${VeloApp.esc(p.id)}">Edit</button>
            ${canDelete ? `<button type="button" class="icon-btn icon-btn-danger" data-act="delete" data-id="${VeloApp.esc(p.id)}" title="Delete profile"><svg class="ic"><use href="#i-trash"/></svg></button>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  populateEditProfile(id) {
    const p = this.profiles.find(x => x.id === id);
    if (!p) return;
    this.$('profInputName').value = p.name;
    this.$('profInputFtp').value = p.ftp;
    this.$('profInputWeight').value = p.weightKg;
    this.$('profInputMaxHr').value = p.maxHr;
    if (this.$('profInputLthr')) this.$('profInputLthr').value = p.lthr || '';
    if (this.$('profInputCrank')) this.$('profInputCrank').value = p.crankMm || '';
    this.$('profInputName').dataset.editId = id;
    this.setText('profileFormHeaderTitle', `EDIT PROFILE: ${p.name}`);
    const cancelBtn = this.$('btnCancelEditProfile');
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
    this.$('profInputName').focus();
  }

  cancelEditProfile() {
    this.$('profInputName').value = '';
    this.$('profInputFtp').value = this.activeProfile.ftp;
    this.$('profInputWeight').value = this.activeProfile.weightKg;
    this.$('profInputMaxHr').value = this.activeProfile.maxHr;
    if (this.$('profInputLthr')) this.$('profInputLthr').value = this.activeProfile.lthr || '';
    if (this.$('profInputCrank')) this.$('profInputCrank').value = this.activeProfile.crankMm || '';
    delete this.$('profInputName').dataset.editId;
    this.setText('profileFormHeaderTitle', 'CREATE NEW RIDER PROFILE');
    const cancelBtn = this.$('btnCancelEditProfile');
    if (cancelBtn) cancelBtn.style.display = 'none';
  }

  deleteProfile(id) {
    if (id === this.activeProfileId) {
      this.showToast('Switch to another profile before deleting this one.', 'warning');
      return;
    }
    const p = this.profiles.find(x => x.id === id);
    if (!p || !confirm(`Delete profile "${p.name}"?`)) return;
    this.profiles = this.profiles.filter(x => x.id !== id);
    this.saveProfiles();
    this.updateProfileUi();
    this.showToast(`Deleted profile "${p.name}".`);
  }

  saveProfileFromInputs() {
    const name = this.$('profInputName').value.trim() || 'Rider';
    const ftp = Math.max(50, parseInt(this.$('profInputFtp').value, 10) || this.activeProfile.ftp);
    const weightKg = Math.max(30, parseFloat(this.$('profInputWeight').value) || this.activeProfile.weightKg);
    const maxHr = Math.max(100, parseInt(this.$('profInputMaxHr').value, 10) || this.activeProfile.maxHr);
    // Threshold HR is optional: blank = estimated as 90% of max HR where it is needed.
    const lthrIn = parseInt((this.$('profInputLthr') || {}).value, 10);
    const lthr = lthrIn >= 100 && lthrIn <= 220 && lthrIn < maxHr ? lthrIn : null;
    // Crank length is optional (quadrant analysis); blank = 172.5 mm.
    const crankIn = parseFloat((this.$('profInputCrank') || {}).value);
    const crankMm = crankIn >= 150 && crankIn <= 200 ? Math.round(crankIn * 2) / 2 : null;
    const editId = this.$('profInputName').dataset.editId;
    if (editId) {
      const p = this.profiles.find(x => x.id === editId);
      if (p) {
        if (p === this.activeProfile && Number(p.ftp) !== ftp && this.logFtpChange) this.logFtpChange(p.ftp, ftp, 'manual');
        Object.assign(p, { name, ftp, weightKg, maxHr }); if (lthr) p.lthr = lthr; else delete p.lthr;
        if (crankMm) p.crankMm = crankMm; else delete p.crankMm;
      }
      this.showToast(`Updated "${name}" (${ftp} W FTP)`, 'success');
    } else {
      const newId = 'prof_' + Date.now();
      this.profiles.push({ id: newId, name, ftp, weightKg, maxHr, ...(lthr ? { lthr } : {}), ...(crankMm ? { crankMm } : {}) });
      this.activeProfileId = newId;
      this.showToast(`Created and activated "${name}" (${ftp} W FTP)`, 'success');
    }
    this.cancelEditProfile();
    this.applyProfileChange();
    this.closeModal('profileManagerModal');
  }

  // -------------------------------------------------------------- library --
  loadSavedWorkouts() {
    try {
      const parsed = JSON.parse(localStorage.getItem('apex_velo_saved_workouts') || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  saveSavedWorkouts(list) {
    try { localStorage.setItem('apex_velo_saved_workouts', JSON.stringify(list)); } catch (e) { /* ignore */ }
  }

  saveWorkoutPermanently(workout) {
    if (!workout) return null;
    const toSave = JSON.parse(JSON.stringify(workout));
    if (!toSave.id || toSave.id === 'preview_ai' || toSave.id.startsWith('ai_tmp_')) toSave.id = 'custom_' + Date.now();
    toSave.isCustom = true;
    toSave.category = toSave.category || 'custom';
    const saved = this.loadSavedWorkouts();
    const i = saved.findIndex(w => w.id === toSave.id);
    if (i >= 0) saved[i] = toSave; else saved.unshift(toSave);
    this.saveSavedWorkouts(saved);
    const li = this.workoutLibrary.findIndex(w => w.id === toSave.id);
    if (li >= 0) this.workoutLibrary[li] = toSave; else this.workoutLibrary.unshift(toSave);
    this.renderWorkoutCatalog(this.currentCatalogFilter || 'all', this.currentCatalogSearch || '');
    this.showToast(`Saved "${toSave.title}" to your library.`, 'success');
    return toSave;
  }

  deleteWorkout(id) {
    const workout = this.workoutLibrary.find(w => w.id === id);
    if (!workout) return;
    if (!confirm(`Delete "${workout.title}" from your library?`)) return;
    this.workoutLibrary = this.workoutLibrary.filter(w => w.id !== id);
    this.saveSavedWorkouts(this.loadSavedWorkouts().filter(w => w.id !== id));
    if (this.currentWorkout && this.currentWorkout.id === id) this.selectWorkoutById(this.workoutLibrary[0].id);
    this.renderWorkoutCatalog(this.currentCatalogFilter || 'all', this.currentCatalogSearch || '');
    this.showToast(`Deleted "${workout.title}".`);
  }

  static isHardStart(w) {
    const t = (w.title || '').toLowerCase();
    const d = (w.desc || '').toLowerCase();
    return (w.id || '').startsWith('hardstart_') || (w.id || '').startsWith('billat_') ||
      t.includes('hard-start') || t.includes('fast-start') || d.includes('hard start') || d.includes('fast-start');
  }

  static isCustomWorkout(w) {
    return !!(w.isCustom || (w.id || '').startsWith('custom_') || (w.id || '').startsWith('ai_') || w.category === 'custom');
  }

  renderWorkoutCatalog(filterCategory = 'all', searchQuery = '') {
    const container = this.$('workoutCardsContainer');
    if (!container) return;
    this.currentCatalogFilter = filterCategory;
    this.currentCatalogSearch = searchQuery;
    const q = (searchQuery || '').toLowerCase();
    const filtered = this.workoutLibrary.filter(w => {
      let matchCat;
      if (filterCategory === 'all') matchCat = true;
      else if (filterCategory === 'hardstart') matchCat = VeloApp.isHardStart(w);
      else if (filterCategory === 'custom') matchCat = VeloApp.isCustomWorkout(w);
      else matchCat = w.category === filterCategory;
      const matchSearch = !q || (w.title || '').toLowerCase().includes(q) || (w.desc || '').toLowerCase().includes(q);
      return matchCat && matchSearch;
    });

    if (!filtered.length) {
      container.innerHTML = '<div class="empty-state wide">No workouts match. Try the workout architect above or the AI Coach.</div>';
      return;
    }
    const ftp = this.activeProfile.ftp;
    container.innerHTML = filtered.map(w => {
      const isSelected = this.currentWorkout && w.id === this.currentWorkout.id;
      const hard = VeloApp.isHardStart(w);
      const custom = VeloApp.isCustomWorkout(w);
      const maxPct = Math.max(...w.intervals.map(i => i.pctFtp || 0));
      return `
        <article class="workout-preset-card${isSelected ? ' selected' : ''}" data-id="${VeloApp.esc(w.id)}" tabindex="0">
          <div class="w-card-tags">
            <span class="w-card-tag tag-${VeloApp.esc(w.category)}">${VeloApp.esc(String(w.category).toUpperCase())}</span>
            ${hard ? '<span class="w-card-tag tag-hardstart">HARD-START</span>' : ''}
            ${custom ? '<span class="w-card-tag tag-custom">SAVED</span>' : ''}
          </div>
          <div class="w-card-title">${VeloApp.esc(w.title)}</div>
          <canvas class="w-card-profile" data-profile="${VeloApp.esc(w.id)}"></canvas>
          <div class="w-card-desc">${VeloApp.esc(w.desc)}</div>
          <div class="w-card-footer">
            <div class="w-card-meta num">
              <span><b>${w.durationMin}</b>m</span><span><b>${w.tss}</b> TSS</span><span>IF <b>${w.if}</b></span><span>peak <b>${Math.round(ftp * maxPct / 100)}</b>W</span>
            </div>
            <div class="btn-row btn-row-tight">
              <button type="button" class="btn btn-sm btn-primary btn-ride-now" data-act="load" data-id="${VeloApp.esc(w.id)}">Ride</button>
              ${custom ? `<button type="button" class="icon-btn icon-btn-danger btn-delete-workout" data-act="delete" data-id="${VeloApp.esc(w.id)}" title="Delete"><svg class="ic"><use href="#i-trash"/></svg></button>` : ''}
            </div>
          </div>
        </article>`;
    }).join('');
    if (this.activeTab === 'workouts') {
      container.querySelectorAll('canvas.w-card-profile').forEach(c => {
        const w = this.workoutLibrary.find(x => x.id === c.dataset.profile);
        if (w) this.drawMiniProfile(c, w.intervals);
      });
    }
  }

  /** Small zone-coloured interval profile used on cards and previews. */
  drawMiniProfile(canvas, intervals, opts = {}) {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || opts.width || 280;
    const h = rect.height || opts.height || 40;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const total = intervals.reduce((a, iv) => a + (iv.duration || 0), 0) || 1;
    const maxPct = Math.max(130, ...intervals.map(iv => iv.pctFtp || 0)) * 1.08;
    let x = 0;
    for (const iv of intervals) {
      const bw = (iv.duration / total) * w;
      const bh = Math.max(2, ((iv.pctFtp || 0) / maxPct) * h);
      ctx.fillStyle = VeloMetrics.zoneForPct(iv.pctFtp).color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x, h - bh, Math.max(0.5, bw - (bw > 3 ? 1 : 0)), bh);
      x += bw;
    }
    ctx.globalAlpha = 1;
    const ftpY = Math.round(h - (100 / maxPct) * h) + 0.5;
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.55)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, ftpY); ctx.lineTo(w, ftpY); ctx.stroke();
    ctx.setLineDash([]);
  }

  selectWorkoutById(id) {
    const found = this.workoutLibrary.find(w => w.id === id);
    if (found) this.selectWorkout(found);
  }

  selectWorkout(workout) {
    if (!workout || !workout.intervals || !workout.intervals.length) return;
    this.currentWorkout = JSON.parse(JSON.stringify(workout));
    this.intervalIndex = 0;
    this.intervalSecondsRemaining = this.currentWorkout.intervals[0].duration;
    this.renderIntervalTrack();
    this.populateCustomIntervalTable();
    this.updateHudTitles();
    this.renderWorkoutCatalog(this.currentCatalogFilter || 'all', this.currentCatalogSearch || '');
  }

  /** Loads a workout object into the cockpit, resets the session and switches tab (never auto-starts). */
  loadWorkoutObjectIntoCockpit(workout) {
    if (!workout) return;
    if (this.totalElapsedSeconds > 10 && !confirm('Replace the current session? Unsaved telemetry will be discarded.')) return;
    this.selectWorkout(workout);
    this.resetWorkout(false);
    this.switchTab('cockpit');
  }

  loadWorkoutIntoCockpit(id) {
    const w = this.workoutLibrary.find(x => x.id === id);
    if (w) this.loadWorkoutObjectIntoCockpit(w);
  }

  // ------------------------------------------------------- speed / power --
  /** Steady-state road speed from power (Newton-Raphson on the aero + rolling model). */
  calcVirtualSpeedKmh(watts, weightKg = 75, bikeKg = 9) {
    if (watts <= 0) return 0;
    const m = (weightKg || 75) + (bikeKg || 9);
    const g = 9.81, Crr = 0.004, CdA = 0.32, rho = 1.225;
    let v = 7.0;
    for (let i = 0; i < 12; i++) {
      const f = 0.5 * rho * CdA * v * v * v + Crr * m * g * v - watts;
      const fp = 1.5 * rho * CdA * v * v + Crr * m * g;
      const vNext = v - f / fp;
      if (Math.abs(vNext - v) < 0.01) { v = vNext; break; }
      v = Math.max(0.1, vNext);
    }
    return Math.max(0, parseFloat((v * 3.6).toFixed(1)));
  }

  getSmoothedPower(windowSec = 3) {
    if (!this.powerBuffer.length) return 0;
    const n = Math.min(this.powerBuffer.length, Math.max(1, windowSec));
    let sum = 0;
    for (let i = this.powerBuffer.length - n; i < this.powerBuffer.length; i++) sum += this.powerBuffer[i];
    return Math.round(sum / n);
  }

  setSmoothingWindow(sec) {
    this.smoothingWindow = sec;
    document.querySelectorAll('.smooth-pill').forEach(p => p.classList.toggle('active', parseInt(p.dataset.sec, 10) === sec));
    this.setText('hudPowerHeroLabel', sec === 1 ? '1s INSTANT POWER' : (sec === 60 ? '1m SMOOTHED POWER' : `${sec}s SMOOTHED POWER`));
    const smoothed = this.getSmoothedPower(sec);
    this.setText('valInstantPower', smoothed);
    this.setText('zenInstantPower', smoothed);
  }

  // --------------------------------------------------------------- targets --
  getCurrentTargetWatts() {
    const iv = this.currentWorkout.intervals[this.intervalIndex];
    if (!iv) return 0;
    return Math.round(this.activeProfile.ftp * (iv.pctFtp / 100) * this.ergBiasMultiplier);
  }

  /** Physiological cadence target: explicit value, else derived from step name and intensity. */
  getCurrentTargetCadence(idxOrIv = this.intervalIndex) {
    let iv = null;
    if (typeof idxOrIv === 'object' && idxOrIv !== null) iv = idxOrIv;
    else if (this.currentWorkout && this.currentWorkout.intervals) iv = this.currentWorkout.intervals[idxOrIv];
    if (!iv) return 90;
    if (typeof iv.cadence === 'number' && iv.cadence > 0) return Math.round(iv.cadence);
    if (typeof iv.targetCadence === 'number' && iv.targetCadence > 0) return Math.round(iv.targetCadence);
    const name = (iv.name || '').toLowerCase();
    const pct = (iv.pctFtp || 0) * (this.ergBiasMultiplier || 1.0);
    if (name.includes('sprint') || pct >= 150) return 115;
    if (name.includes('microburst') || name.includes('burst') || name.includes('tabata')) return 110;
    if (name.includes('surge') || name.includes('launch') || name.includes('hard-start') || name.includes('fast-start')) return 105;
    if (name.includes('climb') || name.includes('berg') || name.includes('torque') || name.includes('grind')) return 70;
    if (name.includes('recovery') || name.includes('flush') || name.includes('cooldown') || pct <= 55) return 85;
    if (pct >= 106) return 100;
    if (pct >= 91) return 94;
    if (pct >= 84) return 92;
    if (pct >= 76) return 90;
    return 88;
  }

  setErgBias(delta) {
    this.ergBiasMultiplier = Math.max(0.6, Math.min(1.4, Math.round((this.ergBiasMultiplier + delta) * 100) / 100));
    this.updateBiasUi();
    this.ergApplyNow(false);
    this.updateHudTitles();
  }

  getErgProfile() {
    const step = this.currentWorkout?.intervals?.[this.intervalIndex] || {};
    return VeloErg.describe(this.currentWorkout || {}, step, this.ergResponse || 'auto');
  }

  configureErg() {
    return this.erg.configure(this.currentWorkout || {},
      this.currentWorkout?.intervals?.[this.intervalIndex] || {}, this.ergResponse || 'auto');
  }

  updateErgResponseUi() {
    const profile = this.getErgProfile();
    const select = this.$('ergResponse');
    if (select) select.value = this.ergResponse || 'auto';
    this.setText('ergResponseSummary', `${profile.label}: ${profile.reason}`);
  }

  setErgResponse(value) {
    if (!['auto', 'steady', 'responsive'].includes(value)) return;
    this.ergResponse = value;
    try { localStorage.setItem('apex_erg_response', value); } catch (e) { /* optional preference */ }
    this.configureErg();
    this.updateErgResponseUi();
    this.ergApplyNow(false);
  }

  /**
   * Sends the ERG target right away (between ticks). With `soft`, a soft start is armed first,
   * so Start, Resume, Skip, Jump and a trainer reconnect never hit a standing flywheel at full load.
   */
  ergApplyNow(soft = false) {
    if (!this.ergModeEnabled || !this.isPlaying) return;
    this.configureErg();
    const target = this.getCurrentTargetWatts();
    if (soft) {
      // Live readings, not the last tick's: after a pause the cranks may have stopped.
      const now = performance.now();
      const fresh = this.devicePowerFresh ? this.devicePowerFresh(now) : null;
      const pedalAlive = fresh ? fresh.pedals : (now - this.blePedal.lastTime) < 3500 && this.blePedal.watts !== null;
      const trainerAlive = fresh ? fresh.trainer : (now - this.bleTrainer.lastTime) < 3500 && this.bleTrainer.watts !== null;
      const src = pedalAlive ? this.blePedal : trainerAlive ? this.bleTrainer : null;
      const cad = this.deviceCadenceReading ? this.deviceCadenceReading(now) : src?.cadence;
      this.erg.softStart({
        target,
        power: src ? Math.max(0, src.watts || 0) : 0,
        cadence: cad ?? 0,
        cadenceKnown: Number.isFinite(cad),
        targetCadence: this.getCurrentTargetCadence(),
      });
    }
    const watts = this.erg.now(target, this.intervalIndex);
    this.ble.setTrainerErgPower(watts, true);
    if (this.ble.isTrainerConnected()) this.lastCommandedErgWatts = watts;
  }

  /**
   * ERG nudge in watts (phone +/-5 W): moves the bias by that many watts of the current step,
   * so later steps scale the same way as with the % buttons.
   */
  setErgBiasWatts(dw) {
    const iv = this.currentWorkout && this.currentWorkout.intervals[this.intervalIndex];
    const base = iv ? this.activeProfile.ftp * (iv.pctFtp / 100) : 0;
    if (!(base > 0)) return;
    // The bias is a whole %, so pick the step whose rounded target lands closest to exactly dw watts.
    const now = Math.round(base * this.ergBiasMultiplier);
    const raw = Math.abs(dw) / base * 100;
    const pick = [Math.floor(raw), Math.ceil(raw)].filter(c => c >= 1)
      .map(c => ({ c, err: Math.abs(Math.round(base * (this.ergBiasMultiplier + Math.sign(dw) * c / 100)) - now - dw) }))
      .sort((a, b) => a.err - b.err || b.c - a.c)[0];
    this.setErgBias(Math.sign(dw) * (pick ? pick.c : 1) / 100);
  }

  /** Out-of-the-saddle break: eases ERG for 30 s (tap again to end early). */
  toggleStand() {
    if (!this.isPlaying) { this.showToast('Stand works during a ride.', 'info'); return; }
    if (this.getErgProfile().test) { this.showToast('Keep the prescribed load during a ramp test. Pause or finish if you cannot continue.', 'info'); return; }
    const on = this.erg.stand();
    this.ergApplyNow(false);
    this.updateStandUi();
    this.showToast(on ? `Stand: ERG eased ${Math.round((1 - this.erg.o.standPct) * 100)}% for ${this.erg.o.standSec} s.` : 'Stand ended - ramping back to target.', 'info');
  }

  updateStandUi() {
    const left = this.erg ? this.erg.standLeft : 0;
    this.setText('btnStandText', left > 0 ? `Standing ${left}s` : 'Stand 30s');
    this.$('btnStand')?.classList.toggle('active', left > 0);
  }

  updateBiasUi() {
    const pct = Math.round(this.ergBiasMultiplier * 100) + '%';
    this.setText('biasValueDisplay', pct);
    this.setText('zenBiasDisplay', pct);
    this.$('biasValueDisplay')?.classList.toggle('biased', this.ergBiasMultiplier !== 1);
    this.renderIntervalTrack();
  }

  // -------------------------------------------------------------- playback --
  updatePlaybackControlsUi() {
    if (this.renderReadinessChips) this.renderReadinessChips();
    const finished = this.isWorkoutCompleted || (this.currentWorkout && this.intervalIndex >= this.currentWorkout.intervals.length);
    let s;
    if (this.isPlaying) s = ['btn btn-pause', 'PAUSE WORKOUT', '#i-pause', 'status-running', 'WORKOUT RUNNING', 'PAUSE'];
    else if (finished) s = ['btn btn-start', 'RESTART WORKOUT', '#i-reset', 'status-completed', 'WORKOUT FINISHED', 'RESTART'];
    else if (this.totalElapsedSeconds > 0) s = ['btn btn-start', 'RESUME WORKOUT', '#i-play', 'status-paused', 'PAUSED', 'RESUME'];
    else s = ['btn btn-start', 'START WORKOUT', '#i-play', 'status-ready', 'READY TO START', 'START'];
    const btnPlay = this.$('btnPlayPause');
    if (btnPlay) btnPlay.className = s[0];
    this.setText('btnPlayPauseText', s[1]);
    this.$('btnPlayPauseIcon')?.setAttribute('href', s[2]);
    const statusPill = this.$('hudWorkoutStatusPill');
    if (statusPill) { statusPill.className = `workout-status-pill ${s[3]}`; statusPill.textContent = s[4]; }
    const zen = this.$('btnZenPlayPause');
    if (zen) { zen.className = s[0]; zen.textContent = s[5]; }
    document.body.classList.toggle('is-riding', this.isPlaying);
  }

  togglePlayPause() {
    if (this.isWorkoutCompleted || (this.currentWorkout && this.intervalIndex >= this.currentWorkout.intervals.length)) {
      this.resetWorkout(false);
    }
    this.isPlaying = !this.isPlaying;
    if (this.isPlaying) {
      if (!this.sessionStartedAt) this.sessionStartedAt = Date.now();
      if (this.recordedSamples.length) {
        this.analytics.startSegment();
        this.powerBuffer = [];
        this._nextSampleStartsSegment = true;
      }
      this.trainerOdoLast = null; // distance ridden while paused is not counted
      this.audio.init();
      this.ble.startTrainerWorkout();
      this.ergApplyNow(true);
      this.start1HzTimer();
      this.acquireWakeLock();
    } else {
      this.clock.stop();
      this.ble.pauseTrainerWorkout();
      this.releaseWakeLock();
    }
    this.updatePlaybackControlsUi();
    this.updatePowerSourceBadge();
  }

  start1HzTimer() {
    this.clock.start();
  }

  /** Keeps the screen (and so Windows) awake while riding - no mouse input for an hour is normal in ERG. */
  async acquireWakeLock() {
    if (this.wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
    } catch (e) {
      this.wakeLock = null; // denied (e.g. battery saver) - riding still works
    }
  }

  releaseWakeLock() {
    const lock = this.wakeLock;
    this.wakeLock = null;
    if (lock) lock.release().catch(() => {});
  }

  /** A ride is in progress (running or paused with data) and would be lost by closing the page. */
  hasUnsavedRide() {
    return !this.isWorkoutCompleted && (this.isPlaying || this.totalElapsedSeconds > 0);
  }

  resetWorkout(confirmPrompt = true) {
    if (confirmPrompt && this.totalElapsedSeconds > 10 && !confirm('Reset to step 1? Live telemetry for this session will be discarded.')) return;
    this._remoteFinishedRide = null;
    this._remoteFitUpload = null;
    this._easySpinOffer = null;
    this.renderEasySpinOffer();
    // Easy-spin extensions belong to one ride only.
    if (this.currentWorkout && this.currentWorkout.intervals.some(iv => iv.extension)) {
      this.currentWorkout = { ...this.currentWorkout, intervals: this.currentWorkout.intervals.filter(iv => !iv.extension) };
    }
    this.isPlaying = false;
    this.releaseWakeLock();
    this.isWorkoutCompleted = false;
    this.clock.stop();
    this.ble.stopTrainerWorkout();
    this.totalElapsedSeconds = 0;
    this.intervalIndex = 0;
    this.intervalSecondsRemaining = this.currentWorkout.intervals[0]?.duration || 300;
    this.recordedSamples = [];
    this._nextSampleStartsSegment = false;
    this._deviceSourceChanges = [];
    this.powerBuffer = [];
    this.liveWbal = undefined; // set from the CP model on the first ride second
    if (this.renderLiveWbal) this.renderLiveWbal();
    this.totalDistanceMeters = 0;
    this.totalDistanceKm = 0;
    this.currentSpeed = 0;
    this.maxSpeedKmh = 0;
    this.sessionStartedAt = null;
    this.analytics.reset();
    this.simulator.reset();
    this.trainerOdoLast = null;      // last KICKR odometer reading (m); null = re-sync on the next one
    this.powerMatchOffset = 0;
    this.erg.reset();
    this.lastCommandedErgWatts = null;
    this.rideHadHardware = false;
    this.hardwareSpeedSource = 'SIMULATOR';
    this.hardwareDistanceSource = 'SIMULATOR';

    const zeros = {
      valInstantPower: '0', val3sPower: '0W', val1sPower: '0W', val30sPower: '0W', valSpeed: '0.0', valDistance: '0.00',
      hudTotalDistance: '0.00 km', hudCurrentSpeed: '0.0 km/h', speedSourceTag: 'SIM', distSourceTag: 'SIM',
      valCadence: '0', valHeartRate: '0', valNormPower: '0', valAvgPower: '0', valIntensityFactor: '0.00', valTss: '0',
      valTotalKj: '0 kJ', hudTotalElapsed: '00:00', valHrZone: '--', zenInstantPower: '0', zenCadence: '0', zenHeartRate: '0'
    };
    Object.entries(zeros).forEach(([id, v]) => this.setText(id, v));
    this.setText('hudIntervalCountdown', this.fmtTime(this.intervalSecondsRemaining));
    for (let i = 1; i <= 7; i++) {
      const seg = this.$('zSeg' + i);
      if (seg) seg.style.width = '0%';
      this.setText('zTime' + i, '00:00');
    }
    const pill = this.$('hudCompliancePill');
    if (pill) { pill.className = 'compliance-pill compliance-idle num'; pill.textContent = 'TARGET --'; }

    if (this.telemetryChart) {
      this.telemetryChart.data.labels = [];
      this.telemetryChart.data.datasets.forEach(ds => { ds.data = []; });
      this.telemetryChart.update('none');
    }
    this.updateMmpChart();
    this.updateHudTitles();
    this.renderIntervalTrack();
    this.updatePlaybackControlsUi();
    this.updatePowerSourceBadge();
  }

  skipInterval() {
    if (this.intervalIndex < this.currentWorkout.intervals.length - 1) {
      this.intervalIndex++;
      this.intervalSecondsRemaining = this.currentWorkout.intervals[this.intervalIndex].duration;
      this.updateHudTitles();
      this.renderIntervalTrack();
      this.ergApplyNow(true);
    }
  }

  jumpToInterval(idx) {
    if (!this.currentWorkout || !this.currentWorkout.intervals) return;
    if (idx >= 0 && idx < this.currentWorkout.intervals.length) {
      this.intervalIndex = idx;
      this.intervalSecondsRemaining = this.currentWorkout.intervals[idx].duration;
      this.updateHudTitles();
      this.renderIntervalTrack();
      this.ergApplyNow(true);
      this.showToast(`Step ${idx + 1}: ${this.currentWorkout.intervals[idx].name}`);
    }
  }

  adjustIntervalDuration(secondsDelta) {
    const remaining = Math.max(5, this.intervalSecondsRemaining + secondsDelta);
    const iv = this.currentWorkout.intervals[this.intervalIndex];
    if (iv) iv.duration += remaining - this.intervalSecondsRemaining;
    this.intervalSecondsRemaining = remaining;
    this.setText('hudIntervalCountdown', this.fmtTime(this.intervalSecondsRemaining));
    this.renderIntervalTrack();
  }

  // ----------------------------------------------------------- 1 Hz engine --
  tick1Hz() {
    this.totalElapsedSeconds++;
    this.intervalSecondsRemaining--;

    const targetPower = this.getCurrentTargetWatts();
    this.simulator.step(targetPower, this.activeProfile.ftp);

    // Source hierarchy: Assioma pedals (CPS) > KICKR SHIFT (FTMS) > simulator
    const now = performance.now();
    const chosenSources = this.devicePowerFresh ? this.devicePowerFresh(now) : null;
    const pedalAlive = chosenSources ? chosenSources.pedals : (now - this.blePedal.lastTime) < 3500 && this.blePedal.watts !== null;
    const trainerAlive = chosenSources ? chosenSources.trainer : (now - this.bleTrainer.lastTime) < 3500 && this.bleTrainer.watts !== null;
    const trainerLinkAlive = (now - this.bleTrainer.lastTime) < 3500;
    const trainerConnected = this.ble && this.ble.isTrainerConnected();
    const hrAlive = (now - this.bleHr.lastTime) < 4000 && this.bleHr.hr !== null;
    const anyHardware = pedalAlive || trainerAlive || hrAlive;
    const hardwareLinked = this.ble && ['trainer', 'pedals', 'hr'].some(k => this.ble.getState(k) !== 'disconnected');
    if (anyHardware || hardwareLinked) this.rideHadHardware = true;
    // Never fill a real ride's dropouts with synthetic data.
    const simOk = this.simulator.enabled && !this.rideHadHardware;

    let power = 0, cadence = 0, leftBal = null, rightBal = null, source = 'SIMULATOR';
    if (pedalAlive) {
      power = Math.max(0, Math.round(this.blePedal.watts));
      cadence = this.blePedal.cadence !== null ? this.blePedal.cadence : (trainerAlive && this.bleTrainer.cadence !== null ? this.bleTrainer.cadence : 0);
      leftBal = this.blePedal.leftPct;
      rightBal = this.blePedal.rightPct;
      source = 'PEDALS';
    } else if (trainerAlive) {
      power = Math.max(0, Math.round(this.bleTrainer.watts));
      cadence = this.bleTrainer.cadence !== null ? this.bleTrainer.cadence : 0;
      source = 'TRAINER';
    } else if (simOk) {
      power = Math.round(this.simulator.power);
      cadence = this.simulator.cadence;
      leftBal = this.simulator.leftBalance;
      rightBal = this.simulator.rightBalance;
    } else {
      source = 'NONE';
    }
    const chosenCadence = this.deviceCadenceReading ? this.deviceCadenceReading(now) : null;
    if (this.deviceCadenceReading && (chosenCadence !== null || !simOk || this.cadenceSourcePreference !== 'auto')) cadence = chosenCadence ?? 0;
    const hr = hrAlive ? this.bleHr.hr : (simOk && !anyHardware ? Math.round(this.simulator.heartRate) : 0);

    // ERG: the governor shapes the trainer target (soft start, anti-stall, step lead) and runs
    // PowerMatch, where the pedals are truth and trim the trainer so pedal power meets the target.
    const cadenceKnown = this.deviceCadenceReading ? chosenCadence !== null : (pedalAlive && this.blePedal.cadence !== null) || (trainerAlive && this.bleTrainer.cadence !== null);
    const pmOn = this.powerMatchEnabled && pedalAlive && trainerConnected && this.ergModeEnabled;
    const ivs = this.currentWorkout.intervals;
    const nextIv = ivs[this.intervalIndex + 1];
    this.configureErg();
    const erg = this.erg.tick({
      target: targetPower,
      nextTarget: nextIv ? Math.round(this.activeProfile.ftp * (nextIv.pctFtp / 100) * this.ergBiasMultiplier) : null,
      secondsLeft: this.intervalSecondsRemaining,
      stepDuration: (ivs[this.intervalIndex] || {}).duration || Infinity,
      cadence,
      power: source === 'NONE' ? null : power,
      cadenceKnown,
      targetCadence: this.getCurrentTargetCadence(),
      ftp: this.activeProfile.ftp,
      pedalPower: pmOn ? power : null,
      stepKey: this.intervalIndex,
    });
    this.powerMatchOffset = this.erg.offset;
    this.updateStandUi();
    if (this.ergModeEnabled) {
      if (erg.event === 'test-stop') {
        this.togglePlayPause();
        this.showToast('Ramp test paused: cadence and power fell. Finish the test at failure; resuming at an easier load changes the result.', 'info');
      } else {
        this.ble.setTrainerErgPower(erg.watts);
        this.lastCommandedErgWatts = trainerConnected ? erg.watts : null;
        if (erg.event === 'stall' && trainerConnected) {
          this.showToast(`Low cadence - ERG eased to ${erg.watts} W. Spin up and it ramps back to target.`, 'info');
        }
      }
    }

    this.currentPower = power;
    this.currentCadence = cadence;
    this.currentHeartRate = hr;
    this.currentLeftBal = leftBal;
    this.currentRightBal = rightBal;
    this.activePowerSource = source;

    this.powerBuffer.push(power);
    if (this.powerBuffer.length > 120) this.powerBuffer.shift();

    // Speed: KICKR SHIFT when streaming, else virtual road speed from power
    let speed;
    if (trainerLinkAlive && this.bleTrainer.speed !== null && this.bleTrainer.speed >= 0) {
      speed = parseFloat(Number(this.bleTrainer.speed).toFixed(1));
      this.hardwareSpeedSource = 'KICKR SHIFT';
    } else {
      speed = this.calcVirtualSpeedKmh(power, this.activeProfile.weightKg);
      this.hardwareSpeedSource = 'VIRTUAL';
    }
    this.currentSpeed = speed;
    if (speed > this.maxSpeedKmh) this.maxSpeedKmh = speed;

    // Distance: add what the KICKR's cumulative odometer (uint24 m) moved since the last second.
    // The first reading, a reading after a pause or a dropout, and a counter that went backwards
    // (trainer reboot / reconnect) only re-sync - so the total never jumps back and paused
    // pedalling is not counted. Without trainer distance, speed is integrated.
    const odo = trainerLinkAlive && this.bleTrainer.distanceMeters !== null && this.bleTrainer.distanceMeters !== undefined ? Number(this.bleTrainer.distanceMeters) : null;
    if (odo !== null && Number.isFinite(odo)) {
      const step = this.trainerOdoLast === null ? null : odo - this.trainerOdoLast;
      if (step !== null && step >= 0 && step <= 500) this.totalDistanceMeters += step;
      this.trainerOdoLast = odo;
      this.hardwareDistanceSource = 'KICKR SHIFT';
    } else {
      this.trainerOdoLast = null;
      this.totalDistanceMeters += speed / 3.6;
      this.hardwareDistanceSource = 'VIRTUAL';
    }
    this.totalDistanceKm = parseFloat((this.totalDistanceMeters / 1000).toFixed(2));

    this.analytics.update(power);

    if (this.intervalSecondsRemaining <= 3 && this.intervalSecondsRemaining > 0) this.audio.countdownTick(this.intervalSecondsRemaining);
    else if (this.intervalSecondsRemaining === 0) this.audio.intervalGo();

    if (this.pip && this.pip.active) this.pip.renderMiniHud();

    if (this.updateLiveWbal) {
      if (this.liveWbal === undefined) this.resetLiveWbal();
      this.updateLiveWbal(power, !!this._nextSampleStartsSegment && this.recordedSamples.length > 0);
    }

    this.recordedSamples.push({
      time: this.totalElapsedSeconds,
      timestamp: Date.now(),
      segmentStart: !!this._nextSampleStartsSegment,
      target: targetPower,
      workoutStep: this.intervalIndex,
      stepTime: Math.max(0, this.currentWorkout.intervals[this.intervalIndex].duration - this.intervalSecondsRemaining),
      power,
      cadence,
      hr,
      speed,
      dist: this.totalDistanceKm,
      leftBal,
      rightBal,
      src: source
    });
    this._nextSampleStartsSegment = false;

    this.updateHudDisplays(power, targetPower, cadence, hr);
    this.updateTelemetryChart(this.totalElapsedSeconds, power, cadence, hr, targetPower);
    this.updatePowerSourceBadge();
    if (this.totalElapsedSeconds % 5 === 0 && this.activeTab === 'analytics') this.updateMmpChart();
    if (this.ergModeEnabled && erg.event === 'test-stop') return;

    if (this.intervalSecondsRemaining <= 0) {
      this.intervalIndex++;
      if (this.intervalIndex >= this.currentWorkout.intervals.length) {
        // Workout done: keep spinning on an easy step and offer "+5 min easy spin" for 10 s.
        if (this.offerEasySpin()) return;
        this.finishWorkout(true);
        return;
      }
      this.intervalSecondsRemaining = this.currentWorkout.intervals[this.intervalIndex].duration;
      this.updateHudTitles();
      this.ergApplyNow(false);
    }
    if (this._easySpinOffer && Date.now() >= this._easySpinOffer.until) this.declineEasySpin();
    else if (this._easySpinOffer) this.renderEasySpinOffer();
    // Full redraw only when the step (or workout / ERG bias) changed; otherwise just the countdown.
    // Rebuilding the track and every queue card each second slowed long rides down.
    if (this.intervalTrackRenderKey() !== this._trackRenderKey) this.renderIntervalTrack();
    else this.updateIntervalCountdown();
  }

  // ------------------------------------------------------- easy spin --
  static EASY_SPIN = { name: 'Easy spin', duration: 300, pctFtp: 45, cadence: 90, extension: true };
  static EASY_SPIN_OFFER_MS = 10000;

  /**
   * At the natural end of a workout: add a provisional 5-min easy spin (so the legs keep turning in
   * ERG) and show a 10 s prompt. Accept keeps it; Finish or no answer removes it and saves the ride.
   * Returns false when there is nothing to offer (not riding).
   */
  offerEasySpin() {
    if (!this.isPlaying || !this.currentWorkout) return false;
    const w = this.currentWorkout;
    this.currentWorkout = { ...w, intervals: [...w.intervals, { ...VeloApp.EASY_SPIN }] }; // copy: the library workout is untouched
    this.intervalIndex = this.currentWorkout.intervals.length - 1;
    this.intervalSecondsRemaining = VeloApp.EASY_SPIN.duration;
    this._easySpinOffer = { until: Date.now() + VeloApp.EASY_SPIN_OFFER_MS };
    this.audio.workoutCompleteFanfare();
    this.updateHudTitles();
    this.renderIntervalTrack();
    this.ergApplyNow(false);
    this.renderEasySpinOffer();
    if (this.publishSoon) this.publishSoon();
    return true;
  }

  acceptEasySpin() {
    if (!this._easySpinOffer) return;
    this._easySpinOffer = null;
    this.renderEasySpinOffer();
    this.showToast('+5 min easy spin - the ride continues.', 'success');
    if (this.publishSoon) this.publishSoon();
  }

  /** Finish now (or the offer timed out): drop the provisional spin and save it as a completed workout. */
  declineEasySpin() {
    if (!this._easySpinOffer) return;
    this._easySpinOffer = null;
    this.renderEasySpinOffer();
    const ivs = this.currentWorkout.intervals;
    if (ivs.length && ivs[ivs.length - 1].extension && this.intervalIndex === ivs.length - 1) {
      this.currentWorkout = { ...this.currentWorkout, intervals: ivs.slice(0, -1) };
      this.intervalIndex = this.currentWorkout.intervals.length;
    }
    this.updateWorkoutOverview();
    this.finishWorkout(true, { fanfare: false }); // a natural end; the fanfare already played with the offer
  }

  renderEasySpinOffer() {
    let el = document.getElementById('easySpinOffer');
    const o = this._easySpinOffer;
    if (!o) { if (el) el.remove(); return; }
    const left = Math.max(0, Math.ceil((o.until - Date.now()) / 1000));
    if (!el) {
      el = document.createElement('div');
      el.id = 'easySpinOffer';
      el.className = 'easy-spin-offer';
      el.setAttribute('role', 'dialog');
      el.innerHTML = `<div class="eso-title">Workout complete - nice work!</div>
        <div class="eso-sub">Spinning easy at ${VeloApp.EASY_SPIN.pctFtp}% FTP. Keep going to flush the legs?</div>
        <div class="eso-actions"><button type="button" class="btn btn-start eso-yes" data-eso="yes">+5 min easy spin</button>
        <button type="button" class="btn btn-ghost eso-no" data-eso="no">Finish now <span class="num" data-eso-left></span></button></div>`;
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-eso]');
        if (b) (b.dataset.eso === 'yes' ? this.acceptEasySpin() : this.declineEasySpin());
      });
      document.body.appendChild(el);
    }
    const t = el.querySelector('[data-eso-left]');
    if (t) t.textContent = `(${left})`;
  }

  finishWorkout(isNaturalEnd = false, { fanfare = true } = {}) {
    this._easySpinOffer = null;
    this.renderEasySpinOffer();
    this.isPlaying = false;
    this.releaseWakeLock();
    this.clock.stop();
    this.ble.stopTrainerWorkout();
    this.isWorkoutCompleted = true;
    this.updatePlaybackControlsUi();
    this.updatePowerSourceBadge();
    if (this.isZenMode) this.toggleZenMode();
    if (isNaturalEnd && fanfare) this.audio.workoutCompleteFanfare();

    if (!(this.recordedSamples.length > 0 || this.totalElapsedSeconds > 0)) {
      this.showToast('Workout stopped. No telemetry was recorded.', 'info');
      return;
    }

    const samples = this.recordedSamples.slice();
    const durSec = Math.max(1, this.totalElapsedSeconds);
    const distKm = parseFloat((this.totalDistanceMeters / 1000).toFixed(2));
    const p = VeloMetrics.stats(samples.map(s => s.power));
    const h = VeloMetrics.stats(samples.map(s => s.hr));
    const c = VeloMetrics.stats(samples.map(s => s.cadence));
    const bal = samples.filter(s => Number(s.leftBal) > 0 && Number(s.rightBal) > 0);
    const avgLeft = bal.length ? Math.round((bal.reduce((a, s) => a + Number(s.leftBal), 0) / bal.length) * 10) / 10 : null;
    const kj = Math.round(this.analytics.totalJoules / 1000) || Math.round(VeloMetrics.workKjFromSamples(samples));
    const np = this.analytics.normalizedPower || VeloMetrics.normalizedPower(samples) || VeloMetrics.avgPower(samples.map(s => s.power));
    const ftp = this.activeProfile.ftp;
    const ifac = ftp > 0 ? np / ftp : 0;
    const tss = this.analytics.tss || (ftp > 0 ? Math.round(((durSec * np * ifac) / (ftp * 3600)) * 100) : 0);
    const start = samples.length && Number.isFinite(samples[0].timestamp)
      ? new Date(samples[0].timestamp - (samples[0].time || 0) * 1000)
      : new Date(this.sessionStartedAt || Date.now() - durSec * 1000);

    const record = {
      id: 'ride_' + Date.now(),
      date: start.toISOString(),
      profileName: this.activeProfile.name,
      deviceSourceChanges: (this._deviceSourceChanges || []).slice(),
      deviceSources: { power: this.powerSourcePreference || 'auto', cadence: this.cadenceSourcePreference || 'auto' },
      title: this.currentWorkout.title,
      workoutId: this.currentWorkout.id,
      duration: this.totalElapsedSeconds,
      durationMin: Math.round(this.totalElapsedSeconds / 60),
      distanceKm: distKm,
      totalDistanceMeters: Math.round(this.totalDistanceMeters),
      avgSpeedKmh: parseFloat((distKm / (durSec / 3600)).toFixed(1)),
      maxSpeedKmh: parseFloat((this.maxSpeedKmh || 0).toFixed(1)),
      avgWatts: VeloMetrics.avgPower(samples.map(s => s.power)),
      maxWatts: p.max,
      np,
      tss,
      if: ifac.toFixed(2),
      kj,
      totalCalories: VeloMetrics.kcalFromKj(kj),
      avgHr: h.avg,
      maxHr: h.max,
      avgCadence: c.avg,
      maxCadence: c.max,
      leftBal: avgLeft,
      rightBal: avgLeft === null ? null : Math.round((100 - avgLeft) * 10) / 10,
      compliancePct: VeloMetrics.complianceScore(samples) ?? 0,
      ftpAtRide: ftp,
      samplesCount: samples.length,
      source: 'APEX VELO Cockpit',
      completedAt: Date.now(),
      samples
    };
    this.completedWorkouts.unshift(record);
    this.saveHistory();
    if (this.preparePhoneFit) this.preparePhoneFit(record);
    this.renderHistoryTable();
    this.recalculatePmc();
    this.refreshAnalytics();
    this.showToast('Workout complete - saved to your training history.', 'success');
    this.showRideSummary(record, isNaturalEnd);
  }

  // ----------------------------------------------------- BLE & hardware --
  handleBleTelemetry(data) {
    const now = performance.now();
    switch (data.type) {
      case 'pedals':
        if (data.name) this.blePedal.name = data.name;
        if (data.watts !== undefined && data.watts !== null) this.blePedal.watts = data.watts;
        if (data.cadence !== undefined && data.cadence !== null) this.blePedal.cadence = data.cadence;
        if (data.leftPct !== undefined && data.leftPct !== null) {
          this.blePedal.leftPct = data.leftPct;
          this.blePedal.rightPct = (data.rightPct !== undefined && data.rightPct !== null) ? data.rightPct : 100 - data.leftPct;
        }
        if (data.torque !== undefined && data.torque !== null) this.blePedal.torque = data.torque;
        this.blePedal.lastTime = now;
        return;
      case 'trainer':
        if (data.name) this.bleTrainer.name = data.name;
        if (data.watts !== undefined && data.watts !== null) this.bleTrainer.watts = data.watts;
        if (data.cadence !== undefined && data.cadence !== null) this.bleTrainer.cadence = data.cadence;
        if (data.speed !== undefined && data.speed !== null) this.bleTrainer.speed = data.speed;
        if (data.distanceMeters !== undefined && data.distanceMeters !== null) this.bleTrainer.distanceMeters = data.distanceMeters;
        this.bleTrainer.lastTime = now;
        return;
      case 'hr':
        this.bleHr.hr = (typeof data.hr === 'number' && data.hr > 0) ? data.hr : null;
        this.bleHr.contact = data.contact === undefined ? null : data.contact;
        this.bleHr.lastTime = now;
        return;
      case 'battery':
        this.bleBattery[data.device] = data.level;
        if (data.level !== null && data.level <= 15 && !this.lowBatteryWarned[data.device]) {
          this.lowBatteryWarned[data.device] = true;
          this.showToast(`${this.deviceLabel(data.device)} battery low (${data.level}%).`, 'warning');
        }
        break;
      case 'calibration_response':
        this.onCalibrationResponse(data);
        break;
      case 'state':
        this.updateDeviceBadge(data.device, data.state);
        if (data.state === 'failed') this.showToast(`${this.deviceLabel(data.device)}: could not reconnect. Reconnect it manually.`, 'error');
        break;
      case 'reconnected':
        this.onHardwareConnected(data.device);
        this.showToast(`${this.deviceLabel(data.device)} reconnected.`, 'success');
        if (data.device === 'trainer') this.trainerOdoLast = null;
        if (data.device === 'trainer' && this.isPlaying) {
          this.ble.startTrainerWorkout();
          this.ergApplyNow(true);
        }
        break;
      case 'disconnect':
        this.onDeviceDisconnected(data.device, data.willReconnect);
        break;
      case 'ftms_response':
        if (!data.ok && data.result === 0x05) this.showToast('Trainer refused control (another app may hold it). Retrying...', 'warning');
        break;
      default:
        break;
    }
    this.updatePowerSourceBadge();
    if (this.publishSoon) this.publishSoon(); // link state / battery changes reach the phone at once
  }

  deviceLabel(kind) {
    const slot = this.ble?.slots?.[kind];
    const alias = this.ble?._knownIds?.()[kind]?.alias;
    return alias || slot?.device?.name || { trainer: 'Smart trainer', pedals: 'Power meter', hr: 'Heart-rate sensor', fan: 'HEADWIND fan' }[kind] || kind;
  }

  onDeviceDisconnected(kind, willReconnect) {
    if (kind === 'trainer') {
      this.bleTrainer.watts = null; this.bleTrainer.cadence = null; this.bleTrainer.speed = null; this.bleTrainer.distanceMeters = null;
    } else if (kind === 'pedals') {
      this.blePedal.watts = null; this.blePedal.cadence = null; this.blePedal.leftPct = null; this.blePedal.rightPct = null;
      if (this.calibration.phase !== 'idle') this.finishCalibration(false, 'Pedals disconnected during calibration.');
    } else if (kind === 'hr') {
      this.bleHr.hr = null;
      this.bleHr.contact = null;
    }
    if (!willReconnect) {
      this.lowBatteryWarned[kind] = false;
      this.bleBattery[kind] = null;
    }
    this.showToast(willReconnect ? `${this.deviceLabel(kind)} link lost - reconnecting automatically...` : `${this.deviceLabel(kind)} disconnected.`,
      willReconnect ? 'warning' : 'info');
    this.updateDeviceBadge(kind, willReconnect ? 'reconnecting' : 'disconnected');
  }

  updateDeviceBadge(kind, state) {
    const el = this.$({ trainer: 'btnBleFtms', pedals: 'btnBlePedals', hr: 'btnBleHr' }[kind]);
    if (!el) return;
    el.dataset.state = state;
    el.classList.toggle('connected', state === 'connected');
  }

  async connectDevice(kind, options = {}) {
    if (!navigator.bluetooth) {
      this.showToast('Web Bluetooth needs Chrome, Edge or Brave on https:// or localhost.', 'error');
      return;
    }
    const connected = kind === 'fan' ? this.ble.isFanConnected() : kind === 'trainer' ? this.ble.isTrainerConnected() : kind === 'pedals' ? this.ble.isPedalsConnected() : this.ble.isHrConnected();
    const state = this.ble.getState(kind);
    if (state === 'connecting') {
      this.showToast(`${this.deviceLabel(kind)} is already connecting...`, 'info');
      return;
    }
    if (!options.replace && (connected || state === 'reconnecting')) {
      if (connected && !confirm(`Disconnect ${this.deviceLabel(kind)}?`)) return;
      this.disconnectDeviceKind(kind);
      return;
    }
    // 'failed' (auto-reconnect gave up): forget the old link and open the chooser again right away.
    if (state === 'failed') this.disconnectDeviceKind(kind, true);

    this.updateDeviceBadge(kind, 'connecting');
    this.bleBattery[kind] = null;
    try {
      const ok = kind === 'fan' ? await this.ble.connectFan(options) : kind === 'trainer' ? await this.ble.connectTrainer(options) : kind === 'pedals' ? await this.ble.connectPedals(options) : await this.ble.connectHr(options);
      this.onConnectResult(kind, ok);
    } catch (err) {
      this.updateDeviceBadge(kind, this.ble.getState(kind));
      const msg = String((err && err.message) || err || '');
      if (err && err.name === 'AbortError') this.showToast('Pairing stopped.', 'info');
      else if (err && err.name === 'NotFoundError') {
        if (/cancel/i.test(msg)) this.showToast(`${this.deviceLabel(kind)} pairing cancelled.`, 'info');
        else this.showToast(`No ${this.deviceLabel(kind)} found. ${this.deviceWakeHint(kind)}`, 'warning');
      } else if (err && err.name === 'SecurityError') {
        this.showToast('Bluetooth blocked by the browser. Open the app with Launch-Apex-Velo.bat (http://localhost:8080).', 'error');
      } else if (err && err.name === 'NotAllowedError') {
        this.showToast('Bluetooth permission denied. Allow Bluetooth for localhost in Chrome site settings.', 'error');
      } else if (err && (err.name === 'NetworkError' || err.name === 'TimeoutError')) {
        this.showToast(`${this.deviceLabel(kind)} did not respond. ${this.deviceWakeHint(kind)}`, 'error');
      } else {
        this.showToast(`${this.deviceLabel(kind)} error: ${msg}`, 'warning');
      }
    }
    this.updatePowerSourceBadge();
  }

  /** Badge, toast and ERG hand-over after a connect attempt (from the chooser or a reconnect). */
  onConnectResult(kind, ok) {
    this.updateDeviceBadge(kind, ok ? 'connected' : 'disconnected');
    if (ok) {
      this.onHardwareConnected(kind);
      this.showToast(`${this.deviceLabel(kind)} connected.`, 'success');
      if (kind === 'trainer' && this.isPlaying) {
        this.ble.startTrainerWorkout();
        this.ergApplyNow(true);
      }
    } else {
      const err = this.ble.slots && this.ble.slots[kind] ? this.ble.slots[kind].lastError : null;
      const why = err && err.message ? ` (${err.message})` : '';
      const what = err && err.name === 'NotFoundError' ? 'not found nearby' : 'found but the connection failed after 3 tries';
      this.showToast(`${this.deviceLabel(kind)} ${what}${why}. ${this.deviceWakeHint(kind)}`, 'warning');
    }
  }

  disconnectDeviceKind(kind, silent = false) {
    if (kind === 'trainer') this.ble.disconnectTrainer();
    else if (kind === 'pedals') this.ble.disconnectPedals();
    else if (kind === 'fan') this.ble.disconnectFan();
    else this.ble.disconnectHr();
    this.updateDeviceBadge(kind, 'disconnected');
    if (!silent) this.updatePowerSourceBadge();
  }

  /** What to check when a device is not found or does not answer. */
  deviceWakeHint(kind) {
    return {
      trainer: 'Power on the trainer and close other apps that may hold its Bluetooth connection.',
      pedals: 'Turn the cranks to wake the power meter and close other apps using it.',
      fan: 'Plug in HEADWIND, keep it nearby, and close the Wahoo app if it holds the connection.',
      hr: 'Put on the sensor, wet strap electrodes if needed, and close other apps using its connection.'
    }[kind] || '';
  }

  /** Real hardware takes over: the simulator must never mix synthetic data into a real ride. */
  onHardwareConnected(kind) {
    if (kind === 'fan') {
      this.fanStatus = 'Connected. Choose an airflow level; connecting has not changed it.';
      return; // a fan is not a telemetry source
    }
    if (this.simulator && this.simulator.enabled) {
      this.simulator.enabled = false;
      this.simulator.reset();
      this.$('simToggleBtn')?.classList.remove('active');
      this.showToast('Simulator switched off - live hardware connected.', 'info');
    }
  }

  /** Source badge + ERG pill (+ Hardware Lab values when open). Called each tick and on BLE events. */
  updatePowerSourceBadge() {
    const badge = this.$('hudPowerSourceBadge');
    if (!badge) return;
    const now = performance.now();
    const chosen = this.devicePowerFresh ? this.devicePowerFresh(now) : null;
    const pedalAlive = chosen ? chosen.pedals : (now - this.blePedal.lastTime) < 3500 && this.blePedal.watts !== null;
    const trainerAlive = chosen ? chosen.trainer : (now - this.bleTrainer.lastTime) < 3500 && this.bleTrainer.watts !== null;
    const trainerConnected = this.ble && this.ble.isTrainerConnected();
    const pmActive = pedalAlive && trainerConnected && this.powerMatchEnabled && this.ergModeEnabled;
    const trim = `${this.powerMatchOffset >= 0 ? '+' : ''}${Math.round(this.powerMatchOffset)}`;

    let cls, label, title;
    if (pmActive) {
      cls = 'src-powermatch'; label = `${/assioma/i.test(this.blePedal.name) ? 'ASSIOMA' : 'METER'} POWERMATCH`;
      title = `PowerMatch: ${this.blePedal.name} (${Math.round(this.currentPower)} W) trims trainer ERG by ${trim} W`;
    } else if (pedalAlive) {
      cls = 'src-pedals'; label = 'POWER METER'; title = `Power from ${this.blePedal.name} (CPS)`;
    } else if (trainerAlive) {
      cls = 'src-trainer'; label = 'TRAINER POWER'; title = `Power from ${this.bleTrainer.name} (FTMS)`;
    } else if (this.simulator.enabled && !this.rideHadHardware) {
      cls = 'src-sim'; label = 'SIMULATOR'; title = 'Physics simulator - connect pedals or trainer for live data';
    } else {
      cls = 'src-none'; label = 'NO SOURCE'; title = 'No power source - connect hardware or enable the simulator';
    }
    const newCls = `power-source-badge ${cls}`;
    if (badge.className !== newCls) badge.className = newCls;
    const html = `<span class="badge-dot"></span>${VeloApp.esc(label)}`;
    if (badge.innerHTML !== html) badge.innerHTML = html;
    badge.title = title;

    const ergPill = this.$('hudErgStatusPill');
    if (ergPill) {
      const targetW = this.getCurrentTargetWatts();
      let text, pc;
      if (!this.ergModeEnabled) { text = 'ERG OFF'; pc = 'erg-status-pill erg-off'; }
      else if (trainerConnected && this.ble.slots.trainer.controlGranted !== true) {
        text = this.ble.slots.trainer.controlGranted === false ? 'ERG · CONTROL REFUSED' : 'ERG · WAITING FOR CONTROL'; pc = 'erg-status-pill';
      }
      else if (trainerConnected && this.erg.mode !== 'normal') {
        const cmd = this.lastCommandedErgWatts != null ? this.lastCommandedErgWatts : targetW;
        text = { 'soft-start': `ERG SOFT START ${cmd}W - SPIN UP`, stall: `ERG EASED ${cmd}W - SPIN UP`, ramp: `ERG RAMP ${cmd}/${targetW}W`, stand: `ERG STAND ${cmd}W - ${this.erg.standLeft}s`, 'test-stop': 'ERG · TEST PAUSED AT FAILURE' }[this.erg.mode];
        pc = 'erg-status-pill erg-active';
      }
      else if (trainerConnected) { text = pmActive ? `ERG MATCH ${targetW}W (${trim})` : `ERG ${targetW}W`; pc = 'erg-status-pill erg-active'; }
      else { text = 'ERG · CONNECT TRAINER'; pc = 'erg-status-pill'; }
      if (ergPill.textContent !== text) ergPill.textContent = text;
      if (ergPill.className !== pc) ergPill.className = pc;
    }

    if (this.$('hardwareModal')?.classList.contains('open')) this.updateHardwarePanel();
    else if (this.renderDevicesPanel) this.renderDevicesPanel();
  }

  /** Hardware Lab drawer: live values, link diagnostics, PowerMatch trim. */
  updateHardwarePanel() {
    const now = performance.now();
    const pedalAlive = (now - this.blePedal.lastTime) < 3500 && this.blePedal.watts !== null;
    const trainerLive = (now - this.bleTrainer.lastTime) < 3500;
    const trainerConnected = this.ble.isTrainerConnected();
    const hrAlive = (now - this.bleHr.lastTime) < 4000 && this.bleHr.hr !== null;
    const stateText = { connected: 'Connected', connecting: 'Connecting', reconnecting: 'Reconnecting', failed: 'Reconnect failed', disconnected: 'Disconnected' };

    const info = (kind) => {
      const d = this.ble.getDiagnostics ? this.ble.getDiagnostics(kind) : null;
      if (!d) return { rssi: 'n/a', link: '--', line: 'Not connected', state: 'disconnected' };
      let line = stateText[d.state] || d.state;
      if (d.state === 'reconnecting') line = `Reconnecting - attempt ${Math.min(d.attempt + 1, VeloBle.RECONNECT_MAX_ATTEMPTS)}/${VeloBle.RECONNECT_MAX_ATTEMPTS}, next try in ${(d.nextRetryMs / 1000).toFixed(1)} s`;
      else if (d.state === 'connected') line = `Connected for ${this.fmtTime(d.connectedForMs / 1000)}`;
      else if (d.state === 'disconnected') line = 'Not connected';
      return {
        rssi: d.rssi !== null && d.rssi !== undefined ? `${d.rssi} dBm` : 'n/a',
        link: d.lastPacketAgeMs !== null ? `${(d.packetRate || 0).toFixed(1)} pkt/s - last ${Math.round(d.lastPacketAgeMs)} ms` : '--',
        line,
        state: d.state
      };
    };
    const setState = (badgeId, lineId, inf, streaming) => {
      const b = this.$(badgeId);
      const st = inf.state === 'disconnected' && streaming ? 'connected' : inf.state;
      if (b) { b.dataset.state = st; b.textContent = inf.state === 'disconnected' && streaming ? 'Streaming' : (stateText[st] || st); }
      this.setText(lineId, inf.state === 'disconnected' && streaming ? 'Receiving telemetry' : inf.line);
    };

    const dp = info('pedals');
    setState('hwPedalStatusBadge', 'hwPedalState', dp, pedalAlive);
    this.setText('hwPedalWattsVal', pedalAlive ? `${Math.round(this.blePedal.watts || 0)} W` : '-- W');
    this.setText('hwPedalCadVal', pedalAlive && this.blePedal.cadence !== null ? `${this.blePedal.cadence} RPM` : '-- RPM');
    this.setText('hwPedalBalVal', pedalAlive && this.blePedal.leftPct !== null ? `${Number(this.blePedal.leftPct).toFixed(1)}% L / ${Number(this.blePedal.rightPct).toFixed(1)}% R` : '-- L / -- R');
    this.setText('hwPedalBattery', this.bleBattery.pedals !== null ? `${this.bleBattery.pedals}%` : '--');
    this.setText('hwPedalRssi', dp.rssi);
    this.setText('hwPedalLink', dp.link);
    this.setText('btnConnectPedalsModal', (this.ble.isPedalsConnected() || pedalAlive) ? 'Disconnect pedals' : (dp.state === 'reconnecting' ? 'Cancel reconnect' : 'Connect Assioma pedals'));

    const dt = info('trainer');
    setState('hwTrainerStatusBadge', 'hwTrainerState', dt, trainerConnected || trainerLive);
    this.setText('hwTrainerSpeedVal', (trainerConnected || trainerLive) ? `${(this.currentSpeed || 0).toFixed(1)} km/h` : '-- km/h');
    this.setText('hwTrainerDistVal', (trainerConnected || trainerLive) ? `${(this.totalDistanceKm || 0).toFixed(2)} km` : '-- km');
    this.setText('hwTrainerTargetVal', `${this.getCurrentTargetWatts()} W`);
    this.setText('hwTrainerCommandedVal', this.lastCommandedErgWatts !== null ? `${this.lastCommandedErgWatts} W` : '-- W');
    this.setText('hwTrainerBattery', this.bleBattery.trainer !== null ? `${this.bleBattery.trainer}%` : '--');
    this.setText('hwTrainerRssi', dt.rssi);
    this.setText('hwTrainerLink', dt.link);
    this.setText('btnConnectTrainerModal', trainerConnected ? 'Disconnect KICKR SHIFT' : (dt.state === 'reconnecting' ? 'Cancel reconnect' : 'Connect KICKR SHIFT'));

    const dh = info('hr');
    setState('hwHrStatusBadge', 'hwHrState', dh, hrAlive);
    this.setText('hwHrVal', hrAlive ? `${this.bleHr.hr} bpm` : (this.bleHr.contact === false && (now - this.bleHr.lastTime) < 4000 ? 'No skin contact' : '-- bpm'));
    this.setText('hwHrBattery', this.bleBattery.hr !== null ? `${this.bleBattery.hr}%` : '--');
    this.setText('hwHrRssi', dh.rssi);
    this.setText('hwHrLink', dh.link);
    this.setText('btnConnectHrModal', this.ble.isHrConnected() ? 'Disconnect HR strap' : (dh.state === 'reconnecting' ? 'Cancel reconnect' : 'Connect HR strap'));

    const pmActive = this.powerMatchEnabled && pedalAlive && trainerConnected && this.ergModeEnabled;
    const trim = `${this.powerMatchOffset >= 0 ? '+' : ''}${Math.round(this.powerMatchOffset)}`;
    this.setText('hwPowerMatchTrimBadge', pmActive ? `Trim: ${trim}W` : (this.powerMatchEnabled ? 'Trim: -- (standby)' : 'Disabled'));
    const bar = this.$('hwPowerMatchBar');
    if (bar) {
      const pct = Math.min(1, Math.abs(this.powerMatchOffset) / 45) * 50;
      bar.style.left = this.powerMatchOffset >= 0 ? '50%' : `${50 - pct}%`;
      bar.style.width = `${pct}%`;
      bar.classList.toggle('neg', this.powerMatchOffset < 0);
    }
    const errW = pedalAlive ? Math.round((this.blePedal.watts || 0) - this.getCurrentTargetWatts()) : null;
    this.setText('hwPowerMatchError', errW === null ? 'Pedal error vs target: --' : `Pedal error vs target: ${errW >= 0 ? '+' : ''}${errW} W`);
    if (this.renderDevicesPanel) this.renderDevicesPanel();
  }

  // -------------------------------------------------- pedal calibration --
  setCalibrationUi(phase, title, status, progress = null, count = null) {
    this.calibrationView = { phase, title: title || '', status: status || '', count: count === null || count === '' ? null : count, at: Date.now() };
    if (this.publishSoon) this.publishSoon();
    const panel = this.$('calibPanel');
    if (panel) panel.dataset.phase = phase;
    if (title) this.setText('calibTitle', title);
    if (status) this.setText('calibStatus', status);
    const arc = this.$('calibArc');
    if (arc && progress !== null) {
      const C = 2 * Math.PI * 19;
      arc.style.strokeDasharray = `${C}`;
      arc.style.strokeDashoffset = `${C * (1 - progress)}`;
    }
    if (count !== null) this.setText('calibCountdown', count);
  }

  /** Guided zero-offset: 3-2-1 countdown, send CPS op code 0x0C, wait up to 12 s for the pedals' response. */
  async calibrateAssiomaPedals() {
    if (!this.ble || !this.ble.isPedalsConnected()) {
      this.showToast('Connect your power meter first.', 'warning');
      return;
    }
    if (this.isPlaying) { this.showToast('Pause the ride before calibrating.', 'warning'); return; }
    if (!this.ble.canCalibrate()) { this.showToast('This meter does not expose offset calibration. Use its manufacturer app.', 'warning'); return; }
    if (this.calibration.phase !== 'idle') return;
    const btn = this.$('btnCalibratePedalsModal');
    if (btn) btn.disabled = true;
    this.calibration.phase = 'countdown';
    this.showToast('Zero-offset: unclip and hold the cranks still.', 'info');

    for (let s = this.calibrationCountdownSec; s > 0; s--) {
      this.setCalibrationUi('countdown', 'Hold still...', `Cranks vertical, no load. Sending in ${s} s.`, (this.calibrationCountdownSec - s) / this.calibrationCountdownSec, s);
      await new Promise(r => setTimeout(r, 1000));
      if (this.calibration.phase !== 'countdown') return;
    }
    this.setCalibrationUi('sending', 'Calibrating...', 'Offset compensation sent (CPS 0x0C). Waiting for the pedals...', 1, '');
    this.calibration.phase = 'waiting';
    try {
      const sent = await this.ble.calibratePedals();
      if (!sent) throw new Error('Calibration command was not accepted');
      clearTimeout(this.calibration.timeout);
      this.calibration.timeout = setTimeout(() => {
        if (this.calibration.phase === 'waiting') this.finishCalibration(false, 'No response from the pedals within 12 s.');
      }, 12000);
    } catch (err) {
      this.finishCalibration(false, 'Could not send calibration: ' + (err.message || err));
    }
  }

  onCalibrationResponse(data) {
    const codes = { 2: 'op code not supported', 3: 'invalid parameter', 4: 'operation failed (pedal moving or loaded?)' };
    if (data.success) {
      const off = data.offset !== null && data.offset !== undefined ? data.offset : null;
      this.finishCalibration(true, off !== null ? `Zero-offset complete. Offset value: ${off}.` : 'Zero-offset complete.', off);
    } else {
      this.finishCalibration(false, `Calibration rejected: ${codes[data.code] || 'unknown error'}. Unclip, keep the cranks vertical and retry.`);
    }
  }

  finishCalibration(success, message, offset = null) {
    clearTimeout(this.calibration.timeout);
    this.calibration.phase = 'idle';
    const btn = this.$('btnCalibratePedalsModal');
    if (btn) btn.disabled = false;
    this.setCalibrationUi(success ? 'success' : 'error', success ? 'Calibrated' : 'Calibration failed', message, success ? 1 : 0, '');
    const cd = this.$('calibCountdown');
    if (cd) cd.innerHTML = `<svg class="ic"><use href="#${success ? 'i-check' : 'i-x'}"/></svg>`;
    if (success) {
      const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      this.setText('calibLastOffset', `Last calibration ${stamp}${offset !== null ? ` - offset ${offset}` : ''}`);
      this.showToast(`Assioma calibrated${offset !== null ? ` (Offset: ${offset})` : ''}.`, 'success');
    } else {
      this.showToast(message, 'error');
    }
  }

  // ---------------------------------------------------------------- HUD --
  /** Planned duration and time-weighted target power for the whole loaded workout. */
  updateWorkoutOverview() {
    let duration = 0, joules = 0;
    for (const iv of this.currentWorkout.intervals) {
      const seconds = Number(iv.duration) || 0;
      if (seconds <= 0) continue;
      const watts = Math.round(this.activeProfile.ftp * (iv.pctFtp / 100) * this.ergBiasMultiplier);
      duration += seconds;
      joules += watts * seconds;
    }
    const totalSeconds = Math.round(duration);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor(totalSeconds % 3600 / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (minutes) parts.push(`${minutes} min`);
    if (seconds) parts.push(`${seconds} s`);
    this.setText('hudWorkoutTitle', this.currentWorkout.title || 'Loaded workout');
    this.setText('hudWorkoutDuration', hours ? this.fmtTime(totalSeconds) : parts.join(' ') || '0 min');
    this.setText('hudWorkoutAvgPower', duration > 0 ? `${Math.round(joules / duration)} W` : '--');
  }

  updateHudTitles() {
    this.updateWorkoutOverview();
    this.updateErgResponseUi();
    const iv = this.currentWorkout.intervals[this.intervalIndex];
    if (!iv) return;
    const targetW = this.getCurrentTargetWatts();
    const targetCad = this.getCurrentTargetCadence();
    const pct = Math.round(iv.pctFtp * this.ergBiasMultiplier);
    this.setText('hudIntervalName', `Interval ${this.intervalIndex + 1}: ${iv.name}`);
    this.setText('hudIntervalTargetTag', `Target: ${targetW}W (${pct}%)`);
    this.setText('hudCadenceTargetTag', `${targetCad} RPM Target`);
    this.setText('valTargetPower', targetW + 'W');
    this.setText('hudIntervalCountdown', this.fmtTime(this.intervalSecondsRemaining));
    this.updatePowerSourceBadge();

    this.setText('zenWorkoutTitle', this.currentWorkout.title || 'Active Workout');
    this.setText('zenStepIndex', `STEP ${this.intervalIndex + 1} OF ${this.currentWorkout.intervals.length}`);
    this.setText('zenStepName', iv.name);
    const zb = this.$('zenStepZoneBadge');
    if (zb) {
      const z = VeloMetrics.zoneForPct(iv.pctFtp * this.ergBiasMultiplier);
      zb.textContent = `${z.short} ${z.name}`.toUpperCase();
      zb.style.setProperty('--zc', z.color);
    }
    this.setText('zenTargetWatts', targetW + 'W');
    this.setText('zenTargetPct', `(${pct}% FTP)`);
    this.updateUpNext();
  }

  updateUpNext() {
    const nextIv = this.currentWorkout.intervals[this.intervalIndex + 1];
    if (nextIv) {
      const nextW = Math.round(this.activeProfile.ftp * (nextIv.pctFtp / 100) * this.ergBiasMultiplier);
      this.setText('zenUpNextText', `Step ${this.intervalIndex + 2}: ${nextIv.name} - ${this.fmtTime(nextIv.duration)} @ ${nextW}W (${nextIv.pctFtp}%) - ${this.getCurrentTargetCadence(this.intervalIndex + 1)} rpm`);
    } else {
      this.setText('zenUpNextText', 'Final step - bring it home.');
    }
  }

  updateHudDisplays(power, target, cadence, hr) {
    const displayPower = this.getSmoothedPower(this.smoothingWindow || 3);
    const p = this.activeProfile;
    this.setText('valInstantPower', displayPower);
    this.setText('valTargetPower', target + 'W');
    this.setText('valWkg', (displayPower / p.weightKg).toFixed(2));
    this.setText('val1sPower', this.getSmoothedPower(1) + 'W');
    this.setText('val3sPower', this.getSmoothedPower(3) + 'W');
    this.setText('val30sPower', this.getSmoothedPower(30) + 'W');

    const spd = (this.currentSpeed || 0).toFixed(1);
    const dst = (this.totalDistanceKm || 0).toFixed(2);
    this.setText('valSpeed', spd);
    this.setText('valDistance', dst);
    this.setText('hudTotalDistance', dst + ' km');
    this.setText('hudCurrentSpeed', spd + ' km/h');
    const srcTag = (s) => (s === 'KICKR SHIFT' ? 'KICKR' : s === 'VIRTUAL' ? 'VIRTUAL' : 'SIM');
    this.setText('speedSourceTag', srcTag(this.hardwareSpeedSource));
    this.setText('distSourceTag', srcTag(this.hardwareDistanceSource));

    // Cadence compliance (+/-4 rpm)
    const targetCad = this.getCurrentTargetCadence();
    const cadDiff = cadence - targetCad;
    const cadState = cadence > 0 ? (Math.abs(cadDiff) <= 4 ? 'cadence-compliant' : (cadDiff < 0 ? 'cadence-under' : 'cadence-over')) : null;
    this.setText('valCadence', cadence);
    this.setText('valCadenceSub', cadence === 0 ? `TGT: ${targetCad} RPM` : `TGT: ${targetCad} RPM (${cadDiff >= 0 ? '+' : ''}${cadDiff})`);
    ['metricCellCadence', 'zenTileCadence'].forEach(id => {
      const el = this.$(id);
      if (!el) return;
      el.classList.remove('cadence-compliant', 'cadence-under', 'cadence-over');
      if (cadState) el.classList.add(cadState);
    });

    const hrz = VeloMetrics.hrZone(hr, p.maxHr);
    this.setText('valHeartRate', hr > 0 ? hr : '--');
    this.setText('valHrZone', hr > 0 ? `${hrz.label} - ${hrz.pct}%` : '--');
    this.setText('valNormPower', this.analytics.normalizedPower);
    this.setText('valAvgPower', this.analytics.totalSeconds ? Math.round(this.analytics.totalJoules / this.analytics.totalSeconds) : 0);
    this.setText('valIntensityFactor', this.analytics.intensityFactor.toFixed(2));
    this.setText('valTss', this.analytics.tss);
    this.setText('valTotalKj', Math.round(this.analytics.totalJoules / 1000) + ' kJ');
    this.setText('hudIntervalCountdown', this.fmtTime(this.intervalSecondsRemaining));
    this.setText('hudTotalElapsed', this.fmtTime(this.totalElapsedSeconds));

    // Target compliance: +/-5 % counts as on target
    const ts = VeloMetrics.targetState(power, target, 5);
    const pill = this.$('hudCompliancePill');
    if (pill) {
      const d = `${ts.diff >= 0 ? '+' : ''}${ts.diff}W`;
      let cls, txt;
      if (ts.state === 'on') { cls = 'compliance-on'; txt = `ON TARGET (${d})`; }
      else if (ts.state === 'idle') { cls = 'compliance-idle'; txt = 'TARGET --'; }
      else { cls = Math.abs(ts.diffPct) <= 10 ? 'compliance-close' : 'compliance-off'; txt = `${ts.state === 'under' ? 'UNDER' : 'OVER'} (${d})`; }
      pill.className = `compliance-pill ${cls} num`;
      pill.textContent = txt;
    }
    const marker = this.$('targetBandMarker');
    if (marker) {
      const clamped = Math.max(-20, Math.min(20, ts.diffPct || 0));
      marker.style.left = `${50 + (clamped / 20) * 50}%`;
      marker.dataset.state = ts.state;
    }

    // L/R balance: only measured values are shown ('--' when the source does not report it)
    const lBal = Number.isFinite(this.currentLeftBal) ? this.currentLeftBal : null;
    const rBal = Number.isFinite(this.currentRightBal) ? this.currentRightBal : null;
    this.setText('balanceDataStatus', lBal === null ? 'NO DATA' : this.activePowerSource === 'SIMULATOR' ? 'SIMULATED' : 'MEASURED');
    this.setText('valLeftBalance', lBal !== null ? lBal.toFixed(1) + '%' : '--');
    this.setText('valRightBalance', rBal !== null ? rBal.toFixed(1) + '%' : '--');
    const bl = this.$('barLeftBalance'), br = this.$('barRightBalance');
    if (bl) bl.style.width = (lBal !== null ? lBal : 50) + '%';
    if (br) br.style.width = (rBal !== null ? rBal : 50) + '%';
    const leftW = lBal !== null ? Math.round(power * (lBal / 100)) : null;
    this.setText('valLeftWatts', leftW !== null ? leftW + 'W' : '--');
    this.setText('valRightWatts', leftW !== null ? (power - leftW) + 'W' : '--');

    let tip;
    if (lBal !== null && Math.abs(lBal - 50) > 3.5) tip = `${lBal > 50 ? 'Left' : 'Right'} leg dominant (${lBal.toFixed(1)} / ${(100 - lBal).toFixed(1)}). Think "pull through" on the weaker side's upstroke.`;
    else if (cadence > 0 && cadence < targetCad - 6) tip = `Cadence ${cadence} rpm is below the ${targetCad} rpm target. Spin up to spare muscular fatigue.`;
    else if (cadence > targetCad + 8) tip = `Cadence ${cadence} rpm is above target. Settle toward ${targetCad} rpm for efficiency.`;
    else if (power > 0) tip = 'Smooth and balanced. Keep a relaxed upper body and steady breathing.';
    else tip = 'Waiting for power...';
    this.setText('valBiomechFeedback', tip);

    const zInfo = this.analytics.getCurrentZoneInfo(power);
    const zBadge = this.$('currentZoneBadge');
    if (zBadge) { zBadge.textContent = `${zInfo.name.toUpperCase()} - ${zInfo.pct}%`; zBadge.style.setProperty('--zc', zInfo.color); }
    const totalActive = Math.max(1, this.analytics.totalSeconds);
    for (let i = 1; i <= 7; i++) {
      const sec = this.analytics.zoneSeconds[i - 1];
      const seg = this.$('zSeg' + i);
      if (seg) seg.style.width = (sec / totalActive) * 100 + '%';
      this.setText('zTime' + i, this.fmtTime(sec));
    }

    this.lastInstantPower = displayPower;
    this.lastCadence = cadence;
    this.lastHr = hr;
    this.updateZenHud(displayPower, target, cadence, targetCad, hr, hrz, ts);
  }

  // ------------------------------------------------------- device preview --
  /**
   * Before Start, while paused and after a ride, connected devices still show their live values
   * in the cockpit (and on the phone view). Display only: nothing is recorded, and ride totals,
   * analytics, distance and the smoothing buffer are left untouched. The simulator is never shown.
   */
  initDevicePreview() {
    const id = setInterval(() => { if (!this.isPlaying) this.devicePreviewTick(); }, 1000);
    this._disposers.push(() => clearInterval(id));
  }

  /** Live device values (same freshness rules as the ride tick), or null when none is streaming. */
  liveDeviceReadings() {
    const now = performance.now();
    const fresh = this.devicePowerFresh ? this.devicePowerFresh(now) : null;
    const pedalAlive = fresh ? fresh.pedals : (now - this.blePedal.lastTime) < 3500 && this.blePedal.watts !== null;
    const trainerAlive = fresh ? fresh.trainer : (now - this.bleTrainer.lastTime) < 3500 && this.bleTrainer.watts !== null;
    const hrAlive = (now - this.bleHr.lastTime) < 4000 && this.bleHr.hr !== null;
    const chosenCadence = this.deviceCadenceReading ? this.deviceCadenceReading(now) : null;
    if (!pedalAlive && !trainerAlive && !hrAlive && chosenCadence === null) return null;
    let power = null, cadence = null, leftBal = null;
    if (pedalAlive) {
      power = Math.max(0, Math.round(this.blePedal.watts));
      cadence = this.blePedal.cadence !== null ? this.blePedal.cadence : (trainerAlive ? this.bleTrainer.cadence : null);
      leftBal = this.blePedal.leftPct;
    } else if (trainerAlive) {
      power = Math.max(0, Math.round(this.bleTrainer.watts));
      cadence = this.bleTrainer.cadence;
    }
    if (this.deviceCadenceReading) cadence = chosenCadence;
    return { power, cadence: cadence !== null && cadence !== undefined ? Math.round(cadence) : null, hr: hrAlive ? this.bleHr.hr : null, leftBal };
  }

  devicePreviewTick() {
    const r = this.liveDeviceReadings();
    if (!r) {
      // A device stopped streaming: clear what the preview showed, once.
      if (!this._previewShown) return;
      this._previewShown = false;
      this.renderDevicePreview({ power: null, cadence: null, hr: null, leftBal: null });
      return;
    }
    this._previewShown = true;
    this.renderDevicePreview(r);
    if (this.publishSoon) this.publishSoon();
  }

  /** Writes live device values into the power / cadence / HR tiles (cockpit + zen) only. */
  renderDevicePreview({ power, cadence, hr, leftBal }) {
    const p = this.activeProfile;
    const pw = power === null ? '--' : power;
    ['valInstantPower', 'zenInstantPower'].forEach(id => this.setText(id, pw));
    ['valWkg', 'zenWkg'].forEach(id => this.setText(id, power === null ? '--' : (power / p.weightKg).toFixed(2)));
    this.setText('val1sPower', power === null ? '--' : power + 'W');
    ['valCadence', 'zenCadence'].forEach(id => this.setText(id, cadence === null ? '--' : cadence));
    const hrz = hr ? VeloMetrics.hrZone(hr, p.maxHr) : null;
    this.setText('valHeartRate', hr || '--');
    this.setText('valHrZone', hrz ? `${hrz.label} - ${hrz.pct}%` : '--');
    this.setText('zenHeartRate', hr || '--');
    this.setText('zenHrZone', hrz ? `${hrz.label} - ${hrz.pct}% of max` : '--');
    const lBal = Number.isFinite(leftBal) ? leftBal : null;
    this.setText('balanceDataStatus', lBal === null ? 'NO DATA' : 'MEASURED');
    this.setText('valLeftBalance', lBal !== null ? lBal.toFixed(1) + '%' : '--');
    this.setText('valRightBalance', lBal !== null ? (100 - lBal).toFixed(1) + '%' : '--');
    // The phone view reads these.
    this.lastInstantPower = power || 0;
    this.lastCadence = cadence || 0;
    this.lastHr = hr || 0;
    this.currentLeftBal = lBal;
    this.currentRightBal = lBal !== null ? 100 - lBal : null;
    const source = this.devicePowerFresh ? this.devicePowerFresh() : null;
    if (source) this.activePowerSource = power === null ? 'NONE' : source.pedals ? 'PEDALS' : source.trainer ? 'TRAINER' : 'NONE';
  }

  // ------------------------------------------------------------------ Zen --
  updateZenHud(displayPower, target, cadence, targetCad, hr, hrz, ts) {
    const p = this.activeProfile;
    this.setText('zenInstantPower', displayPower);
    this.setText('zenWkg', (displayPower / p.weightKg).toFixed(2));
    this.setText('zenCadence', cadence);
    const cadDiff = cadence - targetCad;
    this.setText('zenCadenceTarget', cadence === 0 ? `TGT: ${targetCad} RPM`
      : Math.abs(cadDiff) <= 4 ? `ON CADENCE (${targetCad} RPM)`
      : cadDiff < 0 ? `SPIN FASTER (${cadDiff} / ${targetCad})` : `SPIN SLOWER (+${cadDiff} / ${targetCad})`);

    // Cadence halo: arc = live cadence on a 40-130 rpm dial, band = target +/-4 rpm
    const C = 2 * Math.PI * 52;
    const D = C * 0.75; // 270-degree dial
    const frac = (v) => Math.max(0, Math.min(1, (v - 40) / 90));
    const arc = this.$('zenCadenceArc');
    if (arc) arc.style.strokeDasharray = `${(D * frac(cadence)).toFixed(1)} ${C.toFixed(1)}`;
    const band = this.$('zenCadenceBand');
    if (band) {
      const a = frac(targetCad - 4), b = frac(targetCad + 4);
      band.style.strokeDasharray = `0 ${(D * a).toFixed(1)} ${(D * (b - a)).toFixed(1)} ${C.toFixed(1)}`;
    }

    this.setText('zenHeartRate', hr > 0 ? hr : '--');
    this.setText('zenHrZone', hr > 0 ? `${hrz.label} - ${hrz.pct}% of max` : '--');
    const hm = this.$('zenHrMarker');
    if (hm) {
      const pos = hr > 0 ? Math.max(0, Math.min(1, (hrz.pct - 50) / 50)) : 0; // gauge spans 50-100 % of max HR
      hm.style.left = `${(pos * 100).toFixed(1)}%`;
      hm.dataset.zone = hrz.idx;
    }
    this.setText('zenSpeed', (this.currentSpeed || 0).toFixed(1));
    this.setText('zenTssVal', this.analytics.tss);
    this.setText('zenNpVal', this.analytics.normalizedPower + 'W');
    this.setText('zenCountdown', this.fmtTime(this.intervalSecondsRemaining));
    this.setText('zenTotalElapsed', this.fmtTime(this.totalElapsedSeconds));
    const curIv = this.currentWorkout.intervals[this.intervalIndex];
    if (curIv) {
      const ivDur = curIv.duration || 60;
      const prog = this.$('zenProgressFill');
      if (prog) prog.style.width = Math.min(100, Math.max(0, ((ivDur - this.intervalSecondsRemaining) / ivDur) * 100)) + '%';
    }

    // Dynamic halo: lime on target (+/-5 %), amber under, cyan over; glow scales with the error.
    const card = this.$('zenPowerCard');
    const pill = this.$('zenDiffPill');
    if (card && pill) {
      let cc, pc, txt;
      if (ts.state === 'on' || ts.state === 'idle') { cc = 'zen-compliant'; pc = 'pill-on'; txt = `ON TARGET (${ts.diff >= 0 ? '+' : ''}${ts.diff}W)`; }
      else if (ts.state === 'under') { cc = 'zen-under'; pc = 'pill-under'; txt = `PUSH HARDER (${ts.diff}W)`; }
      else { cc = 'zen-over'; pc = 'pill-over'; txt = `HIGH POWER (+${ts.diff}W)`; }
      card.className = `zen-power-card ${cc}`;
      pill.className = `zen-diff-pill ${pc} num`;
      pill.textContent = txt;
      card.style.setProperty('--halo-strength', Math.min(1, 0.4 + Math.abs(ts.diffPct || 0) / 25).toFixed(2));
    }
    if (this.isZenMode) {
      this.updateUpNext();
      this.renderZenIntervalTrack();
    }
  }

  toggleZenMode() {
    this.isZenMode = !this.isZenMode;
    const overlay = this.$('zenCockpitOverlay');
    if (this.isZenMode) {
      if (overlay) {
        overlay.style.display = 'flex';
        overlay.classList.toggle('no-cad-halo', !this.zenCadenceHalo);
        requestAnimationFrame(() => overlay.classList.add('visible'));
      }
      document.body.classList.add('zen-mode');
      this.$('btnToggleZenMode')?.classList.add('active');
      this.$('btnHeaderZenMode')?.classList.add('zen-active');
      this.updateHudTitles();
      this.updatePlaybackControlsUi();
      this.updateHudDisplays(this.currentPower || 0, this.getCurrentTargetWatts(), this.lastCadence || 0, this.lastHr || 0);
      this.setText('zenTotalDuration', this.fmtTime(this.currentWorkout.intervals.reduce((a, b) => a + (b.duration || 0), 0)));
      this.renderZenIntervalTrack();
    } else {
      if (overlay) { overlay.classList.remove('visible'); overlay.style.display = 'none'; }
      document.body.classList.remove('zen-mode');
      this.$('btnToggleZenMode')?.classList.remove('active');
      this.$('btnHeaderZenMode')?.classList.remove('zen-active');
      this.renderIntervalTrack();
    }
  }

  toggleZenCadenceHalo() {
    this.zenCadenceHalo = !this.zenCadenceHalo;
    this.$('zenCockpitOverlay')?.classList.toggle('no-cad-halo', !this.zenCadenceHalo);
    this.$('btnZenCadenceHalo')?.classList.toggle('active', this.zenCadenceHalo);
    try { localStorage.setItem('apex_zen_cad_halo', this.zenCadenceHalo ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  }

  toggleFocusMode() {
    const isFocus = document.body.classList.toggle('focus-mode');
    this.$('btnToggleFocusMode')?.classList.toggle('active', isFocus);
    requestAnimationFrame(() => {
      this.trackCache.key = '';
      this.renderIntervalTrack();
      if (this.telemetryChart) this.telemetryChart.resize();
    });
  }

  // ------------------------------------------------- interval track (canvas) --
  /**
   * Redraws the interval track and the upcoming queue. The bar layer is cached in an
   * offscreen canvas; the 60 fps loop only composites it and draws the moving playhead.
   */
  renderIntervalTrack() {
    this.updateWorkoutOverview();
    this._trackRenderKey = this.intervalTrackRenderKey();
    this.drawIntervalTrack(true);
    this.renderUpcomingIntervals();
    if (this.isZenMode) this.renderZenIntervalTrack();
  }

  /** What the interval track and queue depend on (besides the countdown). */
  intervalTrackRenderKey() {
    const iv = (this.currentWorkout && this.currentWorkout.intervals) || [];
    return `${this.intervalIndex}|${iv.length}|${this.ergBiasMultiplier}|${this.activeProfile && this.activeProfile.ftp}|${this.isZenMode}`;
  }

  /** Once a second between steps: the live card's countdown (the rAF loop draws the playhead). */
  updateIntervalCountdown() {
    const el = this.$('upcomingCardsContainer')?.querySelector('.upcoming-card.active .upcoming-card-dur');
    if (el) el.textContent = `${this.fmtTime(this.intervalSecondsRemaining)} left`;
    if (!this.isPlaying) this.drawIntervalTrack(false);
    if (this.isZenMode) this.renderZenIntervalTrack();
  }

  intervalTrackKey(w, h) {
    const iv = this.currentWorkout.intervals;
    return `${w}x${h}@${window.devicePixelRatio || 1}|${this.intervalIndex}|${this.ergBiasMultiplier}|${this.activeProfile.ftp}|${iv.map(i => i.duration + ':' + i.pctFtp).join(',')}`;
  }

  drawIntervalTrack(force = false) {
    const canvas = this.$('intervalCanvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const w = Math.round(rect.width), h = Math.round(rect.height);
    if (w < 2 || h < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const key = this.intervalTrackKey(w, h);
    if (force || key !== this.trackCache.key || !this.trackCache.canvas) {
      this.trackCache.key = key;
      this.trackCache.canvas = this.buildIntervalLayer(w, h, dpr);
    }
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.trackCache.canvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const intervals = this.currentWorkout.intervals;
    const total = intervals.reduce((a, iv) => a + iv.duration, 0) || 1;
    let before = 0;
    for (let i = 0; i < Math.min(this.intervalIndex, intervals.length); i++) before += intervals[i].duration;
    const cur = intervals[this.intervalIndex];
    let progress = cur ? before + Math.max(0, cur.duration - this.intervalSecondsRemaining) : total;
    if (this.isPlaying && cur) progress += this.clock.subSecondProgress(); // sub-second interpolation -> smooth motion
    const x = Math.min(w - 1, Math.max(1, (progress / total) * w));

    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(0, 0, x, h);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(34, 211, 238, 0.9)';
    ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 6); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  buildIntervalLayer(w, h, dpr) {
    const layer = document.createElement('canvas');
    layer.width = Math.round(w * dpr);
    layer.height = Math.round(h * dpr);
    const ctx = layer.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const intervals = this.currentWorkout.intervals;
    const total = intervals.reduce((a, iv) => a + iv.duration, 0) || 1;
    const maxPct = Math.max(...intervals.map(iv => iv.pctFtp * this.ergBiasMultiplier));
    const scaleMax = Math.max(140, Math.min(220, maxPct * 1.12));
    const plotH = h - 4;

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
    ctx.lineWidth = 1;
    [50, 75, 125].forEach(p => {
      const y = Math.round(h - (p / scaleMax) * plotH) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    });

    let x = 0;
    this._trackHitboxes = [];
    intervals.forEach((iv, idx) => {
      const bw = (iv.duration / total) * w;
      const pct = iv.pctFtp * this.ergBiasMultiplier;
      const bh = Math.max(3, Math.min(plotH, (pct / scaleMax) * plotH));
      const y = h - bh;
      const color = VeloMetrics.zoneForPct(pct).color;
      const gap = bw > 4 ? 1.5 : 0;
      const isCur = idx === this.intervalIndex;
      ctx.globalAlpha = idx < this.intervalIndex ? 0.28 : (isCur ? 1 : 0.72);
      const grad = ctx.createLinearGradient(0, y, 0, h);
      grad.addColorStop(0, color);
      grad.addColorStop(1, color + '55');
      ctx.fillStyle = grad;
      const r = Math.max(0, Math.min(3, bw / 2 - gap));
      this.roundRectTop(ctx, x + gap / 2, y, Math.max(0.5, bw - gap), bh, r);
      ctx.fill();
      if (isCur) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5;
        this.roundRectTop(ctx, x + gap / 2 + 0.75, y + 0.75, Math.max(0.5, bw - gap - 1.5), bh - 0.75, r);
        ctx.stroke();
      }
      this._trackHitboxes.push({ x0: x, x1: x + bw, idx });
      x += bw;
    });
    ctx.globalAlpha = 1;

    const ftpY = Math.round(h - (100 / scaleMax) * plotH) + 0.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, ftpY); ctx.lineTo(w, ftpY); ctx.stroke();
    ctx.setLineDash([]);
    const label = `FTP ${Math.round(this.activeProfile.ftp * this.ergBiasMultiplier)}W`;
    ctx.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
    const lw = ctx.measureText(label).width + 10;
    ctx.fillStyle = 'rgba(9, 13, 22, 0.9)';
    ctx.fillRect(w - lw - 6, ftpY - 8, lw, 16);
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.6)';
    ctx.strokeRect(w - lw - 5.5, ftpY - 7.5, lw - 1, 15);
    ctx.fillStyle = '#fbbf24';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, w - lw - 1, ftpY);
    return layer;
  }

  roundRectTop(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
  }

  intervalAtCanvasX(clientX) {
    const canvas = this.$('intervalCanvas');
    if (!canvas || !this._trackHitboxes) return null;
    const x = clientX - canvas.getBoundingClientRect().left;
    const hit = this._trackHitboxes.find(b => x >= b.x0 && x < b.x1);
    return hit ? hit.idx : null;
  }

  renderUpcomingIntervals() {
    const container = this.$('upcomingCardsContainer');
    if (!container) return;
    const intervals = this.currentWorkout?.intervals || [];
    const ftp = this.activeProfile ? this.activeProfile.ftp : 185;
    this.setText('upcomingQueueCount', `${intervals.length} Steps (${Math.min(this.intervalIndex + 1, intervals.length)}/${intervals.length})`);
    this.setText('upcomingProfileFtp', Math.round(ftp * this.ergBiasMultiplier));

    container.innerHTML = intervals.map((iv, idx) => {
      const isActive = idx === this.intervalIndex;
      const isPast = idx < this.intervalIndex;
      const targetW = Math.round(ftp * (iv.pctFtp / 100) * this.ergBiasMultiplier);
      const pct = Math.round(iv.pctFtp * this.ergBiasMultiplier);
      const z = VeloMetrics.zoneForPct(pct);
      const dur = isActive ? `${this.fmtTime(this.intervalSecondsRemaining)} left` : this.fmtTime(iv.duration);
      return `
        <button type="button" class="upcoming-card ${isActive ? 'active' : (isPast ? 'past' : '')}" data-idx="${idx}" style="--zc:${z.color}" title="Step ${idx + 1}: ${VeloApp.esc(iv.name)} - click to jump">
          <div class="upcoming-card-header">
            <span class="upcoming-card-step num">#${idx + 1}${isActive ? ' LIVE' : (isPast ? ' DONE' : '')}</span>
            <span class="upcoming-card-zone zone-${z.key}">${z.short}</span>
          </div>
          <div class="upcoming-card-name">${VeloApp.esc(iv.name)}</div>
          <div class="upcoming-card-power num">${targetW}W <small>${pct}% FTP</small></div>
          <div class="upcoming-card-footer">
            <span class="num upcoming-card-dur">${dur}</span>
            <span class="upcoming-cadence-pill num" title="Target cadence">${this.getCurrentTargetCadence(idx)} rpm</span>
          </div>
        </button>`;
    }).join('');
    const active = container.querySelector('.upcoming-card.active');
    if (active && this.isPlaying && !this._queueHover) {
      const left = active.offsetLeft - container.clientWidth / 2 + active.clientWidth / 2;
      if (Math.abs(container.scrollLeft - left) > 4) container.scrollTo({ left, behavior: 'smooth' });
    }
  }

  renderZenIntervalTrack() {
    const canvas = this.$('zenIntervalCanvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || 260, h = rect.height || 36;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ivs = this.currentWorkout.intervals || [];
    const totalSec = ivs.reduce((a, iv) => a + (iv.duration || 0), 0) || 1;
    const maxPct = Math.max(130, ...ivs.map(iv => iv.pctFtp || 0)) * 1.1;
    let x = 0;
    ivs.forEach((iv, idx) => {
      const bw = (iv.duration / totalSec) * w;
      const bh = Math.max(4, ((iv.pctFtp || 50) / maxPct) * (h - 4));
      ctx.fillStyle = VeloMetrics.zoneForPct(iv.pctFtp).color;
      ctx.globalAlpha = idx === this.intervalIndex ? 1 : (idx < this.intervalIndex ? 0.25 : 0.55);
      ctx.fillRect(x, h - bh, Math.max(1, bw - 1), bh);
      x += bw;
    });
    ctx.globalAlpha = 1;
    let before = 0;
    for (let i = 0; i < Math.min(this.intervalIndex, ivs.length); i++) before += ivs[i].duration;
    const cur = ivs[this.intervalIndex];
    const prog = cur ? before + (cur.duration - this.intervalSecondsRemaining) : totalSec;
    const cx = Math.min(w - 1, (prog / totalSec) * w);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
  }

  // ------------------------------------------------------- render loop --
  /** One rAF loop for the playhead and the diagnostics drawer. Idles when hidden. */
  start60FpsLoop() {
    let lastPanel = 0;
    const loop = (time) => {
      this.animFrameId = requestAnimationFrame(loop);
      if (document.hidden) return;

      if (this.activeTab === 'cockpit' && !this.isZenMode && this.isPlaying) this.drawIntervalTrack(false);
      if (time - lastPanel > 500) {
        lastPanel = time;
        if (this.$('hardwareModal')?.classList.contains('open')) this.updateHardwarePanel();
      }
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  /** Releases timers, the clock worker, observers, charts and listeners. */
  destroy() {
    cancelAnimationFrame(this.animFrameId);
    this.releaseWakeLock();
    if (this.stopRemoteView) this.stopRemoteView();
    clearTimeout(this._backupTimer);
    clearTimeout(this._stravaAutoTimer);
    clearInterval(this._fanAutoTimer);
    if (this.ble?.destroy) this.ble.destroy();
    this.clock.destroy();
    this._disposers.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } });
    this._disposers = [];
    [this.telemetryChart, this.pmcChart, this.mmpChart, this.ftpChart, this.driftChart, this.currentScrubChart, this.progWeeklyChart, this.progScatterChart, this.efChart, this.recoveryChart, this.balanceChart, this.cpHistoryChart]
      .forEach(c => { if (c) c.destroy(); });
    if (this.destroyReviewCharts) this.destroyReviewCharts();
    if (this._resizeObserver) this._resizeObserver.disconnect();
  }

  // ---------------------------------------------------------- navigation --
  switchTab(tabKey) {
    const btn = document.querySelector(`.nav-btn[data-tab="${tabKey}"]`);
    if (!btn) return;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-view').forEach(v => v.classList.toggle('active', v.id === 'view-' + tabKey));
    this.activeTab = tabKey;
    this.handleTabSwitched(tabKey);
  }

  handleTabSwitched(tabKey) {
    if (tabKey === 'calendar') this.renderCalendarView();
    else if (tabKey === 'ai-coach') { this.updateAiCoachTelemetry(); if (this.renderTrainingBlock) this.renderTrainingBlock(); }
    else if (tabKey === 'ask') { if (this.onAskTab) this.onAskTab(); }
    else if (tabKey === 'analytics') {
      requestAnimationFrame(() => {
        this.refreshAnalytics();
        [this.pmcChart, this.mmpChart, this.ftpChart, this.driftChart, this.progWeeklyChart, this.progScatterChart, this.efChart, this.recoveryChart, this.balanceChart, this.cpHistoryChart].forEach(c => c && c.resize());
      });
    } else if (tabKey === 'cockpit') {
      requestAnimationFrame(() => {
        this.trackCache.key = '';
        this.renderIntervalTrack();
        if (this.telemetryChart) this.telemetryChart.resize();
      });
    } else if (tabKey === 'workouts') {
      requestAnimationFrame(() => this.renderWorkoutCatalog(this.currentCatalogFilter || 'all', this.currentCatalogSearch || ''));
    }
  }

  // ---------------------------------------------------------------- DOM --
  initDoms() {
    document.querySelectorAll('.nav-btn').forEach(btn => this.on(btn, 'click', () => this.switchTab(btn.dataset.tab)));

    // Profiles
    this.on(this.$('headerProfileSelect'), 'change', (e) => {
      if (e.target.value === '__manage__') { this.openModal('profileManagerModal'); e.target.value = this.activeProfileId; }
      else this.setActiveProfile(e.target.value);
    });
    this.on(this.$('btnManageProfiles'), 'click', () => this.openModal('profileManagerModal'));
    this.on(this.$('cockpitRiderBadge'), 'click', () => this.openModal('profileManagerModal'));
    this.on(this.$('btnCloseProfileModal'), 'click', () => this.closeModal('profileManagerModal'));
    this.on(this.$('btnCancelEditProfile'), 'click', () => this.cancelEditProfile());
    this.on(this.$('btnSaveNewProfile'), 'click', () => this.saveProfileFromInputs());
    this.on(this.$('profileListContainer'), 'click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'select') this.setActiveProfile(b.dataset.id);
      else if (b.dataset.act === 'edit') this.populateEditProfile(b.dataset.id);
      else if (b.dataset.act === 'delete') this.deleteProfile(b.dataset.id);
    });

    // Workout library (delegated)
    this.on(this.$('workoutCardsContainer'), 'click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act) {
        e.stopPropagation();
        if (act.dataset.act === 'load') this.loadWorkoutIntoCockpit(act.dataset.id);
        else if (act.dataset.act === 'delete') this.deleteWorkout(act.dataset.id);
        return;
      }
      const card = e.target.closest('.workout-preset-card');
      if (card) this.selectWorkoutById(card.dataset.id);
    });
    document.querySelectorAll('.cat-pill').forEach(pill => this.on(pill, 'click', () => {
      document.querySelectorAll('.cat-pill').forEach(p => p.classList.toggle('active', p === pill));
      this.renderWorkoutCatalog(pill.dataset.cat, this.$('searchWorkoutsInput')?.value || '');
    }));
    this.on(this.$('searchWorkoutsInput'), 'input', (e) => {
      this.renderWorkoutCatalog(document.querySelector('.cat-pill.active')?.dataset?.cat || 'all', e.target.value);
    });
    this.on(this.$('btnGoToCoach'), 'click', () => this.switchTab('ai-coach'));

    // Custom interval table (delegated)
    const tbody = this.$('customIntervalTableBody');
    this.on(tbody, 'change', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const iv = this.currentWorkout.intervals[idx];
      if (!iv) return;
      if (e.target.classList.contains('tbl-iv-name')) iv.name = e.target.value;
      else if (e.target.classList.contains('tbl-iv-pct')) iv.pctFtp = Math.max(20, Math.min(300, parseFloat(e.target.value) || iv.pctFtp));
      else if (e.target.classList.contains('tbl-iv-dur')) {
        iv.duration = Math.max(5, parseInt(e.target.value, 10) || iv.duration);
        if (idx === this.intervalIndex) this.intervalSecondsRemaining = Math.min(this.intervalSecondsRemaining, iv.duration);
      }
      this.renderIntervalTrack();
      this.populateCustomIntervalTable();
      this.updateHudTitles();
    });
    this.on(tbody, 'click', (e) => {
      const b = e.target.closest('[data-remove]');
      if (b) this.removeInterval(parseInt(b.dataset.remove, 10));
    });
    this.on(this.$('btnAddIntervalRow'), 'click', () => {
      this.currentWorkout.intervals.push({ name: 'New Step', duration: 180, pctFtp: 90 });
      this.renderIntervalTrack();
      this.populateCustomIntervalTable();
    });
    this.on(this.$('btnSaveCustomAsPreset'), 'click', () => {
      const title = prompt('Preset name:', this.currentWorkout.title || 'My Custom Workout');
      if (title && title.trim()) {
        const custom = JSON.parse(JSON.stringify(this.currentWorkout));
        custom.id = 'custom_' + Date.now();
        custom.title = title.trim();
        custom.category = 'custom';
        const load = VeloAiCoach.estimateLoad(custom.intervals);
        Object.assign(custom, { durationMin: load.durationMin, tss: load.tss, if: load.if });
        this.saveWorkoutPermanently(custom);
      }
    });

    // Playback
    this.on(this.$('btnPlayPause'), 'click', () => this.togglePlayPause());
    this.on(this.$('btnEndWorkout'), 'click', () => this.finishWorkout());
    this.on(this.$('btnResetWorkout'), 'click', () => this.resetWorkout(true));
    // The browser drops a wake lock when the tab is hidden; take it back when the rider returns.
    this.on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible' && this.isPlaying) this.acquireWakeLock(); });
    // Closing or reloading the tab mid-ride would lose the ride: ask first.
    this.on(window, 'beforeunload', (e) => { if (this.hasUnsavedRide()) { e.preventDefault(); e.returnValue = ''; } });
    this.on(this.$('btnSkipInterval'), 'click', () => this.skipInterval());
    this.on(this.$('btnExtendInterval'), 'click', () => this.adjustIntervalDuration(30));
    this.on(this.$('btnShortenInterval'), 'click', () => this.adjustIntervalDuration(-30));
    this.on(this.$('upcomingCardsContainer'), 'click', (e) => {
      const card = e.target.closest('.upcoming-card');
      if (card) this.jumpToInterval(parseInt(card.dataset.idx, 10));
    });
    this.on(this.$('upcomingCardsContainer'), 'pointerenter', () => { this._queueHover = true; });
    this.on(this.$('upcomingCardsContainer'), 'pointerleave', () => { this._queueHover = false; });

    // Interval canvas: hover tooltip + click to jump
    const trackCanvas = this.$('intervalCanvas');
    const tip = this.$('intervalHoverTip');
    this.on(trackCanvas, 'pointermove', (e) => {
      const idx = this.intervalAtCanvasX(e.clientX);
      if (idx === null || !tip) { if (tip) tip.hidden = true; return; }
      const iv = this.currentWorkout.intervals[idx];
      const pct = Math.round(iv.pctFtp * this.ergBiasMultiplier);
      const z = VeloMetrics.zoneForPct(pct);
      tip.innerHTML = `<b>#${idx + 1} ${VeloApp.esc(iv.name)}</b><span class="num">${Math.round(this.activeProfile.ftp * pct / 100)}W &middot; ${pct}% &middot; ${this.fmtTime(iv.duration)}</span><span class="tip-zone" style="--zc:${z.color}">${z.short} ${z.name}</span>`;
      tip.hidden = false;
      const wrapRect = this.$('intervalTrackWrap').getBoundingClientRect();
      tip.style.left = `${Math.max(90, Math.min(wrapRect.width - 90, e.clientX - wrapRect.left))}px`;
    });
    this.on(trackCanvas, 'pointerleave', () => { if (tip) tip.hidden = true; });
    this.on(trackCanvas, 'click', (e) => {
      const idx = this.intervalAtCanvasX(e.clientX);
      if (idx !== null) this.jumpToInterval(idx);
    });

    // Simulator
    this.on(this.$('simToggleBtn'), 'click', () => {
      this.simulator.enabled = !this.simulator.enabled;
      this.$('simToggleBtn')?.classList.toggle('active', this.simulator.enabled);
      this.updatePowerSourceBadge();
      this.showToast(this.simulator.enabled ? 'Simulator on (used only when no hardware streams).' : 'Simulator off - live hardware only.');
    });

    // Smoothing pills (one delegated handler per group; cockpit and Zen stay in sync)
    document.querySelectorAll('.power-smoothing-pills').forEach(group => this.on(group, 'click', (e) => {
      const pill = e.target.closest('.smooth-pill');
      if (pill) this.setSmoothingWindow(parseInt(pill.dataset.sec, 10) || 3);
    }));

    // Bluetooth
    this.on(this.$('btnBleFtms'), 'click', () => this.connectDevice('trainer'));
    this.on(this.$('btnBlePedals'), 'click', () => this.connectDevice('pedals'));
    this.on(this.$('btnBleHr'), 'click', () => this.connectDevice('hr'));
    this.on(this.$('btnConnectPedalsModal'), 'click', () => this.connectSavedDevice ? this.connectSavedDevice('pedals') : this.connectDevice('pedals'));
    this.on(this.$('btnConnectPedalsAllModal'), 'click', () => this.connectDevice('pedals', { acceptAll: true }));
    this.on(this.$('btnConnectTrainerModal'), 'click', () => this.connectSavedDevice ? this.connectSavedDevice('trainer') : this.connectDevice('trainer'));
    this.on(this.$('btnConnectTrainerAllModal'), 'click', () => this.connectDevice('trainer', { acceptAll: true }));
    this.on(this.$('btnConnectHrModal'), 'click', () => this.connectSavedDevice ? this.connectSavedDevice('hr') : this.connectDevice('hr'));
    this.on(this.$('btnConnectHrAllModal'), 'click', () => this.connectDevice('hr', { acceptAll: true }));
    this.on(this.$('btnCalibratePedalsModal'), 'click', () => this.calibrateAssiomaPedals());
    this.on(this.$('chkEnablePowerMatch'), 'change', (e) => {
      this.powerMatchEnabled = e.target.checked;
      this.powerMatchOffset = 0;
      this.erg.offset = 0;
      this.updatePowerSourceBadge();
      this.showToast(this.powerMatchEnabled ? 'PowerMatch enabled.' : 'PowerMatch disabled.');
    });
    this.on(this.$('btnOpenHardwareModal'), 'click', () => this.openHardwareLab());
    this.on(this.$('btnCloseHardwareModal'), 'click', () => this.closeModal('hardwareModal'));
    this.on(this.$('btnCloseHardwareBtn'), 'click', () => this.closeModal('hardwareModal'));
    this.on(this.$('hudErgStatusPill'), 'click', () => this.toggleErgMode());

    // ERG bias
    try {
      const saved = localStorage.getItem('apex_erg_response');
      if (['auto', 'steady', 'responsive'].includes(saved)) this.ergResponse = saved;
    } catch (e) { /* optional preference */ }
    this.on(this.$('ergResponse'), 'change', (e) => this.setErgResponse(e.target.value));
    [['btnBiasMinus5', -0.05], ['btnBiasMinus1', -0.01], ['btnBiasPlus1', 0.01], ['btnBiasPlus5', 0.05],
     ['btnZenBiasMinus5', -0.05], ['btnZenBiasMinus1', -0.01], ['btnZenBiasPlus1', 0.01], ['btnZenBiasPlus5', 0.05]]
      .forEach(([id, d]) => this.on(this.$(id), 'click', () => this.setErgBias(d)));
    this.on(this.$('btnStand'), 'click', () => this.toggleStand());
    this.on(this.$('btnBiasReset'), 'click', () => { this.ergBiasMultiplier = 1.0; this.updateBiasUi(); this.updateHudTitles(); });

    // Header tools
    this.on(this.$('btnToggleAudio'), 'click', () => this.audio.toggleMute());
    this.on(this.$('btnToggleFullscreen'), 'click', () => this.toggleFullscreen());
    this.on(document, 'fullscreenchange', () => this.$('btnToggleFullscreen')?.classList.toggle('active', !!document.fullscreenElement));
    this.on(this.$('btnShowShortcuts'), 'click', () => this.openModal('shortcutsModal'));
    this.on(this.$('btnCloseShortcutsModal'), 'click', () => this.closeModal('shortcutsModal'));
    this.on(this.$('btnCloseShortcutsBtn'), 'click', () => this.closeModal('shortcutsModal'));
    this.on(this.$('btnTogglePip'), 'click', () => this.pip.toggle());
    this.on(this.$('btnToggleFocusMode'), 'click', () => this.toggleFocusMode());

    // Zen
    this.on(this.$('btnToggleZenMode'), 'click', () => this.toggleZenMode());
    this.on(this.$('btnHeaderZenMode'), 'click', () => this.toggleZenMode());
    this.on(this.$('btnCloseZenCockpit'), 'click', () => this.toggleZenMode());
    this.on(this.$('btnZenPlayPause'), 'click', () => this.togglePlayPause());
    this.on(this.$('btnZenSkipStep'), 'click', () => this.skipInterval());
    this.on(this.$('btnZenCadenceHalo'), 'click', () => this.toggleZenCadenceHalo());
    try { this.zenCadenceHalo = localStorage.getItem('apex_zen_cad_halo') !== '0'; } catch (e) { /* ignore */ }
    this.$('btnZenCadenceHalo')?.classList.toggle('active', this.zenCadenceHalo);

    this.on(this.$('btnCloseModal'), 'click', () => this.closeModal('rideSummaryModal'));
    document.querySelectorAll('.modal-overlay').forEach(modal => this.on(modal, 'click', (e) => {
      if (e.target === modal) this.closeModal(modal.id);
    }));

    // Rebuild the DPR-sensitive interval layer on resize (coalesced per frame)
    if (typeof ResizeObserver !== 'undefined') {
      let pending = false;
      this._resizeObserver = new ResizeObserver(() => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          this.trackCache.key = '';
          this.drawIntervalTrack(true);
        });
      });
      const wrap = this.$('intervalTrackWrap');
      if (wrap) this._resizeObserver.observe(wrap);
    }

    this.initHistoryDom();
  }

  openHardwareLab() {
    this.updatePowerSourceBadge();
    this.openModal('hardwareModal');
    this.updateHardwarePanel();
    if (this.openDevicesFocus) this.openDevicesFocus();
  }

  toggleErgMode() {
    this.ergModeEnabled = !this.ergModeEnabled;
    this.erg.reset();
    this.powerMatchOffset = 0;
    this.ergApplyNow(true);
    this.updatePowerSourceBadge();
    this.showToast(this.ergModeEnabled ? 'ERG on - the trainer holds target power.' : 'ERG off - free resistance; targets are guidance only.');
  }

  populateCustomIntervalTable() {
    const tbody = this.$('customIntervalTableBody');
    if (!tbody) return;
    const ftp = this.activeProfile.ftp;
    tbody.innerHTML = this.currentWorkout.intervals.map((iv, i) => {
      const z = VeloMetrics.zoneForPct(iv.pctFtp);
      return `
        <tr${i === this.intervalIndex ? ' class="row-active"' : ''}>
          <td class="num">${i + 1}</td>
          <td><input type="text" value="${VeloApp.esc(iv.name)}" class="tbl-input tbl-iv-name" data-idx="${i}"></td>
          <td><input type="number" value="${iv.pctFtp}" class="tbl-input tbl-iv-pct num" data-idx="${i}" min="20" max="300"></td>
          <td><span class="zone-dot" style="--zc:${z.color}"></span><strong class="num">${Math.round(ftp * iv.pctFtp / 100)}W</strong> <small>${z.short}</small></td>
          <td><input type="number" value="${iv.duration}" class="tbl-input tbl-iv-dur num" data-idx="${i}" min="5" step="5"></td>
          <td><button type="button" class="icon-btn icon-btn-danger" data-remove="${i}" title="Remove step"><svg class="ic"><use href="#i-x"/></svg></button></td>
        </tr>`;
    }).join('');
  }

  removeInterval(idx) {
    if (this.currentWorkout.intervals.length <= 1) return;
    this.currentWorkout.intervals.splice(idx, 1);
    if (this.intervalIndex >= this.currentWorkout.intervals.length) this.intervalIndex = this.currentWorkout.intervals.length - 1;
    this.renderIntervalTrack();
    this.populateCustomIntervalTable();
  }

  initKeyboardShortcuts() {
    this.on(window, 'keydown', (e) => {
      // Devices controls keep normal Tab, Space and arrow behavior. Ride shortcuts
      // must never change resistance or skip steps while a dialog is being used.
      if (document.querySelector('.modal-overlay.open') && e.code !== 'Escape') return;
      const tag = e.target.tagName ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Tab' || ((tag === 'button' || tag === 'summary') && ['Space', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowRight'].includes(e.code))) return;
      if (['Space','ArrowUp','ArrowDown','ArrowRight','KeyS'].includes(e.code) && this.activeTab !== 'cockpit' && !this.isZenMode) return;
      switch (e.code) {
        case 'Space': e.preventDefault(); this.togglePlayPause(); break;
        case 'ArrowUp': e.preventDefault(); this.setErgBias(e.shiftKey ? 0.05 : 0.01); break;
        case 'ArrowDown': e.preventDefault(); this.setErgBias(e.shiftKey ? -0.05 : -0.01); break;
        case 'ArrowRight': e.preventDefault(); this.skipInterval(); break;
        case 'KeyF': e.preventDefault(); this.toggleFullscreen(); break;
        case 'KeyP': e.preventDefault(); this.pip.toggle(); break;
        case 'KeyM': e.preventDefault(); this.audio.toggleMute(); break;
        case 'KeyS': e.preventDefault(); this.toggleStand(); break;
        case 'KeyZ': e.preventDefault(); this.toggleZenMode(); break;
        case 'KeyC': if (this.isZenMode) { e.preventDefault(); this.toggleZenCadenceHalo(); } break;
        case 'KeyH':
          e.preventDefault();
          if (this.$('hardwareModal')?.classList.contains('open')) this.closeModal('hardwareModal'); else this.openHardwareLab();
          break;
        case 'Slash': if (e.shiftKey) { e.preventDefault(); this.openModal('shortcutsModal'); } break;
        case 'Escape':
          if (this.isZenMode) { e.preventDefault(); this.toggleZenMode(); return; }
          document.querySelectorAll('.modal-overlay.open').forEach(m => this.closeModal(m.id));
          if (document.body.classList.contains('focus-mode')) this.toggleFocusMode();
          break;
        default: break;
      }
    });
  }

  /** Cycling records only (non-cycling Strava activities stay out of power/fitness analytics). */
  cyclingRides() { return (this.completedWorkouts || []).filter(r => VeloMetrics.isCycling(r)); }

  /** PMC options (strength load toggles); defaults when the Strava sync module is absent. */
  pmcOpts() { return this.pmcOptions ? this.pmcOptions() : {}; }

  // --------------------------------------------------------- persistence --
  loadHistory() {
    try {
      if (localStorage.getItem('apex_velo_healthfit_resynced_v4')) {
        const raw = localStorage.getItem('apex_velo_history');
        if (raw !== null) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed;
        }
      }
    } catch (e) { /* ignore */ }
    try { localStorage.setItem('apex_velo_healthfit_resynced_v4', 'true'); } catch (e) { /* ignore */ }
    if (typeof DIVAN_HEALTHFIT_DATA !== 'undefined' && Array.isArray(DIVAN_HEALTHFIT_DATA.rides) && DIVAN_HEALTHFIT_DATA.rides.length) {
      const synced = DIVAN_HEALTHFIT_DATA.rides.map(r => ({ ...r, profileName: 'Divan (HealthFit)' }));
      try { localStorage.setItem('apex_velo_history', JSON.stringify(synced)); } catch (e) { /* ignore */ }
      return synced;
    }
    return [];
  }

  /**
   * Mirrors the ride list into localStorage. Full sample streams quickly exceed the ~5 MB quota,
   * so on quota errors only summaries are kept there (the samples stay in IndexedDB).
   */
  persistHistoryLocal() {
    try {
      localStorage.setItem('apex_velo_history', JSON.stringify(this.completedWorkouts));
      return true;
    } catch (e) {
      try {
        localStorage.setItem('apex_velo_history', JSON.stringify(this.completedWorkouts.map(({ samples, ...rest }) => rest)));
        return true;
      } catch (e2) {
        console.warn('Could not mirror ride history to localStorage', e2);
        return false;
      }
    }
  }

  async saveHistory() {
    const local = this.persistHistoryLocal();
    // Re-check the training block against the rides (new ride, import, sync) before the calendar redraws.
    if (this.reviewTrainingBlock) this.reviewTrainingBlock({ announce: true });
    const db = await VeloDB.saveRidesBatch(this.completedWorkouts);
    if (!db && !this.dbWriteWarned) {
      this.dbWriteWarned = true;
      this.showToast(local
        ? 'Could not write to the ride database - summaries are saved, but export important rides (FIT) as a backup.'
        : 'Could not save ride history in this browser. Export the ride (FIT) before closing the page.', 'error');
    }
    this.renderCalendarView();
    this.updateHeroStats();
    if (this.scheduleAutoBackup) this.scheduleAutoBackup();
  }

  async initIndexedDb() {
    try {
      if (localStorage.getItem('apex_velo_history') === '[]') {
        await VeloDB.clearAllRides();
        return;
      }
      const dbRides = await VeloDB.getAllRides();
      if (dbRides === null) {
        // Unreadable (not empty): do not write anything back, or stored samples could be overwritten.
        console.warn('Ride database could not be read; leaving it untouched.');
        this.showToast('Could not read the ride database - your stored rides are untouched. Reload the page to try again.', 'warning');
        return;
      }
      if (dbRides.length) {
        const byId = new Map(this.completedWorkouts.map(r => [r.id, r]));
        let changed = 0;
        dbRides.forEach(r => {
          const existing = byId.get(r.id);
          if (!existing) { this.completedWorkouts.push(r); changed++; }
          else if (!existing.samples && r.samples && r.samples.length) { existing.samples = r.samples; changed++; }
        });
        if (changed) {
          this.renderHistoryTable();
          this.recalculatePmc();
          if (this.reviewTrainingBlock) this.reviewTrainingBlock({ announce: false });
          this.renderCalendarView();
          this.updateHeroStats();
          this.refreshAnalytics();
        }
      } else if (this.completedWorkouts.length) {
        await VeloDB.saveRidesBatch(this.completedWorkouts);
      }
    } catch (e) {
      console.warn('initIndexedDb error', e);
    }
  }
}

let app = null;
window.addEventListener('DOMContentLoaded', () => {
  window.app = app = new VeloApp();
});

// PWA: network-first service worker; reload once when a new version takes control (never mid-ride).
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.__APEX_TEST_MODE__) {
  window.addEventListener('load', () => {
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded && !(window.app && window.app.hasUnsavedRide())) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
