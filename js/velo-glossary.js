/**
 * APEX VELO // LAB - Plain-English meanings for every acronym and metric (pure data + tiny DOM helper).
 *
 * One source for the short subtext shown under labels ("TSS" -> "Workout load score"), so the same
 * term reads the same everywhere. Names follow Settings > Training terms explained.
 *  - plain(key):   the short meaning.
 *  - html(key):    <span class="plain">meaning</span> for templates.
 *  - apply(root):  adds the subtext to every static element with data-term="key" (once), and a
 *                  tooltip with the full name; data-term-short="key" uses the shorter wording (table
 *                  headers); data-term-tip="key" adds only the tooltip (chips, legends).
 */
const VeloGlossary = (() => {
  const TERMS = {
    ftp: { name: 'Functional Threshold Power', plain: 'Max power for about an hour' },
    cp: { name: 'Critical Power', plain: 'Your long-effort limit' },
    cpModel: { name: 'Critical power model', plain: 'Your limits, from your best efforts' },
    wprime: { name: 'W prime', plain: 'Burst energy reserve' },
    wbal: { name: 'W prime balance', plain: 'Burst energy left right now' },
    pmax: { name: 'Maximum power', plain: 'Top sprint power' },
    np: { name: 'Normalized Power', plain: 'Surge-weighted average', short: 'surge-weighted avg' },
    if: { name: 'Intensity Factor', plain: 'How hard vs your FTP', short: 'effort vs FTP' },
    tss: { name: 'Training Stress Score', plain: 'Workout load score', short: 'workout load' },
    ctl: { name: 'Chronic Training Load', plain: 'Fitness base, last 6 weeks' },
    atl: { name: 'Acute Training Load', plain: 'Recent strain, last week' },
    tsb: { name: 'Training Stress Balance', plain: 'Freshness: fitness minus strain' },
    ramp: { name: 'Fitness ramp rate', plain: 'How fast fitness is building' },
    ef: { name: 'Efficiency Factor', plain: 'Watts per heartbeat' },
    vi: { name: 'Variability Index', plain: 'How steady the pacing was' },
    trimp: { name: 'Training Impulse', plain: 'Heart-rate workload' },
    hrv: { name: 'Heart Rate Variability', plain: 'Recovery sign from heartbeats' },
    rhr: { name: 'Resting heart rate', plain: 'Heartbeat at rest' },
    recovery: { name: 'Resting heart rate and heart rate variability', plain: 'Recovery signs from your watch' },
    vo2max: { name: 'Maximum oxygen uptake', plain: 'Size of your aerobic engine' },
    wkg: { name: 'Watts per kilogram', plain: 'Power per kilo of body weight' },
    kj: { name: 'Kilojoules of work', plain: 'Energy put into the pedals', short: 'energy (kJ)' },
    decoupling: { name: 'Aerobic decoupling (Pw:HR)', plain: 'Heart-rate drift at steady power' },
    pdc: { name: 'Power duration curve', plain: 'Your best power for every duration' },
    pmc: { name: 'Performance management chart', plain: 'Fitness, strain and freshness over time' },
    pi: { name: 'Polarization index', plain: 'Easy-vs-hard balance score' },
    matches: { name: 'Matches burned', plain: 'Big hard surges' },
    aboveCp: { name: 'Work above critical power', plain: 'Energy spent above your limit' },
    wdepl: { name: 'W prime max depletion', plain: 'Deepest dip into burst energy' },
    qa: { name: 'Quadrant analysis', plain: 'Pushing hard vs spinning fast' },
    lr: { name: 'Left / right balance', plain: 'Share of power per leg', short: 'leg split' },
    cadence: { name: 'Cadence (rpm)', plain: 'Pedal turns per minute' },
    readiness: { name: 'Readiness', plain: 'Ready to train hard today?' },
    peak20: { name: '20-minute peak power', plain: 'Best 20 min, last 90 days' },
    fit: { name: 'Model fit error', plain: 'How closely the model matches' },
    seiler: { name: '3-zone distribution', plain: 'Easy / medium / hard split' },
    zones: { name: 'Power zones', plain: 'Effort bands, easy to all-out' },
    hrZones: { name: 'Heart-rate zones', plain: 'Heart effort bands' },
    profile: { name: 'Power profile', plain: 'Recent bests vs the 90 days before' },
    cpHistory: { name: 'Critical power and W prime over time', plain: 'Your limit and burst energy, trend' },
    ftpHistory: { name: 'FTP history', plain: 'Your FTP and hardest ride each month' },
    weekly: { name: 'Weekly load', plain: 'Training done each week' },
    intensityMix: { name: 'Intensity mix', plain: 'Hours by how hard each ride was' },
    ridePlot: { name: 'Ride plot', plain: 'Every second of the ride' },
    rideCurve: { name: 'Ride power curve', plain: "This ride's best power per duration" },
    hist: { name: 'Power distribution', plain: 'Time spent at each power' },
    pace: { name: 'Time above critical power', plain: 'How long you can go above it' },
    kcal: { name: 'Kilocalories', plain: 'Energy your body used' },
    // Invisible spacer: keeps values aligned in a grid where only some labels need a subtext.
    gap: { name: '', plain: '\u00a0' }
  };

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plain = (key) => (TERMS[key] ? TERMS[key].plain : '');
  const html = (key, short = false) => {
    if (key === 'gap') return '<span class="plain" aria-hidden="true">\u00a0</span>';
    return TERMS[key] ? `<span class="plain">${esc(short && TERMS[key].short ? TERMS[key].short : TERMS[key].plain)}</span>` : '';
  };
  const tip = (key) => (TERMS[key] && TERMS[key].name ? `${TERMS[key].name}: ${TERMS[key].plain}` : '');

  function apply(root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll('[data-term], [data-term-short]').forEach((el) => {
      const short = !el.hasAttribute('data-term');
      const key = el.getAttribute(short ? 'data-term-short' : 'data-term');
      if (!TERMS[key]) return;
      if (![...el.children].some((c) => c.classList && c.classList.contains('plain'))) el.insertAdjacentHTML('beforeend', key === 'gap' ? '<span class="plain" aria-hidden="true">\u00a0</span>' : html(key, short));
      if (!el.title && tip(key)) el.title = tip(key);
    });
    scope.querySelectorAll('[data-term-tip]').forEach((el) => {
      const key = el.getAttribute('data-term-tip');
      if (TERMS[key] && !el.title) el.title = tip(key);
    });
  }

  return { TERMS, plain, html, tip, apply };
})();

if (typeof window !== 'undefined') window.VeloGlossary = VeloGlossary;
if (typeof module !== 'undefined' && module.exports) module.exports = VeloGlossary;
