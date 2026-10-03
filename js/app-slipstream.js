// APEX VELO // LAB - Slipstream visuals.
// Purely presentational: watches values the app already writes to the page and mirrors them
// into the zone light, the cockpit power ring and the W' liquid. It never calls into the app,
// changes app state or touches an element the app reads, so ride logic is unaffected.
(function () {
  'use strict';

  // Zone light: two colours per Coggan zone (cool in recovery, hot in the hard zones).
  const ZONE_LIGHT = {
    Z1: ['#3d63ff', '#19c2e0'], Z2: ['#2a86ff', '#1fd1b2'], Z3: ['#16c08d', '#a7e04a'], Z4: ['#ffb21f', '#ff7a2f'],
    Z5: ['#ff5a36', '#ff2d7a'], Z6: ['#ff2e63', '#a23bff'], Z7: ['#9b4dff', '#ff3dce']
  };
  const RING_R = 160, RING_C = 2 * Math.PI * RING_R, RING_ARC = RING_C * 0.75;
  const TARGET_AT = 0.625; // target sits at the same spot on the ring for every interval

  const $ = (id) => document.getElementById(id);
  const num = (el) => { const n = parseFloat(String(el && el.textContent || '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };
  const watch = (el, fn, opts) => { if (!el) return; fn(); new MutationObserver(fn).observe(el, opts || { childList: true, characterData: true, subtree: true }); };

  let zoneKey = '';
  function updateZone() {
    const tag = $('hudIntervalTargetTag');
    const m = tag && /\((\d+(?:\.\d+)?)%\)/.exec(tag.textContent || '');
    if (!m || !window.VeloMetrics) return;
    const z = VeloMetrics.zoneForPct(Number(m[1]));
    if (!z || z.short === zoneKey || !ZONE_LIGHT[z.short]) return;
    zoneKey = z.short;
    const [a, b] = ZONE_LIGHT[z.short];
    document.body.style.setProperty('--zone-a', a);
    document.body.style.setProperty('--zone-b', b);
    document.body.dataset.zone = z.short.toLowerCase();
  }

  function updateRing() {
    const arc = $('ssRingArc'), band = $('ssRingBand');
    if (!arc || !band) return;
    const target = num($('valTargetPower'));
    const power = num($('valInstantPower'));
    const max = target > 0 ? target / TARGET_AT : 400;
    const frac = Math.max(0, Math.min(1, power / max));
    arc.style.strokeDasharray = `${(frac * RING_ARC).toFixed(1)} ${RING_C.toFixed(1)}`;
    if (target > 0) {
      const a = (target * 0.95) / max * RING_ARC, b = (target * 1.05) / max * RING_ARC;
      band.style.strokeDasharray = `${(b - a).toFixed(1)} ${RING_C.toFixed(1)}`;
      band.style.strokeDashoffset = (-a).toFixed(1);
    } else {
      band.style.strokeDasharray = `0 ${RING_C.toFixed(1)}`;
    }
  }

  function placeTick() {
    const tick = $('ssRingTick');
    if (!tick) return;
    const ang = (135 + TARGET_AT * 270) * Math.PI / 180;
    tick.setAttribute('x1', (200 + 174 * Math.cos(ang)).toFixed(1));
    tick.setAttribute('y1', (200 + 174 * Math.sin(ang)).toFixed(1));
    tick.setAttribute('x2', (200 + 190 * Math.cos(ang)).toFixed(1));
    tick.setAttribute('y2', (200 + 190 * Math.sin(ang)).toFixed(1));
  }

  function updateLiquid() {
    const fill = $('wbalFill'), liquid = $('ssWbalLiquid');
    if (!fill || !liquid) return;
    const w = parseFloat(fill.style.width);
    liquid.style.height = `${Number.isFinite(w) ? Math.max(0, Math.min(100, w)) : 0}%`;
    liquid.dataset.level = fill.dataset.level || 'high';
  }

  function init() {
    placeTick();
    watch($('hudIntervalTargetTag'), updateZone);
    watch($('valInstantPower'), updateRing);
    watch($('valTargetPower'), updateRing);
    watch($('wbalFill'), updateLiquid, { attributes: true, attributeFilter: ['style', 'data-level'] });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
