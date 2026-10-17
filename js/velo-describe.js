/**
 * APEX VELO // LAB - "Describe a workout": the AI builds exactly the session the rider asks for.
 *
 * Unlike the AI Coach, nothing about the rider's history, fitness or fatigue is sent: only the request
 * and the FTP (so "2x20 at 250 W" can become % FTP). The answer goes through the same /api/coach route
 * as the coach (desktop server or the Android app), and is checked and scored here before it is shown.
 */
(function (root) {
  const CATEGORIES = ['endurance', 'sweetspot', 'threshold', 'vo2', 'custom'];
  const MAX_REQUEST = 1000;

  function buildPrompt(request, ftp) {
    const watts = Number(ftp) > 0 ? `The rider's FTP is ${Math.round(ftp)} W: convert any watt targets to % of FTP.` : 'Targets are given as % of FTP.';
    return `DIRECT WORKOUT REQUEST. Build exactly the indoor ERG workout the rider describes below. This is not a coaching request:
do not analyse training history, fitness or fatigue, and do not change what was asked for. Where the request leaves something open,
choose sensible values (a 45-60 minute session, a 10 minute warmup and a 5 minute cooldown unless the request says otherwise).
${watts}

RIDER'S REQUEST:
"""
${String(request).slice(0, MAX_REQUEST)}
"""

RULES: targets as % of FTP (pctFtp, 30-250); durations in seconds; include a warmup and cooldown unless the rider says not to;
give each step a short name and a cadence target in rpm when it matters (low-cadence, high-cadence or sprint work);
write each repetition as its own step. The title is short and descriptive; desc is one or two plain sentences describing the session.

Return ONLY JSON matching:
{ "title": "...", "category": "endurance" | "sweetspot" | "threshold" | "vo2", "desc": "...",
  "intervals": [ { "name": "Warmup", "duration": 600, "pctFtp": 55, "cadence": 90 } ] }`;
  }

  function extractJson(text) {
    const raw = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(raw); } catch (e) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('the answer did not contain a workout');
      return JSON.parse(m[0]);
    }
  }

  /** The AI's answer as a library workout, or throws with a reason. `estimateLoad` is VeloAiCoach.estimateLoad. */
  function toWorkout(text, estimateLoad, now = Date.now()) {
    const parsed = extractJson(text);
    const w = parsed && (parsed.workout || parsed);
    const list = Array.isArray(w && w.intervals) ? w.intervals : [];
    const intervals = list.map(iv => {
      const step = {
        name: String((iv && iv.name) || 'Step').slice(0, 60),
        duration: Math.max(5, Math.min(4 * 3600, Math.round(Number(iv && iv.duration) || 0))),
        pctFtp: Math.max(30, Math.min(250, Math.round(Number(iv && iv.pctFtp) || 0)))
      };
      const cadence = Math.round(Number(iv && iv.cadence) || 0);
      if (cadence >= 40 && cadence <= 140) step.cadence = cadence;
      return step;
    }).filter(iv => iv.duration > 0 && iv.pctFtp > 0);
    if (!intervals.length) throw new Error('the answer did not contain any workout steps');
    const total = intervals.reduce((a, iv) => a + iv.duration, 0);
    if (total > 6 * 3600) throw new Error('the workout came back longer than 6 hours');
    const load = estimateLoad(intervals);
    return {
      id: 'ai_req_' + now,
      category: CATEGORIES.includes(w.category) ? w.category : 'custom',
      title: String(w.title || 'Your workout').slice(0, 80),
      desc: String(w.desc || '').slice(0, 400),
      durationMin: load.durationMin,
      tss: load.tss,
      if: load.if,
      intervals,
      fromRequest: true
    };
  }

  const api = { buildPrompt, toWorkout, MAX_REQUEST };
  root.VeloDescribe = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
