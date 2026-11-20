/**
 * APEX VELO // LAB - Ride brief: one ride's recorded data, as text an AI coach answers questions from
 * (pure, no DOM, no storage).
 *
 *  - build(record, opts): ride totals, how to read the data (ERG, transitions, heart-rate lag), every
 *    step with settled power, time to reach target and heart rate at start / end / peak, the sets of
 *    repeated efforts, zones, decoupling, earlier rides of the same workout, recent training and a
 *    5-10 s trace of the recording itself. Only measured values; "-" = not recorded.
 *  - cleanAiText(text): an answer as plain markdown, even when a model wrapped it in JSON or a code fence.
 *  - REVIEW_PROMPT / SUGGESTIONS: what the ride chat offers.
 */
class VeloRideBrief {
  static MAX_TRACE_ROWS = 720;
  static REVIEW_LABEL = 'Review this ride';
  static REVIEW_PROMPT = 'Review this ride as my coach. Lead with the two or three things this ride actually tells you about my fitness or fatigue, ' +
    'each backed by the numbers that show it: heart-rate response across the efforts and sets (where it levelled off, how high it went, how fast it came down in the recoveries), ' +
    'any cadence fade, decoupling, and how it compares with my earlier rides of this workout where they are listed. ' +
    'Then say whether these targets were too easy, about right or too hard for me, with the evidence, and give one concrete change for next time with real numbers. ' +
    'Do not restate the plan, and do not comment on power sitting slightly above or below target in ERG unless it points to a trainer or sensor problem. Under 220 words.';
  static SUGGESTIONS = [
    'Was this too hard or too easy for me?',
    'How did my heart rate respond across the sets?',
    'How does this compare with the last time I did it?',
    'Did I fade anywhere? Where and why?',
    'Should my FTP or targets change?',
    'What should my next session be?'
  ];

  static fmt(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  }

  static mean(values) {
    const v = values.filter(x => Number.isFinite(x) && x > 0);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }

  static round(x) { return x === null || x === undefined || !Number.isFinite(x) ? '-' : Math.round(x); }

  /**
   * Steps of the ride, split where the recorded target changes (or the recording breaks), each with:
   * settled power (after the trainer's transition), seconds until power first held within 5% of
   * target for 3 s, heart rate at start / end / peak, cadence, and the zero-power seconds.
   */
  static steps(samples, ftp) {
    const segs = [];
    let cur = null;
    (samples || []).forEach((s, i, all) => {
      const t = Number(s.target) || 0;
      if (!cur || t !== cur.target || VeloMetrics.isSampleBreak(all[i - 1], s)) { cur = { target: t, start: i, samples: [] }; segs.push(cur); }
      cur.samples.push(s);
    });
    const M = VeloRideBrief.mean;
    let k = 0;
    return segs.filter(g => g.samples.length >= 5).map((g, i) => {
      const ss = g.samples, n = ss.length;
      const pw = ss.map(s => Number(s.power) || 0), hr = ss.map(s => Number(s.hr) || 0), cad = ss.map(s => Number(s.cadence) || 0);
      const skip = Math.min(n - 1, n <= 60 ? 5 : 10);
      const work = ftp > 0 && g.target >= ftp * 0.88;
      let reach = null;
      if (g.target > 0) {
        for (let j = 0; j + 2 < n; j++) {
          if ([0, 1, 2].every(d => Math.abs(pw[j + d] - g.target) <= g.target * 0.05)) { reach = j; break; }
        }
      }
      const hrv = hr.filter(x => x > 0);
      const third = Math.floor(n / 3);
      const long = n >= 60;
      const cadFirst = M(cad.slice(0, third)), cadLast = M(cad.slice(n - third));
      return {
        n: i + 1, iv: work ? ++k : null, work, startSec: Number(ss[0].time) || g.start, sec: n, target: g.target,
        avgP: Math.round(pw.reduce((a, b) => a + b, 0) / n),
        settledP: Math.round(pw.slice(skip).reduce((a, b) => a + b, 0) / Math.max(1, n - skip)),
        reach,
        cadence: M(cad), cadFade: long && cadFirst && cadLast ? Math.round(cadLast - cadFirst) : null,
        hrStart: M(hr.slice(0, 3)), hrEnd: M(hr.slice(-3)), hrPeak: hrv.length ? Math.max(...hrv) : null, hrMin: hrv.length ? Math.min(...hrv) : null,
        zeros: pw.filter(x => x <= 0).length
      };
    });
  }

