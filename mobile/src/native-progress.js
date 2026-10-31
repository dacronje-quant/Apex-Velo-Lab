/**
 * Progress tab (docs/ANDROID-UX.md 2.1, workstream U4): one "Am I getting fitter?" card and five topic pages that
 * host the existing Analytics view. Each topic shows the Analytics panels (and cards) it covers; nothing is
 * copied, so every chart keeps its id, bindings and rendering (js/app-analytics.js and friends), which read the
 * rides' summaries (#22), never their samples. The range chip opens the page's own range pills in a sheet.
 */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Topic pages: the Analytics panels each one shows, in order. Cards of a panel that belong to another topic are
 * hidden by apex-progress.css (body[data-av-prog]); the overview panel is shared out between topics.
 */
export const TOPICS = [
  { id: 'fitness', title: 'Fitness & load', icon: 'i-activity', panels: ['overview', 'load'], sub: 'Fitness, fatigue, form, weekly load, training year' },
  { id: 'power', title: 'Power & FTP', icon: 'i-bolt', panels: ['ftp', 'power'], sub: 'FTP history, power curve, critical power' },
  { id: 'intensity', title: 'Intensity', icon: 'i-target', panels: ['intensity', 'aerobic'], sub: 'Zones, intensity mix, efficiency, decoupling' },
  { id: 'health', title: 'Health & recovery', icon: 'i-heart', panels: ['overview', 'health'], sub: 'Readiness, HRV, resting HR, sleep, weight' },
  { id: 'records', title: 'Records', icon: 'i-trophy', panels: ['overview', 'power'], sub: 'All-time bests and power profile' }
];
/** Analytics panel -> topic, for the app's own drill-downs (tiles, today pills, insights). */
export const PANEL_TOPIC = { overview: 'fitness', load: 'fitness', power: 'power', ftp: 'power', intensity: 'intensity', aerobic: 'intensity', health: 'health' };
const TOPIC_CARD = { anaCardRecords: 'records', anaCardProfile: 'records', anaCardReady: 'health' };

/** "Am I getting fitter?" from the fitness (CTL) trend: now against six weeks ago. */
export function fitnessVerdict(pmc, weeks = 6) {
  const ctl = (pmc && pmc.ctlData) || [];
  if (!ctl.length) return { key: 'none', text: 'Ride to see your trend', delta: null };
  const now = Number(ctl[ctl.length - 1]) || 0;
  const then = Number(ctl[Math.max(0, ctl.length - 1 - weeks * 7)]) || 0;
  const delta = Math.round((now - then) * 10) / 10;
  if (delta >= 2) return { key: 'up', text: 'Training load is increasing', delta };
  if (delta <= -2) return { key: 'down', text: 'Training load is easing', delta };
  return { key: 'flat', text: 'Holding steady', delta };
}

