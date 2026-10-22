/**
 * Fits the desktop web app (index.html + js/) into the Android shell without editing it.
 *
 * Runs on DOMContentLoaded, after every app script has loaded but before js/app.js creates VeloApp
 * (this listener is registered first, from <head>). It:
 *   - answers /api/ requests on the phone (saved data, Strava, the AI coach and Ask; everything else that
 *     needs the PC is switched off),
 *   - answers /api/storage/* from the phone's SQLite database (src/native-store.js), so js/velo-storage.js
 *     saves there as it does on the PC and moves the earlier WebView data (IndexedDB + localStorage) in
 *     on the first start; without a database it keeps the WebView storage,
 *   - adds Settings > Strava for the rider's own Strava API application, and the sign-in redirect;
 *     Strava is upload-only on the phone (per-ride "Send to Strava", optional auto-upload, an offline retry
 *     queue), so "Sync from Strava" and "Check Strava" are hidden,
 *   - adds Settings > About with the open-source licences of what the app ships,
 *   - adds the API key fields to Settings > AI engine (the keys stay in Android app storage),
 *   - reads resting HR, HRV and sleep from intervals.icu and Health Connect (Settings > Health) instead of
 *     Apple Health via the PC, for readiness, the calendar and the recovery trends; Health Connect also brings
 *     other apps' rides in and takes rides recorded here (src/native-healthconnect.js),
 *   - keeps the screen on during a ride, shares exported files, and handles the Android back button.
 *
 * Dropped in this version (they need the PC server or another device): phone remote view,
 * the Apple Health inbox (replaced by intervals.icu) and server backups.
 */

import { BACKFILL_DAYS, RECENT_DAYS } from './native-icu.js';
import { aboutSection } from './native-licences.js';
import { isFromDestination } from './native-outbox.js';
import { HC_SOURCE, TYPE_TEXT, WELLNESS_TYPES, RIDE_TYPES, WRITE_TYPES, MERGE_FIELDS, RESUME_SYNC_MS, toRide, importRides, removeRides, recordedHere } from './native-healthconnect.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const AI_PATHS = ['/api/coach', '/api/coach/status', '/api/ask'];

/**
 * Same-origin /api/ calls never leave the WebView as such: saved data, Strava and the AI engine are
 * answered here, the rest reports "not in the app". `routes` is { storage, strava, ai }.
 */
export function installApiRoutes(routes, win = window) {
  if (win.__APEX_DEMO_MODE__) return; // the demo playground blocks /api/ itself
  const { storage, strava, ai } = routes;
  const realFetch = win.fetch.bind(win);
  win.fetch = async function (input, options = {}) {
    const url = new URL(typeof input === 'string' ? input : (input && input.url) || String(input), win.location.href);
    if (url.origin !== win.location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, options);
    const method = String(options.method || (input && input.method) || 'GET').toUpperCase();
    const readBody = async () => typeof options.body === 'string' ? options.body : options.body ? await new Response(options.body).text() : '';
    if (storage && (url.pathname === '/api/storage' || url.pathname.startsWith('/api/storage/'))) {
      const r = await storage.route(url.pathname, method, await readBody());
      // The answers carrying every ride come as UTF-8 pieces: a Blob holds them without one big string.
      return r.chunks ? new Response(new Blob(r.chunks), { status: r.status, headers: { 'Content-Type': 'application/json' } }) : json(r.status, r.body);
    }
    if (ai && AI_PATHS.includes(url.pathname)) {
      const signal = options.signal || (input && input.signal) || undefined;
      try {
        const r = await ai.route(url.pathname, method, url.searchParams, await readBody(), signal);
        if (r) return json(r.status, r.body);
      } catch (e) {
        if (e && e.name === 'AbortError') throw e; // cancelled or timed out by the app, as a real fetch would
        return json(502, { error: `Could not reach the AI service (${(e && e.message) || e}). Check your internet connection.` });
      }
    }
    try {
      if (url.pathname.startsWith('/api/strava/')) {
        const r = await strava.route(url.pathname, method, url.searchParams, await readBody());
        if (r) return json(r.status, r.body);
      }
      if (url.pathname === '/api/local-history') return json(200, { rides: null });
    } catch (e) {
      return json(502, { error: `Could not reach Strava (${(e && e.message) || e}). Check your internet connection.` });
    }
    return json(503, { error: 'Not available in the Android app.' });
  };
}

const TOAST_TEXT = [
  [/Could not reach the local server\.? ?(\(([^)]*)\))?\.? ?Is Launch-Apex-Velo\.bat running\?/i, 'Could not reach Strava. Check your internet connection.'],
  [/The workout image is saved and on your clipboard - add it to the activity\./, 'Use "Save image" in the ride summary to share the workout card.'],
  [/Allow Bluetooth for localhost in Chrome site settings\./, 'Allow "Nearby devices" for Apex Velo in Android settings.'],
  [/Web Bluetooth needs Chrome, Edge or Brave on https:\/\/ or localhost\./, 'Bluetooth is not available on this phone.'],
  [/Server found, but no \w+ yet\. Add it to \.env and restart Launch-Apex-Velo\.bat\./, 'No API key for this AI engine yet. Add it in Settings > AI engine.'],
  [/Local server not running - open the app with Launch-Apex-Velo\.bat to use ([^.]+)\./, 'Add an API key in Settings > AI engine to use $1.'],
  [/The AI coach is offline - start Launch-Apex-Velo\.bat and add an API key\./, 'The AI coach needs an API key: add one in Settings > AI engine.']
];

const AI_KEY_FIELDS = [
  { id: 'claude', label: 'Anthropic (Claude) API key', placeholder: 'sk-ant-...', link: 'https://platform.claude.com/settings/keys', site: 'platform.claude.com' },
  { id: 'gemini', label: 'Google Gemini API key', placeholder: 'AIza...', link: 'https://aistudio.google.com/apikey', site: 'aistudio.google.com' },
  { id: 'openai', label: 'OpenAI (ChatGPT) API key', placeholder: 'sk-...', link: 'https://platform.openai.com/api-keys', site: 'platform.openai.com' }
];

function aiKeysSection() {
  return `
        <div id="nativeAiKeys">
          <p class="field-help">Ask, the AI coach and the ride breakdowns call Claude, Gemini or ChatGPT straight from this phone with your own API key. One key is enough; without one the built-in offline coach is used.</p>
          ${AI_KEY_FIELDS.map((f) => `
          <div class="form-group">
            <label for="nativeAiKey-${f.id}">${f.label}</label>
            <div class="native-key-row">
              <input type="password" id="nativeAiKey-${f.id}" class="input-field" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${f.placeholder}">
              <button type="button" class="btn btn-ghost" data-native-ai-remove="${f.id}" hidden>Remove</button>
            </div>
            <p class="field-help native-key-link">Get one at <a href="${f.link}" target="_blank" rel="noopener">${f.site}</a></p>
          </div>`).join('')}
          <div class="btn-row"><button type="button" class="btn btn-primary" id="btnNativeAiSaveKeys">Save keys</button></div>
          <p class="field-help">Keys stay in this app's private storage on the phone and go only to their own provider. They are not part of exports. Each question uses your API account and is billed there.</p>
        </div>`;
}

/** Settings > AI engine on the phone: key fields instead of the .env instructions. */
function addAiSettingsUi(doc) {
  const card = doc.getElementById('aiCoachConfigCard');
  if (!card || doc.getElementById('nativeAiKeys')) return;
  const detail = doc.getElementById('aiCoachEngineDetail');
  if (detail) { detail.textContent = 'Checking your API keys...'; detail.insertAdjacentHTML('afterend', aiKeysSection()); }
  const help = [...card.querySelectorAll('.field-help')].find((p) => /\.env/.test(p.textContent));
  if (help) help.innerHTML = 'The model lists are read live from each provider whose key is saved, so new models show up after <b>Re-check keys</b>. For Gemini, effort sets the thinking level; for ChatGPT, the reasoning effort. Low effort is fastest and cheapest, and answers sooner on a phone.';
  const recheck = doc.getElementById('btnRecheckAiEngine');
  if (recheck) recheck.textContent = 'Re-check keys';
  const def = doc.querySelector('#selectCoachEffort option[value=""]');
  if (def) def.textContent = 'Default (low)';
  // Static wording elsewhere that talks about the PC server.
  const askNote = doc.getElementById('askDataSize') && doc.getElementById('askDataSize').closest('.footnote');
  if (askNote) askNote.innerHTML = 'This summary of the period is sent with your question (<span id="askDataSize"></span>) to the AI engine you chose. Nothing else leaves this phone.';
  doc.querySelectorAll('.section-sub').forEach((p) => { p.innerHTML = p.innerHTML.replace('when the local server has its API key', 'when its API key is saved in Settings'); });
}

