/**
 * APEX VELO // LAB - Ride share card (image for Strava, Instagram, messages).
 *
 * Two styles, both 1080 x 1350 (4:5 portrait, the shape Strava and Instagram show
 * uncropped) drawn at 2x and saved as a high-quality JPEG (a tenth of the PNG size;
 * Strava and Instagram store photos as JPEG anyway):
 *   - 'full'    title, distance / time / NP, power and heart-rate lanes, the work
 *               intervals (or best efforts on a free ride), cadence and load strip.
 *   - 'minimal' one edge-to-edge power wave, a thin heart-rate line and six numbers.
 *
 * analyse() is pure (no DOM) so it can be unit tested; render() needs a canvas.
 * Every number comes from the saved ride record and its 1 Hz samples. Work
 * intervals come from the workout's own targets; a ride without targets shows
 * its best 5 s / 1 / 5 / 20 min powers instead.
 *
 * Sample shape: { time, power, hr, cadence, target }
 */
class VeloShareCard {
  static W = 1080;
  static H = 1350;
  static STYLES = ['full', 'minimal'];
  static MIME = 'image/jpeg';
  static QUALITY = 0.92;
  static C = {
    bg: '#07070d', ink: '#f4f4f7', ink2: 'rgba(244,244,247,.62)', ink3: 'rgba(244,244,247,.38)', line: 'rgba(255,255,255,.08)',
    pw: '#F0522E', pwHi: '#FF9B6A', pwPeach: '#FFB08A', hr: '#14AA9E', hrHi: '#5FE3D3', cad: '#9373F0', pink: '#ff3d78', lilac: '#c78bff',
  };
  static FONT = 'ApexCardInter';

  // ================================================================ analysis --
  static num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  static pos(v) { const n = VeloShareCard.num(v); return n !== null && n > 0 ? n : null; }

  static fmtTime(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  }

  /** "4 min", "30 s", "1:30" - for interval lengths. */
  static fmtDur(sec) {
    const s = Math.round(sec);
    if (s < 60) return `${s} s`;
    if (s % 60 === 0) return `${s / 60} min`;
    return VeloShareCard.fmtTime(s);
  }

  static centered(a, w) {
    const h = Math.floor(w / 2), out = new Array(a.length);
    let sum = 0, lo = 0, hi = -1;
    for (let i = 0; i < a.length; i++) {
      const L = Math.max(0, i - h), R = Math.min(a.length - 1, i + h);
      while (hi < R) sum += a[++hi];
      while (lo < L) sum -= a[lo++];
      out[i] = sum / (R - L + 1);
    }
    return out;
  }

  /** Forward-fill gaps (null/0) so dropouts don't draw as cliffs; leading gaps take the first value. */
  static ffill(a) {
    const first = a.find(v => v > 0);
    if (first === undefined) return null;
    let last = first;
    return a.map(v => (v > 0 ? (last = v) : last));
  }

  static bestAvg(power, sec) {
    if (power.length < sec) return null;
    let sum = 0, best = 0;
    for (let i = 0; i < power.length; i++) {
      sum += power[i];
      if (i >= sec) sum -= power[i - sec];
      if (i >= sec - 1) best = Math.max(best, sum / sec);
    }
    return Math.round(best);
  }

  /**
   * Work intervals from the workout's targets: contiguous steps whose target is
   * within 80% of the session's hardest target (and at least 75% of FTP).
   * Adjacent work steps merge; very short blips (<10 s) are ignored.
   */
  static workIntervals(samples, ftp) {
    const segs = [];
    let cur = null;
    samples.forEach((s, i) => {
      const t = VeloShareCard.pos(s.target);
      if (!cur || t !== cur.target) { cur = { target: t, start: i, end: i + 1 }; segs.push(cur); } else cur.end = i + 1;
    });
    const hi = Math.max(0, ...segs.map(g => g.target || 0));
    if (!hi) return [];
    const floor = Math.max(0.8 * hi, ftp > 0 ? 0.75 * ftp : 0);
    const work = [];
    for (const g of segs) {
      if (!(g.target >= floor)) continue;
      const prev = work[work.length - 1];
      if (prev && prev.end === g.start) prev.end = g.end; else work.push({ start: g.start, end: g.end });
    }
    return work.filter(w => w.end - w.start >= 10);
  }

  /** Split intervals into sets where a recovery is much longer than the usual one. */
  static groupSets(work) {
    if (work.length < 4) return [work.map((_, i) => i)];
    const gaps = work.slice(1).map((w, i) => w.start - work[i].end);
    const sorted = [...gaps].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const sets = [[0]];
    gaps.forEach((g, i) => { if (g > Math.max(60, med * 2.5)) sets.push([]); sets[sets.length - 1].push(i + 1); });
    return sets.every(s => s.length >= 2) ? sets : [work.map((_, i) => i)];
  }

  /**
   * Splits a title around its interval pattern ("4x4", "30/15", "3 x 10 min") for highlighting.
   * A unit right after the pattern ("Minute", "min", "s") is kept separately so it can stay with it.
   */
  static titleParts(title) {
    const t = String(title || 'Ride').replace(/\s+/g, ' ').trim();
    const m = t.match(/(\d+\s*[x\u00d7]\s*\d+|\d+\s*\/\s*\d+)(\s*(?:minutes?|mins?|seconds?|secs?|s)\b)?/i);
    if (!m) return { before: t, token: '', unit: '', after: '' };
    const unit = m[2] ? (/^\s*m/i.test(m[2]) ? 'min' : 's') : '';
    return { before: t.slice(0, m.index).trim(), token: m[1].replace(/\s*[x\u00d7]\s*/i, '\u00d7').replace(/\s*\/\s*/, '/'), unit, after: t.slice(m.index + m[0].length).trim() };
  }

