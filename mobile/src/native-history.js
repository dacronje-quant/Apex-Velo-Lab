/**
 * History tab on the phone (docs/ANDROID-UX.md, workstream U3): the ride list grouped by month with search and
 * filters, a ride detail page and + for imports. Android app only; the desktop History view is unchanged.
 *
 * Nothing is copied: the detail page hosts the app's own ride summary (#rideSummaryModal's content, moved into
 * the page while it is open), so the Strava panel, AI breakdown, ride analysis, exports and delete keep their
 * bindings. The import sheet shows the existing import card (#importSyncCard) the same way. The ride's samples
 * load on demand through the lazy loader around app.showRideSummary (src/native-app.js).
 */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#${esc(id)}"/></svg>`;
const pos = (v) => Number(v) > 0;
const PAGE_ROWS = 60;
const ON_STRAVA = new Set(['sent', 'duplicate', 'found', 'imported']);

/** Filter chips: [key, label, test(ride, app)]. */
export const FILTERS = [
  ['all', 'All', () => true],
  ['rides', 'Rides', (r, w) => !w.VeloMetrics || w.VeloMetrics.isCycling(r)],
  ['other', 'Other activities', (r, w) => !!w.VeloMetrics && !w.VeloMetrics.isCycling(r)],
  ['power', 'With power', (r) => pos(r.np) || pos(r.avgWatts)],
  ['nostrava', 'Not on Strava', (r) => !(r.strava && ON_STRAVA.has(r.strava.state))]
];

/** Rides matching the search text (title, notes, source, rider) and the filter, newest first. */
export function filterRides(rides, { query = '', filter = 'all' } = {}, win = {}) {
  const q = String(query).trim().toLowerCase();
  const f = (FILTERS.find((x) => x[0] === filter) || FILTERS[0])[2];
  return (rides || [])
    .filter((r) => r && f(r, win) && (!q || [r.title, r.notes, r.source, r.profileName].some((v) => v && String(v).toLowerCase().includes(q))))
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
}

/** [{ key: '2026-10', label: 'October 2026', rides }] in the rides' order. */
export function groupByMonth(rides) {
  const groups = [];
  let cur = null;
  for (const r of rides) {
    const d = new Date(r.date);
    const key = isNaN(d) ? 'undated' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!cur || cur.key !== key) {
      cur = { key, label: isNaN(d) ? 'No date' : d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), rides: [] };
      groups.push(cur);
    }
    cur.rides.push(r);
  }
  return groups;
}

const CSS = `
.av-history .av-hist-tools { display: flex; flex-direction: column; gap: 10px; }
.av-history .av-hist-tools[hidden] { display: none; }
.av-history .av-hist-search { min-height: 44px; width: 100%; }
.av-history .av-hist-chips { display: flex; gap: 10px; overflow-x: auto; padding: 6px 2px; scrollbar-width: none; }
.av-history .av-hist-chips .chip { flex: none; cursor: pointer; font: inherit; }
.av-history .av-hist-chips .chip.on { color: #fff; background: linear-gradient(135deg, var(--zone-a), var(--zone-b)); border-color: transparent; }
.av-history .av-hist-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 4px -4px; }
.av-history .av-hist-head .av-label { margin: 0; }
.av-history .av-month { display: flex; justify-content: space-between; gap: 8px; }
.av-history .av-month small { text-transform: none; letter-spacing: 0; font-weight: 500; }
.av-history .av-ride-row .zone-dot { flex: none; }
.av-history .av-ride-row .ic-ok { color: var(--lime, #a3e635); }
.av-history .av-hist-empty { text-align: center; }
.av-ride-detail > .modal-content { position: static; width: auto; max-width: none; max-height: none; overflow: visible; margin: 0;
  padding: 16px; transform: none; animation: none; border-radius: 22px; }
.av-ride-detail #btnCloseModal, .av-ride-detail .modal-actions [data-act="close"] { display: none !important; }
.av-ride-detail .modal-header { flex-wrap: wrap; }
.av-ride-detail #modalRideTitle, .av-import-sheet #importSyncCard .section-head { display: none; }
.av-ride-detail .btn, .av-import-sheet .btn, .av-import-sheet select.input-field { min-height: 44px; }
.av-ride-detail .table-scroll { max-width: 100%; overflow-x: auto; }
.av-ride-detail .av-ride-notes { white-space: pre-wrap; }
.av-edit-ride { display: flex; flex-direction: column; gap: 12px; }
.av-edit-ride .input-field { min-height: 44px; width: 100%; }
.av-edit-ride textarea.input-field { min-height: 120px; resize: vertical; }
`;

