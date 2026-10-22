/**
 * Phone navigation shell (docs/ANDROID-UX.md, "Shell contract"): five bottom tabs, one top bar, pages,
 * bottom sheets, Android back and hash routes (#/ride, #/history/<rideId>, ...). Android app only (.apex-native);
 * the desktop page never loads it.
 *
 * Screens are registered as pages. A page either hosts one of the app's existing views (`view: 'history'`:
 * the shell calls app.switchTab, so the view's lazy rendering runs as on the PC) or brings its own element
 * (`el`). Each workstream registers its pages from its own module; registering a pattern again replaces it,
 * so U2-U5 take over the interim pages U1 registers below.
 */

export const TAB_IDS = ['ride', 'train', 'history', 'progress', 'you'];
const TAB_DEFAULTS = {
  ride: { label: 'Ride', icon: 'i-play', root: 'ride' },
  train: { label: 'Train', icon: 'i-calendar', root: 'train/plan' },
  history: { label: 'History', icon: 'i-history', root: 'history' },
  progress: { label: 'Progress', icon: 'i-activity', root: 'progress' },
  you: { label: 'You', icon: 'i-user', root: 'you' }
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#${esc(id)}"/></svg>`;

/** '/history/abc/' -> 'history/abc'; '' -> ''. */
export function normalizeRoute(route) {
  return String(route || '').replace(/^#?\/?/, '').replace(/\/+$/, '');
}

/** Matches a route against 'history/:rideId'; returns the params or null. */
export function matchRoute(pattern, route) {
  const p = pattern.split('/'), r = route.split('/');
  if (p.length !== r.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(r[i]);
    else if (p[i] !== r[i]) return null;
  }
  return params;
}

export class Shell {
  /** `getApp()` returns window.app (created after this module runs); `exit()` leaves the app (Android back at the Ride root). */
  constructor({ doc = document, win = window, getApp = () => win.app, exit = () => {} } = {}) {
    this.doc = doc; this.win = win; this.getApp = getApp; this.exit = exit;
    this.tabs = {};
    for (const id of TAB_IDS) this.tabs[id] = { id, ...TAB_DEFAULTS[id] };
    this.pages = new Map(); // pattern -> page
    this.viewRoutes = {}; // legacy view key -> route, for app.switchTab calls made by the app itself
    this.sheets = [];
    this.listeners = new Set();
    this.current = null;
    this._switching = false;
  }

  // ------------------------------------------------------------------ registration --

  /** Sets a tab's label, icon (sprite id) or root route. */
  registerTab(id, opts = {}) {
    if (!this.tabs[id]) throw new Error(`shell: unknown tab "${id}"`);
    Object.assign(this.tabs[id], opts);
    if (this.tabbar) this.renderTabbar();
  }

  /**
   * Registers a page for a route pattern ('history', 'history/:rideId'). Options:
   *  title       string or (params) => string, shown in the top bar
   *  view        key of an existing app view ('history', 'ai-coach', ...) to show, or
   *  el          an element of the page (the shell moves it into the page area)
   *  mount(el, params, route) / unmount(el)   called on enter / leave
   *  parent      route (or (params) => route) Android back goes to; null makes it a root-level page
   *              (back goes to Ride). Default: the tab's root.
   *  actions     (params) => Node | Node[] for the top bar's right side (at most two 44 px buttons)
   *  seg         [{ route, label }]: a segmented control under the top bar (sibling pages of one tab)
   *  fullscreen  true hides the top bar and the tab bar (ride screen, onboarding)
   *  onBack()    return true when it handled Android back itself (e.g. "End this ride?")
   *  tab         the tab it belongs to (default: the route's first segment)
   */
  registerPage(pattern, opts = {}) {
    pattern = normalizeRoute(pattern);
    const page = { pattern, ...opts };
    if (page.el && this.pagesEl && page.el.parentNode !== this.pagesEl) this.adoptPage(page.el);
    this.pages.set(pattern, page);
    if (page.view && !this.viewRoutes[page.view] && !pattern.includes(':')) this.viewRoutes[page.view] = pattern;
    if (this.current && this.current.page.pattern === pattern) this.render(this.current.route);
    return page;
  }

  /** When the app switches to `view` by itself (e.g. "Load into cockpit"), open `route`. */
  mapView(view, route) { this.viewRoutes[view] = normalizeRoute(route); }

  /** fn({ route, tab, params, page }) after every navigation; returns an unsubscribe function. */
  onRoute(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // ------------------------------------------------------------------ navigation --

  resolve(route) {
    route = normalizeRoute(route);
    if (this.pages.has(route)) return { page: this.pages.get(route), params: {}, route };
    for (const page of [...this.pages.values()].reverse()) {
      const params = page.pattern.includes(':') ? matchRoute(page.pattern, route) : null;
      if (params) return { page, params, route };
    }
    return null;
  }

  /** Opens a route ('ride/live', 'history/<id>'). Unknown routes open the Ride tab. */
  go(route, { replace = false } = {}) {
    route = normalizeRoute(route);
    if (!this.resolve(route)) route = this.tabs.ride.root;
    const hash = '#/' + route;
    if (this.win.location.hash !== hash) {
      const url = this.win.location.pathname + this.win.location.search + hash;
      if (replace) this.win.history.replaceState(null, '', url); else this.win.history.pushState(null, '', url);
    }
    this.render(route);
  }

  render(route) {
    const hit = this.resolve(route) || this.resolve(this.tabs.ride.root);
    if (!hit) return;
    const { page, params } = hit;
    const tab = page.tab || hit.route.split('/')[0];
    const prev = this.current;
    while (this.sheets.length) this.closeSheet();
    if (prev && prev.page !== page && prev.page.unmount) { try { prev.page.unmount(prev.page.el); } catch (e) { console.error(e); } }
    this.current = { route: hit.route, tab, params, page };
    const body = this.doc.body;
    body.dataset.avRoute = hit.route;
    body.dataset.avTab = tab;
    body.classList.toggle('av-fullscreen', !!page.fullscreen);
    body.dataset.avHost = page.view ? 'view' : 'page';
    for (const el of this.pagesEl.children) el.hidden = el !== page.el;
    if (page.view) {
      const app = this.getApp();
      if (app && app.switchTab) {
        this._switching = true;
        try { app.switchTab(page.view); } finally { this._switching = false; }
      } else this.whenApp(() => { if (this.current && this.current.page === page) this.render(this.current.route); });
    }
    this.renderTopbar(page, params);
    this.renderTabbar();
    if (page.mount) { try { page.mount(page.el, params, hit.route); } catch (e) { console.error(e); } }
    if (!prev || prev.route !== hit.route) this.win.scrollTo(0, 0);
    for (const fn of this.listeners) { try { fn(this.current); } catch (e) { console.error(e); } }
  }

  /** Runs fn once window.app exists (js/app.js makes it after the saved data has loaded). */
  whenApp(fn) {
    if (this.getApp()) { fn(); return; }
    (this._appWaiters = this._appWaiters || []).push(fn);
    if (this._appTimer) return;
    this._appTimer = this.win.setInterval(() => {
      if (!this.getApp()) return;
      this.win.clearInterval(this._appTimer);
      this._appTimer = null;
      for (const f of this._appWaiters.splice(0)) { try { f(); } catch (e) { console.error(e); } }
    }, 50);
  }

  parentOf(cur = this.current) {
    if (!cur) return null;
    const p = cur.page.parent;
    if (p === null) return null;
    if (typeof p === 'function') return p(cur.params);
    if (typeof p === 'string') return p;
    const root = this.tabs[cur.tab] && this.tabs[cur.tab].root;
    return root && root !== cur.route ? root : null;
  }

  /** Android back: sheet > page > tab root > Ride > exit. Returns false when it left the app. */
  back() {
    if (this.sheets.length) { this.closeSheet(); return true; }
    const cur = this.current;
    if (cur && cur.page.onBack && cur.page.onBack() === true) return true;
    const parent = this.parentOf(cur);
    if (parent) { this.go(parent); return true; }
    if (cur && cur.route !== this.tabs.ride.root) { this.go(this.tabs.ride.root); return true; }
    this.exit();
    return false;
  }

  // ------------------------------------------------------------------ sheets --

  /**
   * Shows `el` in a bottom sheet. An element that already lives in the page is put back where it was when the
   * sheet closes, so existing nodes (and their ids and bindings) can be shown in sheets. Returns the sheet element.
   */
  openSheet(el, { title = '', onClose = null, className = '' } = {}) {
    const doc = this.doc;
    const bg = doc.createElement('div');
    bg.className = 'av-sheet-bg';
    bg.innerHTML = `<div class="av-sheet ${esc(className)}" role="dialog" aria-modal="true"${title ? ` aria-label="${esc(title)}"` : ''}>
      <div class="av-grab" aria-hidden="true"></div>
      <div class="av-sheet-head"><h3>${esc(title)}</h3><button type="button" class="icon-btn av-sheet-close" aria-label="Close">${icon('i-x')}</button></div>
      <div class="av-sheet-body"></div></div>`;
    const marker = el.parentNode ? doc.createComment('av-sheet') : null;
    if (marker) el.parentNode.insertBefore(marker, el);
    const wasHidden = el.hidden;
    el.hidden = false;
    bg.querySelector('.av-sheet-body').appendChild(el);
    const entry = { bg, el, marker, wasHidden, onClose };
    bg.addEventListener('click', (e) => { if (e.target === bg) this.closeSheet(entry); });
    bg.querySelector('.av-sheet-close').addEventListener('click', () => this.closeSheet(entry));
    this.sheets.push(entry);
    doc.body.appendChild(bg);
    doc.body.classList.add('av-sheet-open');
    return bg.querySelector('.av-sheet');
  }

  /** Closes the top sheet (or the given one). */
  closeSheet(entry = this.sheets[this.sheets.length - 1]) {
    const i = this.sheets.indexOf(entry);
    if (i < 0) return;
    this.sheets.splice(i, 1);
    if (entry.marker) { entry.marker.parentNode.insertBefore(entry.el, entry.marker); entry.marker.remove(); entry.el.hidden = entry.wasHidden; }
    entry.bg.remove();
    if (!this.sheets.length) this.doc.body.classList.remove('av-sheet-open');
    if (entry.onClose) { try { entry.onClose(); } catch (e) { console.error(e); } }
  }

  // ------------------------------------------------------------------ building blocks --

  /** A 44 px top-bar icon button. */
  button({ icon: ic, label, onClick, id = '', className = '' }) {
    const b = this.doc.createElement('button');
    b.type = 'button';
    b.className = `icon-btn av-icon-btn ${className}`.trim();
    if (id) b.id = id;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.innerHTML = icon(ic);
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  /**
   * A 56 px list row (.av-row): icon, title, optional subtitle and an end slot (text or a Node). With
   * `onClick` it is a button with a chevron; `end` replaces the chevron.
   */
  row({ icon: ic = '', title, sub = '', end = null, onClick = null, id = '' }) {
    const r = this.doc.createElement(onClick ? 'button' : 'div');
    if (onClick) { r.type = 'button'; r.addEventListener('click', onClick); }
    r.className = 'av-row';
    if (id) r.id = id;
    r.innerHTML = `${ic ? icon(ic) : ''}<div class="av-row-text"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
    if (end instanceof this.win.Node) r.appendChild(end);
    else if (end != null) r.insertAdjacentHTML('beforeend', `<span class="av-row-end">${esc(end)}</span>`);
    else if (onClick) r.insertAdjacentHTML('beforeend', icon('i-right', 'ic av-row-chevron'));
    return r;
  }

  /**
   * The "More" pattern: a ⋯ top-bar button opening a sheet of rows. items: [{ icon, title, sub, onClick }].
   * For less-used content inside a page, use <details class="av-more"><summary>More</summary>…</details>.
   */
  more(items, { title = 'More', label = 'More options' } = {}) {
    return this.button({ icon: 'i-chevron', label, className: 'av-more-btn', onClick: () => {
      const list = this.doc.createElement('div');
      list.className = 'av-list';
      for (const it of (typeof items === 'function' ? items() : items)) {
        list.appendChild(this.row({ ...it, onClick: () => { this.closeSheet(); it.onClick(); } }));
      }
      this.openSheet(list, { title });
    } });
  }

  // ------------------------------------------------------------------ chrome --

  renderTopbar(page, params) {
    const bar = this.topbar;
    const parent = this.parentOf(this.current);
    const title = typeof page.title === 'function' ? page.title(params) : (page.title || '');
    bar.innerHTML = `${parent ? `<button type="button" class="icon-btn av-icon-btn av-back" aria-label="Back">${icon('i-left')}</button>` : ''}<h1 class="av-title">${esc(title)}</h1><div class="av-actions"></div>`;
    if (parent) bar.querySelector('.av-back').addEventListener('click', () => this.back());
    const actions = page.actions ? page.actions(params) : null;
    if (actions) for (const n of [].concat(actions)) if (n) bar.querySelector('.av-actions').appendChild(n);
    this.seg.hidden = !page.seg;
    this.seg.innerHTML = '';
    if (page.seg) {
      for (const s of page.seg) {
        const b = this.doc.createElement('button');
        b.type = 'button';
        b.textContent = s.label;
        b.dataset.avSeg = s.route;
        b.className = normalizeRoute(s.route) === this.current.route ? 'on' : '';
        b.setAttribute('aria-pressed', String(b.className === 'on'));
        b.addEventListener('click', () => this.go(s.route, { replace: true }));
        this.seg.appendChild(b);
      }
    }
  }

  renderTabbar() {
    const cur = this.current && this.current.tab;
    this.tabbar.innerHTML = TAB_IDS.map((id) => {
      const t = this.tabs[id];
      return `<button type="button" class="av-tab${id === cur ? ' on' : ''}" data-av-tab="${id}"${id === cur ? ' aria-current="page"' : ''}><span class="av-tab-pill">${icon(t.icon)}</span><span>${esc(t.label)}</span></button>`;
    }).join('');
  }

  adoptPage(el) {
    el.classList.add('av-page');
    el.hidden = true;
    this.pagesEl.appendChild(el);
  }

  /** Builds the chrome, hooks the app's own tab switches and opens the route in the URL (deep link) or Ride. */
  install() {
    const doc = this.doc, body = doc.body;
    body.classList.add('av-shell');
    this.topbar = doc.createElement('header');
    this.topbar.className = 'av-topbar';
    this.seg = doc.createElement('div');
    this.seg.className = 'av-seg av-subnav';
    this.seg.hidden = true;
    this.pagesEl = doc.createElement('div');
    this.pagesEl.id = 'avPages';
    this.tabbar = doc.createElement('nav');
    this.tabbar.className = 'av-tabbar';
    this.tabbar.setAttribute('aria-label', 'Main');
    this.tabbar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-av-tab]');
      if (!b) return;
      const tab = this.tabs[b.dataset.avTab];
      // Tapping the open tab goes back to its root and to the top.
      if (this.current && this.current.tab === tab.id && this.current.route === tab.root) { this.win.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      this.go(tab.root);
    });
    const main = doc.querySelector('main') || body;
    main.parentNode.insertBefore(this.topbar, main);
    main.parentNode.insertBefore(this.seg, main);
    main.insertBefore(this.pagesEl, main.firstChild);
    body.appendChild(this.tabbar);
    for (const page of this.pages.values()) if (page.el) this.adoptPage(page.el);
    this.win.addEventListener('hashchange', () => {
      const r = normalizeRoute(this.win.location.hash);
      if (r && (!this.current || r !== this.current.route)) this.render(this.resolve(r) ? r : this.tabs.ride.root);
    });
    this.go(normalizeRoute(this.win.location.hash) || this.tabs.ride.root, { replace: true });
  }

  /** Called when the app itself switched views (js/app.js switchTab): follow it with the matching route. */
  followView(view) {
    if (this._switching || !this.current) return;
    const route = this.viewRoutes[view];
    if (route && route !== this.current.route && !(this.current.page.view === view)) this.go(route);
  }
}

/**
 * The pages each tab shows until its own workstream (U2-U5) registers real ones: the existing views, plus a
 * row list for You. They keep every feature reachable through the new navigation in the meantime.
 */
export function registerInterimPages(shell) {
  const app = () => shell.getApp();
  shell.registerPage('ride', { title: 'Ride', view: 'cockpit' });
  const trainSeg = [{ route: 'train/plan', label: 'Plan' }, { route: 'train/workouts', label: 'Workouts' }, { route: 'train/calendar', label: 'Calendar' }, { route: 'train/ask', label: 'Ask' }];
  shell.registerPage('train/plan', { title: 'Train', view: 'ai-coach', seg: trainSeg, parent: null });
  shell.registerPage('train/workouts', { title: 'Train', view: 'workouts', seg: trainSeg, parent: null });
  shell.registerPage('train/calendar', { title: 'Train', view: 'calendar', seg: trainSeg, parent: null });
  shell.registerPage('train/ask', { title: 'Train', view: 'ask', seg: trainSeg, parent: null });
  shell.registerPage('history', { title: 'History', view: 'history' });
  shell.registerPage('history/:rideId', {
    title: 'History', view: 'history',
    mount: (el, { rideId }) => {
      const a = app();
      const ride = a && a.completedWorkouts && a.completedWorkouts.find((r) => r.id === rideId);
      if (ride && a.showRideSummary) a.showRideSummary(ride);
    }
  });
  shell.registerPage('progress', { title: 'Progress', view: 'analytics' });
  const you = shell.doc.createElement('div');
  you.className = 'av-page-body';
  you.innerHTML = '<div class="card av-list"></div>';
  const list = you.firstChild;
  const settings = (sec) => () => { const a = app(); if (a && a.openSettings) a.openSettings(sec); };
  for (const r of [
    { icon: 'i-user', title: 'Profile', sub: 'Name, weight, FTP, heart rate, riders', onClick: () => { const a = app(); if (a) a.openModal('profileManagerModal'); } },
    { icon: 'i-bluetooth', title: 'Devices', sub: 'Trainer, power meter, heart rate, fan', onClick: () => { shell.doc.getElementById('btnOpenHardwareModal')?.click(); } },
    { icon: 'i-refresh', title: 'Connections', sub: 'Strava, Health Connect, intervals.icu, AI coach', onClick: settings('strava') },
    { icon: 'i-folder', title: 'Your data', sub: 'Import, ride files, backups', onClick: settings('importfolder') },
    { icon: 'i-gear', title: 'App settings', sub: 'Rider and app options', onClick: settings('rider') },
    { icon: 'i-book', title: 'Help', sub: 'Training guide, about, licences', onClick: settings('guide') }
  ]) list.appendChild(shell.row(r));
  shell.registerPage('you', { title: 'You', el: you });
}

/**
 * Wires the shell into the page: hooks VeloApp.prototype.switchTab (so the app's own switches follow the
 * routes), registers the interim pages and installs the chrome at DOMContentLoaded, after js/app.js has made
 * window.app. Returns the shell (window.ApexNative.shell).
 */
export function installShell({ win = window, exit } = {}) {
  const shell = new Shell({ doc: win.document, win, exit });
  registerInterimPages(shell);
  shell.mapView('cockpit', 'ride');
  win.addEventListener('DOMContentLoaded', () => {
    /* global VeloApp */
    const App_ = typeof VeloApp !== 'undefined' ? VeloApp : win.VeloApp;
    const P = App_ && App_.prototype;
    if (P && P.switchTab && !P.switchTab.__avShell) {
      const orig = P.switchTab;
      P.switchTab = function (key) { orig.call(this, key); shell.followView(key); };
      P.switchTab.__avShell = true;
    }
    // After the other DOMContentLoaded handlers (js/app.js starts making window.app in its own).
    win.setTimeout(() => shell.install(), 0);
  });
  return shell;
}
