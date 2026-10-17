/**
 * Fits the desktop web app (index.html + js/) into the Android shell without editing it.
 *
 * Runs on DOMContentLoaded, after every app script has loaded but before js/app.js creates VeloApp
 * (this listener is registered first, from <head>). It:
 *   - answers /api/ requests on the phone (Strava; everything else that needs the PC is switched off),
 *   - keeps rides and settings in the app's own storage (IndexedDB + localStorage in the WebView),
 *   - adds Settings > Strava for the rider's own Strava API application, and the sign-in redirect,
 *   - keeps the screen on during a ride, shares exported files, and handles the Android back button.
 *
 * Dropped in this first version (they need the PC server or another device): phone remote view,
 * Apple Health import, server backups, and the cloud AI engine / Ask tab (the offline coach still
 * builds workouts and plans).
 */

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Same-origin /api/ calls never leave the phone: Strava is answered here, the rest reports "not in the app". */
export function installApiRoutes(strava, win = window) {
  if (win.__APEX_DEMO_MODE__) return; // the demo playground blocks /api/ itself
  const realFetch = win.fetch.bind(win);
  win.fetch = async function (input, options = {}) {
    const url = new URL(typeof input === 'string' ? input : (input && input.url) || String(input), win.location.href);
    if (url.origin !== win.location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, options);
    const method = String(options.method || (input && input.method) || 'GET').toUpperCase();
    try {
      if (url.pathname.startsWith('/api/strava/')) {
        const body = typeof options.body === 'string' ? options.body : options.body ? await new Response(options.body).text() : '';
        const r = await strava.route(url.pathname, method, url.searchParams, body);
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
  [/Web Bluetooth needs Chrome, Edge or Brave on https:\/\/ or localhost\./, 'Bluetooth is not available on this phone.']
];

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
    const riderSection = doc.querySelector('#settingsModal .settings-section[data-sec="rider"]');
    if (riderSection) riderSection.insertAdjacentHTML('afterend', stravaSection());
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

export function bootNativeApp({ bluetooth, strava, plugins, win = window }) {
  const doc = win.document;
  const { App, Browser, KeepAwake, Filesystem, Share } = plugins;
  doc.documentElement.classList.add('apex-native');
  installApiRoutes(strava, win);

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
    // `class VeloApp` in js/app.js is a global binding of the page's scripts, not a window property.
    /* global VeloApp */
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
    P.downloadBlob = async function (filename, blob) {
      try {
        const safe = String(filename).replace(/[^\w.\-]+/g, '_');
        const res = await Filesystem.writeFile({ path: safe, data: await blobToBase64(blob), directory: 'CACHE' });
        await Share.share({ title: safe, files: [res.uri] });
      } catch (e) {
        if (!/cancel/i.test(String((e && e.message) || e))) this.showToast(`Could not share ${filename}: ${(e && e.message) || e}`, 'error');
      }
    };
    P.downloadFile = function (filename, content, type) { return this.downloadBlob(filename, new Blob([content], { type })); };
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
      if (['ai', 'health', 'backups', 'phone'].includes(sec)) sec = 'rider'; // sections that need the PC
      showSection.call(this, sec);
      if (sec === 'strava' && this._renderNativeStrava) this._renderNativeStrava().catch(() => {});
    };
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
