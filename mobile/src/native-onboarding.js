/**
 * First-run onboarding (docs/ANDROID-UX.md 2.4, workstream U5): three skippable steps, profile > devices >
 * connect and import, full screen with a progress bar. It replaces the welcome card on the phone.
 *
 * It starts on a new installation (no rider set up yet). The step reached is saved, so a closed app resumes
 * there; once it is finished or skipped it never shows again. Everything skipped stays in You.
 */

export const ONBOARDING_KEY = 'apex_onboarding';
export const STEPS = ['profile', 'devices', 'connect'];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The saved state: { step, done }. */
export function onboardingState(storage) {
  try { return { step: STEPS[0], done: false, ...JSON.parse(storage.getItem(ONBOARDING_KEY) || '{}') }; } catch (e) { return { step: STEPS[0], done: false }; }
}
function saveState(storage, st) { try { storage.setItem(ONBOARDING_KEY, JSON.stringify(st)); } catch (e) { /* private mode: shows again */ } }

/**
 * True when onboarding should open: one started and not finished (step 1 already saved the profile, so the
 * installation no longer looks new), or a new installation that has not dismissed the welcome card.
 */
export function shouldOnboard({ app, storage, win }) {
  if (!app || win.__APEX_DEMO_MODE__ || win.__APEX_TEST_MODE__ || win.__apexNoOnboarding) return false;
  let saved = null;
  try { saved = storage.getItem(ONBOARDING_KEY); } catch (e) { /* ignore */ }
  if (saved) return !onboardingState(storage).done;
  try { if (storage.getItem('apex_setup_dismissed')) return false; } catch (e) { /* ignore */ }
  return !!app.isNewInstallation;
}

const CSS = `
.av-onb { min-height: calc(100vh - 32px); padding-top: calc(12px + env(safe-area-inset-top, 0px)); }
.av-onb-top { display: flex; align-items: center; gap: 12px; min-height: 44px; }
.av-onb-bar { flex: 1; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.av-onb-bar i { height: 6px; border-radius: 9px; background: rgba(255, 255, 255, .12); }
.av-onb-bar i.on { background: linear-gradient(135deg, var(--zone-a), var(--zone-b)); }
.av-onb h2 { font-family: var(--font-display); font-weight: 500; font-size: 26px; letter-spacing: -.03em; margin: 8px 0 0; }
.av-onb .form-group { margin-bottom: 12px; }
.av-onb-foot { display: flex; flex-direction: column; gap: 8px; margin-top: auto; padding-bottom: 16px; }
.av-onb-foot .btn { min-height: 44px; justify-content: center; }
.av-onb-link { display: inline-flex; align-items: center; min-height: 44px; color: var(--cyan); }
`;

/**
 * `storage()` returns the storage to use now. It is looked up on every read and write: js/velo-storage.js
 * replaces window.localStorage with its phone-database mirror at start-up, and a cached reference would keep
 * writing to the old browser storage (the flags would be lost and onboarding would show on every launch).
 */