/** A small fitness line (SVG polyline) over the last days of the CTL series. */
export function sparkline(values, { w = 320, h = 48 } = {}) {
  const v = (values || []).map(Number).filter(Number.isFinite);
  if (v.length < 2) return '';
  const max = Math.max(...v), min = Math.min(Math.min(...v), max - 10), span = max - min || 1; // at least 10 CTL tall, so day-to-day noise stays flat
  const pts = v.map((y, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - 3 - ((y - min) / span) * (h - 6)).toFixed(1)}`).join(' ');
  return `<svg class="av-prog-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--cyan)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

export class ProgressTab {
  constructor({ shell, win = window }) {
    this.shell = shell; this.win = win; this.doc = win.document;
    this.el = this.doc.createElement('div');
    this.el.className = 'av-page-body av-progress';
    this.el.innerHTML = `<div class="card av-prog-answer" id="avProgAnswer"></div>
      <div class="card av-list" id="avProgTopics"></div>`;
    const list = this.el.querySelector('#avProgTopics');
    for (const t of TOPICS) {
      const row = shell.row({ icon: t.icon, title: t.title, onClick: () => shell.go('progress/' + t.id), id: 'avProgRow-' + t.id });
      row.dataset.topic = t.id;
      list.appendChild(row);
    }
  }

  app() { return this.shell.getApp(); }

  register() {
    const shell = this.shell;
    shell.registerPage('progress', { title: 'Progress', el: this.el, actions: () => { const n = this.doc.createElement('span'); n.className = 'av-period'; n.textContent = '6 weeks'; return n; }, mount: () => this.renderAnswer(), unmount: () => this.leave() });
    for (const t of TOPICS) {
      shell.registerPage('progress/' + t.id, {
        title: t.title, view: 'analytics', parent: 'progress',
        actions: () => t.id === 'records' ? null : this.rangeChip(),
        mount: () => this.showTopic(t),
        unmount: () => this.leave(),
        onBack: () => this.closeOverlay()
      });
    }
    // The app's own drill-downs (an overview tile, a today pill, an insight) open the topic that has the card.
    shell.whenApp(() => {
      const app = this.app();
      if (!app || !app.showAnalyticsPanel || app.showAnalyticsPanel.__avProgress) return;
      const orig = app.showAnalyticsPanel.bind(app);
      const routed = (key, opts = {}) => {
        if (!shell.current || shell.current.tab !== 'progress' || !PANEL_TOPIC[key]) return orig(key, opts);
        const topic = TOPIC_CARD[opts.spot] || PANEL_TOPIC[key];
        if (shell.current.route !== 'progress/' + topic) shell.go('progress/' + topic);
        if (opts.spot && app.spotlightAnaCard) this.win.requestAnimationFrame(() => app.spotlightAnaCard(opts.spot));
      };
      routed.__avProgress = true;
      app.showAnalyticsPanel = routed;
    });
  }

  /** The top bar's range chip: the page range ("6 months"); opens the app's own range pills in a sheet. */
  rangeChip() {
    const b = this.doc.createElement('button');
    b.type = 'button';
    b.className = 'chip av-prog-range';
    b.id = 'avProgRange';
    const active = this.doc.querySelector('#anaRangePills .ana-range.active');
    b.textContent = active ? active.textContent.trim() : 'Range';
    b.setAttribute('aria-label', `Time range: ${b.textContent}. Change`);
    b.addEventListener('click', () => this.openRange(b));
    return b;
  }

  openRange(chip) {
    const pills = this.doc.getElementById('anaRangePills');
    if (!pills) return;
    const pick = (e) => {
      const r = e.target.closest('.ana-range');
      if (!r) return;
      // The app's own click handler (bound on the pill) has run: show the new range and close.
      this.win.setTimeout(() => {
        chip.textContent = r.textContent.trim();
        chip.setAttribute('aria-label', `Time range: ${chip.textContent}. Change`);
        this.shell.closeSheet();
        if (this.shell.current && this.shell.current.route === 'progress') this.renderAnswer();
      }, 0);
    };
    pills.addEventListener('click', pick);
    this.shell.openSheet(pills, { title: 'Time range', className: 'av-prog-range-sheet', onClose: () => pills.removeEventListener('click', pick) });
  }

  /** Shows the panels of one topic (and only its cards), then fits the charts drawn while hidden. */
  showTopic(t) {
    const app = this.app();
    this.doc.body.dataset.avProg = t.id;
    this.doc.querySelectorAll('#anaStage > .ana-panel').forEach((p) => {
      p.hidden = !t.panels.includes(p.dataset.panel);
      p.style.order = String(t.panels.indexOf(p.dataset.panel));
    });
    if (app) app.anaPanel = t.panels[0];
    if (t.id === 'power') { this.renderFtpSuggestion(); this.renderPowerSummary(); }
    if (t.id === 'health' && app && app.renderHealthAnalytics) {
      try {
        app.renderHealthAnalytics();
        const readiness = app.healthReadiness?.();
        const note = this.doc.getElementById('anaReadinessNote');
        if (note && readiness) note.textContent = (readiness.reasons || []).join(' · ') || readiness.advice || note.textContent;
      } catch (e) { console.error(e); }
    }
    this.win.requestAnimationFrame(() => this.win.requestAnimationFrame(() => {
      const stage = this.doc.getElementById('anaStage');
      if (app && app.anaChartsIn && stage) app.anaChartsIn(stage).forEach((c) => { try { c.resize(); } catch (e) { /* not drawn yet */ } });
    }));
  }

  /** Android back closes an expanded chart or the day view first. */
  closeOverlay() {
    const zoom = this.doc.getElementById('anaZoomDialog');
    if (zoom && zoom.open) { zoom.close(); return true; }
    const day = this.doc.getElementById('anaDayModal');
    const app = this.app();
    if (day && day.classList.contains('open') && app && app.closeModal) { app.closeModal('anaDayModal'); return true; }
    return false;
  }

  /** Called before the next page mounts (a topic page sets its own again). */
  leave() { delete this.doc.body.dataset.avProg; }

  /** Power & FTP's primary action: "Update FTP" when the rides suggest a higher one (the ride review's own suggestion). */
  renderFtpSuggestion() {
    const app = this.app();
    let box = this.doc.getElementById('avProgFtp');
    if (!box) {
      box = this.doc.createElement('div');
      box.id = 'avProgFtp';
      box.className = 'card av-prog-ftp';
      box.addEventListener('click', (e) => {
        const b = e.target.closest('[data-av-ftp]');
        if (!b || !app) return;
        if (b.dataset.avFtp === 'accept') app.acceptFtpSuggestion(b.dataset.value); else app.dismissFtpSuggestion(b.dataset.value);
        box.hidden = true;
      });
      const stage = this.doc.getElementById('anaStage');
      if (stage) stage.insertBefore(box, stage.firstChild);
    }
    let sug = null;
    try {
      const rides = app && app.cyclingRides ? app.cyclingRides() : [];
      const last = rides.reduce((a, r) => (!a || Date.parse(r.date) > Date.parse(a.date) ? r : a), null);
      sug = last && app.ftpSuggestionFor ? app.ftpSuggestionFor(last) : null;
    } catch (e) { sug = null; }
    box.hidden = !sug;
    if (!sug) return;
    box.innerHTML = `<div class="av-prog-ftp-text"><b>Your FTP looks higher: <span class="num">${esc(sug.ftp)} W</span></b>
        <small>${esc(sug.method)} - ${esc(sug.basis)}. Now ${esc(sug.from)} W.</small></div>
      <div class="btn-row"><button type="button" class="btn btn-start av-big" data-av-ftp="accept" data-value="${esc(sug.ftp)}" id="avProgFtpAccept">Update FTP to ${esc(sug.ftp)} W</button>
        <button type="button" class="btn btn-ghost" data-av-ftp="dismiss" data-value="${esc(sug.ftp)}">Not now</button></div>`;
  }

  /**
   * Power & FTP leads with the numbers a rider asks about (FTP, W/kg, recent bests, critical power), then the
   * familiar charts, then the expert models under their own heading. The app's cards are only reordered
   * (apex-progress.css flattens the two panels on this page), so every chart keeps its ids and bindings.
   */
  renderPowerSummary() {
    const app = this.app();
    const stage = this.doc.getElementById('anaStage');
    if (!stage) return;
    for (const [id, title, sub] of [
      ['avPowSecBests', 'Best efforts', ''],
      ['avPowSecFtp', 'FTP history', ''],
      ['avPowSecExpert', 'Expert analysis', 'Models and estimates for a closer look.']
    ]) {
      if (this.doc.getElementById(id)) continue;
      const h = this.doc.createElement('div');
      h.id = id; h.className = 'av-pow-section';
      h.innerHTML = `<h3>${esc(title)}</h3>${sub ? `<p>${esc(sub)}</p>` : ''}`;
      stage.appendChild(h);
    }
    let box = this.doc.getElementById('avPowerSummary');
    if (!box) {
      box = this.doc.createElement('div');
      box.id = 'avPowerSummary'; box.className = 'card av-pow-summary';
      stage.appendChild(box);
    }
    const p = (app && app.activeProfile) || {};
    const kg = Number(p.weightKg) || 0;
    const wkg = (w) => (w && kg ? (w / kg).toFixed(2) + ' W/kg' : '');
    let best = {}, model = null, allTime = false;
    try {
      const now = Date.now();
      // The same rows as the Power profile card: last 90 days, else all-time bests (rides and the imported archive).
      /* global VeloTrends */
      const rows = app && typeof VeloTrends !== 'undefined' ? VeloTrends.powerProfile(app.cyclingRides ? app.cyclingRides() : [], (r) => (app.ridePeaks ? app.ridePeaks(r) : null), now, app.medalArchive ? app.medalArchive() : null, kg) : [];
      const secs = [5, 60, 300, 1200];
      rows.forEach((r, k) => { best[secs[k]] = r.last; });
      if (!Object.values(best).some(Boolean)) { rows.forEach((r, k) => { best[secs[k]] = r.allTime; }); allTime = Object.values(best).some(Boolean); }
      model = app && app.powerModelAt ? app.powerModelAt(now) : null;
    } catch (e) { best = {}; model = null; }
    const tile = (sec, label, name) => `<div class="av-pow-tile"><span>${label}<small>${name}</small></span><b class="num">${best[sec] ? esc(best[sec]) + '<small> W</small>' : '--'}</b><small>${best[sec] ? esc(wkg(best[sec])) : 'no power rides yet'}</small></div>`;
    box.innerHTML = `<span class="eyebrow">Your power</span>
      <div class="av-pow-ftp"><div><b class="num">${p.ftp ? esc(p.ftp) : '--'}<small> W</small></b><span>FTP${p.ftp && kg ? ' · ' + esc(wkg(p.ftp)) : ''}</span></div>
        <button type="button" class="btn btn-ghost" id="avPowEditFtp">Edit FTP</button></div>
      <div class="av-pow-tiles">${tile(5, '5 s', 'Sprint')}${tile(60, '1 min', 'Anaerobic')}${tile(300, '5 min', 'VO₂ max')}${tile(1200, '20 min', 'Threshold')}</div>
      <p class="av-note">${model && model.ok ? `Critical power <b class="num">${esc(Math.round(model.cp))} W</b> · W′ <b class="num">${esc((model.w / 1000).toFixed(1))} kJ</b>` : 'Critical power appears after hard 3–20 minute efforts.'} · ${allTime ? 'all-time bests (no power rides in the last 90 days)' : 'bests from the last 90 days'}</p>`;
    box.querySelector('#avPowEditFtp').addEventListener('click', () => this.shell.go('you/profile'));
  }

  /** The one-card answer: fitness trend, fatigue, form and FTP, from the same load model as the charts. */
  renderAnswer() {
    const box = this.el.querySelector('#avProgAnswer');
    const app = this.app();
    if (!app || !app.analytics) { box.innerHTML = '<p class="av-note">Loading…</p>'; return; }
    /* global VeloMetrics */
    let pmc = null;
    try { pmc = app.analytics.calculatePmcHistory(app.completedWorkouts, 90, app.pmcOpts ? app.pmcOpts() : {}); } catch (e) { pmc = null; }
    const has = !!(app.completedWorkouts?.length && pmc && pmc.ctlData && pmc.ctlData.length);
    const v = fitnessVerdict(pmc);
    const tsb = has ? pmc.currentTsb : 0;
    const zone = has && typeof VeloMetrics !== 'undefined' ? VeloMetrics.formZone(tsb) : null;
    const p = app.activeProfile || {};
    const wkg = p.ftp && p.weightKg ? (p.ftp / p.weightKg).toFixed(2) : null;
    const signed = (n) => `${n > 0 ? '+' : ''}${Number(n).toFixed(1)}`;
    box.dataset.trend = v.key;
    box.innerHTML = `<span class="eyebrow">Training load trend</span>
      <h2 class="av-prog-verdict" id="avProgVerdict">${has ? esc(v.text) : 'Your progress starts here'}</h2>
      <p class="av-note">${has ? 'Estimated from your training load.' : 'Record or import rides to see your training trend.'}</p>
      ${has ? sparkline(pmc.ctlData.slice(-43)) : '<button type="button" class="btn btn-primary av-big" id="avProgImport">Import rides</button>'}
      <div class="av-prog-kpis">
        <div><span>Fitness</span><b class="num" id="avProgCtl">${has ? esc(pmc.currentCtl.toFixed(1)) : '--'}</b><small>${v.delta != null ? esc(signed(v.delta)) + ' in 6 wk' : 'CTL'}</small></div>
        <div><span>Fatigue</span><b class="num" id="avProgAtl">${has ? esc(pmc.currentAtl.toFixed(1)) : '--'}</b><small>last 7 days</small></div>
        <div><span>Form</span><b class="num" id="avProgTsb">${has ? esc(signed(tsb)) : '--'}</b><small class="form-badge ${zone ? 'form-' + esc(zone.key) : ''}">${zone ? esc(zone.label) : '--'}</small></div>
        <div><span>FTP</span><b class="num" id="avProgFtpVal">${p.ftp ? esc(p.ftp) + ' W' : '--'}</b><small>${wkg ? esc(wkg) + ' W/kg' : 'set in You'}</small></div>
      </div><details class="av-more"><summary>About these numbers</summary><p class="av-note">Fitness and fatigue estimate longer-term and recent training load. Form is the difference between them. These estimates do not measure performance or recovery on their own.</p></details>`;
    box.querySelector('#avProgImport')?.addEventListener('click', () => { this.shell.go('history'); this.doc.getElementById('avHistAdd')?.click(); });
  }
}

/** Registers the Progress pages on the shell; returns { tab } for window.ApexNative.progressTab. */
export function installProgressTab({ shell, win = window }) {
  const tab = new ProgressTab({ shell, win });
  tab.register();
  return { tab };
}
