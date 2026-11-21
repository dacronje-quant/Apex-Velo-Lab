/**
 * APEX VELO // LAB - the gear display for a KICKR BIKE / KICKR BIKE SHIFT (PC cockpit and phone ride screen).
 *
 * The bike reports the gear picked on its own shifters (VeloBle 'gear' events: front and rear, 1-based, with
 * the number of chainrings and cogs it is set up with). With ERG off the trainer is in free resistance, so
 * those gears set how hard it is; with ERG on the trainer holds the target power and the gears only show.
 */
(function (root) {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** "2 × 12" - what the bike is set up with. */
  function setupText(g) { return `${g.frontCount} × ${g.rearCount}`; }

  /** Rear cog 1 is the largest (easiest) on the bike, so a higher number is a harder gear. */
  function describe(g) {
    if (!g) return '';
    return `Gear ${g.front}-${g.rear}: chainring ${g.front} of ${g.frontCount}, cog ${g.rear} of ${g.rearCount}`;
  }

  /** The widget's inner HTML. `erg`: ERG holds power, so the gears do not change resistance. `compact`: phone. */
  function html(g, { erg = false, compact = false } = {}) {
    if (!g) return '';
    const rings = Array.from({ length: g.frontCount }, (_, k) => `<i class="${k + 1 === g.front ? 'on' : ''}" style="--s:${0.62 + 0.38 * (k + 1) / g.frontCount}"></i>`).join('');
    // The cassette as a ladder: easiest (big cog, tall) on the left to hardest (small cog, short) on the right.
    const cogs = Array.from({ length: g.rearCount }, (_, k) => {
      const n = k + 1;
      const h = 100 - (k / Math.max(1, g.rearCount - 1)) * 62;
      return `<i class="${n === g.rear ? 'on' : n < g.rear ? 'past' : ''}" style="height:${h.toFixed(0)}%"></i>`;
    }).join('');
    return `<div class="gv-head">
        <span class="gv-title">${compact ? 'Gear' : 'Gears'}</span>
        <span class="gv-type">Virtual shifting · ${esc(setupText(g))}</span>
      </div>
      <div class="gv-body">
        <div class="gv-now num" aria-hidden="true"><b>${g.front}</b><span>·</span><b>${g.rear}</b></div>
        <div class="gv-parts">
          <div class="gv-rings" aria-hidden="true"><span class="gv-lbl">Front</span><span class="gv-ring-set">${rings}</span><span class="gv-n num">${g.front}/${g.frontCount}</span></div>
          <div class="gv-cogs" aria-hidden="true"><span class="gv-lbl">Rear</span><span class="gv-cog-set">${cogs}</span><span class="gv-n num">${g.rear}/${g.rearCount}</span></div>
        </div>
      </div>
      ${erg ? '<p class="gv-note">ERG holds the power · turn ERG off to ride the gears</p>' : ''}`;
  }

  /** Fills `el` (hidden when there is no gear) and keeps the update cheap: only when something changed. */
  function render(el, g, opts = {}) {
    if (!el) return;
    el.hidden = !g;
    if (!g) { el.dataset.key = ''; return; }
    const key = `${g.front}.${g.rear}.${g.frontCount}.${g.rearCount}.${opts.erg ? 1 : 0}`;
    if (el.dataset.key === key) return;
    const prev = el.dataset.key ? el.dataset.key.split('.').map(Number) : null;
    el.dataset.key = key;
    el.innerHTML = html(g, opts);
    el.setAttribute('aria-label', describe(g));
    el.classList.toggle('gv-erg', !!opts.erg);
    if (prev && (prev[0] !== g.front || prev[1] !== g.rear)) {
      el.dataset.shift = prev[0] * 100 + prev[1] < g.front * 100 + g.rear ? 'up' : 'down';
      el.classList.remove('gv-flash'); void el.offsetWidth; el.classList.add('gv-flash');
    }
  }

  const api = { html, render, describe, setupText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VeloGearView = api;
})(typeof window !== 'undefined' ? window : globalThis);
