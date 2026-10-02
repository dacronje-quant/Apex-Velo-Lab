/**
 * APEX VELO // LAB - Ask: the training-data summary an AI answers questions from (pure, no DOM).
 *
 * The app gathers plain numbers for the chosen period (js/app-ask.js); build() turns them into a compact,
 * labelled text block: who the rider is, today's form, the CP model, period totals against the period
 * before, week by week, power bests, zones, aerobic signs, balance, recovery, other sports and every ride.
 * Only measured values appear - a missing value is "-", never a guess. The block stays under MAX_CHARS
 * by listing fewer of the oldest rides (and saying so).
 */
class VeloAsk {
  static DAY = 86400000;
  static MAX_CHARS = 120000;
  static MAX_RIDE_ROWS = 300;
  static PERIODS = [
    { key: '7d', days: 7, label: 'Last 7 days', short: '7 days' },
    { key: '4w', days: 28, label: 'Last 4 weeks', short: '4 weeks' },
    { key: '6w', days: 42, label: 'Last 6 weeks', short: '6 weeks' },
    { key: '3m', days: 91, label: 'Last 3 months', short: '3 months' },
    { key: '6m', days: 182, label: 'Last 6 months', short: '6 months' },
    { key: '1y', days: 365, label: 'Last 12 months', short: '1 year' },
    { key: 'all', days: 0, label: 'All history', short: 'All' },
    { key: 'custom', days: null, label: 'Custom dates', short: 'Custom' }
  ];
  static SUGGESTIONS = [
    'How has my fitness changed in this period?',
    'Am I recovering well enough?',
    'Which were my best rides, and why?',
    'Is my training too hard, too easy or about right?',
    'How does this period compare with the one before?',
    'Where are my strengths and weaknesses?',
    'Is my left/right pedal balance OK?',
    'What should I focus on next?'
  ];

  static dayKey(d) {
    const x = d instanceof Date ? d : new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  }

