/**
 * Fits the desktop web app (index.html + js/) into the Android shell without editing it.
 *
 * Runs on DOMContentLoaded, after every app script has loaded but before js/app.js creates VeloApp
 * (this listener is registered first, from <head>). It:
 *   - answers /api/ requests on the phone (Strava, the AI coach and Ask; everything else that needs the
 *     PC is switched off),
 *   - keeps rides and settings in the app's own storage (IndexedDB + localStorage in the WebView),
 *   - adds Settings > Strava for the rider's own Strava API application, and the sign-in redirect,
 *   - adds the API key fields to Settings > AI engine (the keys stay in Android app storage),
 *   - keeps the screen on during a ride, shares exported files, and handles the Android back button.
 *
 * Dropped in this version (they need the PC server or another device): phone remote view,
 * Apple Health import and server backups.
 */

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const AI_PATHS = ['/api/coach', '/api/coach/status', '/api/ask'];

/**
 * Same-origin /api/ calls never leave the WebView as such: Strava and the AI engine are answered here,
 * the rest reports "not in the app". `routes` is { strava, ai }.
 */
export function installApiRoutes(routes, win = window) {
  if (win.__APEX_DEMO_MODE__) return; // the demo playground blocks /api/ itself
  const { strava, ai } = routes;
  const realFetch = win.fetch.bind(win);
  win.fetch = async function (input, options = {}) {
    const url = new URL(typeof input === 'string' ? input : (input && input.url) || String(input), win.location.href);
    if (url.origin !== win.location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, options);
    const method = String(options.method || (input && input.method) || 'GET').toUpperCase();
    const readBody = async () => typeof options.body === 'string' ? options.body : options.body ? await new Response(options.body).text() : '';
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
        <p class="field-help">Rides are sent to Strava and synced from it with your own free Strava API application, the same one the desktop app uses.</p>
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
        <p class="field-help">The secret and sign-in stay in this app's private storage on the phone. They are not part of exports.</p>
      </section>`;
}

/** Settings > Strava: the DOM must exist before VeloApp binds the settings tabs. */
function addSettingsUi(doc) {
  const nav = doc.getElementById('settingsNav');
  if (nav && !nav.querySelector('[data-sec="strava"]')) {
    const b = doc.createElement('button');
    b.type = 'button'; b.className = 'cat-pill'; b.dataset.sec = 'strava'; b.textContent = 'Strava';
    const rider = nav.querySelector('[data-sec="rider"]');
    rider ? rider.after(b) : nav.prepend(b);
    const files = doc.createElement('button');
    files.type = 'button'; files.className = 'cat-pill'; files.dataset.sec = 'files'; files.textContent = 'Ride files';
    b.after(files);
    const riderSection = doc.querySelector('#settingsModal .settings-section[data-sec="rider"]');
    if (riderSection) riderSection.insertAdjacentHTML('afterend', stravaSection() + filesSection());
  }
  const status = doc.getElementById('localStorageStatus');
  if (status) status.textContent = 'Saved on this phone.';
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

export function bootNativeApp({ bluetooth, strava, ai, plugins, win = window }) {
  const doc = win.document;
  const { App, Browser, KeepAwake, Filesystem, Share } = plugins;
  doc.documentElement.classList.add('apex-native');
  installApiRoutes({ strava, ai }, win);

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
    addSettingsUi(doc);
    if (ai) addAiSettingsUi(doc);
    // `class VeloApp` in js/app.js is a global binding of the page's scripts, not a window property.
    /* global VeloApp, VeloExport */
    const App_ = typeof VeloApp !== 'undefined' ? VeloApp : win.VeloApp;
    const V = win.VeloStorage, P = App_ && App_.prototype;
    if (V) {
      // No PC database: the app's own IndexedDB/localStorage (persistent in the WebView) is the store.
      V.boot = async () => {};
      V.render = () => { const el = doc.getElementById('localStorageStatus'); if (el) { el.textContent = 'Saved on this phone. Use History > Export to keep a copy elsewhere.'; el.classList.remove('backup-warn'); } };
    }
    if (!P) return;

    // ------------------------------------------------------------ features that need the PC --
    P.initRemoteView = function () { this.remoteTrace = []; this.remoteLastTraceSecond = -1; this._remoteEnabled = false; };
    P.pullHealthInbox = async function () {};
    P.fetchHealthStatus = async function () { return null; };
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
      if (!el || sv.configured || !ride || ride.source === 'Strava') return;
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
      on('btnNativeStravaDisconnect', () => app.disconnectStrava().then(renderSettings));
      this.on($('modalRideDetails'), 'click', (e) => {
        if (e.target.closest('[data-native-strava="setup"]')) { app.closeModal('rideSummaryModal'); app.openSettings('strava'); }
      });
      renderSettings().catch(() => {});
    };
    const showSection = P.showSettingsSection;
    P.showSettingsSection = function (sec) {
      if (['health', 'backups', 'phone'].includes(sec) || (sec === 'ai' && !ai)) sec = 'rider'; // sections that need the PC
      showSection.call(this, sec);
      if (sec === 'strava' && this._renderNativeStrava) this._renderNativeStrava().catch(() => {});
      if (sec === 'ai' && this._renderNativeAiKeys) this._renderNativeAiKeys().catch(() => {});
    };

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
  };
  App.addListener('appUrlOpen', onAppUrl);
  App.getLaunchUrl().then((r) => { if (r && r.url) onAppUrl(r); }).catch(() => {});
  App.addListener('resume', () => { const app = win.app; if (app && app._awaitingStravaConnect) app.refreshStravaStatus(true); });

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
