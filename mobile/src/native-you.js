/**
 * The You tab (docs/ANDROID-UX.md 2.3, workstream U5): Profile, Devices, Connections, Your data, App settings and
 * Help & about. It replaces the Settings modal, the profile modal and the header's rider, Sim and audio controls.
 *
 * Nothing is copied: the Settings sections (js/ and the Android layer's own: Strava, Ride files, Import folder,
 * Health, AI engine, About), the profile form and History's training-load card are moved into the pages, so their
 * ids and bindings keep working. app.openSettings(section) and app.openModal('profileManagerModal') open the
 * matching page, so every link into Settings elsewhere in the app lands on its new home.
 */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Settings section (app.openSettings) -> the You page that now holds it. */
export const SECTION_ROUTES = {
  rider: 'you/profile',
  strava: 'you/connections/strava',
  health: 'you/connections/icu',
  ai: 'you/connections/ai',
  files: 'you/data',
  importfolder: 'you/data',
  backups: 'you/data/backups',
  guide: 'you/help/guide',
  about: 'you/help',
  phone: 'you'
};

const CSS = `
.av-you .settings-section { display: block !important; }
.av-you .card > .settings-section > :first-child { margin-top: 0; }
.av-you .form-group, .av-you .field { margin-bottom: 12px; }
.av-you #btnSettingsEditRider, .av-you .modal-header { display: none !important; }
.av-you details.av-more { margin-top: 4px; }
.av-you details.av-more > summary { justify-content: flex-start; padding: 0 4px; }
.av-split { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--line); }
.av-split:last-child { border-bottom: 0; }
.av-split > .av-row { flex: 1; min-width: 0; border-bottom: 0; }
.av-split > .btn { min-height: 44px; flex: none; }
.av-you :is(input:not([type=checkbox]), select, .btn), .av-onb :is(input, .btn) { min-height: 44px; }
.av-you summary { display: flex; align-items: center; min-height: 44px; }
.av-you .native-toggle { display: flex; align-items: center; gap: 10px; min-height: 44px; }
.av-you input[type=checkbox] { appearance: none; position: relative; flex: none; width: 52px; height: 44px; margin: 0; cursor: pointer; }
.av-you input[type=checkbox]::before { content: ''; position: absolute; left: 3px; right: 3px; top: 8px; height: 28px; border-radius: 99px; background: rgba(255, 255, 255, .12); }
.av-you input[type=checkbox]::after { content: ''; position: absolute; top: 11px; left: 6px; width: 22px; height: 22px; border-radius: 50%; background: #fff; transition: left .2s; }
.av-you input[type=checkbox]:checked::before { background: linear-gradient(135deg, var(--zone-a), var(--zone-b)); }
.av-you input[type=checkbox]:checked::after { left: 24px; }
.av-you-avatar { display: grid; place-items: center; width: 44px; height: 44px; flex: none; border-radius: 50%; font-weight: 700;
  background: linear-gradient(135deg, var(--zone-a), var(--zone-b)); color: #fff; }
`;

/** A row that opens a page, with a separate 44 px action button at the end (e.g. Connect). */
function splitRow(shell, row, action) {
  const wrap = shell.doc.createElement('div');
  wrap.className = 'av-split';
  wrap.appendChild(shell.row(row));
  if (action) {
    const b = shell.doc.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-primary';
    b.textContent = action.label;
    if (action.id) b.id = action.id;
    b.hidden = !!action.hidden;
    b.addEventListener('click', action.onClick);
    wrap.appendChild(b);
  }
  return wrap;
}

/**
 * Registers the You pages on the shell and hooks VeloApp so Settings and the profile modal open them.
 * `services` are the Android layer's objects (strava, icu, healthConnect, ai) used for the status lines.
 */