/**
 * Registers `history` and `history/:rideId` on the shell (replacing U1's interim pages) and, once the app exists,
 * routes the app's own "open this ride" calls (calendar, analytics, Today's last ride) to the detail page.
 */
export function installHistory(shell, { win = window } = {}) {
  const doc = shell.doc;
  const app = () => shell.getApp();
  const state = { query: '', filter: 'all', limit: PAGE_ROWS, tools: false };
  let showSummary = null; // the app's showRideSummary (with the lazy sample loader), before ours
  let detailFor = null; // the ride id the detail page shows while it is open
  let statusTimer = null;

  const style = doc.createElement('style');
  style.textContent = CSS;
  (doc.head || doc.documentElement).appendChild(style);

  const findRide = (id) => { const a = app(); return a && (a.completedWorkouts || []).find((r) => String(r.id) === String(id)); };
  const rideRoute = (id) => 'history/' + encodeURIComponent(id);

  // ------------------------------------------------------------------ list --

  const list = doc.createElement('div');
  list.className = 'av-page-body av-history';
  list.innerHTML = `
    <div class="av-hist-tools" hidden>
      <input type="search" class="input-field av-hist-search" id="avHistSearch" placeholder="Search rides, notes, source" aria-label="Search rides">
      <div class="av-hist-chips" role="group" aria-label="Filter">${FILTERS.map(([k, l]) => `<button type="button" class="chip" data-filter="${k}" aria-pressed="false">${esc(l)}</button>`).join('')}</div>
    </div>
    <div class="av-hist-import" hidden></div>
    <div class="av-hist-head"><span class="av-label" id="avHistCount"></span></div>
    <div class="av-hist-list"></div>`;
  const $ = (sel) => list.querySelector(sel);

  const rowHtml = (r, a) => {
    const d = new Date(r.date);
    const when = isNaN(d) ? '' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const np = r.np || r.avgWatts || 0;
    const bits = [when, a.fmtTime ? a.fmtTime(r.duration || 0) : '', np > 0 ? `${np} W` : '', pos(r.tss) ? `${Math.round(r.tss)} TSS` : ''].filter(Boolean);
    const z = pos(r.if) && win.VeloProgress ? win.VeloProgress.ifBand(parseFloat(r.if)) : null;
    const st = r.strava && r.strava.state;
    const end = ON_STRAVA.has(st) ? `<span class="av-row-end" title="On Strava">${icon('i-check', 'ic ic-ok')}</span>`
      : st === 'failed' ? '<span class="av-row-end warn">Strava failed</span>'
        : st === 'queued' || st === 'sending' || st === 'processing' ? '<span class="av-row-end">Sending...</span>' : '';
    return `<button type="button" class="av-row av-ride-row" data-ride="${esc(r.id)}">${z ? `<i class="zone-dot" style="--zc:${z.color}" title="${esc(z.label)}"></i>` : ''}<div class="av-row-text"><b>${esc(r.title || 'Ride')}</b><small>${esc(bits.join(' · '))}</small></div>${end || icon('i-right', 'ic av-row-chevron')}</button>`;
  };

  function renderList() {
    const a = app();
    const box = $('.av-hist-list');
    if (!a) { box.innerHTML = '<p class="av-note">Loading...</p>'; return; }
    const all = a.completedWorkouts || [];
    const rides = filterRides(all, state, win);
    for (const b of list.querySelectorAll('[data-filter]')) { const on = b.dataset.filter === state.filter; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
    $('#avHistCount').textContent = rides.length === all.length ? `${all.length} ride${all.length === 1 ? '' : 's'}` : `${rides.length} of ${all.length}`;
    if (!all.length) {
      box.innerHTML = `<div class="card av-hist-empty"><p>No rides yet. Import your ride files or history, or record a ride.</p>
        <button type="button" class="btn btn-primary av-big" data-hist="import">${icon('i-download')}Import rides</button></div>`;
      return;
    }
    if (!rides.length) { box.innerHTML = '<p class="av-note">No rides match.</p>'; return; }
    const shown = rides.slice(0, state.limit);
    box.innerHTML = groupByMonth(shown).map((g) => {
      const tss = g.rides.reduce((s, r) => s + (Number(r.tss) || 0), 0);
      return `<div class="av-label av-month"><span>${esc(g.label)}</span><small>${g.rides.length} · ${Math.round(tss)} TSS</small></div>
        <div class="card av-list">${g.rides.map((r) => rowHtml(r, a)).join('')}</div>`;
    }).join('') + (rides.length > shown.length ? `<button type="button" class="btn av-big" data-hist="more">Show more (${rides.length - shown.length})</button>` : '');
  }

  list.addEventListener('click', (e) => {
    const row = e.target.closest('[data-ride]');
    if (row) { shell.go(rideRoute(row.dataset.ride)); return; }
    const f = e.target.closest('[data-filter]');
    if (f) { state.filter = f.dataset.filter; state.limit = PAGE_ROWS; renderList(); return; }
    const h = e.target.closest('[data-hist]');
    if (h && h.dataset.hist === 'more') { state.limit += PAGE_ROWS * 3; renderList(); }
    else if (h && h.dataset.hist === 'import') openImport();
  });
  $('#avHistSearch').addEventListener('input', (e) => { state.query = e.target.value; state.limit = PAGE_ROWS; renderList(); });

  /** The running import (History > Import history) while its card is not on screen; tap opens the import sheet. */
  function renderImportStatus() {
    const panel = doc.getElementById('bulkImportPanel');
    const box = $('.av-hist-import');
    const inSheet = panel && panel.closest('.av-sheet');
    if (!panel || panel.hidden || inSheet) { box.hidden = true; return; }
    const n = (k) => (panel.querySelector(`[data-count="${k}"]`) || {}).textContent || '0';
    const status = (panel.querySelector('.bulk-status') || {}).textContent || '';
    box.hidden = false;
    box.innerHTML = '';
    box.appendChild(shell.row({ icon: 'i-download', title: status.trim() || 'Importing rides', sub: `${n('imported')} imported · ${n('duplicates')} duplicates · ${n('errors')} errors`, onClick: openImport, id: 'avHistImportStatus' }));
    box.firstChild.classList.add('card');
  }

  // ------------------------------------------------------------------ sheets --

  /** Moves an existing node into a sheet's content and puts it back where it was when the sheet closes. */
  function borrow(node, into) {
    if (!node) return () => {};
    const marker = doc.createComment('av-history');
    node.parentNode.insertBefore(marker, node);
    into.appendChild(node);
    return () => { marker.parentNode.insertBefore(node, marker); marker.remove(); };
  }

  /** + : the import card (files, Import history with its job status, HealthFit folder), the watched folder and share. */
  function openImport() {
    const box = doc.createElement('div');
    box.className = 'av-page-body av-import-sheet';
    const restore = borrow(doc.getElementById('importSyncCard'), box);
    const rows = doc.createElement('div');
    rows.className = 'card av-list';
    const a = app();
    if (doc.querySelector('#settingsNav [data-sec="importfolder"]')) {
      rows.appendChild(shell.row({ icon: 'i-folder', title: 'Watch a folder', sub: 'Import new ride files from a Dropbox, Drive or device folder', id: 'avHistWatchFolder', onClick: () => { shell.closeSheet(); if (a) a.openSettings('importfolder'); } }));
    }
    rows.appendChild(shell.row({ icon: 'i-gear', title: 'Ride files and import settings', sub: 'Where exports are saved, sport filter', onClick: () => { shell.closeSheet(); if (a) a.openSettings('files'); } }));
    box.appendChild(rows);
    box.insertAdjacentHTML('beforeend', '<p class="av-note">You can also share ride files to Apex Velo from Garmin Connect, the Wahoo app, Files or an email.</p>');
    shell.openSheet(box, { title: 'Add rides', className: 'av-import', onClose: () => { restore(); renderImportStatus(); } });
  }

  /** Training-load options live in You > Your data (U5); until that page exists, You. */
  const openLoadOptions = () => shell.go(shell.resolve('you/data') ? 'you/data' : 'you');

  const click = (id) => () => { const b = doc.getElementById(id); if (b) b.click(); };
  const listMore = () => {
    const items = [
      { icon: 'i-refresh', title: 'Check Strava', sub: 'Mark rides that are already on Strava', onClick: click('btnStravaCheckAll') },
      { icon: 'i-download', title: 'Full backup · JSON', sub: 'Every ride with its samples', onClick: click('btnExportJsonHistory') },
      { icon: 'i-download', title: 'Current session · FIT', onClick: click('btnExportFitActive') },
      { icon: 'i-download', title: 'Current session · TCX', onClick: click('btnExportTcxActive') },
      { icon: 'i-download', title: 'Current session · CSV', onClick: click('btnExportCsvRide') },
      { icon: 'i-activity', title: 'Training-load options', sub: 'Strength sessions in fatigue and fitness', onClick: openLoadOptions },
      { icon: 'i-folder', title: 'Replace history from HealthFit folder...', onClick: click('btnWipeAndSyncHealthFitFolder') },
      { icon: 'i-trash', title: 'Clear all history...', onClick: click('btnClearAllWorkoutsTable') }
    ];
    return items;
  };
  const moreBtn = shell.more(listMore, { title: 'History', label: 'History options' });
  moreBtn.id = 'avHistMore';
  $('.av-hist-head').appendChild(moreBtn);

  shell.registerPage('history', {
    title: 'History',
    el: list,
    parent: null,
    actions: () => [
      shell.button({ icon: 'i-search', label: 'Search and filter', id: 'avHistSearchBtn', onClick: () => {
        state.tools = !state.tools;
        $('.av-hist-tools').hidden = !state.tools;
        if (state.tools) $('#avHistSearch').focus();
        else if (state.query || state.filter !== 'all') { state.query = ''; state.filter = 'all'; $('#avHistSearch').value = ''; renderList(); }
      } }),
      shell.button({ icon: 'i-plus', label: 'Add rides', id: 'avHistAdd', onClick: openImport })
    ],
    mount: () => {
      renderList();
      renderImportStatus();
      clearInterval(statusTimer);
      statusTimer = win.setInterval(renderImportStatus, 1000);
    },
    unmount: () => { clearInterval(statusTimer); statusTimer = null; }
  });

  // ------------------------------------------------------------------ ride detail --

  const detail = doc.createElement('div');
  detail.className = 'av-page-body av-ride-detail';
  detail.innerHTML = '<div class="card av-ride-notes" hidden></div>';
  let restoreSummary = null;

  const renderNotes = (ride) => {
    const n = detail.querySelector('.av-ride-notes');
    n.hidden = !(ride && ride.notes);
    n.textContent = (ride && ride.notes) || '';
  };

  function editRide(ride) {
    const a = app();
    const form = doc.createElement('form');
    form.className = 'av-edit-ride';
    form.innerHTML = `<label class="field"><span>Title</span><input class="input-field" id="avRideTitle" maxlength="120" value="${esc(ride.title || '')}"></label>
      <label class="field"><span>Notes</span><textarea class="input-field" id="avRideNotes" maxlength="4000" placeholder="How it felt, the route, the weather...">${esc(ride.notes || '')}</textarea></label>
      <button type="submit" class="btn btn-primary av-big">Save</button>`;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = form.querySelector('#avRideTitle').value.trim();
      const notes = form.querySelector('#avRideNotes').value.trim();
      if (title) ride.title = title;
      if (notes) ride.notes = notes; else delete ride.notes;
      shell.closeSheet();
      const titleEl = doc.getElementById('modalRideTitle');
      if (titleEl) titleEl.textContent = ride.title || 'Workout';
      const h1 = doc.querySelector('.av-topbar .av-title');
      if (h1 && detailFor === ride.id) h1.textContent = ride.title || 'Ride';
      renderNotes(ride);
      if (a) {
        await a.saveHistory();
        if (a.renderHistoryTable) a.renderHistoryTable();
        a.showToast('Ride saved.', 'success');
      }
    });
    shell.openSheet(form, { title: 'Edit ride' });
  }

  const rideMore = (ride) => shell.more(() => {
    const a = app();
    const id = ride.id;
    return [
      { icon: 'i-edit', title: 'Edit title and notes', onClick: () => editRide(ride) },
      { icon: 'i-download', title: 'Export FIT', onClick: () => a.exportFitForRide(id) },
      { icon: 'i-download', title: 'Export TCX', onClick: () => a.exportTcxForRide(id) },
      { icon: 'i-download', title: 'Export CSV', onClick: () => a.exportCsvForRide(id) },
      { icon: 'i-trash', title: 'Delete ride...', onClick: async () => {
        await a.deleteCompletedRide(id);
        if (!findRide(id)) shell.go('history', { replace: true });
      } }
    ];
  }, { title: ride.title || 'Ride', label: 'Ride options' });

  shell.registerPage('history/:rideId', {
    tab: 'history',
    parent: 'history',
    el: detail,
    title: ({ rideId }) => { const r = findRide(rideId); return r ? r.title || 'Ride' : 'Ride'; },
    actions: ({ rideId }) => { const r = findRide(rideId); return r ? rideMore(r) : null; },
    mount: (el, { rideId }) => {
      const a = app();
      const ride = findRide(rideId);
      detailFor = ride ? ride.id : null;
      renderNotes(ride);
      for (const n of el.querySelectorAll('.av-ride-missing')) n.remove();
      if (!ride) {
        el.insertAdjacentHTML('beforeend', '<div class="card av-ride-missing"><p>This ride is not in your history.</p></div>');
        if (!a) shell.whenApp(() => { if (shell.current && shell.current.page.el === detail) shell.render(shell.current.route); });
        return;
      }
      hookApp();
      const content = doc.querySelector('#rideSummaryModal > .modal-content') || detail.querySelector('.modal-content');
      if (content && content.parentNode !== detail) {
        const home = content.parentNode;
        detail.appendChild(content);
        restoreSummary = () => { home.appendChild(content); restoreSummary = null; };
      }
      Promise.resolve(showSummary.call(a, ride)).catch((e) => console.error(e));
    },
    unmount: () => {
      const a = app();
      detailFor = null;
      if (a && closeModal) closeModal.call(a, 'rideSummaryModal'); // destroys the chart, as closing the modal does
      if (restoreSummary) restoreSummary();
    }
  });

  // ------------------------------------------------------------------ app hooks --

  let closeModal = null;
  function hookApp() {
    const a = app();
    if (!a || showSummary) return;
    // The app's own "open this ride" (calendar, analytics, Today, prev/next) opens the detail page instead of the
    // modal. A ride that has just ended keeps the modal, over the ride screen.
    showSummary = a.showRideSummary;
    a.showRideSummary = function (record, isNaturalEnd = false) {
      if (isNaturalEnd || !record || !findRide(record.id)) return showSummary.call(this, record, isNaturalEnd);
      if (detailFor === record.id && shell.current && shell.current.page.el === detail) return showSummary.call(this, record);
      shell.go(rideRoute(record.id), { replace: detailFor != null });
      return undefined;
    };
    const openModal = a.openModal;
    a.openModal = function (id, ...rest) {
      if (id === 'rideSummaryModal' && detailFor != null) return undefined; // the summary is on the page
      return openModal.call(this, id, ...rest);
    };
    closeModal = a.closeModal;
    a.closeModal = function (id, ...rest) {
      const r = closeModal.call(this, id, ...rest);
      // Delete, Close and "Set up Strava" in the summary close the modal: on the page that means leaving it.
      if (id === 'rideSummaryModal' && detailFor != null && shell.current && shell.current.page.el === detail) shell.go('history', { replace: true });
      return r;
    };
    const renderTable = a.renderHistoryTable;
    a.renderHistoryTable = function (...args) {
      const r = renderTable.apply(this, args);
      if (shell.current && shell.current.page.el === list) renderList();
      return r;
    };
    if (shell.current && shell.current.page.el === list) renderList();
  }
  shell.whenApp(hookApp);

  return { renderList, openImport };
}