  static analyse(record, opts = {}) {
    const P = VeloShareCard.pos, n = VeloShareCard.num;
    const samples = Array.isArray(record?.samples) ? record.samples : [];
    const ftp = P(record?.ftpAtRide) || P(opts.ftp) || null;
    const rawPower = samples.map(s => Math.max(0, n(s.power) || 0));
    const hr = VeloShareCard.ffill(samples.map(s => n(s.hr) || 0));
    const cad = VeloShareCard.ffill(samples.map(s => n(s.cadence) || 0));
    // Leading zero power (before the first pedal stroke) would draw as a cliff.
    const firstPedal = rawPower.findIndex(v => v > 0);
    const power = firstPedal > 0 ? rawPower.map((v, i) => (i < firstPedal ? rawPower[firstPedal] : v)) : rawPower;

    let work = samples.length ? VeloShareCard.workIntervals(samples, ftp) : [];
    // A lone effort well before the sets (an "opener") is warm-up, not one of the repeats.
    if (work.length >= 5) {
      const first = VeloShareCard.groupSets(work.slice(1));
      const gap0 = work[1].start - work[0].end, gaps = work.slice(2).map((w, i) => w.start - work[i + 1].end).sort((a, b) => a - b);
      if (first.every(s => s.length >= 2) && gap0 > Math.max(60, 2.5 * gaps[Math.floor(gaps.length / 2)])) work = work.slice(1);
    }
    const intervals = work.map((w, i) => {
      const p = power.slice(w.start, w.end);
      const h = hr ? hr.slice(w.start, Math.min(samples.length, w.end + 20)) : [];
      return { i, start: w.start, end: w.end, seconds: w.end - w.start, avgPower: Math.round(p.reduce((a, b) => a + b, 0) / p.length), peakHr: h.length ? Math.max(...h) : null };
    });
    const sets = intervals.length >= 2 ? VeloShareCard.groupSets(work) : [];
    const lens = intervals.map(x => x.seconds).sort((a, b) => a - b);
    const medLen = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
    const recov = intervals.slice(1).map((x, k) => x.start - intervals[k].end).filter((g, k) => !sets.some(s => s[0] === k + 1 && s !== sets[0]));
    const medRec = recov.length ? [...recov].sort((a, b) => a - b)[Math.floor(recov.length / 2)] : 0;
    const best = intervals.length ? intervals.reduce((a, b) => (b.avgPower > a.avgPower ? b : a)) : null;

    const statsOf = (a) => { const v = (a || []).filter(x => x > 0); return v.length ? { avg: Math.round(v.reduce((x, y) => x + y, 0) / v.length), max: Math.max(...v) } : null; };
    const hrS = statsOf(samples.map(s => n(s.hr)));
    const cadS = statsOf(samples.map(s => n(s.cadence)));
    const dur = P(record?.duration) || samples.length;
    const kj = P(record?.kj);
    const date = new Date(record?.date || Date.now());

    return {
      title: String(record?.title || 'Ride'),
      titleParts: VeloShareCard.titleParts(record?.title),
      date: isNaN(date) ? new Date() : date,
      indoor: true,
      durationSec: dur,
      distanceKm: P(record?.distanceKm),
      np: P(record?.np), avgPower: P(record?.avgWatts), maxPower: P(record?.maxWatts),
      avgHr: P(record?.avgHr) || hrS?.avg || null, maxHr: P(record?.maxHr) || hrS?.max || null,
      avgCadence: P(record?.avgCadence) || cadS?.avg || null, maxCadence: P(record?.maxCadence) || cadS?.max || null,
      tss: P(record?.tss), if: P(record?.if), kj,
      avgSpeedKmh: P(record?.avgSpeedKmh),
      ftp,
      series: { power, hr, cad },
      hasSamples: samples.length >= 30,
      intervals, sets, medLen, medRec, best,
      intervalAvg: intervals.length ? Math.round(intervals.reduce((a, x) => a + x.avgPower, 0) / intervals.length) : null,
      bests: [5, 60, 300, 1200].map(sec => ({ sec, label: sec < 60 ? `${sec} s` : `${sec / 60} min`, watts: VeloShareCard.bestAvg(rawPower, sec) })).filter(b => b.watts > 0),
    };
  }

  /** One line under the title: "2 sets \u00d7 10 \u00b7 30 s on / 15 s off \u00b7 252 W average on the efforts". */
  static subtitle(A) {
    if (A.intervals.length >= 2) {
      const per = A.sets.length > 1 && A.sets.every(s => s.length === A.sets[0].length) ? `${A.sets.length} sets \u00d7 ${A.sets[0].length}` : `${A.intervals.length} \u00d7 ${VeloShareCard.fmtDur(A.medLen)}`;
      const onOff = A.medRec ? ` \u00b7 ${VeloShareCard.fmtDur(A.medLen)} on / ${VeloShareCard.fmtDur(A.medRec)} off` : '';
      return { bold: per, rest: `${onOff} \u00b7 ${A.intervalAvg} W average on the efforts` };
    }
    return { bold: VeloShareCard.fmtTime(A.durationSec), rest: A.avgPower ? ` \u00b7 ${A.avgPower} W average${A.np ? ` \u00b7 ${A.np} W normalized` : ''}` : '' };
  }

  /** A card needs a recorded power stream; summary-only imports have nothing to draw. */
  static canRender(record) {
    const sm = record && Array.isArray(record.samples) ? record.samples : [];
    return sm.length >= 30 && sm.some(x => Number(x.power) > 0);
  }