  /**
   * The local-day window for a period key: { from, to (Date, end of day), days, label }.
   * 'all' starts at firstTs; 'custom' uses fromKey / toKey (YYYY-MM-DD, swapped if reversed).
   */
  static range(key, now = new Date(), { fromKey = '', toKey = '', firstTs = null } = {}) {
    const p = VeloAsk.PERIODS.find(x => x.key === key) || VeloAsk.PERIODS[2];
    const endOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    let from, to = endOf(now);
    if (p.key === 'custom') {
      const a = /^\d{4}-\d{2}-\d{2}$/.test(fromKey) ? new Date(`${fromKey}T00:00:00`) : null;
      const b = /^\d{4}-\d{2}-\d{2}$/.test(toKey) ? new Date(`${toKey}T00:00:00`) : null;
      from = a || new Date(now.getFullYear(), now.getMonth(), now.getDate() - 41);
      to = b ? endOf(b) : to;
      if (from > to) { const t = startOf(to); to = endOf(from); from = t; }
    } else if (p.key === 'all') {
      from = startOf(firstTs ? new Date(firstTs) : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 41));
    } else {
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (p.days - 1));
    }
    const days = Math.max(1, Math.round((startOf(to) - startOf(from)) / VeloAsk.DAY) + 1);
    const label = p.key === 'custom' ? `${VeloAsk.dayKey(from)} to ${VeloAsk.dayKey(to)}` : p.label;
    return { key: p.key, from, to, days, label };
  }

  static n(v, dec = 0) {
    if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return '-';
    return Number(v).toFixed(dec);
  }
  static dur(sec) {
    if (!(sec > 0)) return '-';
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return m === 60 ? `${h + 1}:00` : `${h}:${String(m).padStart(2, '0')}`;
  }
  static row(cells) { return cells.join(' | '); }
  static clean(s) { return String(s ?? '').replace(/[|\s]+/g, ' ').trim().slice(0, 60); }

  /** Builds the text block. See js/app-ask.js askInput() for the shape of `x`. */
  static build(x) {
    const out = [];
    const P = x.period;
    out.push(`TODAY: ${x.today}. Dates are the rider's local dates (YYYY-MM-DD).`);
    out.push(`PERIOD ASKED ABOUT: ${P.label}, ${P.from} to ${P.to} (${P.days} days).`);
    const r = x.rider || {};
    out.push(`RIDER: ${VeloAsk.clean(r.name) || 'Rider'}; FTP ${VeloAsk.n(r.ftp)} W${r.ftp && r.weightKg ? ` (${(r.ftp / r.weightKg).toFixed(2)} W/kg)` : ''}; weight ${VeloAsk.n(r.weightKg, 1)} kg; max HR ${VeloAsk.n(r.maxHr)} bpm; threshold HR ${r.lthr ? `${r.lthr} bpm` : 'not set'}.`);
    if (x.form) {
      const f = x.form;
      out.push(`FORM TODAY: fitness base (CTL) ${VeloAsk.n(f.ctl, 1)}, recent strain (ATL) ${VeloAsk.n(f.atl, 1)}, freshness (TSB) ${f.tsb > 0 ? '+' : ''}${VeloAsk.n(f.tsb, 1)} (${f.formLabel}); ramp ${f.ramp === null ? '-' : `${f.ramp > 0 ? '+' : ''}${f.ramp}`} CTL per week - ${f.rampLabel}.`);
    }
    if (x.readiness) out.push(`READINESS TODAY (Apple Health): ${x.readiness}`);
    out.push(x.model ? `CRITICAL POWER MODEL (best efforts ${x.model.from} to ${x.model.to}): CP (long-effort limit) ${x.model.cp} W, W' (burst energy reserve) ${(x.model.w / 1000).toFixed(1)} kJ, Pmax (top sprint) ${x.model.pmax} W.`
      : `CRITICAL POWER MODEL: none (${x.modelNote || 'not enough hard efforts with power'}).`);

    const t = x.totals || {};
    const tot = (o) => (o ? `rides ${o.rides}, hours ${VeloAsk.n(o.hours, 1)}, distance ${VeloAsk.n(o.km)} km, TSS ${VeloAsk.n(o.tss)}, work ${VeloAsk.n(o.kj)} kJ, average NP ${o.avgNp ? o.avgNp + ' W' : '-'}, longest ${VeloAsk.dur(o.longestSec)}` : '-');
    out.push('', 'PERIOD TOTALS (cycling):', `- this period: ${tot(t.cur)}`);
    if (t.prev) out.push(`- the ${P.days} days before (${t.prevFrom} to ${t.prevTo}): ${tot(t.prev)}`);
    if (t.cur) out.push(`- rides with power data: ${t.cur.withPower}; with heart rate: ${t.cur.withHr}`);

    if (x.weeks && x.weeks.length) {
      out.push('', 'WEEKS (Monday start): week | rides | hours | TSS | kJ | CTL at week end');
      x.weeks.forEach(w => out.push(VeloAsk.row([w.start, w.rides, VeloAsk.n(w.hours, 1), VeloAsk.n(w.tss), VeloAsk.n(w.kj), VeloAsk.n(w.ctl, 1)])));
    }
    if (x.bests && x.bests.length) {
      out.push('', `POWER BESTS (this period / all-time): ${x.bests.map(b => `${b.label} ${b.period ? b.period + ' W' : '-'} / ${b.allTime ? b.allTime + ' W' : '-'}`).join('; ')}.`);
    }
    if (x.zones) {
      const z = x.zones;
      out.push(`TIME IN POWER ZONES (this period, ${z.hours} h with power): ${z.pct.map((p, i) => `Z${i + 1} ${p}%`).join(', ')}. Easy / medium / hard split ${z.seiler.pct.join(' / ')}%; polarization index ${z.seiler.pi === null ? '-' : z.seiler.pi} (${z.seiler.label}).`);
    }
    if (x.aerobic) {
      const a = x.aerobic;
      out.push(`AEROBIC SIGNS: efficiency factor (watts per heartbeat) on ${a.efN} steady rides: first ${VeloAsk.n(a.efFirst, 2)}, last ${VeloAsk.n(a.efLast, 2)}; heart-rate drift (Pw:HR) on ${a.driftN} steady rides: average ${VeloAsk.n(a.driftAvg, 1)}% (under 5% = well coupled).`);
    }
    if (x.balance) out.push(`PEDAL BALANCE: average left ${x.balance.avgLeft}% / right ${(100 - x.balance.avgLeft).toFixed(1)}% over ${x.balance.n} rides (48-52% is the usual range).`);
    if (x.ftpChanges && x.ftpChanges.length) out.push(`FTP CHANGES IN PERIOD: ${x.ftpChanges.map(c => `${c.date} ${c.from || '-'} -> ${c.to} W`).join('; ')}.`);
    if (x.health && x.health.length) {
      out.push('', 'RECOVERY (Apple Health, weekly averages): week | resting HR bpm | HRV ms | sleep h');
      x.health.forEach(h => out.push(VeloAsk.row([h.week, VeloAsk.n(h.rhr), VeloAsk.n(h.hrv), VeloAsk.n(h.sleep, 1)])));
    }
    if (x.others && x.others.length) {
      out.push('', `OTHER ACTIVITIES (${x.others.length}): ${x.others.slice(0, 60).map(o => `${o.date} ${VeloAsk.clean(o.type)}${o.title ? ' "' + VeloAsk.clean(o.title) + '"' : ''} ${VeloAsk.dur(o.dur)}`).join('; ')}${x.others.length > 60 ? '; ...' : ''}.`);
    }

    // Rides last: the longest part, trimmed from the oldest end when the block would be too long.
    const head = ['', 'RIDES (newest first): date | title | time h:mm | km | avg W | NP | IF | TSS | kJ | avg/max HR | rpm | left % | EF | HR drift % | best 5 min / 20 min W | easy/medium/hard time %'];
    const rows = (x.rides || []).map(v => VeloAsk.row([
      v.date, VeloAsk.clean(v.title) || 'Ride', VeloAsk.dur(v.dur), VeloAsk.n(v.km, 1), VeloAsk.n(v.avgW), VeloAsk.n(v.np), VeloAsk.n(v.ifac, 2), VeloAsk.n(v.tss), VeloAsk.n(v.kj),
      `${VeloAsk.n(v.avgHr)}/${VeloAsk.n(v.maxHr)}`, VeloAsk.n(v.cad), VeloAsk.n(v.left, 1), VeloAsk.n(v.ef, 2), VeloAsk.n(v.drift, 1),
      `${VeloAsk.n(v.p5)} / ${VeloAsk.n(v.p20)}`, v.zone3 ? v.zone3.join('/') : '-'
    ]));
    const meanings = x.meanings && x.meanings.length ? ['', `MEANINGS: ${x.meanings.map(([a, b]) => `${a} = ${b}`).join('; ')}.`] : [];
    let base = out.concat(head).join('\n');
    const tail = meanings.join('\n');
    let keep = Math.min(rows.length, VeloAsk.MAX_RIDE_ROWS);
    const size = (k) => base.length + rows.slice(0, k).reduce((a, s) => a + s.length + 1, 0) + tail.length + 120;
    while (keep > 0 && size(keep) > VeloAsk.MAX_CHARS) keep = Math.floor(keep * 0.9);
    const listed = rows.slice(0, keep);
    if (!rows.length) listed.push('(no rides in this period)');
    if (keep < rows.length) listed.push(`(${rows.length - keep} older rides in this period are not listed; the totals and weeks above include them)`);
    return [base, listed.join('\n'), tail].filter(Boolean).join('\n');
  }
}

if (typeof window !== 'undefined') window.VeloAsk = VeloAsk;
if (typeof module !== 'undefined' && module.exports) module.exports = VeloAsk;