export function installYou({ shell, win = window, services = {} }) {
  const doc = win.document;
  const app = () => shell.getApp();
  const $ = (id) => doc.getElementById(id);
  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.appendChild(style);

  const page = (html = '') => {
    const el = doc.createElement('div');
    el.className = 'av-page-body av-you';
    el.innerHTML = html;
    return el;
  };
  /** Moves existing nodes (by id) into `box`, once; missing ones are skipped (e.g. no Health Connect). */
  const adopt = (box, ...ids) => {
    for (const id of ids) {
      const n = $(id);
      if (n && n.parentNode !== box) box.appendChild(n);
    }
  };
  const section = (sec) => { const a = app(); if (a && a.showSettingsSection) { try { a.showSettingsSection(sec); } catch (e) { console.error(e); } } };
  const clickId = (id) => () => { const b = $(id); if (b) b.click(); };

  // ------------------------------------------------------------------ You (root) --
  const root = page('<div class="card av-list" id="avYouList"></div>');
  const renderRoot = () => {
    const list = root.querySelector('#avYouList');
    list.innerHTML = '';
    const p = (app() && app().activeProfile) || {};
    const prof = shell.row({ title: p.name || 'Rider', sub: [p.ftp ? `FTP ${p.ftp} W` : '', p.weightKg ? `${p.weightKg} kg` : '', p.ftp && p.weightKg ? `${(p.ftp / p.weightKg).toFixed(1)} W/kg` : ''].filter(Boolean).join(' · ') || 'Name, weight, FTP, heart rate', onClick: () => shell.go('you/profile'), id: 'avYouProfile' });
    prof.insertAdjacentHTML('afterbegin', `<span class="av-you-avatar" aria-hidden="true">${esc((p.name || 'R').trim().charAt(0).toUpperCase())}</span>`);
    list.appendChild(prof);
    for (const r of [
      { icon: 'i-bluetooth', title: 'Devices', sub: 'Trainer, power meter, heart rate, fan', route: 'you/devices' },
      { icon: 'i-refresh', title: 'Connections', sub: 'Strava, Health Connect, intervals.icu, AI coach', route: 'you/connections' },
      { icon: 'i-folder', title: 'Your data', sub: 'Import, watched folder, backup, ride files', route: 'you/data' },
      { icon: 'i-gear', title: 'App settings', sub: 'Audio cues, simulator', route: 'you/app' },
      { icon: 'i-book', title: 'Help & about', sub: 'Training guide, licences', route: 'you/help' }
    ]) list.appendChild(shell.row({ ...r, id: 'avYou-' + r.route.split('/')[1], onClick: () => shell.go(r.route) }));
  };
  shell.registerPage('you', { title: 'You', el: root, mount: renderRoot });

  // ------------------------------------------------------------------ Profile --
  // The rider summary (Settings > Rider) and the profile form and list (the profile modal), on one page that opens
  // with the active rider ready to edit.
  const profile = page('<div class="card" id="avProfileForm"></div><div class="card" id="avProfileSummary"></div>');
  const fillProfile = () => {
    const a = app();
    if (a && a.populateEditProfile && a.activeProfileId) a.populateEditProfile(a.activeProfileId);
  };
  shell.registerPage('you/profile', {
    title: 'Profile', el: profile,
    mount: () => {
      adopt(profile.querySelector('#avProfileSummary'), 'settingsRiderSummary');
      const form = profile.querySelector('#avProfileForm');
      const modal = doc.querySelector('#profileManagerModal .modal-content');
      if (modal) for (const n of [...modal.children]) if (!n.classList.contains('modal-header')) form.appendChild(n);
      section('rider');
      fillProfile();
    }
  });

  // ------------------------------------------------------------------ Devices --
  const KINDS = [['trainer', 'Trainer / smart bike'], ['pedals', 'Power meter'], ['hr', 'Heart rate'], ['fan', 'Fan']];
  const devices = page('<div class="card av-list" id="avDeviceList"></div><p class="av-note">Tap a device for calibration, PowerMatch, its name, replacing or forgetting it.</p>');
  shell.registerPage('you/devices', {
    title: 'Devices', el: devices,
    mount: () => {
      const list = devices.querySelector('#avDeviceList');
      list.innerHTML = '';
      const open = clickId('btnOpenHardwareModal'); // the header's Devices button (disabled in the demo)
      for (const [k, label] of KINDS) {
        const name = ($('deviceName-' + k) || {}).textContent || label;
        const badge = doc.querySelector(`#deviceCard-${k} .hw-state`);
        list.appendChild(shell.row({ icon: k === 'hr' ? 'i-heart' : 'i-bluetooth', title: name.trim(), sub: badge ? badge.textContent.trim() : '', onClick: open, id: 'avDevice-' + k }));
      }
      list.appendChild(shell.row({ icon: 'i-plus', title: 'Pair a new device', id: 'avDevicePair', onClick: () => { open(); const d = $('deviceAddSection'); if (d) d.open = true; } }));
    }
  });

  // ------------------------------------------------------------------ Connections --
  const conns = page();
  const status = { strava: '', hc: '', icu: '', ai: '' };
  const renderConns = async () => {
    conns.innerHTML = '<p class="av-label">Send my rides to</p><div class="card av-list" id="avConnOut"></div><p class="av-label">Recovery data from</p><div class="card av-list" id="avConnIn"></div><p class="av-label">AI coach</p><div class="card av-list" id="avConnAi"></div>';
    const out = conns.querySelector('#avConnOut');
    let st = null;
    try { st = services.strava ? await services.strava.status() : null; } catch (e) { /* shown as unknown */ }
    status.strava = !st ? '' : st.connected ? `Connected${st.athlete ? ' as ' + st.athlete : ''} · uploads new rides` : 'Not connected';
    out.appendChild(splitRow(shell, { icon: 'i-upload', title: 'Strava', sub: status.strava, onClick: () => shell.go('you/connections/strava'), id: 'avConnStrava' },
      { label: 'Connect', id: 'avConnStravaConnect', hidden: !!(st && st.connected), onClick: () => { const a = app(); if (a && a.connectStrava) a.connectStrava(); } }));
    const hasHc = !!$('nativeHc');
    let hcOn = false;
    if (hasHc && services.healthConnect) {
      try {
        const s = await services.healthConnect.status();
        hcOn = !!(s.granted && (s.granted.read.length || s.granted.write.length));
        status.hc = s.availability.status !== 'available' ? 'Not installed on this phone' : hcOn ? 'Connected' : 'Not connected';
      } catch (e) { status.hc = ''; }
    }
    if (hasHc) {
      out.appendChild(splitRow(shell, { icon: 'i-heart', title: 'Health Connect', sub: status.hc, onClick: () => shell.go('you/connections/healthconnect'), id: 'avConnHc' },
        { label: 'Connect', id: 'avConnHcConnect', hidden: hcOn, onClick: () => { const b = doc.querySelector('[data-hc-request="recovery"]'); if (b) b.click(); } }));
    }
    const inn = conns.querySelector('#avConnIn');
    let icu = null;
    try { icu = services.icu ? await services.icu.status() : null; } catch (e) { /* unknown */ }
    inn.appendChild(shell.row({ icon: 'i-activity', title: 'intervals.icu', sub: icu ? (icu.configured ? 'Connected · resting HR, HRV, sleep' : 'Not connected') : 'Resting HR, HRV, sleep', onClick: () => shell.go('you/connections/icu'), id: 'avConnIcu' }));
    if (hasHc) inn.appendChild(shell.row({ icon: 'i-heart', title: 'Health Connect', sub: 'Recovery data and which source comes first', onClick: () => shell.go('you/connections/healthconnect'), id: 'avConnHcIn' }));
    const engine = ($('aiCoachEngineDetail') || {}).textContent || '';
    conns.querySelector('#avConnAi').appendChild(shell.row({ icon: 'i-sparkles', title: 'AI coach', sub: engine.trim().slice(0, 80) || 'Provider, model, API keys', onClick: () => shell.go('you/connections/ai'), id: 'avConnAiRow' }));
  };
  shell.registerPage('you/connections', { title: 'Connections', el: conns, mount: () => { renderConns().catch((e) => console.error(e)); } });

  const strava = page('<div class="card" id="avStravaBox"></div>');
  shell.registerPage('you/connections/strava', { title: 'Strava', el: strava, parent: 'you/connections', mount: () => { adopt(strava.firstChild, 'nativeStravaSettings'); section('strava'); } });

  const icuPage = page('<div class="card" id="avIcuBox"></div>');
  shell.registerPage('you/connections/icu', {
    title: 'intervals.icu', el: icuPage, parent: 'you/connections',
    mount: () => { const hc = $('nativeHc'); if (hc) adopt(hcPage.firstChild, 'nativeHc'); adopt(icuPage.firstChild, 'healthSettings'); section('health'); }
  });
  const hcPage = page('<div class="card" id="avHcBox"></div>');
  shell.registerPage('you/connections/healthconnect', {
    title: 'Health Connect', el: hcPage, parent: 'you/connections',
    mount: () => { adopt(hcPage.firstChild, 'nativeHc'); adopt(icuPage.firstChild, 'healthSettings'); section('health'); }
  });

  const ai = page('<div class="card" id="avAiBox"></div><details class="av-more card" id="avAiAdvanced"><summary>Advanced · API keys</summary></details>');
  shell.registerPage('you/connections/ai', {
    title: 'AI coach', el: ai, parent: 'you/connections',
    mount: () => {
      adopt(ai.querySelector('#avAiBox'), 'aiCoachConfigCard');
      adopt(ai.querySelector('#avAiAdvanced'), 'nativeAiKeys');
      section('ai');
      // Without a key for the chosen provider the coach cannot run, so the keys are shown rather than folded.
      if (services.ai) services.ai.status().then((s) => { if (!s.configured) ai.querySelector('#avAiAdvanced').open = true; }).catch(() => {});
    }
  });

  // ------------------------------------------------------------------ Your data --
  const data = page(`<div class="card av-list" id="avDataActions"></div>
    <p class="av-label">Watch a folder</p><div class="card" id="avDataFolder"></div>
    <p class="av-label">Ride files</p><div class="card" id="avDataFiles"></div>
    <details class="av-more card" id="avDataAdvanced"><summary>Advanced · training load, clear history</summary><div class="av-list" id="avDataDanger"></div></details>`);
  const dataActions = data.querySelector('#avDataActions');
  for (const r of [
    { icon: 'i-download', title: 'Import ride files', sub: '.fit .tcx .gpx .csv .json', onClick: clickId('btnChooseImportFiles'), id: 'avDataImportFiles' },
    { icon: 'i-history', title: 'Import my history', sub: 'A Strava, Garmin or other export (.zip)', onClick: clickId('btnImportHistory'), id: 'avDataImportHistory' },
    { icon: 'i-save', title: 'Back up everything', sub: 'Full JSON backup to Documents/ApexVelo', onClick: clickId('btnExportJsonHistory'), id: 'avDataBackup' }
  ]) dataActions.appendChild(shell.row(r));
  // Backups on this phone (the phone database's snapshots): only with the phone database.
  const backupsRow = shell.row({ icon: 'i-refresh', title: 'Backups', sub: 'Copies kept on this phone: back up now, restore', onClick: () => shell.go('you/data/backups'), id: 'avDataBackups' });
  dataActions.appendChild(backupsRow);
  data.querySelector('#avDataDanger').appendChild(shell.row({ icon: 'i-trash', title: 'Clear all history', sub: 'Deletes every ride on this phone', onClick: clickId('btnClearAllWorkoutsTable'), id: 'avDataClear' }));
  const placeData = () => {
    adopt(data.querySelector('#avDataFolder'), 'nativeImportSettings');
    adopt(data.querySelector('#avDataFiles'), 'nativeFileSettings');
    const adv = data.querySelector('#avDataAdvanced');
    const card = $('stravaSyncCard');
    if (card && card.parentNode !== adv) adv.insertBefore(card, adv.querySelector('#avDataDanger'));
  };
  shell.registerPage('you/data', {
    title: 'Your data', el: data,
    mount: () => {
      placeData();
      const hasFolder = !!$('nativeImportSettings');
      data.querySelector('#avDataFolder').hidden = !hasFolder;
      data.querySelector('#avDataFolder').previousElementSibling.hidden = !hasFolder;
      backupsRow.hidden = !(win.VeloStorage && win.VeloStorage.enabled);
      section('importfolder');
    }
  });

  // The Backups section of Settings (js/app-backup.js) works on the phone database's snapshots as on the PC's:
  // status, Back up now, the list with Preview & restore (asks first, makes a safety copy), open a backup file.
  const backups = page('<div class="card" id="avBackupsBox"></div>');
  shell.registerPage('you/data/backups', {
    title: 'Backups', el: backups, parent: 'you/data',
    mount: () => {
      const sec = doc.querySelector('.settings-section[data-sec="backups"]');
      if (sec && sec.parentNode !== backups.firstChild) backups.firstChild.appendChild(sec);
      const a = app();
      if (a && a.runAutoBackup) a.runAutoBackup().then(() => a.showLocalBackups && a.showLocalBackups()).catch(() => {});
    }
  });

  // ------------------------------------------------------------------ App settings --
  const appPage = page('<div class="card av-list" id="avAppList"></div><details class="av-more card" id="avAppAdvanced"><summary>Advanced · simulator</summary><div class="av-list" id="avAppAdvList"></div></details>');
  const switchRow = (id, title, sub, get, toggle) => {
    const sw = doc.createElement('button');
    sw.type = 'button'; sw.className = 'av-switch'; sw.id = id; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-label', title);
    const sync = () => sw.setAttribute('aria-checked', String(!!get()));
    sw.addEventListener('click', () => { toggle(); sync(); });
    sync();
    return shell.row({ title, sub, end: sw });
  };
  shell.registerPage('you/app', {
    title: 'App settings', el: appPage,
    mount: () => {
      const a = app();
      const list = appPage.querySelector('#avAppList'), adv = appPage.querySelector('#avAppAdvList');
      list.innerHTML = ''; adv.innerHTML = '';
      list.appendChild(switchRow('avAudioCues', 'Audio cues', 'Beeps at interval changes', () => a && a.audio && !a.audio.muted, () => { if (a && a.audio) a.audio.toggleMute(); }));
      adv.appendChild(switchRow('avSimulator', 'Simulator', 'Simulated power when no trainer or power meter streams', () => a && a.simulator && a.simulator.enabled, clickId('simToggleBtn')));
    }
  });

  // ------------------------------------------------------------------ Help & about --
  const help = page('<div class="card av-list" id="avHelpList"></div><p class="av-label">About</p><div class="card" id="avHelpAbout"></div>');
  help.querySelector('#avHelpList').appendChild(shell.row({ icon: 'i-book', title: 'Training guide', sub: 'Training terms explained in plain words', onClick: () => shell.go('you/help/guide'), id: 'avHelpGuide' }));
  shell.registerPage('you/help', { title: 'Help & about', el: help, mount: () => adopt(help.querySelector('#avHelpAbout'), 'nativeAboutSettings') });
  const guide = page('<div class="card" id="avGuideBox"></div>');
  shell.registerPage('you/help/guide', { title: 'Training guide', el: guide, parent: 'you/help', mount: () => {
    const g = doc.querySelector('.settings-section[data-sec="guide"]');
    if (g && g.parentNode !== guide.firstChild) guide.firstChild.appendChild(g);
  } });

  // ------------------------------------------------------------------ app hooks --
  win.addEventListener('DOMContentLoaded', () => {
    /* global VeloApp */
    const App_ = typeof VeloApp !== 'undefined' ? VeloApp : win.VeloApp;
    const P = App_ && App_.prototype;
    if (!P) return;
    // Settings is now the You tab: every app.openSettings(section) opens the page that holds the section.
    P.openSettings = function (sec) { shell.go(SECTION_ROUTES[sec] || 'you'); };
    // Messages in js/ that point to a setting name its You page (js/app-settings.js settingsLabel).
    P.settingsLabels = { ai: 'You > Connections > AI coach', health: 'You > Connections > intervals.icu',
      appleHealth: 'Connect Health Connect or intervals.icu in You > Connections' };
    const openModal = P.openModal, closeModal = P.closeModal;
    P.openModal = function (id, ...rest) {
      if (id === 'settingsModal') { shell.go('you'); return; }
      if (id === 'profileManagerModal') { if (!/^you\/profile$|^onboarding\//.test((shell.current || {}).route || '')) shell.go('you/profile'); return; }
      return openModal.call(this, id, ...rest);
    };
    P.closeModal = function (id, ...rest) {
      if (id === 'profileManagerModal' || id === 'settingsModal') {
        // Saving the profile resets the form to "new rider": keep the active rider ready to edit.
        if (id === 'profileManagerModal' && shell.current && shell.current.route === 'you/profile') { fillProfile(); section('rider'); }
        return;
      }
      return closeModal.call(this, id, ...rest);
    };
  });
  // History's training-load card belongs to Your data > Advanced from the start, not after the first visit.
  shell.whenApp(() => win.setTimeout(placeData, 0));
  return { renderConns, status };
}
