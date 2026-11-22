/* Phone Zen: a one-glance ride screen. Presentation only; ride commands are delegated to the existing phone controls.
   Built for a phone on the bars: the interval countdown is the largest number, power is the 3 s average shown
   against the target as one bar and a status, and heart rate and cadence only light up when they need attention. */
window.PhoneZen = (() => {
  const $ = id => document.getElementById(id);
  const LIGHT = {Z1:['#3d63ff','#19c2e0'],Z2:['#2a86ff','#1fd1b2'],Z3:['#16c08d','#a7e04a'],Z4:['#ffb21f','#ff7a2f'],Z5:['#ff5a36','#ff2d7a'],Z6:['#ff2e63','#a23bff'],Z7:['#9b4dff','#ff3dce']};
  const STEP_LIGHT = {Z1:'#3d63ff',Z2:'#2a86ff',Z3:'#16c08d',Z4:'#ffb21f',Z5:'#ff5a36',Z6:'#ff2e63',Z7:'#9b4dff'};
  const ON_TARGET_PCT = 5, CLOSE_PCT = 10, BAND_PCT = 15, CADENCE_SLACK = 5;
  let active = false, previous = null, stripKey = '';
  const fmt = s => {
    s = Math.max(0, Math.round(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  };
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const zoneOf = pct => window.VeloMetrics && pct > 0 ? VeloMetrics.zoneForPct(pct) : null;
  const stepColor = pct => { const z = zoneOf(pct); return (z && STEP_LIGHT[z.short]) || '#2a86ff'; };
  /** The 3 s average: steady enough to read at a glance, quick enough to follow an effort. */
  const power3 = s => { const a = s.powerAverages && s.powerAverages[3]; return a != null ? a : s.power; };

  function setActive(value) {
    active = value;
    document.body.classList.toggle('zen-active', value);
    $('phoneZen').hidden = !value;
    $('btnZen').setAttribute('aria-pressed', String(value));
    if (value) $('zenExit').focus(); else $('btnZen').focus();
    if (previous) update(previous);
    window.dispatchEvent(new Event('resize'));
  }
  function init() {
    $('btnZen').addEventListener('click', () => setActive(true));
    $('zenExit').addEventListener('click', () => setActive(false));
    document.addEventListener('keydown', e => { if (active && e.key === 'Escape') setActive(false); });
    [['zenDown','btnDown'],['zenToggle','btnToggle'],['zenUp','btnUp'],['zenSkip','btnSkip']].forEach(([zen, normal]) => $(zen).addEventListener('click', () => { $(normal).click(); syncControls(); }));
  }

  /** Whole-workout strip: one segment per step in its zone colour, the ridden part dimmed, a needle at "now". */
  function drawStrip(s) {
    const prof = (s.profile || []).filter(p => p[0] > 0);
    const strip = $('zenStrip');
    strip.hidden = !prof.length;
    if (!prof.length) return;
    const key = s.title + '|' + prof.map(p => p.join(':')).join(',');
    if (key !== stripKey) {
      stripKey = key;
      $('zenSegments').innerHTML = prof.map(p => `<i style="flex:${p[0]} 0 0;background:${stepColor(p[1])}"></i>`).join('');
    }
    const at = Math.max(0, Math.min(1, s.progress || 0)) * 100;
    $('zenDone').style.width = at + '%';
    $('zenHere').style.left = at + '%';
  }

  function powerStatus(s, power, running) {
    const st = $('zenStatus');
    const hasTarget = s.target > 0;
    $('zenBand').hidden = !hasTarget;
    if (!hasTarget) { st.textContent = running ? 'Free ride' : stateWord(s); st.className = 'zen-status'; return; }
    if (!running || !(power > 0)) { st.textContent = stateWord(s); st.className = 'zen-status'; $('zenMarker').hidden = true; return; }
    const d = (power - s.target) / s.target * 100, off = Math.abs(d);
    // In ERG the trainer sets the watts, so the status says where power is rather than asking for an effort.
    const under = s.erg ? 'Under' : 'Push', over = s.erg ? 'Over' : 'Ease off';
    st.textContent = off <= ON_TARGET_PCT ? 'On target' : d < 0 ? under : over;
    st.className = 'zen-status ' + (off <= ON_TARGET_PCT ? 'on' : off <= CLOSE_PCT ? 'close' : 'off');
    $('zenMarker').hidden = false;
    $('zenMarker').style.left = Math.max(3, Math.min(97, 50 + d / BAND_PCT * 50)) + '%';
  }
  const stateWord = s => s.state === 'running' ? 'Riding' : s.state === 'paused' ? 'Paused' : s.state === 'finished' ? 'Finished' : 'Ready';

  function update(s) {
    if (Array.isArray(s)) s = s[0]; // tolerate the old (snapshot, power, label) call shape
    if (!s) return;
    previous = s;
    const running = s.state === 'running', finished = s.state === 'finished';
    const rampFinished = finished && !!s.completedRide?.rampTest;
    const power = power3(s);

    // Zone light follows the step's target zone (as the PC cockpit does), so it does not flicker when power
    // hovers at a zone edge; a free ride without a target follows the 3 s power instead.
    const basis = s.target > 0 ? s.target : power > 0 ? power : 0;
    const zone = s.targetZone || zoneOf(s.ftp > 0 ? basis / s.ftp * 100 : 0);
    const colors = zone && LIGHT[zone.short];
    if (colors) { document.body.style.setProperty('--zone-a', colors[0]); document.body.style.setProperty('--zone-b', colors[1]); document.body.dataset.zone = zone.short.toLowerCase(); }

    // Where you are
    $('zenStep').textContent = s.step ? `${s.step.index}/${s.step.count} · ${s.step.name || ''}` : (s.title || 'Free ride');
    const totalLeft = s.totalDuration && !s.rampTest?.openEnded ? Math.max(0, Math.round(s.totalDuration * (1 - (s.progress || 0)))) : null;
    $('zenTotalWrap').hidden = totalLeft == null;
    $('zenTotal').textContent = totalLeft != null ? fmt(totalLeft) : '';
    drawStrip(s);

    // The countdown
    $('zenClockLabel').textContent = rampFinished ? 'RAMP COMPLETE' : s.step ? (s.rampTest?.openEnded ? 'STEP LEFT' : 'INTERVAL LEFT') : 'RIDE TIME';
    $('zenClock').textContent = rampFinished ? 'DONE' : s.step ? fmt(s.step.remaining) : fmt(s.elapsed || 0);

    // Power: 3 s average against the target
    $('zenPower').textContent = power != null && (power > 0 || running) ? power : '--';
    $('zenPower').classList.toggle('four-digits', String($('zenPower').textContent).length > 3);
    $('zenTarget').textContent = s.target > 0 ? (s.erg ? 'ERG holding ' : 'Target ') + s.target + ' W' : 'No target';
    $('zenTargetPct').textContent = s.target > 0 && s.targetPct != null ? s.targetPct + '% FTP' : '';
    powerStatus(s, power, running);

    // Heart rate and cadence; a tile lights up only when you are off the cadence target
    $('zenHr').textContent = s.hr || '--';
    $('zenHrSub').textContent = s.hr && s.hrZone ? s.hrZone : 'bpm';
    $('zenCadence').textContent = s.cadence || '--';
    const tc = s.targetCadence, cad = s.cadence;
    const offCad = running && tc > 0 && cad > 0 && Math.abs(cad - tc) > CADENCE_SLACK;
    $('zenCadTile').classList.toggle('warn', offCad);
    $('zenCadenceTarget').textContent = tc > 0 ? `target ${tc}${offCad ? (cad < tc ? ' ↑' : ' ↓') : ''}` : 'rpm';

    // What comes next
    const next = $('zenNext');
    if (rampFinished) { next.hidden = false; $('zenNextSwatch').hidden = true; $('zenNextText').textContent = s.completedRide.rampTest.message || 'Ramp test complete.'; }
    else if (s.next) {
      next.hidden = false; $('zenNextSwatch').hidden = false;
      $('zenNextSwatch').style.background = stepColor(s.ftp > 0 ? s.next.watts / s.ftp * 100 : 0);
      $('zenNextText').innerHTML = `Next <b>${esc(s.next.name)}</b> · <span class="num">${fmt(s.next.duration)} @ ${s.next.watts} W</span>`;
    } else if (s.step && !finished) {
      next.hidden = false; $('zenNextSwatch').hidden = true;
      $('zenNextText').textContent = s.rampTest?.openEnded ? 'Ramp continues until you cannot hold the target.' : 'Final step. Bring it home.';
    } else next.hidden = true;

    syncControls();
  }

  function syncControls() {
    $('zenState').textContent = $('state').textContent;
    for (const [zen, normal] of [['zenDown','btnDown'],['zenToggle','btnToggle'],['zenUp','btnUp'],['zenSkip','btnSkip']]) $(zen).disabled = $(normal).disabled;
    const label = $('btnToggle').textContent;
    const words = {PAUSE:'Pause', RESUME:'Resume', START:'Start', FINISHED:'Finished'};
    $('zenToggleText').textContent = words[label] || label;
    $('zenToggle').setAttribute('aria-label', label === 'PAUSE' ? 'Pause ride' : label === 'RESUME' ? 'Resume ride' : label === 'START' ? 'Start ride' : 'Ride finished');
    $('zenToggle').classList.toggle('paused', label !== 'PAUSE');
    const armed = $('btnSkip').classList.contains('armed');
    $('zenSkip').textContent = armed ? 'Confirm' : 'Skip';
    $('zenSkip').setAttribute('aria-label', armed ? 'Tap again to skip step' : 'Skip step');
    // Show a tapped ±5 W straight away, before the PC confirms it.
    if (previous) {
      const s = previous, pending = Number($('trTarget').textContent);
      if (pending > 0) {
        $('zenTarget').textContent = (s.erg ? 'ERG holding ' : 'Target ') + pending + ' W';
        $('zenTargetPct').textContent = s.ftp > 0 ? Math.round(pending / s.ftp * 100) + '% FTP' : '';
      }
    }
  }
  return {init, update, syncControls, setActive, get active() { return active; }};
})();
