/**
 * APEX VELO // LAB - Analytics studio (mixin on VeloApp).
 *
 * Turns the Analytics page into modules: a dock of tabs that each carry a live headline value,
 * one panel at a time (keyboard 1-7, [ and ]), drill-down from the overview tiles, an insight feed
 * built only from numbers the page already computed, legend chips that show / hide a series,
 * drag-to-zoom on the time charts and an expanded (full-window) view of any chart card.
 */
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const PANEL_KEY = 'apex_ana_panel';

  /** Draws the drag-to-zoom selection and drops a zoom the app has since replaced (range change). */
  const brushPlugin = {
    id: 'anaBrush',
    beforeUpdate(chart) {
      const st = chart.$brush;
      if (!st || !st.zoom) return;
      const x = chart.options.scales && chart.options.scales.x;
      if (!x || x.min !== st.zoom.min || x.max !== st.zoom.max) { st.zoom = null; st.btn.hidden = true; }
    },
    afterDraw(chart) {
      const st = chart.$brush, a = chart.chartArea;
      if (!st || !st.drag || !a) return;
      const l = Math.min(st.drag.x0, st.drag.x1), r = Math.max(st.drag.x0, st.drag.x1);
      const c = chart.ctx;
      c.save();
      c.fillStyle = 'rgba(124, 200, 255, 0.12)'; c.fillRect(l, a.top, r - l, a.bottom - a.top);
      c.strokeStyle = 'rgba(124, 200, 255, 0.55)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(l + 0.5, a.top); c.lineTo(l + 0.5, a.bottom); c.moveTo(r - 0.5, a.top); c.lineTo(r - 0.5, a.bottom); c.stroke();
      c.restore();
    }
  };

  Object.assign(VeloApp.prototype, {
    /** Panel keys in dock order. */
    anaPanels() {
      return [...document.querySelectorAll('#anaSectionNav .ana-mod')].map(b => b.dataset.panel);
    },

    /** Dock, panels, pager, drill-down links, legends, zoom and expand (replaces the scroll-spy nav). */
    initAnalyticsNav() {
      const nav = document.getElementById('anaSectionNav');
      const view = document.getElementById('view-analytics');
      if (!nav || !view) return;
      if (typeof Chart !== 'undefined' && Chart.register && !this._anaBrushRegistered) { Chart.register(brushPlugin); this._anaBrushRegistered = true; }

      const tabs = [...nav.querySelectorAll('.ana-mod')];
      tabs.forEach(t => this.on(t, 'click', () => this.showAnalyticsPanel(t.dataset.panel, { focusTab: false })));
      // Roving focus inside the tab list (arrows, Home, End).
      this.on(nav, 'keydown', (e) => {
        const i = tabs.indexOf(document.activeElement);
        if (i < 0) return;
        const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        const t = tabs[(to + tabs.length) % tabs.length];
        this.showAnalyticsPanel(t.dataset.panel, { focusTab: true });
      });
      // 1-7 jump to a module, [ and ] step through them (only on this page, never while typing or in a dialog).
      this.on(window, 'keydown', (e) => {
        if (this.activeTab !== 'analytics' || e.metaKey || e.ctrlKey || e.altKey) return;
        const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable)) return;
        if (document.querySelector('.modal-overlay.open') || document.getElementById('anaZoomDialog')?.open) return;
        const keys = this.anaPanels();
        const m = /^Digit([1-9])$/.exec(e.code);
        if (m && keys[Number(m[1]) - 1]) { e.preventDefault(); this.showAnalyticsPanel(keys[Number(m[1]) - 1]); }
        else if (e.code === 'BracketRight' || e.code === 'BracketLeft') { e.preventDefault(); this.stepAnalyticsPanel(e.code === 'BracketRight' ? 1 : -1); }
      });
      document.querySelectorAll('#anaPager .ana-pager-btn').forEach(b => this.on(b, 'click', () => this.stepAnalyticsPanel(Number(b.dataset.dir), true)));

      // Drill-down: tiles, today pills and insights carry data-goto (panel) and data-spot (card id).
      const go = (el) => this.showAnalyticsPanel(el.dataset.goto, { spot: el.dataset.spot });
      this.on(view, 'click', (e) => {
        const el = e.target.closest('[data-goto]');
        if (!el || !view.contains(el)) return;
        const inner = e.target.closest('button, a, input, summary');
        if (inner && inner !== el && el.contains(inner)) return; // e.g. the readiness chip inside a pill
        go(el);
      });
      this.on(view, 'keydown', (e) => {
        const el = e.target.closest && e.target.closest('[data-goto][role="button"]');
        if (!el || e.target !== el || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault(); go(el);
      });

      // Legend chips show / hide their series.
      view.querySelectorAll('.ana-legend').forEach(box => this.on(box, 'click', (e) => {
        const b = e.target.closest('.lg-toggle');
        const chart = b && this[box.dataset.chart];
        if (!chart) return;
        const i = Number(b.dataset.ds);
        const on = !chart.isDatasetVisible(i);
        chart.setDatasetVisibility(i, on);
        chart.update();
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('is-off', !on);
      }));

      // Drag-to-zoom (mouse / pen) on the long time-series charts.
      [[this.pmcChart, 'category'], [this.efChart, 'linear'], [this.balanceChart, 'linear'], [this.cpHistoryChart, 'linear']]
        .forEach(([c, kind]) => this.attachBrushZoom(c, kind));

      this.initAnaExpand();

      // Sticky dock gets a solid backdrop once it is stuck under the header.
      const sentinel = document.getElementById('anaDockSentinel');
      if (sentinel && typeof IntersectionObserver === 'function') {
        const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 68;
        const io = new IntersectionObserver(([en]) => nav.classList.toggle('is-stuck', !en.isIntersecting && en.boundingClientRect.top < header + 20),
          { rootMargin: `-${header + 9}px 0px 0px 0px` });
        io.observe(sentinel);
        this._anaDockObserver = io;
      }
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => this.moveAnaGlider(false));
        ro.observe(nav);
        this._anaDockResize = ro;
      }

      let start = 'overview';
      try { const saved = localStorage.getItem(PANEL_KEY); if (saved && this.anaPanels().includes(saved)) start = saved; } catch (e) { /* storage blocked */ }
      this.showAnalyticsPanel(start, { instant: true, remember: false });
    },

    /** Shows one module. opts: spot (card id to bring into view), focusTab, instant, remember. */
    showAnalyticsPanel(key, opts = {}) {
      const keys = this.anaPanels();
      if (!keys.includes(key)) return;
      const prev = this.anaPanel;
      const dir = prev && keys.indexOf(key) < keys.indexOf(prev) ? -1 : 1;
      this.anaPanel = key;
      if (opts.remember !== false) { try { localStorage.setItem(PANEL_KEY, key); } catch (e) { /* storage blocked */ } }

      document.querySelectorAll('#anaSectionNav .ana-mod').forEach(t => {
        const on = t.dataset.panel === key;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        if (on && opts.focusTab) t.focus();
      });
      const animate = !opts.instant && prev !== key && !reducedMotion();
      let shown = null;
      document.querySelectorAll('#anaStage > .ana-panel').forEach(p => {
        const on = p.dataset.panel === key;
        if (on === !p.hidden) return;
        p.hidden = !on;
        if (on) shown = p;
      });
      if (shown && animate) {
        shown.style.setProperty('--ana-dir', String(dir));
        shown.querySelectorAll('.card, .tile, .pmc-stat-pill, .ana-panel-head').forEach((el, i) => el.style.setProperty('--i', String(Math.min(i, 8))));
        shown.classList.remove('ana-enter');
        void shown.offsetWidth; // restart the entrance animation
        shown.classList.add('ana-enter');
        clearTimeout(this._anaEnterTimer);
        this._anaEnterTimer = setTimeout(() => shown.classList.remove('ana-enter'), 900);
      }
      this.updateAnaPager();
      this.moveAnaGlider(!opts.instant);

      // Charts measured while hidden have no size: fit them now and replay their draw-in.
      const panel = document.getElementById('ana-panel-' + key);
      requestAnimationFrame(() => {
        this.anaChartsIn(panel).forEach(c => {
          c.resize();
          if (animate && c.options.animation !== false) { c.reset(); c.update(); }
        });
      });

      // Keep the dock in view when switching from deep in a long panel.
      if (!opts.instant && !opts.spot && this.activeTab === 'analytics') {
        const nav = document.getElementById('anaSectionNav');
        const sentinel = document.getElementById('anaDockSentinel');
        if (nav && sentinel && getComputedStyle(nav).position === 'sticky') {
          const top = sentinel.getBoundingClientRect().top + window.scrollY - (parseFloat(getComputedStyle(nav).top) || 0) + 1;
          if (window.scrollY > top) window.scrollTo({ top, behavior: 'auto' });
        }
      }
      if (opts.spot) requestAnimationFrame(() => this.spotlightAnaCard(opts.spot));
    },

    stepAnalyticsPanel(dir, toTop = false) {
      const keys = this.anaPanels();
      const i = keys.indexOf(this.anaPanel || 'overview');
      const next = keys[Math.max(0, Math.min(keys.length - 1, i + dir))];
      if (next === this.anaPanel) return;
      this.showAnalyticsPanel(next);
      if (toTop) {
        const nav = document.getElementById('anaSectionNav');
        if (nav) nav.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
    },

    /** Chart.js instances drawn inside an element. */
    anaChartsIn(root) {
      if (!root || typeof Chart === 'undefined' || !Chart.getChart) return [];
      return [...root.querySelectorAll('canvas')].map(c => Chart.getChart(c)).filter(Boolean);
    },

    updateAnaPager() {
      const keys = this.anaPanels();
      const i = keys.indexOf(this.anaPanel);
      const name = (k) => document.querySelector(`#anaSectionNav .ana-mod[data-panel="${k}"] .ana-mod-name`)?.textContent || '';
      const prev = document.getElementById('anaPagerPrev'), next = document.getElementById('anaPagerNext');
      if (prev) { prev.hidden = i <= 0; this.setText('anaPagerPrevName', i > 0 ? name(keys[i - 1]) : ''); }
      if (next) { next.hidden = i < 0 || i >= keys.length - 1; this.setText('anaPagerNextName', i < keys.length - 1 ? name(keys[i + 1]) : ''); }
    },

    /** Slides the highlight behind the active module and scrolls it into view on narrow screens. */
    moveAnaGlider(smooth = true) {
      const nav = document.getElementById('anaSectionNav');
      const glider = nav && nav.querySelector('.ana-dock-glider');
      const active = nav && nav.querySelector('.ana-mod.active');
      if (!glider || !active || !active.offsetWidth) return;
      glider.classList.toggle('no-anim', !smooth || reducedMotion());
      glider.style.width = active.offsetWidth + 'px';
      glider.style.height = active.offsetHeight + 'px';
      glider.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
      glider.classList.add('ready');
      if (nav.scrollWidth > nav.clientWidth + 2) {
        const left = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
        nav.scrollTo({ left: Math.max(0, left), behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
      }
    },

    /** Brings a card into view and pulses its outline. */
    spotlightAnaCard(id) {
      const el = document.getElementById(id);
      if (!el || el.offsetParent === null) return;
      el.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
      el.classList.remove('ana-spot');
      void el.offsetWidth;
      el.classList.add('ana-spot');
      clearTimeout(el._anaSpotTimer);
      el._anaSpotTimer = setTimeout(() => el.classList.remove('ana-spot'), 1900);
    },

    // ----------------------------------------------------------- zoom (brush) --
    /** Mouse / pen drag across the plot zooms the x axis; double-click or the chip resets it. */
    attachBrushZoom(chart, kind) {
      if (!chart || chart.$brush) return;
      const canvas = chart.canvas, box = canvas.parentElement;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'ana-zoom-reset'; btn.hidden = true;
      btn.innerHTML = '<svg class="ic ic-xs"><use href="#i-reset"/></svg>Reset zoom';
      box.appendChild(btn);
      const st = chart.$brush = { kind, drag: null, zoom: null, home: null, btn };
      const localX = (e) => {
        const a = chart.chartArea, r = canvas.getBoundingClientRect();
        return Math.max(a.left, Math.min(a.right, e.clientX - r.left));
      };
      this.on(canvas, 'pointerdown', (e) => {
        if (e.pointerType === 'touch' || e.button !== 0 || !chart.chartArea) return;
        const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, a = chart.chartArea;
        if (x < a.left || x > a.right || y < a.top || y > a.bottom) return;
        st.drag = { x0: x, x1: x };
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* capture unsupported */ }
      });
      this.on(canvas, 'pointermove', (e) => { if (st.drag) { st.drag.x1 = localX(e); chart.draw(); } });
      const finish = () => {
        const d = st.drag;
        st.drag = null;
        if (!d) return;
        if (Math.abs(d.x1 - d.x0) < 12) { chart.draw(); return; }
        st.dragEnd = Date.now(); // the click that ends a zoom drag is not a tap on a day
        const xs = chart.scales.x;
        let min = xs.getValueForPixel(Math.min(d.x0, d.x1)), max = xs.getValueForPixel(Math.max(d.x0, d.x1));
        if (kind === 'category') {
          min = Math.max(0, Math.round(min)); max = Math.round(max);
          if (max - min < 2) { chart.draw(); return; }
        }
        if (!st.zoom) st.home = { min: chart.options.scales.x.min, max: chart.options.scales.x.max };
        chart.options.scales.x.min = min; chart.options.scales.x.max = max;
        st.zoom = { min, max };
        chart.update();
        st.btn.hidden = false;
      };
      this.on(canvas, 'pointerup', finish);
      this.on(canvas, 'pointercancel', () => { st.drag = null; chart.draw(); });
      this.on(canvas, 'dblclick', () => this.resetChartZoom(chart));
      this.on(btn, 'click', () => this.resetChartZoom(chart));
    },

    resetChartZoom(chart, silent = false) {
      const st = chart && chart.$brush;
      if (!st || !st.zoom) return;
      chart.options.scales.x.min = st.home ? st.home.min : undefined;
      chart.options.scales.x.max = st.home ? st.home.max : undefined;
      st.zoom = null; st.btn.hidden = true;
      if (!silent) chart.update();
    },

    // -------------------------------------------------------------- expand --
    /** Every [data-expandable] card gets a button that opens it in a full-window dialog. */
    initAnaExpand() {
      const dlg = document.getElementById('anaZoomDialog'), body = document.getElementById('anaZoomBody');
      if (!dlg || !body || typeof dlg.showModal !== 'function') return;
      document.querySelectorAll('#view-analytics [data-expandable]').forEach(card => {
        const title = card.querySelector('.card-title');
        if (!title || title.querySelector('.ana-expand-btn')) return;
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ana-expand-btn';
        const name = (title.firstElementChild ? title.firstElementChild.childNodes[0]?.textContent || title.firstElementChild.textContent : '').trim();
        b.setAttribute('aria-label', `Expand ${name || 'chart'}`); b.title = 'Expand';
        b.innerHTML = '<svg class="ic"><use href="#i-expand"/></svg>';
        title.appendChild(b);
        this.on(b, 'click', () => this.expandAnaCard(card));
      });
      this.on(document.getElementById('anaZoomClose'), 'click', () => dlg.close());
      this.on(dlg, 'click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop
      this.on(dlg, 'close', () => this.collapseAnaCard());
    },

    expandAnaCard(card) {
      const dlg = document.getElementById('anaZoomDialog'), body = document.getElementById('anaZoomBody');
      if (!dlg || dlg.open || !card) return;
      const ph = document.createElement('div');
      ph.className = 'ana-zoom-placeholder';
      ph.style.height = card.offsetHeight + 'px';
      card.before(ph);
      this._anaZoom = { card, ph };
      body.appendChild(card);
      card.classList.add('is-zoomed');
      dlg.showModal();
      document.documentElement.classList.add('ana-zoom-lock');
      requestAnimationFrame(() => this.anaChartsIn(card).forEach(c => c.resize()));
    },

    collapseAnaCard() {
      const z = this._anaZoom;
      document.documentElement.classList.remove('ana-zoom-lock');
      if (!z) return;
      this._anaZoom = null;
      z.card.classList.remove('is-zoomed');
      z.ph.replaceWith(z.card);
      requestAnimationFrame(() => this.anaChartsIn(z.card).forEach(c => c.resize()));
      const b = z.card.querySelector('.ana-expand-btn');
      if (b) b.focus({ preventScroll: true });
    },

    // ----------------------------------------------- dock values & insights --
    /** Headline value on each dock module plus the "What changed" feed (after every dashboard render). */
    renderAnaOverview() {
      const d = this._dashData;
      if (!d) return;
      const text = (id) => (document.getElementById(id)?.textContent || '').trim();
      const tile = (k) => d.tiles.find(t => t.key === k) || {};
      const fin = (v) => v !== null && v !== undefined && Number.isFinite(v);
      // Arrow = direction of the 6-week change, colour = whether that direction is good (as on the tiles).
      const trend = (t, step) => {
        if (!fin(t.now) || !fin(t.then) || Math.abs(t.now - t.then) < step) return null;
        const up = t.now > t.then;
        return { dir: up ? 'up' : 'down', tone: (t.good === 'up') === up ? 'good' : 'bad' };
      };
      const setMod = (k, stat, sub, tr = null) => {
        this.setText('anaModStat-' + k, stat);
        this.setText('anaModSub-' + k, sub);
        const el = document.getElementById('anaModStat-' + k);
        if (el) { el.dataset.dir = tr ? tr.dir : ''; el.dataset.tone = tr ? tr.tone : ''; }
      };
      const has = this.cyclingRides().length > 0;
      const form = text('pmcFormStatus');
      setMod('overview', has ? text('pmcValTsb') : '--', has && form && form !== '--' ? form : 'form today');
      const ramp = text('anaRampVal');
      setMod('load', has ? text('pmcValCtl') : '--', ramp && ramp !== '--' ? `ramp ${ramp} / wk` : 'fitness (CTL)', trend(tile('ctl'), 0.1));
      const m = this._cpModelForFtp;
      const pdc = this._pdc;
      const g20 = typeof VeloPower !== 'undefined' ? VeloPower.gridIndex(1200) : -1;
      const p20 = pdc && g20 >= 0 ? pdc.range.watts[g20] : null;
      if (m) setMod('power', `${m.cp} W`, `CP · W′ ${(m.w / 1000).toFixed(1)} kJ`);
      else if (p20 > 0) setMod('power', `${p20} W`, 'best 20 min');
      else setMod('power', '--', 'no power data yet');
      setMod('ftp', text('pmcValFtp') || '--', (text('pmcValWkg').match(/^[\d.]+ W\/kg/) || ['in use'])[0], trend(tile('ftp'), 1));
      const s = this._anaSeiler;
      setMod('intensity', s ? s.label : '--', s ? `${Math.round(s.pct[0])}% easy · ${Math.round(s.pct[2])}% hard` : 'needs power data');
      const ef = tile('ef');
      setMod('aerobic', fin(ef.now) ? ef.now.toFixed(2) : '--', fin(ef.now) ? 'W per bpm · 30 days' : 'efficiency (EF)', trend(ef, 0.01));
      this.renderAnaInsights(d);
    },

    renderAnaInsights(d) {
      const box = document.getElementById('anaInsights');
      if (!box) return;
      const fin = (v) => v !== null && v !== undefined && Number.isFinite(v);
      const signed = (v, dec = 0) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(dec)}`;
      const tile = (k) => d.tiles.find(t => t.key === k) || {};
      const out = [];
      const add = (o) => out.push(o);
      if (!this.cyclingRides().length) {
        box.innerHTML = '<div class="mix-note">No rides yet. Record a ride or import files in History and this page fills in.</div>';
        return;
      }
      const pmc = d.pmc;
      if (pmc && fin(pmc.currentTsb)) {
        const z = VeloMetrics.formZone(pmc.currentTsb);
        add({ goto: 'load', spot: 'anaCardPmc', icon: 'i-activity', tone: ['fresh', 'productive', 'optimal'].includes(z.key) ? 'good' : 'bad',
          title: `Form: ${z.label}`, value: signed(pmc.currentTsb, 1), text: z.desc });
      }
      const ctl = tile('ctl');
      if (fin(ctl.now) && fin(ctl.then)) {
        const dv = ctl.now - ctl.then, v = VeloTrends.rampVerdict(d.ramp);
        add({ goto: 'load', spot: 'anaCardPmc', icon: 'i-activity', tone: Math.abs(dv) < 0.1 ? 'flat' : dv > 0 ? 'good' : 'bad',
          title: Math.abs(dv) < 0.1 ? 'Fitness is holding' : `Fitness ${dv > 0 ? 'up' : 'down'} in 6 weeks`, value: signed(dv, 1),
          text: `CTL ${ctl.now.toFixed(1)} now${v.key !== 'none' ? ` · ramp: ${v.label.toLowerCase()}` : ''}` });
      }
      const k = this._progKpis;
      if (k && k.cur && k.cur.rides) {
        const c = k.cur, p = k.prev;
        const pct = p && p.hours ? Math.round(((c.hours - p.hours) / p.hours) * 100) : null;
        add({ goto: 'load', spot: 'anaCardWeekly', icon: 'i-calendar', tone: pct === null ? 'flat' : pct > 0 ? 'good' : pct < 0 ? 'bad' : 'flat',
          title: `${c.hours.toFixed(1)} h on the bike`, value: pct === null ? `${c.rides}` : `${pct > 0 ? '+' : ''}${pct}%`,
          text: `${c.rides} ride${c.rides === 1 ? '' : 's'} · ${Math.round(c.tss).toLocaleString()} TSS${pct === null ? '' : ` · vs the period before`}` });
      }
      const prs = this._anaPrs || [];
      if (prs.length) add({ goto: 'power', spot: 'anaCardProfile', icon: 'i-trophy', tone: 'good', title: `New PR${prs.length === 1 ? '' : 's'} in the last 90 days`, value: `${prs.length}`, text: prs.join(' · ') });
      const m = this._cpModelForFtp, ftp = Number((this.activeProfile || {}).ftp) || 0;
      if (m) {
        const vs = ftp ? Math.round(((m.cp - ftp) / ftp) * 100) : null;
        add({ goto: 'power', spot: 'cpModelCard', icon: 'i-bolt', tone: vs !== null && vs > 5 ? 'good' : 'flat', title: `Critical power ${m.cp} W`, value: vs === null ? '' : `${vs > 0 ? '+' : ''}${vs}%`,
          text: `W′ ${(m.w / 1000).toFixed(1)} kJ${vs === null ? '' : ` · ${vs > 5 ? 'well above' : vs < -5 ? 'below' : 'close to'} your FTP of ${ftp} W`}` });
      } else {
        const p = tile('p20');
        if (fin(p.now)) {
          const dv = fin(p.then) ? p.now - p.then : null;
          add({ goto: 'power', spot: 'anaCardProfile', icon: 'i-bolt', tone: dv === null || dv === 0 ? 'flat' : dv > 0 ? 'good' : 'bad', title: `20-min peak ${Math.round(p.now)} W`,
            value: dv === null ? '' : `${signed(dv)} W`, text: dv === null ? 'Best 20 minutes in the last 90 days' : 'vs 6 weeks ago (best of the 90 days before)' });
        }
      }
      const s = this._anaSeiler;
      if (s) add({ goto: 'intensity', spot: 'anaCardZones', icon: 'i-focus', tone: 'flat', title: `${s.label} intensity`, value: s.pi === null ? '' : `PI ${s.pi.toFixed(2)}`,
        text: `${s.pct[0]}% low · ${s.pct[1]}% moderate · ${s.pct[2]}% high` });
      const ef = tile('ef');
      if (fin(ef.now) && fin(ef.then) && ef.then > 0) {
        const pct = ((ef.now - ef.then) / ef.then) * 100;
        add({ goto: 'aerobic', spot: 'anaCardEf', icon: 'i-crank', tone: Math.abs(pct) < 0.5 ? 'flat' : pct > 0 ? 'good' : 'bad',
          title: `Aerobic efficiency ${Math.abs(pct) < 0.5 ? 'steady' : pct > 0 ? 'rising' : 'slipping'}`, value: `${signed(pct, 1)}%`, text: `EF ${ef.now.toFixed(2)} W per bpm, 30-day average vs 6 weeks ago` });
      }
      const rhr = tile('rhr'), hrv = tile('hrv');
      if (fin(rhr.now) || fin(hrv.now)) {
        const dr = fin(rhr.now) && fin(rhr.then) ? rhr.now - rhr.then : null;
        add({ goto: 'health', spot: 'anaCardHealthHr', icon: 'i-heart', tone: dr === null || Math.abs(dr) < 1 ? 'flat' : dr < 0 ? 'good' : 'bad',
          title: fin(rhr.now) ? `Resting HR ${Math.round(rhr.now)} bpm` : `HRV ${Math.round(hrv.now)} ms`, value: dr === null ? '' : `${signed(dr)} bpm`,
          text: [fin(hrv.now) && fin(rhr.now) ? `HRV ${Math.round(hrv.now)} ms` : '', '30-day averages from Apple Health'].filter(Boolean).join(' · ') });
      }
      box.innerHTML = out.map(o => `
        <button type="button" class="ana-insight" data-goto="${o.goto}" data-spot="${o.spot}" data-tone="${o.tone}">
          <span class="ana-insight-ic"><svg class="ic"><use href="#${o.icon}"/></svg></span>
          <span class="ana-insight-txt"><b>${esc(o.title)}</b><small>${esc(o.text)}</small></span>
          ${o.value ? `<span class="ana-insight-val num">${esc(o.value)}</span>` : ''}
          <svg class="ic ic-xs ana-insight-go"><use href="#i-right"/></svg>
        </button>`).join('') || '<div class="mix-note">Not enough data in this period yet.</div>';
    }
  });
})();