function filesSection() {
  return `
      <section class="settings-section" data-sec="files" id="nativeFileSettings">
        <p class="field-help">Ride files are saved in <b>Documents/ApexVelo</b> on this phone, where any file manager can open them and Garmin Connect, TrainingPeaks, intervals.icu and others can import them.</p>
        <label class="native-toggle"><input type="checkbox" id="nativeAutoFit" checked> Save a FIT file of every ride when it finishes</label>
        <p class="field-help">History &gt; Export (FIT, TCX, CSV and the full JSON backup) saves to the same folder. Rides themselves are always kept in the app as well.</p>
      </section>`;
}

function stravaSection() {
  return `
      <section class="settings-section" data-sec="strava" id="nativeStravaSettings">
        <p class="field-help">Rides are sent to Strava with your own free Strava API application, the same one the desktop app uses. The app only uploads: it never reads your Strava activities.</p>
        <ol class="setup-steps">
          <li>Open <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener">strava.com/settings/api</a> and create an application (any name and website).</li>
          <li>Set <b>Authorization Callback Domain</b> to <code>localhost</code>.</li>
          <li>Copy the <b>Client ID</b> and <b>Client Secret</b> here, press Save, then Connect Strava.</li>
        </ol>
        <div class="form-group"><label for="nativeStravaClientId">Client ID</label><input type="text" id="nativeStravaClientId" class="input-field" inputmode="numeric" autocomplete="off" placeholder="e.g. 123456"></div>
        <div class="form-group"><label for="nativeStravaSecret">Client Secret</label><input type="password" id="nativeStravaSecret" class="input-field" autocomplete="off" placeholder="40 letters and numbers"></div>
        <div class="settings-kv" id="nativeStravaStatus" aria-live="polite"><span class="dim">Checking...</span></div>
        <div class="btn-row">
          <button type="button" class="btn btn-primary" id="btnNativeStravaSave">Save</button>
          <button type="button" class="btn btn-strava" id="btnNativeStravaConnect">Connect Strava</button>
          <button type="button" class="btn btn-ghost" id="btnNativeStravaDisconnect">Disconnect</button>
        </div>
        <label class="native-toggle"><input type="checkbox" id="nativeStravaAuto"> Auto-upload new rides to Strava</label>
        <p class="field-help">Each ride recorded here is sent when it finishes. Without a connection it waits and is retried when the app opens or comes back. Rides imported from Strava are never sent back.</p>
        <div class="settings-kv" id="nativeStravaQueue" aria-live="polite"></div>
        <p class="field-help">The secret and sign-in stay in this app's private storage on the phone. They are not part of exports.</p>
      </section>`;
}

function healthSection() {
  return `
        <p class="field-help">Resting heart rate, HRV and sleep are read from your <b>intervals.icu</b> wellness data (synced there from your watch). They drive the readiness score, the calendar recovery strip and the recovery trends.</p>
        <ol class="setup-steps">
          <li>On <a href="https://intervals.icu/settings" target="_blank" rel="noopener">intervals.icu/settings</a>, open <b>Developer settings</b> and copy your <b>API key</b>.</li>
          <li>Paste it here and press <b>Save and backfill</b>. All your history (up to about two years) is read once; after that the last week is refreshed when the app opens and every hour.</li>
        </ol>
        <div class="form-group">
          <label for="nativeIcuKey">intervals.icu API key</label>
          <input type="password" id="nativeIcuKey" class="input-field" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Letters and numbers">
        </div>
        <div class="settings-kv" id="healthStatus" aria-live="polite"><span class="dim">Checking...</span></div>
        <div class="form-group" id="nativeIcuHrvGroup" hidden>
          <label for="nativeIcuHrv">HRV used for readiness</label>
          <select id="nativeIcuHrv" class="input-field">
            <option value="auto">Automatic (the kind most of your days have)</option>
            <option value="hrv">Overnight rMSSD</option>
            <option value="hrvSDNN">SDNN (Apple Watch spot checks)</option>
          </select>
          <p class="field-help">One kind is used for every day, so your normal range never mixes the two. Changing it reads your history again.</p>
        </div>
        <p class="field-help">Sleep stages are read from the custom wellness fields <code>DeepSleep</code>, <code>LightSleep</code> and <code>REMSleep</code> (seconds), when your intervals.icu account has them.</p>
        <div class="btn-row">
          <button type="button" class="btn btn-primary" id="btnNativeIcuSave">Save and backfill</button>
          <button type="button" class="btn" id="btnHealthRefresh">Sync now</button>
          <button type="button" class="btn btn-ghost" id="btnNativeIcuBackfill">Backfill all again</button>
          <button type="button" class="btn btn-ghost" id="btnNativeIcuRemove">Remove</button>
        </div>
        <p class="field-help">The key stays in this app's private storage on the phone, goes only to intervals.icu and is not part of exports. The app only reads your wellness data.</p>`;
}

const HC_GROUPS = [
  ['recovery', 'Recovery data', WELLNESS_TYPES, 'read'],
  ['rides', 'Rides from other apps', RIDE_TYPES, 'read'],
  ['write', 'Save rides recorded here', WRITE_TYPES, 'write']
];
const HC_FIELDS = { rhr: 'Resting heart rate', hrv: 'HRV', sleep: 'Sleep and its stages', weight: 'Weight', spo2: 'Blood oxygen', resp: 'Breathing rate' };

function healthConnectSection() {
  return `
        <div class="native-hc" id="nativeHc">
          <h4 class="native-hc-title">Health Connect</h4>
          <p class="field-help">Android's <b>Health Connect</b> shares data between your health apps (Samsung Health, Fitbit, Google Fit, Garmin, Oura, Zwift...). Apex Velo can read your recovery data and rides from them, and save the rides you record here. Each kind of data is asked for separately, and everything stays on this phone.</p>
          <div class="settings-kv" id="nativeHcStatus" aria-live="polite"><span class="dim">Checking...</span></div>
          <div class="btn-row"><button type="button" class="btn btn-primary" id="btnNativeHcInstall" hidden>Get Health Connect</button></div>
          <div id="nativeHcGroups">${HC_GROUPS.map(([id, label, types, mode]) => `
            <div class="native-hc-group" data-hc-group="${id}">
              <b>${label}</b>
              <ul class="native-hc-types">${types.map((t) => `<li data-hc-type="${mode}:${t}"><span class="native-hc-mark" aria-hidden="true"></span>${TYPE_TEXT[t]}</li>`).join('')}</ul>
              <button type="button" class="btn" data-hc-request="${id}">Allow</button>
            </div>`).join('')}
          </div>
          <label class="native-toggle"><input type="checkbox" id="nativeHcAutoWrite"> Save each ride I record here to Health Connect</label>
          <label class="native-toggle"><input type="checkbox" id="nativeHcBackground"> Look for changes once a day while the app is closed</label>
          <p class="field-help">The first sync reads the last two years. After that only what changed is read: when the app opens, when you come back to it, and (if allowed) once a day in the background. Rides already in your history (the same start and length) are not added twice: the copy with power is kept. Rides that came from Health Connect are never written back.</p>
          <h4 class="native-hc-title">When intervals.icu and Health Connect both have a day</h4>
          <div class="native-hc-prefs">${Object.entries(HC_FIELDS).map(([k, label]) => `
            <label for="nativeHcPref-${k}">${label}</label>
            <select id="nativeHcPref-${k}" class="input-field" data-hc-pref="${k}">
              <option value="${HC_SOURCE}">Health Connect first</option>
              <option value="icu">intervals.icu first</option>
            </select>`).join('')}
          </div>
          <p class="field-help">The other source fills in a day the first one has no value for. HRV is never mixed: Health Connect has overnight rMSSD, so SDNN from intervals.icu is not used to fill its gaps (or the other way round).</p>
          <div class="btn-row">
            <button type="button" class="btn" id="btnNativeHcSync">Sync now</button>
            <button type="button" class="btn btn-ghost" id="btnNativeHcManage">Manage in Health Connect</button>
            <button type="button" class="btn btn-ghost" id="btnNativeHcDisconnect">Disconnect</button>
          </div>
        </div>`;
}

/**
 * The phone does not read Strava: "Sync from Strava" and "Check Strava" go. The strength-load switches in the
 * same card stay (they are about training load, not Strava).
 */
function hideStravaSync(doc) {
  const card = doc.getElementById('stravaSyncCard');
  if (card) {
    card.querySelectorAll('.strava-sync-row, .strava-sync-meta, .card-title .chip, :scope > .field-help').forEach((el) => { el.hidden = true; });
    const title = card.querySelector('.strava-sync-title');
    if (title) title.textContent = 'Training load';
    const auto = doc.getElementById('chkStravaAutoCheck');
    if (auto && auto.closest('label')) auto.closest('label').hidden = true;
  }
  const checkAll = doc.getElementById('btnStravaCheckAll');
  if (checkAll) checkAll.hidden = true;
}