export function installOnboarding({ shell, win = window, storage: getStorage = () => win.localStorage }) {
  const doc = win.document;
  const storage = {
    getItem: (k) => getStorage().getItem(k),
    setItem: (k, v) => getStorage().setItem(k, v)
  };
  const app = () => shell.getApp();
  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.appendChild(style);

  const finish = (route = 'ride') => {
    saveState(storage, { step: STEPS[STEPS.length - 1], done: true });
    try { storage.setItem('apex_setup_dismissed', '1'); } catch (e) { /* ignore */ }
    shell.go(route, { replace: true });
  };
  const next = (step) => {
    const i = STEPS.indexOf(step);
    if (i >= STEPS.length - 1) { finish(); return; }
    saveState(storage, { step: STEPS[i + 1], done: false });
    shell.go('onboarding/' + STEPS[i + 1], { replace: true });
  };

  const frame = (step, title, intro, body, primary) => {
    const i = STEPS.indexOf(step);
    return `<div class="av-onb-step">Step ${i + 1} of ${STEPS.length}</div><div class="av-onb-top"><div class="av-onb-bar" aria-label="Step ${i + 1} of ${STEPS.length}">${STEPS.map((s, j) => `<i class="${j <= i ? 'on' : ''}"></i>`).join('')}</div>
        <button type="button" class="btn btn-ghost" data-onb="skipall">Skip setup</button></div>
      <h2>${esc(title)}</h2><p class="av-note">${intro}</p>${body}
      <div class="av-onb-foot"><button type="button" class="btn btn-primary av-big" data-onb="next">${esc(primary)}</button>
        <button type="button" class="btn btn-ghost" data-onb="skip">Skip this step</button></div>`;
  };

  const el = doc.createElement('div');
  el.className = 'av-page-body av-onb';
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-onb]');
    if (!b) return;
    const step = shell.current && shell.current.params.step;
    const act = b.dataset.onb;
    if (act === 'skipall') finish();
    else if (act === 'skip') next(step);
    else if (act === 'next') { if (step === 'profile' && !saveProfile()) return; next(step); }
    else if (act === 'unknownftp') {
      const input = el.querySelector('#onbFtp');
      input.disabled = !input.disabled;
      b.setAttribute('aria-pressed', String(input.disabled));
      b.textContent = input.disabled ? 'Enter my FTP' : "I don’t know my FTP";
      el.querySelector('#onbFtpHelp').hidden = !input.disabled;
    }
    else if (act === 'pair') pair(b.dataset.kind);
    else if (act === 'strava') { const a = app(); if (a && a.connectStrava) a.connectStrava(); }
    else if (act === 'hc') { const h = doc.querySelector('[data-hc-request="recovery"]'); if (h) h.click(); }
    else if (act === 'import') { const h = doc.getElementById('btnImportHistory'); if (h) h.click(); }
  });

  const saveProfile = () => {
    const a = app();
    const p = a && a.activeProfile;
    if (!p) return false;
    let invalid = null;
    for (const [id, message] of [['onbWeight', 'Enter a weight from 30 to 200 kg.'], ['onbFtp', 'Enter an FTP from 50 to 700 W.'], ['onbMaxHr', 'Enter a heart rate from 100 to 230 bpm, or leave it blank.']]) {
      const input = el.querySelector('#' + id);
      const error = el.querySelector('#' + id + 'Error');
      const valid = input.disabled || input.checkValidity();
      input.setAttribute('aria-invalid', String(!valid));
      error.hidden = valid;
      error.textContent = valid ? '' : message;
      if (!valid && !invalid) invalid = input;
    }
    if (invalid) { invalid.focus(); return false; }
    const v = (id) => (el.querySelector('#' + id) || {}).value;
    const name = String(v('onbName') || '').trim();
    const ftp = parseInt(v('onbFtp'), 10), kg = parseFloat(v('onbWeight')), hr = parseInt(v('onbMaxHr'), 10);
    if (name) p.name = name.slice(0, 60);
    if (ftp >= 50 && ftp <= 700) { if (Number(p.ftp) !== ftp && a.logFtpChange) a.logFtpChange(p.ftp, ftp, 'manual'); p.ftp = ftp; }
    if (kg >= 30 && kg <= 200) p.weightKg = kg;
    if (hr >= 100 && hr <= 230) p.maxHr = hr;
    delete p.needsSetup;
    a.saveProfiles();
    if (a.applyProfileChange) a.applyProfileChange();
    return true;
  };

  // The same pairing as Devices > Pair device (the in-app chooser), then the row shows the device's state.
  const pair = async (kind) => {
    const a = app();
    if (!a || !a.connectDevice) return;
    try { await a.connectDevice(kind, { replace: true }); } catch (e) { /* the app shows why */ }
    if (shell.current && shell.current.params.step === 'devices') render('devices');
  };

  const render = (step) => {
    const a = app();
    const p = (a && a.activeProfile) || {};
    if (step === 'profile') {
      el.innerHTML = frame(step, 'About you', 'FTP sets your workout targets. You can update these details later.', `
        <div class="card">
          <div class="form-group"><label for="onbName">Name</label><input id="onbName" class="input-field" autocomplete="name" value="${esc(p.needsSetup ? '' : p.name)}" placeholder="Rider"></div>
          <div class="form-group"><label for="onbWeight">Weight (kg)</label><input id="onbWeight" class="input-field" type="number" inputmode="decimal" step="0.1" min="30" max="200" required aria-describedby="onbWeightError" value="${esc(p.weightKg || 75)}"><p class="av-field-error" id="onbWeightError" hidden></p></div>
          <div class="form-group"><label for="onbFtp">FTP (W)</label><input id="onbFtp" class="input-field" type="number" inputmode="numeric" min="50" max="700" required aria-describedby="onbFtpError" value="${esc(p.ftp || 200)}"><p class="av-field-error" id="onbFtpError" hidden></p>
            <button type="button" class="av-text-action" data-onb="unknownftp" aria-pressed="false">I don’t know my FTP</button><p class="av-note" id="onbFtpHelp" hidden>Workouts will use ${esc(p.ftp || 200)} W until you update FTP in Profile or take a ramp test in Train.</p></div>
          <div class="form-group"><label for="onbMaxHr">Max heart rate (bpm, optional)</label><input id="onbMaxHr" class="input-field" type="number" inputmode="numeric" min="100" max="230" aria-describedby="onbMaxHrError" value="${esc(p.maxHr || '')}"><p class="av-field-error" id="onbMaxHrError" hidden></p></div>
        </div>
        <a class="av-onb-link" id="onbDemo" href="?apexDemo=1">Explore a demo</a>`, 'Continue');
    } else if (step === 'devices') {
      el.innerHTML = frame(step, 'Pair your devices', 'Wake your trainer or sensor, then tap Pair.', `
        <div class="card av-list">
          <button type="button" class="av-row" data-onb="pair" data-kind="trainer" id="onbPairTrainer"><div class="av-row-text"><b>Trainer or smart bike</b><small id="onbState-trainer"></small></div><span class="av-pair-label">Pair</span></button>
          <button type="button" class="av-row" data-onb="pair" data-kind="pedals" id="onbPairPedals"><div class="av-row-text"><b>Power meter</b><small id="onbState-pedals"></small></div><span class="av-pair-label">Pair</span></button>
          <button type="button" class="av-row" data-onb="pair" data-kind="hr" id="onbPairHr"><div class="av-row-text"><b>Heart-rate strap</b><small id="onbState-hr"></small></div><span class="av-pair-label">Pair</span></button>
        </div><details class="av-more"><summary>Pairing help</summary><p class="av-note">Pedal to wake a trainer, spin a power meter or wet your heart-rate strap. Keep it near your phone and close other apps using it.</p></details>`, 'Continue');
      for (const k of ['trainer', 'pedals', 'hr']) {
        const s = doc.querySelector(`#deviceCard-${k} .hw-state`), out = el.querySelector('#onbState-' + k);
        if (out) out.textContent = s ? s.textContent.trim() : '';
        const action = el.querySelector(`[data-kind="${k}"] .av-pair-label`);
        if (action) action.textContent = s?.dataset.state === 'connected' ? 'Replace' : 'Pair';
      }
    } else {
      const hasHc = !!doc.querySelector('[data-hc-request="recovery"]');
      el.innerHTML = frame(step, 'Connect (optional)', 'Everything stays on this phone unless you connect it.', `
        <div class="card av-list">
          <button type="button" class="av-row" data-onb="strava" id="onbStrava"><div class="av-row-text"><b>Strava</b><small>Send recorded rides</small></div><span class="av-pair-label">Connect</span></button>
          ${hasHc ? '<button type="button" class="av-row" data-onb="hc" id="onbHc"><div class="av-row-text"><b>Health Connect</b><small>Read recovery data</small></div><span class="av-pair-label">Connect</span></button>' : ''}
          <button type="button" class="av-row" data-onb="import" id="onbImport"><div class="av-row-text"><b>Import my history</b><small>A Garmin or Strava export</small></div><span class="av-pair-label">Import</span></button>
        </div>`, 'Finish setup');
    }
  };

  const steps = new Set(STEPS);
  shell.registerPage('onboarding/:step', {
    title: 'Welcome', el, fullscreen: true, tab: 'ride',
    parent: ({ step }) => { const i = STEPS.indexOf(step); return i > 0 ? 'onboarding/' + STEPS[i - 1] : null; },
    mount: (_, { step }) => {
      if (!steps.has(step)) { shell.go('onboarding/' + STEPS[0], { replace: true }); return; }
      if (onboardingState(storage).done) { shell.go('ride', { replace: true }); return; }
      saveState(storage, { step, done: false });
      render(step);
    }
  });

  // On launch: open (or resume) it once the app exists and the shell has opened its first route.
  let checked = false;
  const off = shell.onRoute(() => {
    if (checked) return;
    checked = true;
    off();
    shell.whenApp(() => {
      const a = app();
      const welcome = doc.getElementById('firstRunHelp');
      if (welcome && !win.__APEX_DEMO_MODE__) welcome.hidden = true; // replaced by onboarding (the demo keeps its banner)
      if (!shouldOnboard({ app: a, storage, win })) return;
      shell.go('onboarding/' + onboardingState(storage).step, { replace: true });
    });
  });
  return { finish, next };
}