  /** Runs of hard steps with only short easy steps (under 3 min) between them. */
  static sets(steps) {
    const out = [];
    let cur = null, gap = 0;
    steps.forEach((s, i) => {
      if (s.work) {
        if (!cur || gap >= 180) { cur = { efforts: [] }; out.push(cur); }
        cur.efforts.push({ ...s, recovery: steps[i + 1] && !steps[i + 1].work ? steps[i + 1] : null });
        gap = 0;
      } else if (cur) gap += s.sec;
    });
    return out.filter(s => s.efforts.length >= 2);
  }

  /** The recording averaged into buckets of 5 s or more (at most MAX_TRACE_ROWS rows). */
  static trace(samples) {
    const n = (samples || []).length;
    if (!n) return { bucket: 0, rows: [] };
    const bucket = Math.max(5, Math.ceil(n / VeloRideBrief.MAX_TRACE_ROWS / 5) * 5);
    const rows = [];
    for (let i = 0; i < n; i += bucket) {
      const ch = samples.slice(i, i + bucket);
      const avg = (key) => { const v = ch.map(s => Number(s[key]) || 0).filter(x => x > 0); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : '-'; };
      const pw = Math.round(ch.reduce((a, s) => a + (Number(s.power) || 0), 0) / ch.length);
      rows.push([VeloRideBrief.fmt(Number(ch[0].time) || i), avg('target'), pw, avg('cadence'), avg('hr')].join(' '));
    }
    return { bucket, rows };
  }

