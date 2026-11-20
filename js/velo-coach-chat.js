/**
 * APEX VELO // LAB - AI Coach chat: the pure helpers behind the one conversation (no DOM).
 *
 * The rider talks to one coach about everything: questions about their training (answered from the data
 * summary of js/velo-ask.js), a workout to ride, or a multi-week plan. What to do is ticked under the
 * message box (INTENTS); the words typed always go to the coach. This file holds the parts that need no
 * page, so they can be tested on their own:
 *
 *  - parseRequest(): lengths the rider typed ("a 60 min ride", "10 weeks", "6 hours a week", "no rides on
 *    Friday") so the options follow the message instead of contradicting it.
 *  - structure(): a workout as one short line ("10m 55%, 3x (12m 90%, 4m 55%), 5m 50%").
 *  - brief(): the recent conversation as context for a new workout or plan, so "make it shorter" or
 *    "turn that into a workout" works.
 *  - historyForApi(): the conversation as alternating rider / coach turns for /api/ask, with workouts and
 *    plans the coach built counting as its turns.
 */
(function (root) {
  const INTENTS = {
    chat: {
      label: 'Ask about my riding', short: 'Ask', icon: 'i-chat', send: 'Ask', sendShort: 'Ask',
      placeholder: 'Ask about your rides, fitness, power or recovery...', placeholderShort: 'Ask about your riding...',
      help: 'Questions, analysis and advice from your rides, power, heart rate and recovery.'
    },
    workout: {
      label: 'Create a workout', short: 'Workout', icon: 'i-bolt', send: 'Create workout', sendShort: 'Create',
      placeholder: 'Describe it, or leave it to the coach: e.g. 45 min sweet spot, legs tired', placeholderShort: 'e.g. 45 min sweet spot, or leave blank',
      help: 'One session for the trainer, built from your form and your own words.'
    },
    plan: {
      label: 'Plan my training', short: 'Plan', icon: 'i-calendar', send: 'Build plan', sendShort: 'Build',
      placeholder: 'Your goal and limits: e.g. gran fondo in 10 weeks, no rides on Friday', placeholderShort: 'e.g. 10 weeks, no rides on Friday',
      help: 'A 4-12 week plan, placed on your Calendar and checked after every ride.'
    }
  };
  const INTENT_KEYS = Object.keys(INTENTS);
  /** What a request with no words means, so every rider turn has text for the API. */
  const EMPTY_REQUEST = {
    workout: "Create today's workout from my form and history.",
    plan: 'Build my training plan.'
  };
  const DURATION_OPTIONS = [30, 45, 60, 75, 90, 120];
  const WEEK_OPTIONS = [4, 6, 8, 10, 12];
  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const DAY_RE = '(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday|rsday)?s?';
  const DAY_INDEX = { mon: 0, tue: 1, tues: 1, wed: 2, weds: 2, thu: 3, thur: 3, thurs: 3, fri: 4, sat: 5, sun: 6 };
  /** Ride days for "N rides a week" (Monday = 0), spreading the hard days out and keeping the weekend. */
  const DAY_PATTERNS = { 2: [2, 5], 3: [1, 3, 5], 4: [1, 3, 5, 6], 5: [0, 1, 3, 5, 6], 6: [0, 1, 2, 3, 5, 6], 7: [0, 1, 2, 3, 4, 5, 6] };

  const nearest = (v, list) => list.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), list[0]);
  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; };

  /** The session length the rider typed, in minutes, or null. Interval lengths ("2x20 min", "5 x 3 min") are not it. */
  function sessionMinutes(text) {
    const t = ` ${String(text || '').toLowerCase().replace(/[–—]/g, '-')} `;
    const found = [];
    const reps = /(?:\d\s*[x×*]\s*|\bsets? of\s*)$/;
    for (const m of t.matchAll(/(\d{2,3})\s?-?\s?(?:min|mins|minute|minutes)\b/g)) {
      if (reps.test(t.slice(Math.max(0, m.index - 8), m.index))) continue;
      const v = Number(m[1]);
      if (v >= 20 && v <= 240) found.push(v);
    }
    for (const m of t.matchAll(/(\d(?:[.,]\d+)?)\s?(?:h|hr|hrs|hour|hours)(?:\s?(\d{2})\b)?/g)) {
      if (reps.test(t.slice(Math.max(0, m.index - 8), m.index))) continue;
      if (/^\s*(?:a|per|each|\/)\s?week|^\s*weekly/.test(t.slice(m.index + m[0].length, m.index + m[0].length + 10))) continue;
      const v = Math.round(Number(m[1].replace(',', '.')) * 60 + (m[2] ? Number(m[2]) : 0));
      if (v >= 20 && v <= 240) found.push(v);
    }
    if (/\bhour and a half\b|\bone and a half hours?\b/.test(t)) found.push(90);
    else if (/\b(?:an|one) hour\b/.test(t)) found.push(60);
    if (/\bhalf an hour\b/.test(t)) found.push(30);
    return found.length ? Math.max(...found) : null;
  }

  /**
   * Options the rider's words imply. `current` is { days: [0-6] } for the plan. Returns, only for what was
   * found: { durationMin, durationOption } (workout) or { weeks, hoursPerWeek, days, longDay } (plan),
   * plus `said`: short labels of what was picked up ("10 weeks", "no Friday").
   */
  function parseRequest(text, intent, current = {}) {
    const t = ` ${String(text || '').toLowerCase().replace(/[–—]/g, '-')} `;
    const out = { said: [] };
    if (intent === 'workout') {
      const min = sessionMinutes(t);
      if (min) { out.durationMin = min; out.durationOption = nearest(min, DURATION_OPTIONS); out.said.push(`${min} min`); }
      return out;
    }
    if (intent !== 'plan') return out;
    const wk = t.match(/(\d{1,2})\s?-?\s?(?:week|weeks|wk|wks)\b/);
    if (wk && Number(wk[1]) >= 2 && Number(wk[1]) <= 30) {
      out.weeks = nearest(Math.min(12, Math.max(4, Number(wk[1]))), WEEK_OPTIONS);
      out.said.push(`${out.weeks} weeks`);
    }
    const hrs = t.match(/(\d{1,2}(?:[.,]\d)?)\s?(?:h|hr|hrs|hour|hours)\s?(?:a|per|each|\/|of riding a|of training a)\s?week|(\d{1,2}(?:[.,]\d)?)\s?(?:h|hr|hrs|hours)\s?weekly/);
    if (hrs) {
      const v = Number((hrs[1] || hrs[2]).replace(',', '.'));
      if (v >= 2 && v <= 25) { out.hoursPerWeek = v; out.said.push(`${v} h a week`); }
    }
    let days = Array.isArray(current.days) ? current.days.slice() : null;
    const count = t.match(/(\d|two|three|four|five|six|seven)\s?(?:days?|rides?|sessions?|times?)\s?(?:a|per|each|\/)\s?week/);
    if (count) {
      const n = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 }[count[1]] || Number(count[1]);
      if (DAY_PATTERNS[n] && (!days || days.length !== n)) days = DAY_PATTERNS[n].slice();
      if (DAY_PATTERNS[n]) out.said.push(`${n} days a week`);
    }
    const excluded = new Set();
    const chain = new RegExp(`^\\s*(?:,|or|and|&|nor)\\s+(?:on\\s+)?${DAY_RE}\\b`);
    for (const m of t.matchAll(new RegExp(`\\b(?:no|not|never|except|can't|cannot|can not|without|off on)\\s+(?:[a-z']+\\s+){0,3}?(?:on\\s+)?${DAY_RE}\\b`, 'g'))) {
      excluded.add(DAY_INDEX[m[1]]);
      // "no rides on Monday or Wednesday", "except Tuesday, Thursday and Friday"
      let rest = t.slice(m.index + m[0].length), next;
      while ((next = rest.match(chain))) { excluded.add(DAY_INDEX[next[1]]); rest = rest.slice(next[0].length); }
    }
    for (const m of t.matchAll(new RegExp(`\\b${DAY_RE}\\s+(?:off|is off|are off|out)\\b`, 'g'))) excluded.add(DAY_INDEX[m[1]]);
    const long = t.match(new RegExp(`\\blong (?:ride|rides|one)s?\\s+(?:on\\s+)?(?:a\\s+)?${DAY_RE}\\b|${DAY_RE}\\s+long (?:ride|rides)\\b`));
    if (long) {
      out.longDay = DAY_INDEX[long[1] || long[2]];
      if (days && !days.includes(out.longDay)) days.push(out.longDay);
      out.said.push(`long ride ${DAY_NAMES[out.longDay]}`);
    }
    if (excluded.size && days) {
      days = days.filter(d => !excluded.has(d));
      out.said.push(`no ${[...excluded].sort().map(d => DAY_NAMES[d]).join(' or ')}`);
      if (out.longDay !== undefined && excluded.has(out.longDay)) delete out.longDay;
    }
    if (days && (count || excluded.size || long)) {
      const next = [...new Set(days)].sort((a, b) => a - b);
      const before = Array.isArray(current.days) ? [...current.days].sort((a, b) => a - b) : null;
      if (!before || next.join() !== before.join()) out.days = next;
    }
    return out;
  }

  function stepText(iv) {
    const s = Math.round(Number(iv.duration) || 0);
    const d = s >= 60 ? (s % 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s / 60}m`) : `${s}s`;
    return `${d} ${Math.round(Number(iv.pctFtp) || 0)}%`;
  }

  /** A workout's steps as one line: repeats folded ("3x (12m 90%, 4m 55%)"), at most `max` characters. */
  function structure(intervals, max = 420) {
    const steps = (Array.isArray(intervals) ? intervals : []).map(stepText);
    const out = [];
    for (let i = 0; i < steps.length;) {
      let best = null;
      for (let len = 1; len <= 3; len++) {
        const unit = steps.slice(i, i + len).join('|');
        let reps = 1;
        while (i + (reps + 1) * len <= steps.length && steps.slice(i + reps * len, i + (reps + 1) * len).join('|') === unit) reps++;
        if (reps > 1 && (!best || reps * len > best.reps * best.len)) best = { len, reps };
      }
      if (best) {
        const unit = steps.slice(i, i + best.len);
        out.push(`${best.reps}x ${best.len > 1 ? `(${unit.join(', ')})` : unit[0]}`);
        i += best.reps * best.len;
      } else out.push(steps[i++]);
    }
    return clip(out.join(', '), max);
  }

  /** A workout card as text the AI can read back ("Workout "Sweet Spot 3x12" (60 min, TSS 72): ..."). */
  function workoutText(m, { advice = true } = {}) {
    const w = (m && m.workout) || {};
    const a = (m && m.assessment) || {};
    return `Workout "${w.title || 'Workout'}" (${w.durationMin || '?'} min, TSS ${w.tss ?? '?'}, IF ${w.if ?? '?'}): ${structure(w.intervals)}.`
      + (w.desc ? ` ${clip(w.desc, 240)}` : '')
      + (advice && a.trainingAdvice ? ` Coach's advice: ${clip(a.trainingAdvice, 360)}` : '');
  }

  /** A plan card as text the AI can read back. */
  function planText(m) {
    const p = (m && m.plan) || {};
    const weeks = Array.isArray(p.weeks) ? p.weeks.map(w => `W${w.index} ${w.type}${w.phase ? ` (${w.phase})` : ''}`).join(', ') : '';
    return `Training plan "${p.title || 'Plan'}": ${p.weekCount || (p.weeks || []).length} weeks, ${p.startDate || '?'} to ${p.endDate || '?'}${p.hours ? `, ${p.hours}` : ''}.`
      + (weeks ? ` Weeks: ${clip(weeks, 300)}.` : '') + (p.summary ? ` ${clip(p.summary, 400)}` : '');
  }

  /**
   * The recent conversation as plain lines for a workout or plan request. `focus` is the index of a message
   * that must be kept at length (a "turn this into a workout" on an answer). Oldest lines go first when it is long.
   */
  function brief(messages, { maxChars = 2200, focus = -1 } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const lines = [];
    list.forEach((m, i) => {
      if (!m) return;
      const long = i === focus;
      if (m.role === 'user') lines.push(`Rider: ${clip(String(m.content || '').trim() || EMPTY_REQUEST[m.intent] || '', 300)}`);
      else if (m.role === 'assistant') lines.push(`Coach: ${clip(m.content, long ? 2400 : 500)}`);
      else if (m.role === 'workout') lines.push(`Coach built: ${workoutText(m, { advice: long })}`);
      else if (m.role === 'plan') lines.push(`Coach built: ${planText(m)}`);
    });
    const kept = lines.filter(l => !/^Rider: $/.test(l)).slice(-8);
    while (kept.length > 1 && kept.join('\n').length > maxChars) kept.shift();
    const text = kept.join('\n');
    return text.length > maxChars + 400 ? `${text.slice(0, maxChars + 399)}…` : text;
  }

  /** What the coach gets as the rider's words for a workout or plan: the request, then the chat so far. */
  function requestNotes(text, earlier) {
    const req = String(text || '').trim();
    return earlier ? `${req}\n\nEARLIER IN THIS CHAT (context only - build what the rider asks for above):\n${earlier}` : req;
  }

  /**
   * Alternating user / assistant turns for /api/ask (the last `max`, starting with the rider). Workouts and
   * plans built in the chat are coach turns; notes and errors are left out; turns in a row are joined.
   */
  function historyForApi(messages, max = 20, maxChars = 20000) {
    const out = [];
    for (const m of Array.isArray(messages) ? messages : []) {
      if (!m) continue;
      let role = null, content = '';
      if (m.role === 'user') { role = 'user'; content = String(m.content || '').trim() || EMPTY_REQUEST[m.intent] || ''; }
      else if (m.role === 'assistant') { role = 'assistant'; content = String(m.content || '').trim(); }
      else if (m.role === 'workout') { role = 'assistant'; content = `[Built in this chat] ${workoutText(m)}`; }
      else if (m.role === 'plan') { role = 'assistant'; content = `[Built in this chat] ${planText(m)}`; }
      if (!role || !content) continue;
      const last = out[out.length - 1];
      if (last && last.role === role) last.content = `${last.content}\n\n${content}`;
      else out.push({ role, content });
    }
    let list = out.slice(-max).map(m => ({ role: m.role, content: m.content.length > maxChars ? m.content.slice(-maxChars) : m.content }));
    while (list.length && list[0].role !== 'user') list = list.slice(1);
    return list;
  }

  /** True when an answer reads like a session that could be built ("4 x 8 min at 105% FTP"). */
  function looksLikeSession(text) {
    const t = String(text || '');
    return /\d\s?[x×]\s?\d|\d\s?(?:min|minutes)\b[^.\n]{0,40}(?:%|ftp|watts|\bw\b|zone|z[1-7])|%\s?(?:of\s)?ftp|\bz[2-6]\b[^.\n]{0,30}\d+\s?min/i.test(t);
  }

  const api = { INTENTS, INTENT_KEYS, EMPTY_REQUEST, DURATION_OPTIONS, WEEK_OPTIONS, DAY_NAMES, parseRequest, sessionMinutes, structure, workoutText, planText, brief, requestNotes, historyForApi, looksLikeSession };
  root.VeloCoachChat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