  static fileName(record, style = 'full') {
    const d = new Date(record?.date || Date.now());
    const day = isNaN(d) ? 'ride' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const slug = String(record?.title || 'ride').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 48) || 'ride';
    return `apex-velo-${day}-${slug}${style === 'minimal' ? '-minimal' : ''}.jpg`;
  }

  // ================================================================= drawing --
  static _fontReady = null;
  /** Loads the variable Inter (thin to black) once; falls back to the page's Inter. */
  static ensureFont(base = '') {
    if (VeloShareCard._fontReady) return VeloShareCard._fontReady;
    const g = typeof globalThis !== 'undefined' ? globalThis : window;
    if (!g.FontFace || !g.document?.fonts) return (VeloShareCard._fontReady = Promise.resolve(false));
    const url = (base || '') + 'vendor/fonts/inter-latin-wght-normal.woff2';
    const face = new g.FontFace(VeloShareCard.FONT, `url(${url}) format('woff2')`, { weight: '100 900' });
    VeloShareCard._fontReady = face.load().then(f => { g.document.fonts.add(f); return true; }).catch(() => false);
    return VeloShareCard._fontReady;
  }

  static font(weight, size) { return `${weight} ${size}px ${VeloShareCard.FONT}, Inter, "Segoe UI", Roboto, Arial, sans-serif`; }

  static spacing(ctx, em, size) { if ('letterSpacing' in ctx) ctx.letterSpacing = `${(em * size).toFixed(2)}px`; }

  /** Text with letter-spacing, returns its width. */
  static text(ctx, str, x, y, { weight = 400, size = 16, color = VeloShareCard.C.ink, track = 0, align = 'left', fill = null } = {}) {
    ctx.font = VeloShareCard.font(weight, size);
    VeloShareCard.spacing(ctx, track, size);
    const w = ctx.measureText(str).width;
    const x0 = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    ctx.fillStyle = fill || color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(str, x0, y);
    VeloShareCard.spacing(ctx, 0, size);
    return w;
  }

  static measure(ctx, str, weight, size, track = 0) {
    ctx.font = VeloShareCard.font(weight, size);
    VeloShareCard.spacing(ctx, track, size);
    const w = ctx.measureText(str).width;
    VeloShareCard.spacing(ctx, 0, size);
    return w;
  }

  /** Big number with a smaller unit after it. */
  static valueUnit(ctx, value, unit, x, y, size, { weight = 250, unitSize = Math.round(size * 0.32), track = -0.05, fill = null, unitColor = VeloShareCard.C.ink2, unitWeight = 400 } = {}) {
    const w = VeloShareCard.text(ctx, value, x, y, { weight, size, track, fill });
    if (unit) VeloShareCard.text(ctx, unit, x + w + Math.round(size * 0.07), y, { weight: unitWeight, size: unitSize, color: unitColor });
  }

  static gradText(ctx, x0, x1) {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, VeloShareCard.C.pwPeach); g.addColorStop(0.38, VeloShareCard.C.pw); g.addColorStop(0.75, VeloShareCard.C.pink); g.addColorStop(1, VeloShareCard.C.lilac);
    return g;
  }

  static rr(ctx, x, y, w, h, r) {
    const rad = typeof r === 'number' ? [r, r, r, r] : r;
    ctx.beginPath();
    ctx.moveTo(x + rad[0], y);
    ctx.lineTo(x + w - rad[1], y); ctx.quadraticCurveTo(x + w, y, x + w, y + rad[1]);
    ctx.lineTo(x + w, y + h - rad[2]); ctx.quadraticCurveTo(x + w, y + h, x + w - rad[2], y + h);
    ctx.lineTo(x + rad[3], y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - rad[3]);
    ctx.lineTo(x, y + rad[0]); ctx.quadraticCurveTo(x, y, x + rad[0], y);
    ctx.closePath();
  }

  /** Soft colour field: a radial gradient squashed into an ellipse. */
  static blob(ctx, cx, cy, rx, ry, stops, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy); ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    stops.forEach(([o, c]) => g.addColorStop(o, c));
    ctx.fillStyle = g;
    ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
    ctx.restore();
  }

  static _grain = null;
  static grain(ctx, w, h, alpha) {
    const doc = (typeof document !== 'undefined') ? document : null;
    if (!doc) return;
    if (!VeloShareCard._grain) {
      const c = doc.createElement('canvas'); c.width = c.height = 256;
      const g = c.getContext('2d'), img = g.createImageData(256, 256);
      let seed = 1234567;
      for (let i = 0; i < img.data.length; i += 4) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const v = (seed >> 8) & 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      VeloShareCard._grain = c;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = ctx.createPattern(VeloShareCard._grain, 'repeat');
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  static background(ctx, minimal) {
    const { W, H } = VeloShareCard;
    ctx.fillStyle = VeloShareCard.C.bg; ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (minimal) {
      VeloShareCard.blob(ctx, 540, 780, 520, 300, [[0, '#ff4a2a'], [0.4, '#a0193f'], [1, 'rgba(0,0,0,0)']], 0.3);
      VeloShareCard.blob(ctx, 90, 70, 420, 260, [[0, '#5b35ff'], [1, 'rgba(0,0,0,0)']], 0.2);
    } else {
      VeloShareCard.blob(ctx, 880, 50, 470, 400, [[0, '#ff5a2c'], [0.45, '#b01f4e'], [1, 'rgba(0,0,0,0)']], 0.42);
      VeloShareCard.blob(ctx, 20, 660, 420, 370, [[0, '#6a3cff'], [0.45, '#2d1880'], [1, 'rgba(0,0,0,0)']], 0.4);
      VeloShareCard.blob(ctx, 900, 1200, 460, 360, [[0, '#0fb5a4'], [0.45, '#0a5a73'], [1, 'rgba(0,0,0,0)']], 0.34);
      VeloShareCard.blob(ctx, 330, 0, 260, 230, [[0, '#ff8a3d'], [1, 'rgba(0,0,0,0)']], 0.16);
    }
    ctx.restore();
    VeloShareCard.grain(ctx, W, H, 0.07);
    const v = ctx.createRadialGradient(W / 2, H * 0.4, H * 0.35, W / 2, H * 0.4, H * 0.85);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.5)');
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  }

  /** Smooth Catmull-Rom path through points. */
  static curve(ctx, pts, close = null) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    const t = 1 / 3;
    for (let k = 0; k < pts.length - 1; k++) {
      const p0 = pts[k - 1] || pts[k], p1 = pts[k], p2 = pts[k + 1], p3 = pts[k + 2] || p2;
      ctx.bezierCurveTo(p1[0] + (p2[0] - p0[0]) * t / 2, p1[1] + (p2[1] - p0[1]) * t / 2,
        p2[0] - (p3[0] - p1[0]) * t / 2, p2[1] - (p3[1] - p1[1]) * t / 2, p2[0], p2[1]);
    }
    if (close !== null) { ctx.lineTo(pts[pts.length - 1][0], close); ctx.lineTo(pts[0][0], close); ctx.closePath(); }
  }

  /** Power smoothed lightly inside intervals (keeps their edges crisp) and more between them. */
  static powerSeries(A) {
    const p = A.series.power, n = p.length;
    if (!n) return [];
    const longEfforts = A.medLen >= 120;
    const fine = VeloShareCard.centered(p, longEfforts ? 7 : 3), soft = VeloShareCard.centered(p, 15);
    const near = new Array(n).fill(0);
    A.intervals.forEach(w => { for (let i = Math.max(0, w.start - 6); i < Math.min(n, w.end + 6); i++) near[i] = 1; });
    const blend = VeloShareCard.centered(near, 9);
    return p.map((_, i) => blend[i] * fine[i] + (1 - blend[i]) * soft[i]);
  }

  /** Top of the power scale: the drawn line's own near-peak, so a lone spike may clip but nothing else does. */
  static waveMax(ps, A) {
    const sorted = [...ps].sort((a, b) => a - b);
    const q = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.997))] || 0;
    return Math.max(200, q * 1.1, ...A.intervals.map(w => w.avgPower * 1.25));
  }

  static points(series, x0, x1, yOf, maxPts = 360) {
    const n = series.length, step = Math.max(1, Math.ceil(n / maxPts)), pts = [];
    for (let i = 0; i < n; i += step) pts.push([x0 + (i / Math.max(1, n - 1)) * (x1 - x0), yOf(series[i])]);
    if ((n - 1) % step) pts.push([x1, yOf(series[n - 1])]);
    return pts;
  }

  static glowStroke(ctx, color, width, blur, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = color; ctx.shadowBlur = blur;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  }

  static brand(ctx, x, y) {
    const C = VeloShareCard.C;
    ctx.save();
    ctx.shadowColor = 'rgba(240,82,46,.55)'; ctx.shadowBlur = 20;
    let g;
    if (ctx.createConicGradient) {
      g = ctx.createConicGradient(Math.PI * 7 / 6, x + 13, y + 13);
      [[0, C.pw], [0.25, '#ff2d6f'], [0.5, C.cad], [0.75, C.hr], [1, C.pw]].forEach(([o, c]) => g.addColorStop(o, c));
    } else { g = ctx.createLinearGradient(x, y, x + 26, y + 26); g.addColorStop(0, C.pw); g.addColorStop(1, C.cad); }
    ctx.fillStyle = g;
    VeloShareCard.rr(ctx, x, y, 26, 26, 8); ctx.fill();
    ctx.restore();
    VeloShareCard.text(ctx, 'APEX VELO', x + 38, y + 19, { weight: 500, size: 15, track: 0.18 });
  }

  static dateLabel(d, long = true) {
    if (!long) return `${String(d.getDate()).padStart(2, '0')} \u00b7 ${String(d.getMonth() + 1).padStart(2, '0')} \u00b7 ${d.getFullYear()}`;
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${days[d.getDay()]} ${String(d.getDate()).padStart(2, '0')} ${mon[d.getMonth()]} ${d.getFullYear()}`.toUpperCase();
  }

  /** Lays out title runs [{text, grad}] into lines no wider than maxW. */
  static wrapRuns(ctx, runs, weight, size, track, maxW) {
    const words = [];
    runs.forEach(r => String(r.text).split(' ').filter(Boolean).forEach(w => words.push({ text: w, grad: r.grad })));
    const space = VeloShareCard.measure(ctx, ' ', weight, size, track);
    const lines = [[]]; let lw = 0;
    for (const w of words) {
      const ww = VeloShareCard.measure(ctx, w.text, weight, size, track);
      if (lines[lines.length - 1].length && lw + space + ww > maxW) { lines.push([]); lw = 0; }
      const line = lines[lines.length - 1];
      lw += (line.length ? space : 0) + ww;
      line.push({ ...w, w: ww });
    }
    return { lines, space, widest: Math.max(...lines.map(l => l.reduce((a, w, i) => a + w.w + (i ? space : 0), 0))) };
  }

  static titleRuns(A) {
    const t = A.titleParts;
    return [{ text: t.before, grad: false }, { text: [t.token, t.unit].filter(Boolean).join(' '), grad: true }, { text: t.after, grad: false }].filter(r => r.text);
  }

  static drawTitle(ctx, A, x, y, maxW) {
    const runs = VeloShareCard.titleRuns(A);
    let size = 86, lay;
    for (; size >= 52; size -= 4) {
      lay = VeloShareCard.wrapRuns(ctx, runs, 700, size, -0.045, maxW);
      if (lay.lines.length <= 2 && lay.widest <= maxW) break;
    }
    if (lay.lines.length > 2) lay.lines = lay.lines.slice(0, 2);
    const lh = Math.round(size * 0.97);
    let by = y + Math.round(size * 0.78);
    for (const line of lay.lines) {
      let cx = x;
      for (const w of line) {
        const fill = w.grad ? VeloShareCard.gradText(ctx, cx, cx + w.w) : null;
        VeloShareCard.text(ctx, w.text, cx, by, { weight: 700, size, track: -0.045, fill });
        cx += w.w + lay.space;
      }
      by += lh;
    }
    return y + lh * lay.lines.length;
  }

  static async render(record, { style = 'full', scale = 2, canvas = null, fontBase = '' } = {}) {
    await VeloShareCard.ensureFont(fontBase);
    const A = VeloShareCard.analyse(record);
    const doc = typeof document !== 'undefined' ? document : null;
    const c = canvas || doc.createElement('canvas');
    c.width = VeloShareCard.W * scale; c.height = VeloShareCard.H * scale;
    const ctx = c.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (style === 'minimal') VeloShareCard.drawMinimal(ctx, A); else VeloShareCard.drawFull(ctx, A);
    return c;
  }

  static async toBlob(record, opts = {}) {
    const c = await VeloShareCard.render(record, opts);
    return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('Could not encode the card image.'))), VeloShareCard.MIME, VeloShareCard.QUALITY));
  }

  // ------------------------------------------------------------ full style --
  static drawFull(ctx, A) {
    const { W, H, C } = VeloShareCard, T = VeloShareCard.text, pad = 64, right = W - pad, cw = right - pad;
    VeloShareCard.background(ctx, false);
    VeloShareCard.brand(ctx, pad, 60);
    T(ctx, `${VeloShareCard.dateLabel(A.date)} \u00b7 INDOOR`, right, 79, { weight: 500, size: 15, track: 0.18, color: C.ink2, align: 'right' });

    let y = VeloShareCard.drawTitle(ctx, A, pad - 3, 124, cw);
    const sub = VeloShareCard.subtitle(A);
    y += 24;
    const bw = T(ctx, sub.bold, pad, y + 20, { weight: 600, size: 24 });
    T(ctx, sub.rest, pad + bw, y + 20, { weight: 400, size: 24, color: C.ink2 });
    y += 52;

    // hero numbers
    const heroTop = y, heroH = 146;
    ctx.fillStyle = C.line;
    ctx.fillRect(pad, heroTop, cw, 1); ctx.fillRect(pad, heroTop + heroH, cw, 1);
    const cols = [[pad, 'DISTANCE', A.distanceKm ? A.distanceKm.toFixed(1) : '--', 'km'], [pad + cw * 0.35 + 34, 'MOVING TIME', VeloShareCard.fmtTime(A.durationSec), ''], [pad + cw * 0.675 + 34, 'NORM. POWER', A.np ? String(Math.round(A.np)) : '--', 'W']];
    cols.forEach(([x, k, v, u], i) => {
      if (i) ctx.fillRect(x - 34, heroTop, 1, heroH);
      T(ctx, k, x, heroTop + 38, { weight: 600, size: 13, track: 0.2, color: C.ink3 });
      VeloShareCard.valueUnit(ctx, v, u, x, heroTop + 122, 78, { weight: 250, unitSize: 26 });
    });
    y = heroTop + heroH + 32;

    // fixed blocks below the charts, measured from the bottom
    const footY = H - 46;
    const stripH = 104, stripTop = footY - 50 - stripH;
    const sectionH = A.intervals.length >= 2 ? (A.intervals.length <= 8 ? 104 : 150) : 104;
    const sectionTop = stripTop - 28 - sectionH - 32;
    // charts get what's left
    const lanes = sectionTop - 22 - y;
    const head = 32, ticks = 30, gap = 14;
    const ph = Math.round((lanes - head * 2 - ticks - gap) * 0.66), hh = lanes - head * 2 - ticks - gap - ph;

    if (A.hasSamples) VeloShareCard.drawLanes(ctx, A, pad, right, y, ph, hh, head, gap);
    else T(ctx, 'Second-by-second data was not recorded for this ride.', pad, y + 40, { size: 18, color: C.ink3 });

    VeloShareCard.drawSection(ctx, A, pad, right, sectionTop, sectionH);
    VeloShareCard.drawStrip(ctx, A, pad, right, stripTop, stripH);

    T(ctx, A.avgSpeedKmh ? `${A.avgSpeedKmh.toFixed(1)} KM/H AVG \u00b7 VIRTUAL SPEED` : 'INDOOR RIDE', pad, footY, { weight: 500, size: 14, track: 0.18, color: C.ink3 });
    T(ctx, 'APEX VELO LAB', right, footY, { weight: 500, size: 14, track: 0.18, color: C.ink3, align: 'right' });
  }

  static laneHead(ctx, x, right, y, name, color, meta) {
    const { C } = VeloShareCard, T = VeloShareCard.text;
    ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 12; ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x + 5, y - 5, 5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    T(ctx, name, x + 20, y, { weight: 600, size: 14, track: 0.2 });
    // meta: [[text, bold], ...] right aligned
    let w = meta.reduce((a, [t, b]) => a + VeloShareCard.measure(ctx, t, b ? 600 : 400, 16), 0), cx = right - w;
    meta.forEach(([t, b]) => { cx += T(ctx, t, cx, y, { weight: b ? 600 : 400, size: 16, color: b ? C.ink : C.ink2 }); });
  }

  static drawLanes(ctx, A, x0, x1, y, ph, hh, head, gap) {
    const { C } = VeloShareCard, T = VeloShareCard.text, n = A.series.power.length;
    const xOf = (i) => x0 + (i / Math.max(1, n - 1)) * (x1 - x0);
    // ---- power
    VeloShareCard.laneHead(ctx, x0, x1, y + 14, 'POWER', C.pw, [['avg ', 0], [`${A.avgPower || '--'} W`, 1], [' \u00b7 max ', 0], [`${A.maxPower || '--'} W`, 1]]);
    const top = y + head, bottom = top + ph;
    const ps = VeloShareCard.powerSeries(A);
    const pmax = VeloShareCard.waveMax(ps, A);
    const yP = (v) => bottom - Math.min(v, pmax) / pmax * ph;
    // interval bands + labels
    A.intervals.forEach(w => { ctx.fillStyle = 'rgba(255,255,255,.035)'; ctx.fillRect(xOf(w.start), top, xOf(w.end) - xOf(w.start), ph); });
    const groups = A.intervals.length > 8 ? A.sets.map((s, k) => ({ a: A.intervals[s[0]].start, b: A.intervals[s[s.length - 1]].end, label: A.sets.length > 1 ? `SET ${k + 1}` : '' }))
      : A.intervals.map((w, k) => ({ a: w.start, b: w.end, label: String(k + 1) }));
    groups.forEach(g => {
      if (!g.label) return;
      const a = xOf(g.a), b = xOf(g.b);
      ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a + .5, top + 10); ctx.lineTo(a + .5, top + 2); ctx.lineTo(b - .5, top + 2); ctx.lineTo(b - .5, top + 10); ctx.stroke();
      T(ctx, g.label, (a + b) / 2, top - 4, { weight: 600, size: 12, track: 0.2, color: C.ink2, align: 'center' });
    });
    const pts = VeloShareCard.points(ps, x0, x1, yP);
    const fill = ctx.createLinearGradient(0, top, 0, bottom);
    fill.addColorStop(0, 'rgba(255,122,74,.75)'); fill.addColorStop(0.45, 'rgba(240,82,46,.32)'); fill.addColorStop(1, 'rgba(240,82,46,0)');
    VeloShareCard.curve(ctx, pts, bottom); ctx.fillStyle = fill; ctx.fill();
    VeloShareCard.curve(ctx, pts); VeloShareCard.glowStroke(ctx, '#FF6A3A', 4, 14, 0.55);
    const st = ctx.createLinearGradient(0, top, 0, bottom);
    st.addColorStop(0, '#FFC2A3'); st.addColorStop(0.35, '#FF7A4A'); st.addColorStop(1, C.pw);
    VeloShareCard.curve(ctx, pts); ctx.strokeStyle = st; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();

    // ---- heart rate
    const hy = bottom + gap;
    if (A.series.hr && A.avgHr) {
      VeloShareCard.laneHead(ctx, x0, x1, hy + 14, 'HEART RATE', C.hr, [['avg ', 0], [`${A.avgHr} bpm`, 1], [' \u00b7 max ', 0], [`${A.maxHr} bpm`, 1]]);
      const ht = hy + head, hb = ht + hh;
      const hs = VeloShareCard.centered(A.series.hr, 9);
      const lo = Math.max(40, Math.min(...hs) - 8), hi = Math.max(...hs) + 10;
      const yH = (v) => hb - (v - lo) / (hi - lo) * hh;
      const hp = VeloShareCard.points(hs, x0, x1, yH);
      const hf = ctx.createLinearGradient(0, ht, 0, hb);
      hf.addColorStop(0, 'rgba(47,211,194,.5)'); hf.addColorStop(1, 'rgba(20,170,158,0)');
      VeloShareCard.curve(ctx, hp, hb); ctx.fillStyle = hf; ctx.fill();
      VeloShareCard.curve(ctx, hp); VeloShareCard.glowStroke(ctx, '#2FD3C2', 4, 14, 0.5);
      const hsg = ctx.createLinearGradient(x0, 0, x1, 0);
      hsg.addColorStop(0, C.hr); hsg.addColorStop(0.55, C.hrHi); hsg.addColorStop(1, C.hr);
      VeloShareCard.curve(ctx, hp); ctx.strokeStyle = hsg; ctx.lineWidth = 2; ctx.stroke();
      // peak marker
      let mi = 0; hs.forEach((v, i) => { if (v > hs[mi]) mi = i; });
      const mx = xOf(mi), my = yH(hs[mi]);
      ctx.save(); ctx.shadowColor = C.hrHi; ctx.shadowBlur = 14;
      ctx.fillStyle = C.bg; ctx.beginPath(); ctx.arc(mx, my, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(mx, my, 5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      T(ctx, String(A.maxHr), mx, my - 14, { weight: 600, size: 13, align: 'center' });
      // time ticks
      const mins = A.durationSec / 60, stepMin = mins > 150 ? 30 : mins > 75 ? 20 : 10;
      for (let m = 0; m <= mins; m += stepMin) {
        const x = x0 + (m * 60 / Math.max(1, A.durationSec)) * (x1 - x0);
        T(ctx, `${m}\u2032`, x, hb + 26, { size: 13, color: C.ink3, align: m === 0 ? 'left' : x > x1 - 30 ? 'right' : 'center' });
      }
    }
  }

  static drawSection(ctx, A, x0, x1, top, h) {
    const { C } = VeloShareCard, T = VeloShareCard.text, cw = x1 - x0;
    const n = A.intervals.length;
    if (n >= 2 && n <= 8) {
      VeloShareCard.laneHead(ctx, x0, x1, top + 14, `${n} INTERVALS \u00b7 AVG POWER`, C.pwPeach, A.maxHr ? [['HR peaked at ', 0], [`${Math.max(...A.intervals.map(x => x.peakHr || 0)) || A.maxHr} bpm`, 1]] : []);
      const g = 16, colW = (cw - g * (n - 1)) / n, pmax = Math.max(300, ...A.intervals.map(x => x.avgPower)) * 1.05;
      A.intervals.forEach((iv, k) => {
        const x = x0 + k * (colW + g), y = top + 32;
        VeloShareCard.valueUnit(ctx, String(iv.avgPower), 'W', x, y + 36, n > 5 ? 32 : 40, { weight: 250, unitSize: 15 });
        ctx.fillStyle = 'rgba(255,255,255,.07)'; VeloShareCard.rr(ctx, x, y + 48, colW, 12, 6); ctx.fill();
        const bwid = Math.max(12, colW * iv.avgPower / pmax);
        const gr = ctx.createLinearGradient(x, 0, x + bwid, 0);
        const best = A.best && iv.i === A.best.i;
        gr.addColorStop(0, 'rgba(240,82,46,.25)'); gr.addColorStop(0.6, best ? C.pw : 'rgba(240,82,46,.85)'); gr.addColorStop(1, best ? '#fff' : C.pwHi);
        ctx.save(); if (best) { ctx.shadowColor = 'rgba(240,82,46,.7)'; ctx.shadowBlur = 18; }
        ctx.fillStyle = gr; VeloShareCard.rr(ctx, x, y + 48, bwid, 12, 6); ctx.fill(); ctx.restore();
        T(ctx, `#${k + 1}`, x, y + 84, { weight: 600, size: 13, track: 0.2, color: C.ink3 });
        if (iv.peakHr) {
          const tw = VeloShareCard.measure(ctx, `${iv.peakHr} bpm`, 400, 13);
          T(ctx, `${iv.peakHr} bpm`, x + colW, y + 84, { size: 13, color: C.ink3, align: 'right' });
          ctx.fillStyle = C.hr; ctx.beginPath(); ctx.arc(x + colW - tw - 9, y + 79.5, 3.5, 0, Math.PI * 2); ctx.fill();
        }
      });
      return;
    }
    if (n > 8) {
      const multi = A.sets.length > 1;
      const meta = multi ? A.sets.flatMap((s, k) => [[`${k ? ' \u00b7 ' : ''}set ${k + 1} `, 0], [`${Math.round(s.reduce((a, i) => a + A.intervals[i].avgPower, 0) / s.length)} W`, 1]]) : [['avg ', 0], [`${A.intervalAvg} W`, 1]];
      VeloShareCard.laneHead(ctx, x0, x1, top + 14, `${n} EFFORTS \u00b7 ${VeloShareCard.fmtDur(A.medLen).toUpperCase()} AVG`, C.pwPeach, meta);
      const barTop = top + 48, barH = 84, setGap = multi ? 22 : 0, g = n > 24 ? 3 : 7;
      const bw = (cw - setGap * (A.sets.length - 1) - g * (n - A.sets.length)) / n;
      const pmax = Math.max(300, ...A.intervals.map(x => x.avgPower)) * 1.05;
      let x = x0;
      A.sets.forEach((s, k) => {
        if (k) x += setGap - g;
        if (multi) T(ctx, `SET ${k + 1}`, x, barTop + barH + 24, { weight: 600, size: 12, track: 0.2, color: C.ink3 });
        s.forEach(i => {
          const iv = A.intervals[i], bh = barH * iv.avgPower / pmax, by = barTop + barH - bh, best = A.best && i === A.best.i;
          const gr = ctx.createLinearGradient(0, by, 0, barTop + barH);
          if (best) { gr.addColorStop(0, '#fff'); gr.addColorStop(0.18, C.pwPeach); gr.addColorStop(0.6, C.pw); gr.addColorStop(1, 'rgba(240,82,46,.2)'); }
          else { gr.addColorStop(0, 'rgba(255,155,106,.95)'); gr.addColorStop(0.55, 'rgba(240,82,46,.55)'); gr.addColorStop(1, 'rgba(240,82,46,.12)'); }
          ctx.save(); if (best) { ctx.shadowColor = 'rgba(240,82,46,.65)'; ctx.shadowBlur = 24; }
          ctx.fillStyle = gr; VeloShareCard.rr(ctx, x, by, bw, bh, [4, 4, 2, 2]); ctx.fill(); ctx.restore();
          if (best) T(ctx, String(iv.avgPower), x + bw / 2, by - 8, { weight: 700, size: 14, align: 'center' });
          x += bw + g;
        });
      });
      return;
    }
    // free ride: best efforts
    if (!A.bests.length) return;
    VeloShareCard.laneHead(ctx, x0, x1, top + 14, 'BEST EFFORTS', C.pwPeach, A.ftp ? [['FTP ', 0], [`${A.ftp} W`, 1]] : []);
    const k = A.bests.length, g = 16, colW = (cw - g * (k - 1)) / k, pmax = A.bests[0].watts * 1.05;
    A.bests.forEach((b, i) => {
      const x = x0 + i * (colW + g), y = top + 32;
      VeloShareCard.valueUnit(ctx, String(b.watts), 'W', x, y + 36, 40, { weight: 250, unitSize: 15 });
      ctx.fillStyle = 'rgba(255,255,255,.07)'; VeloShareCard.rr(ctx, x, y + 48, colW, 12, 6); ctx.fill();
      const gr = ctx.createLinearGradient(x, 0, x + colW, 0);
      gr.addColorStop(0, 'rgba(240,82,46,.25)'); gr.addColorStop(0.6, 'rgba(240,82,46,.85)'); gr.addColorStop(1, VeloShareCard.C.pwHi);
      ctx.fillStyle = gr; VeloShareCard.rr(ctx, x, y + 48, Math.max(12, colW * b.watts / pmax), 12, 6); ctx.fill();
      T(ctx, b.label.toUpperCase(), x, y + 84, { weight: 600, size: 13, track: 0.2, color: C.ink3 });
    });
  }

  static drawStrip(ctx, A, x0, x1, top, h) {
    const { C } = VeloShareCard, T = VeloShareCard.text, cw = x1 - x0;
    const g = ctx.createLinearGradient(x0, top, x1, top + h);
    g.addColorStop(0, 'rgba(255,255,255,.075)'); g.addColorStop(1, 'rgba(255,255,255,.02)');
    VeloShareCard.rr(ctx, x0, top, cw, h, 24); ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.09)'; ctx.lineWidth = 1; ctx.stroke();
    const fr = [1.55, 1, 1, 1], tot = fr.reduce((a, b) => a + b, 0);
    const cells = [
      ['CADENCE', A.avgCadence ? String(A.avgCadence) : '--', 'rpm', C.cad],
      ['TRAINING LOAD', A.tss ? String(Math.round(A.tss)) : '--', 'TSS'],
      ['INTENSITY', A.if ? A.if.toFixed(2) : '--', 'IF'],
      ['WORK', A.kj ? String(Math.round(A.kj)) : '--', 'kJ'],
    ];
    let x = x0;
    cells.forEach(([k, v, u, dot], i) => {
      const w = cw * fr[i] / tot;
      if (i) { ctx.fillStyle = C.line; ctx.fillRect(x, top + 1, 1, h - 2); }
      let lx = x + 24;
      if (dot) { ctx.save(); ctx.shadowColor = dot; ctx.shadowBlur = 10; ctx.fillStyle = dot; ctx.beginPath(); ctx.arc(lx + 4, top + 32.5, 4, 0, Math.PI * 2); ctx.fill(); ctx.restore(); lx += 16; }
      T(ctx, k, lx, top + 37, { weight: 600, size: 11.5, track: 0.2, color: C.ink3 });
      VeloShareCard.valueUnit(ctx, v, u, x + 24, top + 84, 46, { weight: 300, unitSize: 16, track: -0.045 });
      if (i === 0 && A.series.cad && A.hasSamples) {
        const cs = VeloShareCard.centered(A.series.cad, 151);
        const lo = Math.min(...cs), hi = Math.max(...cs), sx0 = x + w - 22 - 130, sx1 = x + w - 22, sy1 = top + h - 22, sy0 = sy1 - 40;
        const pts = VeloShareCard.points(cs, sx0, sx1, v2 => sy1 - (v2 - lo) / Math.max(1, hi - lo) * (sy1 - sy0), 60);
        const sg = ctx.createLinearGradient(sx0, 0, sx1, 0);
        sg.addColorStop(0, 'rgba(147,115,240,.2)'); sg.addColorStop(0.5, '#C3B0FF'); sg.addColorStop(1, 'rgba(147,115,240,.2)');
        VeloShareCard.curve(ctx, pts); ctx.strokeStyle = sg; ctx.lineWidth = 2; ctx.stroke();
      }
      x += w;
    });
  }

  // --------------------------------------------------------- minimal style --
  static drawMinimal(ctx, A) {
    const { W, H, C } = VeloShareCard, T = VeloShareCard.text, pad = 80, right = W - pad;
    VeloShareCard.background(ctx, true);
    T(ctx, VeloShareCard.dateLabel(A.date, false), pad, 86, { weight: 500, size: 14, track: 0.24, color: C.ink3 });
    T(ctx, 'INDOOR RIDE', right, 86, { weight: 500, size: 14, track: 0.24, color: C.ink3, align: 'right' });

    // hero: the interval pattern ("4\u00d74", "30/15") in thin type, else the title
    const tp = A.titleParts;
    let nameY;
    if (tp.token) {
      let size = 230;
      while (size > 120 && VeloShareCard.measure(ctx, tp.token, 200, size, -0.06) > right - pad) size -= 10;
      const w = VeloShareCard.measure(ctx, tp.token, 200, size, -0.06);
      T(ctx, tp.token, pad - 10, 170 + size * 0.72, { weight: 200, size, track: -0.06, fill: VeloShareCard.gradText(ctx, pad, pad + w) });
      nameY = 170 + size * 0.72 + 60;
      const rest = [tp.before, tp.unit && A.intervals.length < 2 ? tp.unit : '', tp.after].filter(Boolean).join(' ');
      const sub = A.intervals.length >= 2 && A.medRec ? `${VeloShareCard.fmtDur(A.medLen)} on / ${VeloShareCard.fmtDur(A.medRec)} easy` : VeloShareCard.fmtTime(A.durationSec);
      const nw = T(ctx, rest || 'Intervals', pad, nameY, { size: 30, track: -0.01 });
      T(ctx, ` \u00b7 ${sub}`, pad + nw, nameY, { size: 30, color: C.ink3 });
    } else {
      const runs = [{ text: A.title, grad: true }];
      let size = 120, lay;
      for (; size >= 64; size -= 6) { lay = VeloShareCard.wrapRuns(ctx, runs, 250, size, -0.05, right - pad); if (lay.lines.length <= 2) break; }
      let by = 150 + size * 0.75;
      lay.lines.slice(0, 2).forEach(line => {
        const text = line.map(w => w.text).join(' '), w = VeloShareCard.measure(ctx, text, 250, size, -0.05);
        T(ctx, text, pad - 6, by, { weight: 250, size, track: -0.05, fill: VeloShareCard.gradText(ctx, pad, pad + w) });
        by += size;
      });
      nameY = by - size + 60;
      T(ctx, `${VeloShareCard.fmtTime(A.durationSec)}${A.avgPower ? ` \u00b7 ${A.avgPower} W average` : ''}`, pad, nameY, { size: 30, color: C.ink3 });
    }

    // stats block from the bottom
    const footY = H - 70, row2 = footY - 62 - 20, row1 = row2 - 136;
    const waveBottom = row1 - 96 - 70, hrH = 92, hrTop = waveBottom - hrH, pBottom = hrTop - 26;
    const pTop = Math.max(nameY + 70, pBottom - 280), ph = pBottom - pTop;

    if (A.hasSamples) {
      ctx.save();
      // fade both ends of the full-bleed wave
      const n = A.series.power.length, ps = VeloShareCard.powerSeries(A);
      const pmax = VeloShareCard.waveMax(ps, A) * 1.1;
      const pts = VeloShareCard.points(ps, 0, W, v => pBottom - Math.min(v, pmax) / pmax * ph);
      const fill = ctx.createLinearGradient(0, pTop, 0, pBottom);
      fill.addColorStop(0, 'rgba(255,122,74,.5)'); fill.addColorStop(0.5, 'rgba(240,82,46,.14)'); fill.addColorStop(1, 'rgba(240,82,46,0)');
      VeloShareCard.curve(ctx, pts, pBottom); ctx.fillStyle = fill; ctx.fill();
      VeloShareCard.curve(ctx, pts); VeloShareCard.glowStroke(ctx, '#FF5A30', 5, 18, 0.6);
      const sg = ctx.createLinearGradient(0, 0, W, 0);
      sg.addColorStop(0, 'rgba(240,82,46,.15)'); sg.addColorStop(0.22, '#FF7A4A'); sg.addColorStop(0.45, '#FFC2A3'); sg.addColorStop(0.7, '#FF6A4A'); sg.addColorStop(1, 'rgba(240,82,46,.15)');
      VeloShareCard.curve(ctx, pts); ctx.strokeStyle = sg; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
      if (A.series.hr && A.avgHr) {
        const hs = VeloShareCard.centered(A.series.hr, 9), lo = Math.min(...hs) - 6, hi = Math.max(...hs) + 6;
        const hp = VeloShareCard.points(hs, 0, W, v => hrTop + hrH - (v - lo) / (hi - lo) * hrH);
        VeloShareCard.curve(ctx, hp); VeloShareCard.glowStroke(ctx, '#2FD3C2', 4, 14, 0.4);
        const hg = ctx.createLinearGradient(0, 0, W, 0);
        hg.addColorStop(0, 'rgba(20,170,158,0)'); hg.addColorStop(0.15, C.hr); hg.addColorStop(0.55, C.hrHi); hg.addColorStop(0.85, C.hr); hg.addColorStop(1, 'rgba(20,170,158,0)');
        VeloShareCard.curve(ctx, hp); ctx.strokeStyle = hg; ctx.lineWidth = 1.75; ctx.stroke();
      }
      // fade the ends into the background
      const fade = (x, dir) => { const g = ctx.createLinearGradient(x, 0, x + dir * 90, 0); g.addColorStop(0, C.bg); g.addColorStop(1, 'rgba(7,7,13,0)'); ctx.fillStyle = g; ctx.fillRect(Math.min(x, x + dir * 90), pTop - 20, 90, waveBottom - pTop + 40); };
      ctx.globalAlpha = 0.85; fade(0, 1); fade(W, -1);
      ctx.restore();
    }

    const colW = (right - pad) / 3;
    const stats = [
      [['DISTANCE'], A.distanceKm ? A.distanceKm.toFixed(1) : '--', 'km'],
      [['TIME'], VeloShareCard.fmtTime(A.durationSec), ''],
      [['NORM. POWER'], A.np ? String(Math.round(A.np)) : '--', 'W'],
      [['AVG POWER', C.pw], A.avgPower ? String(A.avgPower) : '--', 'W'],
      [['AVG HEART RATE', C.hr], A.avgHr ? String(A.avgHr) : '--', 'bpm'],
      [['CADENCE', C.cad], A.avgCadence ? String(A.avgCadence) : '--', 'rpm'],
    ];
    stats.forEach(([[k, dot], v, u], i) => {
      const x = pad + (i % 3) * colW, y = i < 3 ? row1 : row2;
      let lx = x;
      if (dot) { ctx.fillStyle = dot; ctx.beginPath(); ctx.arc(x + 3.5, y - 68.5, 3.5, 0, Math.PI * 2); ctx.fill(); lx += 16; }
      T(ctx, k, lx, y - 64, { weight: 600, size: 12.5, track: 0.24, color: C.ink3 });
      VeloShareCard.valueUnit(ctx, v, u, x, y, 64, { weight: 250, unitSize: 20 });
    });
    const load = [A.tss ? `TSS ${Math.round(A.tss)}` : '', A.if ? `IF ${A.if.toFixed(2)}` : '', A.kj ? `${Math.round(A.kj)} KJ` : ''].filter(Boolean).join('   \u00b7   ');
    T(ctx, load, pad, footY, { weight: 500, size: 14, track: 0.24, color: C.ink3 });
    T(ctx, 'APEX VELO', right, footY, { weight: 500, size: 14, track: 0.24, color: C.ink3, align: 'right' });
  }
}

if (typeof window !== 'undefined') window.VeloShareCard = VeloShareCard;
if (typeof module !== 'undefined') module.exports = VeloShareCard;