  /**
   * opts: { ftp, maxHr, restHr, weightKg, form: {ctl, atl, tsb}, previous: [{ date, title, duration, np, avgWatts, avgHr, maxHr, if, tss, workHr, workP }],
   *         recent: [{ date, title, duration, tss, np }] }
   */
  static build(record, opts = {}) {
    const r = record || {};
    const samples = Array.isArray(r.samples) ? r.samples : [];
    const ftp = Number(r.ftpAtRide || opts.ftp) || 0;
    const maxHr = Number(opts.maxHr) || 0;
    const L = [];
    const v = (x, unit = '') => (x === null || x === undefined || x === '' || (typeof x === 'number' && !Number.isFinite(x)) ? '-' : `${x}${unit}`);
    const when = Number.isFinite(Date.parse(r.date)) ? new Date(r.date) : null;
    L.push('THIS RIDE');
    L.push(`Workout: ${r.title || 'Ride'}${when ? `; ${when.toISOString().slice(0, 16).replace('T', ' ')}` : ''}; source ${r.source || '-'}.`);
    L.push(`Rider: FTP at ride ${v(ftp, ' W')}; max HR ${v(maxHr || null)}; resting HR ${v(opts.restHr || null)}; weight ${v(opts.weightKg || null, ' kg')}.`);
    L.push(`Totals: ${VeloRideBrief.fmt(r.duration || samples.length)} long; avg ${v(r.avgWatts, ' W')}, NP ${v(r.np, ' W')}, IF ${v(r.if)}, TSS ${v(r.tss)}, ${v(r.kj, ' kJ')}; ` +
      `HR avg ${v(r.avgHr)} / max ${v(r.maxHr)}; cadence avg ${v(r.avgCadence)}; on-target score ${v(r.compliancePct, '%')}${r.leftBal ? `; L/R ${r.leftBal}/${r.rightBal}` : ''}.`);
    if (r.rampTest && r.rampTest.message) L.push(`Ramp test: ${r.rampTest.message}`);
    if (opts.form && Number.isFinite(opts.form.ctl)) L.push(`Form now: fitness (CTL) ${Math.round(opts.form.ctl)}, fatigue (ATL) ${Math.round(opts.form.atl)}, form (TSB) ${Math.round(opts.form.tsb)}.`);

    const hasTarget = samples.some(s => Number(s.target) > 0);
    const control = r.control || {};
    const erg = hasTarget && control.erg !== false;
    L.push('', 'HOW TO READ THIS DATA');
    if (erg) {
      L.push(`- Control: ERG mode${control.changed ? ' (switched during the ride; see the trace)' : control.erg === undefined ? ' (the app default; this ride does not say otherwise)' : ''}: the trainer sets the power, not the rider. ` +
        'Power a little above or below target comes from the trainer\'s response (lag or overshoot after each target change, quick cadence changes) and from the power source used, not from the rider\'s pacing. ' +
        'Never tell the rider to hold power closer to target or to let power drop in ERG; what the rider controls is cadence and whether they finish. If the trainer response looks wrong, say so as an equipment point.');
    } else if (hasTarget) {
      L.push('- Control: ERG was off, so the rider controlled power against the targets: power vs target is pacing.');
    } else {
      L.push('- Free ride or import without targets: power is whatever the rider produced.');
    }
    L.push('- "settled W" leaves out the first 5 s of a step (10 s for steps over 1 min), the transition; "reach s" is when power first held within 5% of target for 3 s.',
      '- Heart rate lags effort by 1-2 minutes: on short repeats it keeps rising across a set, so judge it by where it levels off, peak vs max HR, how far it drops in recoveries and against earlier rides of the same workout.',
      '- Cadence usually drops in easy recoveries; that is normal and not worth mentioning unless it changes across the ride.');

    const steps = VeloRideBrief.steps(samples, ftp);
    if (steps.length >= 2 && hasTarget) {
      L.push('', 'STEPS (work k = k-th hard step, 88% FTP or more)');
      L.push('step | kind | start | secs | target W | avg W | settled W | reach s | cadence | cad fade | HR start | HR end | HR peak | zero-power s');
      steps.forEach(s => L.push([s.n, s.work ? `work ${s.iv}` : 'easy', VeloRideBrief.fmt(s.startSec), s.sec, s.target || '-', s.avgP, s.settledP, s.reach ?? '-',
        VeloRideBrief.round(s.cadence), s.cadFade ?? '-', VeloRideBrief.round(s.hrStart), VeloRideBrief.round(s.hrEnd), s.hrPeak ?? '-', s.zeros].join(' | ')));
      const sets = VeloRideBrief.sets(steps);
      if (sets.length) {
        L.push('', 'SETS OF REPEATED EFFORTS');
        sets.forEach((set, i) => {
          const e = set.efforts, first = e[0], last = e[e.length - 1];
          const drops = e.map(x => (x.recovery && x.hrEnd && x.recovery.hrEnd ? x.hrEnd - x.recovery.hrEnd : null)).filter(x => x !== null);
          const peak = Math.max(...e.map(x => x.hrPeak || 0));
          const cads = e.map(x => x.cadence).filter(Boolean);
          L.push(`Set ${i + 1}: ${e.length} efforts (work ${first.iv}-${last.iv}), ${first.sec} s at ${first.target} W${first.target !== last.target ? ` to ${last.target} W` : ''}; ` +
            `settled power ${Math.round(VeloRideBrief.mean(e.map(x => x.settledP)))} W; HR at end of effort ${VeloRideBrief.round(first.hrEnd)} -> ${VeloRideBrief.round(last.hrEnd)} bpm, peak ${peak || '-'}${maxHr && peak ? ` (${Math.round((peak / maxHr) * 100)}% of max)` : ''}; ` +
            `HR drop over each recovery ${drops.length ? `${drops[0]} -> ${drops[drops.length - 1]} bpm (mean ${Math.round(drops.reduce((a, b) => a + b, 0) / drops.length)})` : '-'}; ` +
            `cadence ${cads.length ? `${Math.round(cads[0])} -> ${Math.round(cads[cads.length - 1])} rpm` : '-'}.`);
        });
      }
    }

    if (samples.length >= 60) {
      L.push('', 'WHOLE RIDE');
      if (ftp) {
        const z = VeloInsight.timeInZones(samples, ftp);
        L.push(`Time in power zones Z1-Z7: ${z.map(s => VeloRideBrief.fmt(s)).join(', ')}.`);
      }
      if (maxHr) {
        const hz = [0, 0, 0, 0, 0];
        samples.forEach(s => { const z = VeloMetrics.hrZone(Number(s.hr) || 0, maxHr); if (z.idx) hz[z.idx - 1]++; });
        if (hz.some(Boolean)) L.push(`Time in HR zones Z1-Z5 (% of max HR): ${hz.map(s => VeloRideBrief.fmt(s)).join(', ')}.`);
      }
      const d = VeloInsight.decoupling(samples);
      L.push(d.status === 'ok' ? `Aerobic decoupling (Pw:HR drift, second half vs first): ${d.pct}% (${d.label}).` : `Aerobic decoupling: not measured (${d.status}; it needs a steady ride of 20 min or more).`);
      const hrr = maxHr && ftp ? VeloInsight.hrRecovery(samples, ftp, maxHr) : null;
      if (hrr) L.push(`HR drop 60 s after hard efforts of 30 s or more: ${hrr.efforts.map(e => e.drop).join(', ')} bpm${hrr.slowing ? ' (slowing)' : ''}.`);
      const torque = VeloInsight.avgTorque(samples);
      if (torque) L.push(`Average pedalling torque: ${torque} N·m.`);
      const zeros = samples.filter(s => Number(s.target) > 0 && !(Number(s.power) > 0)).length;
      const noHr = samples.filter(s => !(Number(s.hr) > 0)).length;
      if (zeros || noHr) L.push(`Data gaps: ${zeros} s of zero power during targets; ${noHr} s without heart rate.`);
      const src = [...new Set(samples.map(s => s.src).filter(Boolean))];
      if (src.length) L.push(`Power source: ${src.join(', ')}.`);
    }

    const prev = (opts.previous || []).slice(0, 6);
    if (prev.length) {
      L.push('', 'EARLIER RIDES OF THIS WORKOUT (newest first)');
      L.push('date | duration | avg W | NP | IF | TSS | avg HR | max HR | hard-step W | hard-step HR');
      prev.forEach(p => L.push([String(p.date || '').slice(0, 10), VeloRideBrief.fmt(p.duration), v(p.avgWatts), v(p.np), v(p.if), v(p.tss), v(p.avgHr), v(p.maxHr), v(p.workP), v(p.workHr)].join(' | ')));
      const work = steps.filter(s => s.work);
      if (work.length) L.push(`This ride for comparison: hard-step W ${Math.round(VeloRideBrief.mean(work.map(s => s.settledP)))}, hard-step HR ${VeloRideBrief.round(VeloRideBrief.mean(work.map(s => (s.hrStart + s.hrEnd) / 2)))}.`);
    } else {
      L.push('', 'EARLIER RIDES OF THIS WORKOUT: none recorded.');
    }
    const recent = (opts.recent || []).slice(0, 14);
    if (recent.length) {
      L.push('', 'OTHER RIDES IN THE 14 DAYS BEFORE (newest first)');
      recent.forEach(p => L.push(`${String(p.date || '').slice(0, 10)} ${p.title || 'Ride'}: ${VeloRideBrief.fmt(p.duration)}, TSS ${v(p.tss)}, NP ${v(p.np)}.`));
    }

    const tr = VeloRideBrief.trace(samples);
    if (tr.rows.length) {
      L.push('', `RECORDING (${tr.bucket} s averages): time target_W power_W cadence_rpm HR_bpm`);
      L.push(...tr.rows);
    }
    return L.join('\n');
  }

  /** A model's answer as markdown: unwraps ```fences``` and JSON objects such as {"review": "..."}. */
  static cleanAiText(text) {
    let t = String(text || '').trim();
    const fence = t.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
    if (fence) t = fence[1].trim();
    if (!/^[[{"]/.test(t)) return t;
    let data;
    try { data = JSON.parse(t); } catch (e) { return t; }
    const parts = [];
    const walk = (x, depth) => {
      if (typeof x === 'string') { if (x.trim()) parts.push(x.trim()); }
      else if (Array.isArray(x)) x.forEach(y => (typeof y === 'string' ? parts.push(`- ${y.trim()}`) : walk(y, depth + 1)));
      else if (x && typeof x === 'object' && depth < 4) Object.values(x).forEach(y => walk(y, depth + 1));
    };
    walk(data, 0);
    return parts.length ? parts.join('\n\n') : t;
  }
}

if (typeof window !== 'undefined') window.VeloRideBrief = VeloRideBrief;
if (typeof module !== 'undefined' && module.exports) module.exports = VeloRideBrief;