/** Settings > Strava: the DOM must exist before VeloApp binds the settings tabs. */
function addSettingsUi(doc, icu, healthConnect) {
  hideStravaSync(doc);
  const nav = doc.getElementById('settingsNav');
  if (nav && !nav.querySelector('[data-sec="strava"]')) {
    const b = doc.createElement('button');
    b.type = 'button'; b.className = 'cat-pill'; b.dataset.sec = 'strava'; b.textContent = 'Strava';
    const rider = nav.querySelector('[data-sec="rider"]');
    rider ? rider.after(b) : nav.prepend(b);
    const files = doc.createElement('button');
    files.type = 'button'; files.className = 'cat-pill'; files.dataset.sec = 'files'; files.textContent = 'Ride files';
    b.after(files);
    const about = doc.createElement('button');
    about.type = 'button'; about.className = 'cat-pill'; about.dataset.sec = 'about'; about.textContent = 'About';
    nav.append(about);
    const riderSection = doc.querySelector('#settingsModal .settings-section[data-sec="rider"]');
    if (riderSection) riderSection.insertAdjacentHTML('afterend', stravaSection() + filesSection() + aboutSection());
  }
  const status = doc.getElementById('localStorageStatus');
  if (status) status.textContent = 'Saved on this phone.';
  const health = doc.getElementById('healthSettings');
  if (icu && health && !doc.getElementById('nativeIcuKey')) {
    health.innerHTML = healthSection() + (healthConnect ? healthConnectSection() : '');
    const pill = nav && nav.querySelector('[data-sec="health"]');
    if (pill) pill.textContent = 'Health';
    // Static wording that names Apple Health / Health Auto Export as the source.
    doc.querySelectorAll('[title*="Apple Health"]').forEach((el) => { el.title = el.title.replace('Apple Health', 'intervals.icu'); });
    doc.querySelectorAll('#calRecoveryHint').forEach((el) => { el.textContent = el.textContent.replace('Apple Health', 'intervals.icu'); });
  }
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

const FOLDER = 'ApexVelo';
const FOLDER_LABEL = 'Documents/ApexVelo';
const AUTO_FIT_KEY = 'apex_native_autosave_fit';
const safeName = (name) => String(name).replace(/[^\w.\-]+/g, '_');
const autoSaveFit = () => { try { return localStorage.getItem(AUTO_FIT_KEY) !== '0'; } catch (e) { return true; } };

let storageAsked = null;
/**
 * Writes a file to the phone's public Documents/ApexVelo folder and resolves to its readable path.
 * Android 10 and older need the storage permission (asked once). On Android 11+ the app may only
 * replace files it created itself, so a name taken by an earlier install gets a number added.
 */
export async function saveRideFile(Filesystem, filename, blob) {
  if (!storageAsked) storageAsked = Filesystem.requestPermissions().catch(() => null);
  const perm = await storageAsked;
  if (perm && perm.publicStorage === 'denied') { storageAsked = null; throw new Error('storage permission was denied'); }
  await Filesystem.mkdir({ path: FOLDER, directory: 'DOCUMENTS', recursive: true }).catch(() => {});
  const data = await blobToBase64(blob);
  const name = safeName(filename), dot = name.lastIndexOf('.');
  let lastError;
  for (let i = 1; i <= 5; i++) {
    const candidate = i === 1 ? name : `${name.slice(0, dot)}_${i}${name.slice(dot)}`;
    try {
      await Filesystem.writeFile({ path: `${FOLDER}/${candidate}`, data, directory: 'DOCUMENTS' });
      return `${FOLDER_LABEL}/${candidate}`;
    } catch (e) { lastError = e; }
  }
  throw lastError;
}

/** "Moving your rides" with progress, shown while the first start after the update moves more than a few rides. */
function migrationOverlay(doc) {
  let el = null;
  return {
    show(done, total) {
      if (total < 5) return;
      if (!el) {
        el = doc.createElement('div');
        el.id = 'nativeMigration'; el.className = 'native-migration'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
        el.innerHTML = '<div class="native-migration-card"><b>Moving your rides into the phone database</b><p>Don\'t close the app. This happens once.</p><progress max="1" value="0"></progress><p class="native-migration-count"></p></div>';
        doc.body.appendChild(el);
      }
      el.querySelector('progress').max = total; el.querySelector('progress').value = done;
      el.querySelector('.native-migration-count').textContent = `${done} of ${total} rides`;
    },
    hide() { if (el) el.remove(); el = null; }
  };
}

/**
 * Rides start without their samples on the phone (the store answers /api/storage summary-only), so the
 * history of a long-time rider fits in memory. Views of one ride load that ride's samples first; the
 * analytics across rides use each ride's sampleSummary (js/velo-ride-summary.js). At most LOADED_MAX rides
 * keep loaded samples; rides recorded or imported in this session keep theirs.
 */
const LOADED_MAX = 3;
function lazySamples(P, storage, win) {
  /* global VeloInsight, VeloRideSummary */
  const hasSamples = (r) => (typeof VeloInsight !== 'undefined' ? VeloInsight : win.VeloInsight).hasSamples(r);
  const summary = () => (typeof VeloRideSummary !== 'undefined' ? VeloRideSummary : win.VeloRideSummary);
  const loaded = [];
  /** Puts the ride's samples back on it (from the phone database) when they are not in memory. */
  const withSamples = async (ride) => {
    if (!ride || hasSamples(ride)) return ride;
    let full = null;
    try { full = await storage.ride(ride.id); } catch (e) { /* the view shows the summary-only ride */ }
    if (full && Array.isArray(full.samples) && full.samples.length && !hasSamples(ride)) {
      ride.samples = full.samples;
      loaded.push(ride);
      while (loaded.length > LOADED_MAX) { const old = loaded.shift(); if (old !== ride && loaded.indexOf(old) < 0) delete old.samples; }
    }
    return ride;
  };
  const byId = (app, id) => (app.completedWorkouts || []).find((r) => r.id === id);
  const before = (name, find) => {
    const original = P[name];
    if (!original) return;
    P[name] = async function (...args) { await withSamples(find(this, ...args)); return original.apply(this, args); };
  };
  before('showRideSummary', (app, record) => record);
  before('exportRide', (app, ride) => ride);
  before('requestAiBreakdown', (app, id) => byId(app, id));
  before('saveStravaImage', (app, id) => byId(app, id));
  // Whether a ride can go to Strava (60 s or more of samples) is known from its summary as well.
  const canSend = P.canSendToStrava;
  if (canSend) {
    P.canSendToStrava = function (ride) {
      if (!ride || hasSamples(ride)) return canSend.call(this, ride);
      return ride.source !== 'Strava' && summary().count(ride) >= 60;
    };
  }
  // History > Export JSON: the backup carries every ride's samples, read from the database a ride at a time.
  P.exportJson = async function () {
    const data = this.backupPayload(), head = {}, tail = {};
    let after = false;
    for (const [k, v] of Object.entries(data)) { if (k === 'history') after = true; else (after ? tail : head)[k] = v; }
    try {
      const chunks = await storage.exportChunks(head, tail);
      const name = `apex_velo_backup_${win.VeloMetrics.localDateKey(new Date())}.json`;
      return this.downloadFile(name, new Blob(chunks, { type: 'application/json' }), 'application/json');
    } catch (e) { this.showToast(`Could not export the backup: ${(e && e.message) || e}`, 'error'); }
  };
  // After a save, rides that dropped their samples from memory (a bulk import) pick up their summaries.
  const saveHistory = P.saveHistory;
  P.saveHistory = async function (...args) {
    const result = await saveHistory.apply(this, args);
    const want = (this.completedWorkouts || []).filter((r) => !hasSamples(r) && !summary().get(r)).map((r) => r.id);
    if (want.length) {
      try {
        const got = await storage.summaries(want);
        let n = 0;
        for (const r of this.completedWorkouts) if (got[r.id] && !summary().get(r)) { r.sampleSummary = got[r.id]; n++; }
        if (n && this.refreshAnalytics) this.refreshAnalytics();
      } catch (e) { /* the background pass fills them in */ }
    }
    return result;
  };
  // Bulk import (js/app-bulk-import.js) drops each saved batch's samples from memory and puts them all back
  // for one analytics refresh at the end; on the phone the analytics read the rides' summaries instead.
  if (P.restoreBulkSamples) {
    P.restoreBulkSamples = async function (rides) {
      const want = (rides || []).filter((r) => !hasSamples(r) && !summary().get(r));
      if (!want.length) return;
      const got = await storage.summaries(want.map((r) => r.id)).catch(() => ({}));
      for (const r of want) if (got[r.id]) r.sampleSummary = got[r.id];
    };
  }
  P.backfillRideSummaries = async function () {
    if (this._summaryBackfill) return this._summaryBackfill;
    const run = async () => {
      const ids = await storage.summariesNeeded();
      if (!ids.length) return 0;
      const rides = new Map((this.completedWorkouts || []).map((r) => [String(r.id), r]));
      let done = 0;
      for (const id of ids) {
        const s = await storage.summarizeRide(id).catch(() => null);
        const r = rides.get(String(id));
        if (r && s) r.sampleSummary = s;
        if (++done % 25 === 0 && this.refreshAnalytics) this.refreshAnalytics();
        await new Promise((res) => setTimeout(res, 0)); // one ride at a time, between the app's own work
      }
      if (this.refreshAnalytics) this.refreshAnalytics();
      if (this.renderHistoryTable) this.renderHistoryTable();
      return done;
    };
    this._summaryBackfill = run().finally(() => { this._summaryBackfill = null; });
    return this._summaryBackfill;
  };
  return { withSamples };
}

const HEALTH_SYNC_EVERY_MS = 60 * 60 * 1000;
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const UPLOAD_DEST = 'strava';
const hhmm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export function bootNativeApp({ bluetooth, storage, strava, ai, icu, uploads, plugins, healthConnect = null, wellness = null, win = window }) {
  const doc = win.document;
  const { App, Browser, KeepAwake, Filesystem, Share } = plugins;
  doc.documentElement.classList.add('apex-native');
  installApiRoutes({ storage, strava, ai }, win);

  // External links (Strava activity pages, the API settings page) open in the system browser.
  doc.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const url = new URL(a.getAttribute('href'), win.location.href);
    if (!/^https?:$/.test(url.protocol) || url.origin === win.location.origin) return;
    e.preventDefault();
    Browser.open({ url: url.href }).catch(() => win.open(url.href, '_system'));
  }, true);

  win.addEventListener('DOMContentLoaded', () => {
    doc.body.classList.add('apex-native');
    addSettingsUi(doc, icu, healthConnect);
    if (ai) addAiSettingsUi(doc);
    // `class VeloApp` in js/app.js is a global binding of the page's scripts, not a window property.
    /* global VeloApp, VeloExport */
    const App_ = typeof VeloApp !== 'undefined' ? VeloApp : win.VeloApp;
    const V = win.VeloStorage, P = App_ && App_.prototype;
    if (V && storage) {
      // The phone's SQLite database answers /api/storage, so VeloStorage.boot runs as on the PC. Earlier
      // WebView data is moved in first, a ride at a time (src/native-migrate.js), instead of by its single
      // /migrate request; if that stops, the app keeps the WebView storage and the next start goes on.
      const boot = V.boot;
      V.boot = async function () {
        if (win.__APEX_TEST_MODE__ || win.__APEX_DEMO_MODE__) return boot.call(V);
        const overlay = migrationOverlay(doc);
        try {
          const moved = await storage.migrate((done, total) => overlay.show(done, total));
          // The migration snapshot already keeps the earlier data: velo-storage must not copy the whole history
          // again (its "preserve the browser original" step), also when an earlier start could not set the flag.
          if (moved.storeId && win.localStorage.getItem('apex_sqlite_migration') !== moved.storeId) {
            try { win.localStorage.setItem('apex_sqlite_migration', moved.storeId); } catch (e) { /* storage full */ }
          }
        } catch (e) {
          V.enabled = false;
          V.error = `moving your rides into the phone database stopped (${(e && e.message) || e}). They are still in the app's browser storage, and the move goes on the next time the app starts.`;
          V.render();
          return;
        } finally { overlay.hide(); }
        return boot.call(V);
      };
      V.render = () => {
        const el = doc.getElementById('localStorageStatus');
        if (!el) return;
        el.textContent = V.error ? `Not saved on this phone: ${V.error}${V.recoveryUnavailable ? ' The browser recovery copy is also unavailable; export important rides with History > Export.' : ''}`
          : !V.enabled ? 'Saved in the app\'s browser storage on this phone.'
            : V.pending.length ? 'Saving on this phone...' : 'Saved on this phone. Use History > Export to keep a copy elsewhere.';
        el.classList.toggle('backup-warn', !!V.error);
      };
    } else if (V) {
      // No phone database: the app's own IndexedDB/localStorage (persistent in the WebView) is the store.
      V.boot = async () => {};
      V.render = () => { const el = doc.getElementById('localStorageStatus'); if (el) { el.textContent = 'Saved on this phone. Use History > Export to keep a copy elsewhere.'; el.classList.remove('backup-warn'); } };
    }
    if (!P) return;
    const lazy = storage ? lazySamples(P, storage, win) : null;

    // ------------------------------------------------------------ features that need the PC --
    P.initRemoteView = function () { this.remoteTrace = []; this.remoteLastTraceSecond = -1; this._remoteEnabled = false; };
    if (!icu) {
      P.pullHealthInbox = async function () {};
      P.fetchHealthStatus = async function () { return null; };
    }
    P.runAutoBackup = async function () { return { ok: false, error: 'Backups to the PC are not available in the app. Use History > Export.' }; };
    P.scheduleAutoBackup = function () {};

    // ------------------------------------------------------------------------ messages --
    const showToast = P.showToast;
    P.showToast = function (msg, ...rest) {
      let text = String(msg ?? '');
      for (const [re, to] of TOAST_TEXT) text = text.replace(re, to);
      return showToast.call(this, text, ...rest);
    };

    // ----------------------------------------------------------------------- screen on --
    const acquire = P.acquireWakeLock, release = P.releaseWakeLock;
    P.acquireWakeLock = async function () {
      KeepAwake.keepAwake().catch(() => {});
      return acquire.call(this);
    };
    P.releaseWakeLock = function () {
      KeepAwake.allowSleep().catch(() => {});
      return release.call(this);
    };

    // -------------------------------------------------------------------- file exports --
    // Ride files (FIT, TCX, CSV, JSON backup) are saved to Documents/ApexVelo, the phone's counterpart
    // of the desktop Downloads folder; the workout image goes to the share sheet (gallery, Strava app).
    P.downloadBlob = async function (filename, blob) {
      try {
        const res = await Filesystem.writeFile({ path: safeName(filename), data: await blobToBase64(blob), directory: 'CACHE' });
        await Share.share({ title: safeName(filename), files: [res.uri] });
      } catch (e) {
        if (!/cancel/i.test(String((e && e.message) || e))) this.showToast(`Could not share ${filename}: ${(e && e.message) || e}`, 'error');
      }
    };
    P.downloadFile = async function (filename, content, type) {
      const blob = new Blob([content], { type });
      try {
        const saved = await saveRideFile(Filesystem, filename, blob);
        this.showToast(`Saved to ${saved}.`, 'success');
      } catch (e) {
        this.showToast(`Could not save to ${FOLDER_LABEL} (${(e && e.message) || e}). Choose where to send it instead.`, 'warning');
        return this.downloadBlob(filename, blob);
      }
    };
    // Called by finishWorkout with every new ride (the phone remote's hook, unused in the app):
    // keep a FIT file of each ride recorded on the phone, outside the app's own storage.
    P.preparePhoneFit = function (ride) {
      if (uploads && ride) this.autoUploadRide(ride).catch(() => {});
      if (uploads && healthConnect && recordedHere(ride)) {
        uploads.autoUpload(HC_SOURCE).then((on) => on && uploads.enqueue(ride, HC_SOURCE).then(() => uploads.run())).catch(() => {});
      }
      if (!autoSaveFit() || !ride || !Array.isArray(ride.samples) || !ride.samples.length) return;
      const name = `${VeloExport.fileStem(ride)}.fit`;
      saveRideFile(Filesystem, name, new Blob([VeloExport.buildFit(ride, ride.samples)], { type: 'application/vnd.ant.fit' }))
        .then((saved) => this.showToast(`FIT file saved to ${saved}.`, 'info'))
        .catch((e) => this.showToast(`Could not save the FIT file (${(e && e.message) || e}). Export it from History.`, 'warning'));
    };
    const initSettings = P.initSettings;
    P.initSettings = function () {
      initSettings.call(this);
      const box = doc.getElementById('nativeAutoFit');
      if (!box) return;
      box.checked = autoSaveFit();
      this.on(box, 'change', () => { try { localStorage.setItem(AUTO_FIT_KEY, box.checked ? '1' : '0'); } catch (e) { /* storage unavailable */ } });
    };
    // Sending to Strava would otherwise pop a share sheet for the workout card every time.
    const prepareImage = P.prepareStravaImage;
    P.prepareStravaImage = function (ride) { return prepareImage.call(this, ride, false); };

    // -------------------------------------------------------------------------- Strava --
    // Upload-only: nothing here reads Strava. A ride's Strava state comes from the sync ledger, which keeps the
    // activity id each upload returned; js/app-strava.js keeps showing it from ride.strava.
    P.scheduleStravaAutoCheck = function () {};
    P.runStravaAutoCheck = async function () { return null; };
    P.stravaAutoCheckEnabled = function () { return false; };
    P.previewStravaSync = async function () { this.showToast('The app sends rides to Strava but does not read them. Import your history from your own export files.', 'info'); };
    const refreshStrava = P.refreshStravaStatus;
    P.refreshStravaStatus = async function (rerender) {
      // "Checked" on the phone means the local upload record, so the ride panel offers Send once connected.
      const sv = await refreshStrava.call(this, false);
      sv.canCheck = !!sv.canUpload;
      if (rerender) {
        const ride = this.completedWorkouts.find((r) => r.id === this._reviewRideId);
        if (ride) { this.renderStravaPanel(ride); this.autoCheckRideOnStrava(ride); }
        if (sv.connected) this.showToast(`Strava connected${sv.athlete ? ` as ${sv.athlete}` : ''}.`, 'success');
      }
      return sv;
    };
    /** Copies a ledger row into ride.strava (what the ride panel and history chips show). Resolves true on a change. */
    P.applyUploadRow = function (ride, row, result) {
      if (!ride || !row) return false;
      const cur = ride.strava || {};
      let next = null;
      if (row.status === 'sent') {
        if ((cur.state === 'sent' || cur.state === 'duplicate') && cur.activityId === row.external_id) return false;
        next = { state: result && result.duplicate ? 'duplicate' : 'sent', activityId: row.external_id, sentAt: Date.parse(row.updated_at) || Date.now() };
      } else if (row.status === 'failed') {
        next = { state: 'failed', error: row.last_error || 'Upload failed', failedAt: Date.parse(row.updated_at) || Date.now() };
      } else if (row.status === 'queued') {
        next = { state: 'queued', error: row.last_error || null, attempts: row.attempts || 0, queuedAt: Date.parse(row.updated_at) || Date.now() };
      } else return false;
      if (JSON.stringify(next) === JSON.stringify(cur)) return false;
      ride.strava = next;
      return true;
    };
    P.onUploadChange = function (rideId, row, result) {
      const ride = this.completedWorkouts.find((r) => r.id === rideId);
      // A refused token refresh signs out: refresh the status so the panel offers Connect Strava.
      if (row && row.status === 'queued' && row.last_error) this.refreshStravaStatus(false).catch(() => {});
      if (!this.applyUploadRow(ride, row, result)) return;
      this.saveHistory();
      this.renderHistoryTable();
      if (this._reviewRideId === rideId) this.renderStravaPanel(ride);
      if (this._renderNativeStrava) this._renderNativeStrava().catch(() => {});
    };
    P.autoCheckRideOnStrava = async function (ride) {
      if (!uploads || !ride) return;
      const row = await uploads.state(ride.id, UPLOAD_DEST);
      if (row && this.applyUploadRow(ride, row, null)) { this.saveHistory(); this.renderHistoryTable(); if (this._reviewRideId === ride.id) this.renderStravaPanel(ride); }
    };
    P.checkRidesOnStrava = async function (rides) {
      let found = 0, changed = false;
      for (const ride of rides || []) {
        const row = uploads ? await uploads.state(ride.id, UPLOAD_DEST) : null;
        if (row && row.status === 'sent') found++;
        if (row && this.applyUploadRow(ride, row, null)) changed = true;
      }
      if (changed) { await this.saveHistory(); this.renderHistoryTable(); }
      return { checked: (rides || []).length, found };
    };
    P.sendRideToStrava = async function (rideId) {
      const ride = this.completedWorkouts.find((r) => r.id === rideId);
      if (!uploads || !ride || !this.canSendToStrava(ride) || this._stravaSending === rideId) return;
      this.prepareStravaImage(ride, true);
      let known = await uploads.state(ride.id, UPLOAD_DEST);
      const had = this.stravaStateOf(ride);
      // A ride that already carries its Strava activity (e.g. restored from a backup) goes into the ledger instead.
      if ((!known || known.status !== 'sent') && had.activityId && ['sent', 'duplicate', 'found'].includes(had.state)) {
        known = await uploads.markSent(ride.id, UPLOAD_DEST, had.activityId);
      }
      if (known && known.status === 'sent') { // already on Strava: link it, send nothing
        this.onUploadChange(ride.id, known, null);
        return this.showToast('Already on Strava - linked to the existing activity.', 'success');
      }
      this._stravaSending = rideId;
      ride.strava = { state: 'sending', startedAt: Date.now() };
      this.renderStravaPanel(ride);
      let row;
      try { row = await uploads.sendNow(ride, UPLOAD_DEST); }
      catch (e) { row = { status: 'failed', last_error: (e && e.message) || String(e) }; }
      finally { this._stravaSending = null; }
      if (row && row.status === 'sent') return this.finishStrava(ride, { state: ride.strava.state === 'duplicate' ? 'duplicate' : 'sent', activityId: row.external_id });
      if (!row || row.status !== 'queued') return this.finishStrava(ride, { state: 'failed', error: (row && row.last_error) || 'Upload failed' });
      this.applyUploadRow(ride, row, null);
      this.saveHistory();
      this.renderHistoryTable();
      if (this._reviewRideId === rideId) this.renderStravaPanel(ride);
      this.showToast(`Not sent yet (${row.last_error || 'no connection'}). It is sent automatically when the app can reach Strava.`, 'warning');
    };
    /** Rides recorded here, when "Auto-upload new rides to Strava" is on. */
    P.autoUploadRide = async function (ride) {
      if (!uploads || !this.canSendToStrava(ride) || !(await uploads.autoUpload(UPLOAD_DEST))) return;
      const row = await uploads.enqueue(ride, UPLOAD_DEST);
      this.onUploadChange(ride.id, row, null);
      await uploads.run();
    };
    const canSend = P.canSendToStrava;
    P.canSendToStrava = function (ride) { return !isFromDestination(ride, UPLOAD_DEST) && canSend.call(this, ride); };
    if (lazy) {
      // The workout card made for the upload draws the ride's samples: load them first (the queue reads its own).
      const send = P.sendRideToStrava;
      P.sendRideToStrava = async function (rideId) {
        await lazy.withSamples((this.completedWorkouts || []).find((r) => r.id === rideId));
        return send.call(this, rideId);
      };
    }
    const stravaChip = P.stravaChip;
    P.stravaChip = function (ride) {
      const st = this.stravaStateOf(ride);
      if (st.state === 'queued') return `<span class="chip chip-xs chip-strava-busy" title="${String(st.error || 'Waiting for a connection').replace(/[&<>"']/g, '')}">Strava queued</span>`;
      return stravaChip.call(this, ride);
    };
    P.connectStrava = async function () {
      this._awaitingStravaConnect = true;
      try { await strava.connect(); }
      catch (e) {
        this._awaitingStravaConnect = false;
        this.showToast(e.message, 'warning');
        this.openSettings('strava');
      }
    };
    const renderPanel = P.renderStravaPanel;
    P.renderStravaPanel = function (ride) {
      renderPanel.call(this, ride);
      const el = doc.getElementById('rideStravaPanel');
      const sv = this.strava || {};
      if (!el || !ride || ride.source === 'Strava') return;
      const st = this.stravaStateOf(ride);
      const stateEl = el.querySelector('.strava-state'), detailEl = el.querySelector('.strava-detail');
      if (st.state === 'queued' && stateEl && detailEl) {
        el.className = 'strava-panel strava-busy';
        stateEl.textContent = 'Waiting to send to Strava';
        detailEl.textContent = `${st.error ? st.error + ' ' : ''}It is sent automatically when the app opens or comes back${sv.connected ? '' : ' after you connect Strava'}.`;
        const send = el.querySelector('[data-strava="send"]');
        if (send) send.lastChild.textContent = 'Send now';
      } else if (st.state === 'none' && detailEl && el.querySelector('[data-strava="send"]')) {
        detailEl.textContent = 'Not sent from this phone yet. A workout image is prepared for you to add to the activity.';
      }
      if (sv.configured) return;
      const detail = el.querySelector('.strava-detail'), actions = el.querySelector('.strava-actions');
      if (detail && /\.env|Launch-Apex-Velo/.test(detail.textContent)) detail.textContent = 'Strava is not set up yet: add your Strava API application in Settings > Strava.';
      if (actions && !actions.querySelector('[data-native-strava]')) actions.insertAdjacentHTML('afterbegin', '<button type="button" class="btn btn-strava" data-native-strava="setup">Set up Strava</button>');
    };
    const initStravaUi = P.initStravaUi;
    P.initStravaUi = function () {
      initStravaUi.call(this);
      const app = this;
      const $ = (id) => doc.getElementById(id);
      const renderSettings = async () => {
        const [c, st] = await Promise.all([strava.credentials(), strava.status()]);
        if (c && $('nativeStravaClientId') && !$('nativeStravaClientId').value) $('nativeStravaClientId').value = c.clientId;
        if (c && $('nativeStravaSecret') && !$('nativeStravaSecret').value) $('nativeStravaSecret').placeholder = 'Saved - leave blank to keep it';
        const el = $('nativeStravaStatus');
        if (el) el.innerHTML = !st.configured ? '<span class="dim">Not set up yet.</span>'
          : st.connected ? `<span>Connected${st.athlete ? ' as <b>' + String(st.athlete).replace(/[&<>"']/g, '') + '</b>' : ''}.</span>`
            : '<span class="dim">Saved. Press Connect Strava to sign in.</span>';
        if ($('btnNativeStravaConnect')) $('btnNativeStravaConnect').disabled = !st.configured;
        if ($('btnNativeStravaDisconnect')) $('btnNativeStravaDisconnect').hidden = !st.connected;
        if (!uploads) return;
        if ($('nativeStravaAuto')) $('nativeStravaAuto').checked = await uploads.autoUpload(UPLOAD_DEST);
        const q = await uploads.summary(UPLOAD_DEST), parts = [];
        if (q.queued) parts.push(`${q.queued} ride${q.queued === 1 ? '' : 's'} waiting to upload${q.nextAt > Date.now() ? ` (next try ${hhmm(q.nextAt)})` : ''}`);
        if (q.failed) parts.push(`${q.failed} failed (open the ride to retry)`);
        if (q.sent) parts.push(`${q.sent} sent from this phone`);
        if ($('nativeStravaQueue')) $('nativeStravaQueue').innerHTML = parts.length ? `<span class="dim">${parts.join(' &middot; ')}</span>` : '';
      };
      this._renderNativeStrava = renderSettings;
      const on = (id, fn) => this.on($(id), 'click', fn);
      on('btnNativeStravaSave', async () => {
        const id = $('nativeStravaClientId').value, secret = $('nativeStravaSecret').value || (await strava.credentials())?.clientSecret;
        try {
          await strava.setCredentials(id, secret);
          $('nativeStravaSecret').value = '';
          await app.refreshStravaStatus(false);
          app.showToast('Strava application saved. Now press Connect Strava.', 'success');
        } catch (e) { app.showToast(e.message, 'warning'); }
        renderSettings();
      });
      on('btnNativeStravaConnect', () => app.connectStrava());
      if (uploads) {
        this.on($('nativeStravaAuto'), 'change', async (e) => {
          const on = e.currentTarget.checked;
          await uploads.setAutoUpload(UPLOAD_DEST, on);
          app.showToast(on ? 'New rides will be sent to Strava when they finish.' : 'Auto-upload is off. Send rides from their summary.', 'info');
        });
        uploads.onChange = (rideId, row, result) => app.onUploadChange(rideId, row, result);
      }
      on('btnNativeStravaDisconnect', () => app.disconnectStrava().then(renderSettings));
      this.on($('modalRideDetails'), 'click', (e) => {
        if (e.target.closest('[data-native-strava="setup"]')) { app.closeModal('rideSummaryModal'); app.openSettings('strava'); }
      });
      renderSettings().catch(() => {});
    };
    const showSection = P.showSettingsSection;
    P.showSettingsSection = function (sec) {
      if (['backups', 'phone'].includes(sec) || (sec === 'ai' && !ai) || (sec === 'health' && !icu)) sec = 'rider'; // sections that need the PC
      showSection.call(this, sec);
      if (sec === 'strava' && this._renderNativeStrava) this._renderNativeStrava().catch(() => {});
      if (sec === 'ai' && this._renderNativeAiKeys) this._renderNativeAiKeys().catch(() => {});
    };

    // ------------------------------------------------------------ health (intervals.icu) --
    if (icu) {
      const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const fromIcu = (t) => String(t ?? '').replace(/Apple Health/g, 'intervals.icu');
      /**
       * Replaces the PC's Health Auto Export inbox: reads intervals.icu wellness into the same day store.
       * The first read (or `backfill`) takes all history velo-health keeps; later ones the last week, at
       * most once an hour unless forced. intervals.icu days replace whatever the store had for that day.
       */
      P.pullHealthInbox = async function ({ force = false, announce = false, backfill = false } = {}) {
        if (this._healthBusy) return { ok: false };
        const st = await icu.status();
        if (!st.configured) {
          if (announce) this.showToast('Add your intervals.icu API key in Settings > Health first.', 'info');
          return { ok: false };
        }
        const full = backfill || st.needsBackfill; // first sync, or the app now keeps more fields
        if (!full && !force && Date.now() - st.lastSync < HEALTH_SYNC_EVERY_MS) return { ok: true, added: 0 };
        this._healthBusy = true;
        let added = 0, days = 0;
        try {
          const r = await icu.wellness(localDay(), full ? BACKFILL_DAYS : RECENT_DAYS);
          days = Object.keys(r.days).length;
          // With Health Connect the days of both sources are kept and merged (Settings > Health picks the order).
          const sources = wellness ? await wellness.catch(() => null) : null;
          if (sources) added = await sources.apply(this.healthStore.days, 'icu', r.days);
          else {
            for (const [day, rec] of Object.entries(r.days)) {
              if (JSON.stringify(this.healthStore.days[day]) === JSON.stringify(rec)) continue;
              this.healthStore.days[day] = rec;
              added++;
            }
          }
          if (added) this.saveHealthStore();
          this._healthError = null;
        } catch (e) {
          this._healthError = (e && e.message) || String(e);
          if (!e || !e.status) this._healthError = `Could not reach intervals.icu (${this._healthError}). Check your internet connection.`;
        } finally {
          this._healthBusy = false;
        }
        if (added) { this.refreshHealthDerived(); this.afterHealthChange(); }
        if (announce) {
          this.showToast(this._healthError || (full ? `intervals.icu: ${days} day${days === 1 ? '' : 's'} with health data read, ${added} new or changed.` : added ? `intervals.icu: ${added} day${added === 1 ? '' : 's'} updated.` : 'intervals.icu: up to date.'), this._healthError ? 'warning' : 'success');
        }
        return { ok: !this._healthError, added, days };
      };
      P.fetchHealthStatus = async function () { this._healthStatus = await icu.status(); return this._healthStatus; };
      P.renderHealthSettings = async function () {
        const st = await this.fetchHealthStatus();
        const box = doc.getElementById('healthStatus');
        if (!box) return;
        const keyField = doc.getElementById('nativeIcuKey');
        if (keyField) keyField.placeholder = st.configured ? 'Saved - leave blank to keep it' : 'Letters and numbers';
        ['btnHealthRefresh', 'btnNativeIcuBackfill', 'btnNativeIcuRemove', 'nativeIcuHrvGroup'].forEach((id) => { const b = doc.getElementById(id); if (b) b.hidden = !st.configured; });
        const hrvSelect = doc.getElementById('nativeIcuHrv');
        if (hrvSelect) hrvSelect.value = st.hrvMode;
        if (!st.configured) { box.innerHTML = '<span class="dim">Not set up yet.</span>'; return; }
        const days = this.healthDays || [];
        const last = days[days.length - 1];
        const when = st.lastSync ? new Date(st.lastSync).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'not yet';
        const kv = (k, v) => `<div><span>${esc(k)}</span><b>${v}</b></div>`;
        box.innerHTML = [
          kv('Account', esc((st.athlete && st.athlete.name) || 'connected')),
          kv('Last sync', esc(when)),
          kv('Days stored', `${days.length}${last ? ` <small class="dim">latest ${esc(last.day)}</small>` : ''}`),
          kv('HRV', st.hrvField === 'hrvSDNN' ? 'SDNN (Apple Watch)' : st.hrvField === 'hrv' ? 'Overnight rMSSD' : '<span class="dim">none yet</span>'),
          kv('Sleep stages', days.some((d) => d.deepH !== null && d.deepH !== undefined) ? 'deep, light (core) and REM' : '<span class="dim">total sleep only</span>'),
          kv('Readiness', esc(this.readinessText(this.healthReadiness()))),
          this._healthError ? `<div class="backup-warn">${esc(this._healthError)}</div>` : ''
        ].join('');
      };
      const setText = P.setText;
      const RENAMED = new Set(['calRecoveryHint', 'anaReadinessNote']);
      P.setText = function (id, text) { return setText.call(this, id, RENAMED.has(id) ? fromIcu(text) : text); };
      const chips = P.renderReadinessChips;
      P.renderReadinessChips = function () {
        chips.call(this);
        ['cockpitReadinessChip', 'coachReadinessChip', 'anaReadinessChip'].forEach((id) => {
          const el = doc.getElementById(id);
          if (!el) return;
          el.textContent = fromIcu(el.textContent).replace('No intervals.icu data', 'No health data');
          el.title = fromIcu(el.title).replace('Set up intervals.icu in Settings.', 'Add your intervals.icu API key in Settings > Health.');
        });
      };
      const initHealth = P.initHealth;
      P.initHealth = function () {
        initHealth.call(this);
        const app = this;
        const $ = (id) => doc.getElementById(id);
        const busy = async (btn, fn) => {
          if (btn) btn.disabled = true;
          try { await fn(); } finally { if (btn) btn.disabled = false; app.renderHealthSettings().catch(() => {}); }
        };
        this.on($('btnNativeIcuSave'), 'click', (e) => busy(e.currentTarget, async () => {
          const input = $('nativeIcuKey');
          const value = input && input.value.trim();
          if (value) {
            try { await icu.setKey(value); input.value = ''; }
            catch (err) { app.showToast(err.message, 'warning'); return; }
          } else if (!(await icu.status()).configured) { app.showToast('Paste your intervals.icu API key first.', 'info'); return; }
          await app.pullHealthInbox({ force: true, announce: true, backfill: true });
        }));
        this.on($('nativeIcuHrv'), 'change', (e) => busy(e.currentTarget, async () => {
          await icu.setHrvMode($('nativeIcuHrv').value);
          await app.pullHealthInbox({ force: true, announce: true, backfill: true });
        }));
        this.on($('btnNativeIcuBackfill'), 'click', (e) => busy(e.currentTarget, () => app.pullHealthInbox({ force: true, announce: true, backfill: true })));
        this.on($('btnNativeIcuRemove'), 'click', (e) => busy(e.currentTarget, async () => {
          if (!confirm('Remove the intervals.icu API key from this phone? The health days already stored stay.')) return;
          await icu.removeKey();
          app.showToast('intervals.icu API key removed from this phone.', 'success');
        }));
      };
    }

    // ------------------------------------------------------------------------ Health Connect --
    if (healthConnect) {
      const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      /* global VeloRideImporter, VeloDedupe, VeloRideSummary */
      const importer = () => (typeof VeloRideImporter !== 'undefined' ? VeloRideImporter : win.VeloRideImporter);
      const dedupe = () => (typeof VeloDedupe !== 'undefined' ? VeloDedupe : win.VeloDedupe);
      /**
       * Reads Health Connect: the backfill on the first run, then the changes. Days go into wellness_days and
       * the merged health store (saved as they arrive, so a killed app keeps them); rides into the history.
       * At app start always, on resume at most every 15 minutes unless forced.
       */
      P.syncHealthConnect = async function ({ force = false, announce = false } = {}) {
        const sources = wellness ? await wellness.catch(() => null) : null;
        if (!sources) {
          if (announce) this.showToast('Health Connect needs the phone database, which could not be opened.', 'warning');
          return null;
        }
        if (!force && this._hcLastSync && Date.now() - this._hcLastSync < RESUME_SYNC_MS) return null;
        this._hcLastSync = Date.now();
        const app = this;
        let days = 0, rides = 0, res = null;
        const handlers = {
          async days(map) {
            const n = await sources.apply(app.healthStore.days, HC_SOURCE, map);
            if (n) { days += n; app.saveHealthStore(); }
          },
          async sessions(list) {
            const profile = app.activeProfile || {};
            const made = list.map(({ session, series }) => toRide(session, series, { ftp: Number(profile.ftp) || 0, profileName: profile.name || '', summarize: (s, f, m) => importer().summarize(s, f, m) }));
            const r = importRides(app.completedWorkouts, made, dedupe());
            const changed = [...r.added, ...r.replaced, ...r.updated];
            if (!changed.length) return;
            rides += changed.length;
            // As after a bulk import: once saved, the rides keep only their summary in memory (the analytics read
            // sampleSummary; a view of one ride loads its samples from the phone database).
            const saved = await app.saveHistory();
            const RS = typeof VeloRideSummary !== 'undefined' ? VeloRideSummary : win.VeloRideSummary;
            if (saved !== false && storage && RS) {
              for (const ride of changed) { const sum = RS.of(ride); if (sum) ride.sampleSummary = sum; delete ride.samples; }
            }
          },
          async removed(ids) {
            const gone = removeRides(app.completedWorkouts, ids);
            if (gone.length) { rides += gone.length; await app.saveHistory(); }
            return gone.length;
          },
          daysWithIds: (ids) => sources.daysWithIds(ids)
        };
        this._hcBusy = true;
        this.renderHealthConnect().catch(() => {});
        try {
          res = await healthConnect.sync(handlers, { today: localDay(), onProgress: (done, total) => { this._hcProgress = `${done} of ${total} days`; this.renderHealthConnect().catch(() => {}); } });
          this._hcError = null;
        } catch (e) {
          this._hcError = `Health Connect: ${(e && e.message) || e}`;
        } finally {
          this._hcBusy = false; this._hcProgress = null;
        }
        if (days) { this.refreshHealthDerived(); this.afterHealthChange(); }
        if (rides) { this.renderHistoryTable(); this.refreshAnalytics(); }
        if (announce) {
          this.showToast(this._hcError || (res && (res.days || res.sessions) ? `Health Connect: ${days} day${days === 1 ? '' : 's'} and ${rides} ride${rides === 1 ? '' : 's'} added or updated.` : 'Health Connect: up to date.'), this._hcError ? 'warning' : 'success');
        }
        this.renderHealthConnect().catch(() => {});
        return res;
      };

      P.renderHealthConnect = async function () {
        const box = doc.getElementById('nativeHcStatus');
        if (!box) return;
        const st = await healthConnect.status();
        const $ = (id) => doc.getElementById(id);
        const av = st.availability.status, ok = av === 'available', g = st.granted || { read: [], write: [] };
        const kv = (k, v) => `<div><span>${esc(k)}</span><b>${v}</b></div>`;
        const text = { available: 'Available', not_installed: 'Not installed', update_required: 'Needs an update', unsupported: 'Not available on this phone (Android 9 or newer)' }[av] || esc(av);
        const last = st.state && st.state.lastSync ? new Date(st.state.lastSync).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'not yet';
        box.innerHTML = [
          kv('Health Connect', text),
          ok ? kv('Last sync', this._hcBusy ? `syncing${this._hcProgress ? ` (${esc(this._hcProgress)})` : ''}...` : esc(last)) : '',
          this._hcError ? `<div class="backup-warn">${esc(this._hcError)}</div>` : ''
        ].join('');
        const install = $('btnNativeHcInstall');
        if (install) { install.hidden = !['not_installed', 'update_required'].includes(av); install.textContent = av === 'update_required' ? 'Update Health Connect' : 'Get Health Connect'; }
        ['nativeHcGroups', 'btnNativeHcSync', 'btnNativeHcManage', 'btnNativeHcDisconnect'].forEach((id) => { if ($(id)) $(id).hidden = !ok; });
        doc.querySelectorAll('#nativeHc .native-toggle, #nativeHc .native-hc-prefs').forEach((el) => { el.hidden = !ok; });
        doc.querySelectorAll('[data-hc-type]').forEach((li) => {
          const [mode, type] = li.dataset.hcType.split(':');
          const on = (mode === 'write' ? g.write : g.read).includes(type);
          li.classList.toggle('granted', on);
          li.querySelector('.native-hc-mark').textContent = on ? '✓' : '–';
        });
        doc.querySelectorAll('[data-hc-request]').forEach((b) => {
          const [, , types, mode] = HC_GROUPS.find((x) => x[0] === b.dataset.hcRequest);
          const all = types.every((t) => (mode === 'write' ? g.write : g.read).includes(t));
          b.textContent = all ? 'Allowed' : 'Allow';
          b.disabled = all;
        });
        if ($('nativeHcAutoWrite')) { $('nativeHcAutoWrite').checked = !!uploads && await uploads.autoUpload(HC_SOURCE); $('nativeHcAutoWrite').disabled = !g.write.includes('ExerciseSession'); }
        if ($('nativeHcBackground')) $('nativeHcBackground').checked = !!g.background && await healthConnect.backgroundOn();
        const sources = wellness ? await wellness.catch(() => null) : null;
        if (sources) {
          const prefs = await sources.fieldPrefs();
          doc.querySelectorAll('[data-hc-pref]').forEach((sel) => { sel.value = prefs[sel.dataset.hcPref]; });
        }
      };

      const renderHealth = P.renderHealthSettings;
      P.renderHealthSettings = async function (...args) {
        await renderHealth.apply(this, args);
        await this.renderHealthConnect().catch(() => {});
      };

      const initHealthHc = P.initHealth;
      P.initHealth = function () {
        initHealthHc.call(this);
        const app = this;
        const $ = (id) => doc.getElementById(id);
        const busy = async (btn, fn) => {
          if (btn) btn.disabled = true;
          try { await fn(); } catch (e) { app.showToast((e && e.message) || String(e), 'warning'); } finally { if (btn) btn.disabled = false; app.renderHealthConnect().catch(() => {}); }
        };
        this.on($('btnNativeHcInstall'), 'click', () => plugins.HealthConnect.openInstall().catch(() => {}));
        this.on($('btnNativeHcManage'), 'click', () => plugins.HealthConnect.openSettings().catch(() => {}));
        this.on($('nativeHcGroups'), 'click', (e) => {
          const b = e.target.closest('[data-hc-request]');
          if (!b) return;
          busy(b, async () => {
            const g = await healthConnect.request(b.dataset.hcRequest);
            if (b.dataset.hcRequest === 'write' && g.write.includes('ExerciseSession') && uploads) await uploads.setAutoUpload(HC_SOURCE, true);
            if (b.dataset.hcRequest !== 'write' && g.read.length) await app.syncHealthConnect({ force: true, announce: true });
          });
        });
        this.on($('btnNativeHcSync'), 'click', (e) => busy(e.currentTarget, () => app.syncHealthConnect({ force: true, announce: true })));
        this.on($('nativeHcAutoWrite'), 'change', (e) => busy(null, async () => {
          const on = e.currentTarget.checked;
          if (!uploads) return;
          await uploads.setAutoUpload(HC_SOURCE, on);
          app.showToast(on ? 'Rides you record will be saved to Health Connect.' : 'Rides are no longer saved to Health Connect.', 'info');
        }));
        this.on($('nativeHcBackground'), 'change', (e) => busy(null, async () => {
          const wanted = e.currentTarget.checked;
          const on = await healthConnect.setBackground(wanted);
          if (wanted && !on) app.showToast('Health Connect did not allow reading in the background. The app still syncs when it opens.', 'info');
        }));
        this.on($('nativeHc'), 'change', (e) => {
          const sel = e.target.closest('[data-hc-pref]');
          if (!sel || !MERGE_FIELDS[sel.dataset.hcPref]) return;
          busy(sel, async () => {
            const sources = await wellness;
            await sources.setFieldPref(sel.dataset.hcPref, sel.value);
            if (await sources.remerge(app.healthStore.days)) { app.saveHealthStore(); app.refreshHealthDerived(); app.afterHealthChange(); }
          });
        });
        this.on($('btnNativeHcDisconnect'), 'click', (e) => busy(e.currentTarget, async () => {
          if (!confirm('Disconnect Health Connect? Apex Velo loses its Health Connect permissions. Days and rides already read stay.')) return;
          await plugins.HealthConnect.disconnect();
          await healthConnect.reset();
          if (uploads) await uploads.setAutoUpload(HC_SOURCE, false);
          app.showToast('Health Connect disconnected.', 'success');
        }));
      };
    }

    // ----------------------------------------------------------------------- AI engine --
    if (ai) {
      const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      /* global VeloAiCoach */
      const AC = typeof VeloAiCoach !== 'undefined' ? VeloAiCoach : win.VeloAiCoach;
      // The coach status text: "on this phone" instead of the local server and .env.
      const updateEngine = P.updateCoachEngineStatus;
      P.updateCoachEngineStatus = function () {
        updateEngine.call(this);
        const detail = doc.getElementById('aiCoachEngineDetail'), c = this.aiCoach;
        if (!detail || !c || !AC) return;
        const m = c.model;
        const modelText = `${AC.labelFor(m)}${AC.supportsEffort(m) ? ` - ${c.effort} effort` : ''}`;
        const keys = Object.values(c.engine.providers || {}).map((p) => `${esc(p.label)} ${p.configured ? 'key saved' : 'no key'}`).join(' &middot; ');
        detail.innerHTML = c.isLive
          ? `<strong>Ready.</strong> Requests go from this phone to ${esc(modelText)}. <span style="opacity:.7">(${keys})</span>`
          : `<strong>No ${esc(c.providerLabel)} API key.</strong> Paste it below and press Save keys, or pick a provider whose key is saved. Until then the offline engine is used. <span style="opacity:.7">(${keys})</span>`;
        const pill = doc.getElementById('aiCoachEngineStatus');
        if (pill && !c.isLive) pill.innerHTML = `<span class="status-indicator-dot"></span>${esc(c.providerLabel)}: add an API key`;
      };
      const updateAsk = P.updateAskEngine;
      if (updateAsk) {
        P.updateAskEngine = function () {
          updateAsk.call(this);
          const c = this.aiCoach;
          if (c && !c.isLive) this.setText('askEngineWarnText', `Ask needs a ${c.providerLabel} API key. Add it in Settings > AI engine.`);
        };
      }
      const breakdown = P.intervalBreakdownHtml;
      if (breakdown) {
        P.intervalBreakdownHtml = function (record) {
          return String(breakdown.call(this, record) || '').replace('Add an Anthropic, Gemini or OpenAI key to .env for an AI coach breakdown', 'Add an Anthropic, Gemini or OpenAI key in Settings &gt; AI engine for an AI coach breakdown');
        };
      }
      const initSettingsAi = P.initSettings;
      P.initSettings = function () {
        initSettingsAi.call(this);
        const app = this;
        const field = (id) => doc.getElementById(`nativeAiKey-${id}`);
        const render = async () => {
          const keys = await ai.keys();
          for (const f of AI_KEY_FIELDS) {
            const input = field(f.id);
            if (input) input.placeholder = keys[f.id] ? `Saved (...${keys[f.id].slice(-4)}) - leave blank to keep it` : f.placeholder;
            const rm = doc.querySelector(`[data-native-ai-remove="${f.id}"]`);
            if (rm) rm.hidden = !keys[f.id];
          }
        };
        this._renderNativeAiKeys = render;
        this.on(doc.getElementById('btnNativeAiSaveKeys'), 'click', async () => {
          let saved = 0;
          try {
            for (const f of AI_KEY_FIELDS) {
              const input = field(f.id);
              if (!input || !input.value.trim()) continue;
              await ai.setKey(f.id, input.value);
              input.value = '';
              saved++;
            }
          } catch (e) { app.showToast(e.message, 'warning'); await render(); return; }
          await render();
          if (!saved) { app.showToast('Paste an API key first.', 'info'); return; }
          if (app.refreshCoachEngine) await app.refreshCoachEngine(true); // reads the live model lists and says whether the key works
        });
        this.on(doc.getElementById('nativeAiKeys'), 'click', async (e) => {
          const b = e.target.closest('[data-native-ai-remove]');
          if (!b) return;
          await ai.setKey(b.dataset.nativeAiRemove, '');
          await render();
          if (app.refreshCoachEngine) await app.refreshCoachEngine(false);
          app.showToast('API key removed from this phone.', 'success');
        });
        render().catch(() => {});
      };
    }
  });

  // Strava sign-in returns through the apexvelo:// link (also when Android restarted the app meanwhile).
  const whenApp = async () => { for (let i = 0; i < 100 && !win.app; i++) await new Promise((r) => setTimeout(r, 100)); return win.app; };
  // Rides saved before summaries existed get them in the background, a few seconds after the start.
  if (storage) whenApp().then((app) => app && win.VeloStorage && win.VeloStorage.enabled && app.backfillRideSummaries
    && new Promise((r) => setTimeout(r, 3000)).then(() => app.backfillRideSummaries())).catch(() => {});
  const onAppUrl = async ({ url }) => {
    if (!strava.isRedirect(url)) return;
    Browser.close().catch(() => {});
    const r = await strava.handleRedirect(url);
    const app = await whenApp();
    if (!app) return;
    app._awaitingStravaConnect = false;
    if (!r.ok) { app.showToast(r.error, 'warning'); return; }
    await app.refreshStravaStatus(true);
    if (app._renderNativeStrava) app._renderNativeStrava().catch(() => {});
    if (uploads) uploads.run().catch(() => {}); // rides that waited for the sign-in
  };
  App.addListener('appUrlOpen', onAppUrl);
  App.getLaunchUrl().then((r) => { if (r && r.url) onAppUrl(r); }).catch(() => {});
  // Uploads left in the queue by the last session go out at app start.
  if (uploads) whenApp().then((app) => { if (app) return uploads.run(); }).catch(() => {});
  if (healthConnect) whenApp().then((app) => { if (app && app.syncHealthConnect && !win.__APEX_TEST_MODE__) return app.syncHealthConnect({ force: true }); }).catch(() => {});
  App.addListener('resume', () => {
    const app = win.app;
    if (!app) return;
    if (app._awaitingStravaConnect) app.refreshStravaStatus(true);
    if (uploads) uploads.run().catch(() => {}); // the offline retry queue
    if (icu && app.pullHealthInbox) app.pullHealthInbox().catch(() => {}); // at most hourly
    if (healthConnect && app.syncHealthConnect) app.syncHealthConnect().catch(() => {}); // at most every 15 minutes
  });

  // Android back: close the chooser, then the top dialog, then Zen; never quit mid-ride.
  App.addListener('backButton', () => {
    if (bluetooth && bluetooth.cancelChooser()) return;
    const app = win.app;
    const open = [...doc.querySelectorAll('.modal-overlay.open')].pop();
    if (open && app) { app.closeModal(open.id); return; }
    const zen = doc.getElementById('zenCockpitOverlay');
    if (zen && zen.style.display !== 'none') { const b = doc.getElementById('btnCloseZenCockpit'); if (b) { b.click(); return; } }
    const cockpit = doc.querySelector('.nav-btn[data-tab="cockpit"]');
    if (cockpit && !cockpit.classList.contains('active')) { cockpit.click(); return; }
    App.minimizeApp().catch(() => {});
  });
}
