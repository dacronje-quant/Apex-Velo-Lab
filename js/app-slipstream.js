// APEX VELO // LAB - Slipstream visuals.
// Purely presentational: watches values the app already writes to the page (and reads, never
// writes, the loaded workout on window.app) and mirrors them into the zone light, the cockpit
// power ring, the step progress, the "Next" line, the sparklines and the W' liquid. It never
// calls app methods, changes app state or touches an element the app reads.
(function () {
  'use strict';

  // Zone light: two colours per Coggan zone (cool in recovery, hot in the hard zones).
  const ZONE_LIGHT = {
    Z1: ['#3d63ff', '#19c2e0'], Z2: ['#2a86ff', '#1fd1b2'], Z3: ['#16c08d', '#a7e04a'], Z4: ['#ffb21f', '#ff7a2f'],
    Z5: ['#ff5a36', '#ff2d7a'], Z6: ['#ff2e63', '#a23bff'], Z7: ['#9b4dff', '#ff3dce']
  };
  const RING_R = 160, RING_C = 2 * Math.PI * RING_R, RING_ARC = RING_C * 0.75;
  const TARGET_AT = 0.625; // target sits at the same spot on the ring for every interval
  const SPARK_SECONDS = 60;

  const $ = (id) => document.getElementById(id);
  const num = (el) => { const n = parseFloat(String(el && el.textContent || '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };
  const watch = (el, fn, opts) => { if (!el) return; fn(); new MutationObserver(fn).observe(el, opts || { childList: true, characterData: true, subtree: true }); };
  const setText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
  const fmt = (s) => { s = Math.max(0, Math.round(Number(s) || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(r).padStart(2, '0')}`; };

  // Read-only view of the loaded workout; null when the app is not ready yet.
  function rideState() {
    const app = window.app;
    const ivs = app && app.currentWorkout && app.currentWorkout.intervals;
    if (!Array.isArray(ivs) || !ivs.length) return null;
    const i = Math.max(0, Math.min(ivs.length - 1, Number(app.intervalIndex) || 0));
    return { ivs, i, iv: ivs[i], remaining: Number(app.intervalSecondsRemaining), ftp: Number(app.activeProfile && app.activeProfile.ftp) || 0, bias: Number(app.ergBiasMultiplier) || 1 };
  }

  let zoneKey = '';
  function updateZone() {
    const tag = $('hudIntervalTargetTag');
    const m = tag && /^\s*Target:\s*(\d+)\s*W\s*\((\d+(?:\.\d+)?)%\)/i.exec(tag.textContent || '');
    if (!m || !window.VeloMetrics) return;
    const z = VeloMetrics.zoneForPct(Number(m[2]));
    const ringTarget = $('ssRingTarget');
    if (ringTarget) ringTarget.innerHTML = `target <b>${m[1]} W</b> · ${m[2]}% FTP`;
    if (!z || !ZONE_LIGHT[z.short]) return;
    setText($('ssZoneLabel'), `${z.short} · ${z.name}`);
    if (z.short === zoneKey) return;
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
    tick.setAttribute('x1', (200 + 176 * Math.cos(ang)).toFixed(1));
    tick.setAttribute('y1', (200 + 176 * Math.sin(ang)).toFixed(1));
    tick.setAttribute('x2', (200 + 194 * Math.cos(ang)).toFixed(1));
    tick.setAttribute('y2', (200 + 194 * Math.sin(ang)).toFixed(1));
  }

  function updateStep() {
    const st = rideState();
    const bar = $('ssStepProgress'), next = $('ssNext');
    if (!st) return;
    const dur = Number(st.iv.duration) || 0;
    if (bar) bar.style.width = dur > 0 && Number.isFinite(st.remaining) ? `${Math.max(0, Math.min(100, (1 - st.remaining / dur) * 100)).toFixed(1)}%` : '0%';
    if (!next) return;
    const nx = st.ivs[st.i + 1];
    next.hidden = false;
    if (nx) {
      setText($('ssNextName'), String(nx.name || `Step ${st.i + 2}`));
      const w = st.ftp ? `${Math.round(st.ftp * (Number(nx.pctFtp) / 100) * st.bias)} W · ` : '';
      setText($('ssNextInfo'), `${w}${fmt(nx.duration)}`);
    } else {
      setText($('ssNextName'), 'Finish');
      setText($('ssNextInfo'), 'last step');
    }
  }

  function updateLiquid() {
    const fill = $('wbalFill'), liquid = $('ssWbalLiquid');
    if (!fill || !liquid) return;
    const w = parseFloat(fill.style.width);
    liquid.style.height = `${Number.isFinite(w) ? Math.max(0, Math.min(100, w)) : 0}%`;
    liquid.dataset.level = fill.dataset.level || 'high';
  }

  // Sparklines: sample the shown heart rate and cadence once a second.
  const spark = { hr: [], cad: [] };
  function drawSpark(line, values, lo, hi) {
    if (!line) return;
    if (values.length < 2) { line.setAttribute('points', ''); return; }
    const step = 240 / (SPARK_SECONDS - 1), off = 240 - (values.length - 1) * step;
    line.setAttribute('points', values.map((v, k) => `${(off + k * step).toFixed(1)},${(34 - Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * 32).toFixed(1)}`).join(' '));
  }
  function sampleSparks() {
    if (document.hidden) return;
    const push = (arr, el) => { const t = el && el.textContent; const v = parseFloat(t); arr.push(Number.isFinite(v) && v > 0 ? v : null); if (arr.length > SPARK_SECONDS) arr.shift(); };
    push(spark.hr, $('valHeartRate'));
    push(spark.cad, $('valCadence'));
    const range = (arr, minSpan) => {
      const v = arr.filter((x) => x !== null);
      if (!v.length) return null;
      let lo = Math.min(...v), hi = Math.max(...v);
      if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
      return { v, lo, hi };
    };
    const hr = range(spark.hr, 20), cad = range(spark.cad, 20);
    drawSpark($('ssSparkHr'), hr ? spark.hr.map((x) => (x === null ? hr.lo : x)) : [], hr ? hr.lo : 0, hr ? hr.hi : 1);
    drawSpark($('ssSparkCad'), cad ? spark.cad.map((x) => (x === null ? cad.lo : x)) : [], cad ? cad.lo : 0, cad ? cad.hi : 1);
  }

  function init() {
    placeTick();
    watch($('hudIntervalTargetTag'), updateZone);
    watch($('valInstantPower'), updateRing);
    watch($('valTargetPower'), updateRing);
    watch($('hudIntervalCountdown'), updateStep);
    watch($('hudIntervalName'), updateStep);
    watch($('wbalFill'), updateLiquid, { attributes: true, attributeFilter: ['style', 'data-level'] });
    setInterval(sampleSparks, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
