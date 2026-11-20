/**
 * APEX VELO // LAB - Post-ride insight UI (mixin on VeloApp).
 *
 * Ride review: PR medals (gold all-time / silver this year / bronze 90 days), aerobic decoupling,
 * and - only when a ride proves it - a suggestion to raise FTP with a one-click update.
 * History: medal chips on each ride. The maths lives in VeloInsight (js/velo-insight.js).
 */
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DISMISS_KEY = 'apex_ftp_suggest_dismissed';
  const FRESH_DAYS = 21; // an FTP suggestion is only offered from recent rides
  const ARCHIVE_INDEX = [0, 3, 5, 7, 8]; // MEDAL_DURATIONS -> VeloMetrics.MMP_DURATIONS

  Object.assign(VeloApp.prototype, {
    /** Best powers for the medal durations, from the ride's cached power curve (js/app-power.js). */
    ridePeaks(r) {
      return this.rideMedalPeaks(r);
    },

    medalHistory() {
      return this.cyclingRides().filter(VeloRideSummary.has).map(r => ({ id: r.id, date: r.date, peaks: this.ridePeaks(r) }));
    },

    medalArchive() {
      const a = (typeof APEX_LOCAL_HISTORY !== 'undefined' && APEX_LOCAL_HISTORY && APEX_LOCAL_HISTORY.allTimeMmp && Array.isArray(APEX_LOCAL_HISTORY.allTimeMmp.watts))
        ? APEX_LOCAL_HISTORY.allTimeMmp.watts : null;
      return a ? ARCHIVE_INDEX.map(i => Number(a[i]) || 0) : null;
    },

    rideMedals(r, history = null) {
      const peaks = this.ridePeaks(r);
      if (!peaks || !VeloMetrics.isCycling(r)) return [];
      return VeloInsight.medals({ id: r.id, date: r.date, peaks }, history || this.medalHistory(), this.medalArchive());
    },

    medalChips(medals, date, compact = false) {
      if (!medals.length) return '';
      const year = new Date(date).getFullYear();
      return medals.map(m => `<span class="chip chip-xs medal medal-${m.medal}" title="${esc(VeloInsight.medalTitle(m, year))}">${compact ? '' : '<i class="medal-dot"></i>'}${esc(m.label)}${compact ? '' : ` ${m.watts} W`}</span>`).join('');
    },

    // -------------------------------------------------------------- FTP --
    ftpEvidenceOf(r) {
      if (!VeloRideSummary.has(r) || !VeloMetrics.isCycling(r)) return null;
      const p = this.activeProfile || {};
      this._ftpEvCache = this._ftpEvCache || new Map();
      const key = `${r.id}|${VeloRideSummary.count(r)}|${r.rampTest ? 1 : 0}|${p.maxHr || 0}|${p.lthr || 0}`;
      if (!this._ftpEvCache.has(key)) {
        const s = !VeloInsight.hasSamples(r) && VeloRideSummary.get(r);
        this._ftpEvCache.set(key, r.rampTest
          ? (s ? VeloInsight.rampEvidenceFor(s.ramp, { maxHr: p.maxHr }) : VeloInsight.rampEvidence(r.samples, { maxHr: p.maxHr }))
          : (s ? VeloInsight.ftpEvidenceFor(s.ftp, { maxHr: p.maxHr, lthr: p.lthr }) : VeloInsight.ftpEvidence(r.samples, { maxHr: p.maxHr, lthr: p.lthr })));
      }
      return this._ftpEvCache.get(key);
    },

    /** Latest FTP implied by each method (20 min, 60 min, ramp test, CP model) and the most recent of them. */
    renderFtpMethods() {
      const body = document.getElementById('ftpMethodsBody');
      if (!body) return;
      const found = {};
      [...this.cyclingRides()].filter(r => r.date).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).forEach(r => {
        const ev = this.ftpEvidenceOf(r);
        if (!ev) return;
        [['ramp', ev.ramp], ['m20', ev.from20], ['m60', ev.from60]].forEach(([k, v]) => { if (v > 0 && !found[k]) found[k] = { watts: v, t: Date.parse(r.date) }; });
      });
      const cp = this._cpModelForFtp;
      const rows = [
        { k: 'ramp', label: 'Ramp test (best minute x 0.75)' },
        { k: 'm20', label: '20 min best x 0.95' },
        { k: 'm60', label: '60 min best' }
      ].map(x => ({ ...x, ...(found[x.k] || {}) }));
      if (cp) rows.push({ k: 'cp', label: 'CP model (FTP is about 95-100% of CP)', watts: Math.round(cp.cp * 0.975), t: cp.to });
      const dated = rows.filter(x => x.watts > 0 && Number.isFinite(x.t)).sort((a, b) => b.t - a.t);
      // The CP model's date is the end of its 90-day window, so it only leads when no ride implied an FTP.
      const latest = dated.find(x => x.k !== 'cp') || dated[0];
      const ftp = Number(this.activeProfile.ftp) || 0;
      const day = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
      this.setText('ftpImpliedChip', latest ? `${latest.watts} W` : '--');
      body.innerHTML = (latest ? `<div class="cp-row"><span><b>Most recent implied FTP</b> <small>${esc(latest.label)} &middot; ${day(latest.t)}</small></span><b class="num">${latest.watts} W${ftp ? ` <small>(${latest.watts >= ftp ? '+' : ''}${latest.watts - ftp} vs ${ftp})</small>` : ''}</b></div>` : '')
        + rows.map(x => `<div class="cp-row"><span>${esc(x.label)}${x.t ? ` <small>${day(x.t)}</small>` : ''}</span><b class="num">${x.watts > 0 ? x.watts + ' W' : '--'}</b></div>`).join('');
    },

    dismissedFtp() {
      try { return (JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}') || {})[this.activeProfileId || 'default'] || 0; } catch (e) { return 0; }
    },

    /** A higher-FTP suggestion from this ride (and, if needed, a confirming ride), or null. */
    ftpSuggestionFor(record) {
      if (!record || !VeloRideSummary.has(record) || Date.now() - Date.parse(record.date) > FRESH_DAYS * VeloInsight.DAY) return null;
      const t = Date.parse(record.date);
      const rides = this.cyclingRides().filter(r => VeloRideSummary.has(r) && Date.parse(r.date) <= t && t - Date.parse(r.date) <= FRESH_DAYS * VeloInsight.DAY)
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
      const list = rides.filter(r => r.id !== record.id).concat([record]).map(r => ({ id: r.id, date: r.date, evidence: this.ftpEvidenceOf(r) }));
      return VeloInsight.ftpSuggestion(list, this.activeProfile.ftp, { dismissed: this.dismissedFtp() });
    },

    /** Remembers FTP changes on the profile (shown on the FTP history chart; kept in backups). */
    logFtpChange(from, to, source) {
      const p = this.activeProfile;
      if (!p || !(Number(to) > 0) || Number(from) === Number(to)) return;
      p.ftpHistory = [...(Array.isArray(p.ftpHistory) ? p.ftpHistory : []), { date: new Date().toISOString(), ftp: Number(to), from: Number(from) || null, source }].slice(-100);
    },

    acceptFtpSuggestion(value) {
      const v = Math.round(Number(value));
      if (!(v >= 50)) return;
      const from = this.activeProfile.ftp;
      this.activeProfile.ftp = v;
      this.logFtpChange(from, v, 'ride suggestion');
      this.applyProfileChange();
      this.showToast(`FTP updated ${from} -> ${v} W. Zones and ERG targets now use ${v} W.`, 'success');
      document.getElementById('ftpSuggestBanner')?.remove();
    },

    dismissFtpSuggestion(value) {
      try {
        const all = JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}') || {};
        all[this.activeProfileId || 'default'] = Math.max(Number(all[this.activeProfileId || 'default']) || 0, Math.round(Number(value)) || 0);
        localStorage.setItem(DISMISS_KEY, JSON.stringify(all));
      } catch (e) { /* ignore */ }
      document.getElementById('ftpSuggestBanner')?.remove();
      this.showToast('OK - FTP stays as it is. You will only be asked again for a higher value.', 'info');
    },

    // ----------------------------------------------------------- review --
    /** Insight block for the ride review (medals, decoupling, FTP suggestion). */
    rideInsightHtml(record) {
      if (!VeloMetrics.isCycling(record) || !VeloInsight.hasSamples(record)) return '';
      const medals = this.rideMedals(record);
      const dec = this.rideDecoupling(record);
      const sug = this.ftpSuggestionFor(record);
      const decHtml = dec.status === 'ok'
        ? `<span class="chip decoupling decoupling-${dec.level} decoupling-${dec.tier}" title="Power per heartbeat, first vs second half of ${dec.minutes} min after the warm-up. 3.5% or less = base consolidated, under 5% = coupled, 5-8% = mild drift, over 8% = decoupled.">Heart-rate drift (Pw:HR) ${dec.pct}% &middot; ${esc(dec.label)}</span>`
        : dec.status === 'not-steady' ? '<span class="chip chip-ghost" title="Decoupling is measured on steady rides (Z2, tempo, sweet spot)">Heart-rate drift (Pw:HR): not a steady ride - not measured</span>'
          : '';
      const ftpHtml = sug ? `
        <div class="ftp-suggest" id="ftpSuggestBanner" role="status">
          <div class="fs-main">
            <svg class="ic ic-lg"><use href="#i-trophy"/></svg>
            <div>
              <div class="fs-title">Your FTP looks higher: <b class="num">${sug.ftp} W</b> <span class="delta up num">+${sug.gain} W</span></div>
              <div class="fs-sub">${esc(sug.method)}${sug.p20 ? ` (best 20 min ${sug.p20} W)` : ''}${sug.hrPct ? `, heart rate ${sug.hrPct}% of max` : ''} - ${esc(sug.basis)}.</div>
            </div>
          </div>
          <div class="btn-row btn-row-tight">
            <button type="button" class="btn btn-start" data-ftp="accept" data-value="${sug.ftp}">Update FTP to ${sug.ftp} W</button>
            <button type="button" class="btn btn-ghost" data-ftp="dismiss" data-value="${sug.ftp}">Not now</button>
          </div>
        </div>` : '';
      if (!medals.length && !decHtml && !ftpHtml) return '';
      return `${ftpHtml}
        <div class="review-block ride-insight">
          <div class="sub-title"><span>Highlights</span><span class="hint">gold = all-time best &middot; silver = best this year &middot; bronze = best in 90 days</span></div>
          <div class="btn-row btn-row-tight insight-chips">${medals.length ? this.medalChips(medals, record.date) : '<span class="hint">No new power bests on this ride.</span>'}${decHtml}</div>
        </div>`;
    },

    // ------------------------------------------------------ drift trend --
    /**
     * Decoupling of every steady ride with heart rate, oldest first. Cached per ride. A ride whose date
     * cannot be read is left out (it would otherwise scramble the order); limit keeps the latest ones.
     */
    driftTrendData(limit = 400) {
      const pts = [];
      this.cyclingRides().filter(VeloRideSummary.has).map(r => ({ r, t: Date.parse(r.date) })).filter(e => Number.isFinite(e.t))
        .sort((a, b) => a.t - b.t).forEach(({ r, t }) => {
        const d = this.rideDecoupling(r);
        if (d.status === 'ok') pts.push({ id: r.id, t, date: r.date, title: r.title, pct: d.pct, level: d.level, minutes: d.minutes, np: r.np || r.avgWatts || null });
        });
      return pts.slice(-limit);
    },

    initDriftChart() {
      const cv = document.getElementById('driftTrendCanvas');
      if (!cv || typeof Chart === 'undefined') return;
      const color = { good: '#3ddc97', mild: '#ffae3d', high: '#ff5c86' };
      const ink = getComputedStyle(document.documentElement).getPropertyValue('--text-2').trim() || '#94a3b8';
      const grid = 'rgba(148,163,184,0.12)';
      this.driftChart = new Chart(cv.getContext('2d'), {
        type: 'line',
        data: { datasets: [
          { label: 'Pw:HR drift %', data: [], borderColor: 'rgba(148,163,184,0.5)', borderWidth: 1.5, tension: 0.25, pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: [], pointBorderColor: [] },
          { label: '5% (coupled below)', data: [], borderColor: 'rgba(101,163,13,0.7)', borderDash: [6, 5], borderWidth: 1, pointRadius: 0 }
        ] },
        options: {
          responsive: true, maintainAspectRatio: false,
          onClick: (e, els) => { const el = els && els[0]; if (el && el.datasetIndex === 0 && this._driftPts && this._driftPts[el.index]) this.showRideSummaryById(this._driftPts[el.index].id); },
          scales: {
            // A time axis: rides sit at their dates, so gaps between them are real gaps.
            x: { type: 'linear', ticks: { color: ink, maxRotation: 0, maxTicksLimit: 8, callback: (v) => new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) }, grid: { display: false } },
            y: { suggestedMin: 0, suggestedMax: 10, ticks: { color: ink, callback: (v) => `${v}%` }, grid: { color: grid } }
          },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              title: (items) => { const p = this._driftPts && this._driftPts[items[0].dataIndex]; return p ? `${p.title} - ${new Date(p.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}` : ''; },
              label: (c) => { if (c.datasetIndex !== 0) return ' 5% line'; const p = this._driftPts[c.dataIndex]; return ` Drift ${p.pct}% over ${p.minutes} min${p.np ? ` at ${p.np} W` : ''} - click to open`; }
            } }
          }
        }
      });
      this._driftColor = color;
      this.updateDriftChart();
    },

    updateDriftChart() {
      if (!this.driftChart) return;
      // The page range applies here as on the other time charts.
      const now = Date.now(), start = this.anaRangeStart ? this.anaRangeStart(now) : now - 182 * 86400000;
      const pts = this.driftTrendData().filter(p => p.t >= start && p.t <= now);
      this._driftPts = pts;
      const ds = this.driftChart.data.datasets;
      ds[0].data = pts.map(p => ({ x: p.t, y: p.pct }));
      ds[0].pointBackgroundColor = pts.map(p => this._driftColor[p.level]);
      ds[0].pointBorderColor = pts.map(p => this._driftColor[p.level]);
      ds[1].data = [{ x: start, y: 5 }, { x: now, y: 5 }];
      this.driftChart.options.scales.x.min = start;
      this.driftChart.options.scales.x.max = now;
      this.driftChart.update();
      const label = document.getElementById('driftTrendLabel');
      if (label) {
        if (!pts.length) label.textContent = 'no steady rides with HR yet';
        else {
          const recent = pts.slice(-5), avg = recent.reduce((a, p) => a + p.pct, 0) / recent.length;
          label.textContent = `last ${recent.length}: avg ${avg.toFixed(1)}%`;
        }
      }
    },

    // ---------------------------------------------------- coach context --
    /**
     * What the recorded rides say, for the AI coach: the last hard session's interval diagnosis
     * (and its saved AI breakdown), the Pw:HR drift of recent steady rides, new PR medals and a
     * pending FTP suggestion. Returns { lines: [...], ... } - lines are ready for the prompt.
     */
    coachInsight(lookbackDays = 28, now = new Date()) {
      const within = (r, days) => now - new Date(r.date) <= days * VeloInsight.DAY && now >= new Date(r.date);
      const rides = this.cyclingRides().filter(r => VeloRideSummary.has(r) && within(r, lookbackDays))
        .sort((a, b) => new Date(b.date) - new Date(a.date));
      const out = { lines: [], lastHard: null, drift: [], medals: [], ftp: null };
      if (!rides.length) return out;
      const day = (r) => VeloMetrics.localDateKey(r.date);

      // Last hard session (at least one step at 88% FTP or more)
      for (const r of rides) {
        const rows = this.rideIntervalRows(r, r.ftpAtRide || this.activeProfile.ftp);
        if (!rows.some(x => x.work)) continue;
        const diag = VeloInsight.offlineBreakdown(rows).slice(0, 4);
        out.lastHard = { id: r.id, date: day(r), title: r.title, diag, ai: r.aiBreakdown && r.aiBreakdown.text ? r.aiBreakdown.text.replace(/\s+/g, ' ').slice(0, 320) : null };
        out.lines.push(`Last hard session ${day(r)} "${r.title}": ${diag.join(' ')}`);
        if (out.lastHard.ai) out.lines.push(`Coach notes on it: ${out.lastHard.ai}`);
        break;
      }

      // Aerobic decoupling of steady rides (newest first, up to 5)
      for (const r of rides) {
        const d = this.rideDecoupling(r);
        if (d.status === 'ok') out.drift.push({ date: day(r), pct: d.pct, label: d.label });
        if (out.drift.length >= 5) break;
      }
      if (out.drift.length) {
        const avg = Math.round(out.drift.reduce((a, d) => a + d.pct, 0) / out.drift.length * 10) / 10;
        out.lines.push(`Pw:HR drift on steady rides (newest first): ${out.drift.map(d => `${d.date} ${d.pct}%`).join(', ')} - average ${avg}% (under 5% = aerobically coupled).`);
      }

      // New PR medals in the last 14 days: real improvements (an earlier best existed) for 5 min and
      // longer - short ERG peaks only mirror the targets, and a new history's first rides are "bests" anyway.
      const hist = this.medalHistory();
      rides.filter(r => within(r, 14)).forEach(r => {
        this.rideMedals(r, hist).filter(m => m.medal !== 'bronze' && m.prev && m.i >= 2).forEach(m => out.medals.push({ date: day(r), ...m }));
      });
      if (out.medals.length) {
        out.lines.push(`New power bests (14 days): ${out.medals.slice(0, 4).map(m => `${m.date} ${m.label} ${m.watts} W (${m.medal === 'gold' ? 'all-time best' : 'best this year'}, was ${m.prev} W)`).join('; ')}.`);
      }

      // FTP suggestion not applied yet
      const sug = this.ftpSuggestionFor(rides[0]);
      if (sug) {
        out.ftp = sug;
        out.lines.push(`Recent power suggests FTP about ${sug.ftp} W (profile still ${sug.from} W, ${sug.basis}) - targets are still based on ${sug.from} W.`);
      }
      return out;
    },

    // ------------------------------------------------- interval diagnosis --
    /** Offline breakdown of the hard steps (when there are any) and the ride coach chat (any ride with samples). */
    intervalBreakdownHtml(record) {
      if (!VeloInsight.hasSamples(record)) return '';
      const ftp = record.ftpAtRide || this.activeProfile.ftp;
      const rows = VeloInsight.intervalRows(record.samples, ftp);
      const diag = rows.length >= 2 && rows.some(r => r.work)
        ? `<div class="sub-title"><span>Interval diagnosis</span><span class="hint">hard steps (88% FTP+): target, cadence fade, heart-rate drift</span></div>
          <ul class="diag-list">${VeloInsight.offlineBreakdown(rows).map(l => `<li>${esc(l)}</li>`).join('')}</ul>`
        : '';
      return `
        <div class="review-block interval-diagnosis" id="intervalDiagnosis">
          ${diag}
          <div class="ride-coach" id="aiBreakdownArea">${this.rideCoachHtml(record)}</div>
        </div>`;
    },

    /** The ride coach: ask anything about this ride; answers come from its full recording (VeloRideBrief). */
    rideCoachHtml(record) {
      const coach = this.aiCoach;
      const live = !!(coach && coach.isLive);
      const md = (t) => (window.VeloMarkdown ? window.VeloMarkdown.render(t) : `<p>${esc(t)}</p>`);
      const chat = Array.isArray(record.rideChat) ? record.rideChat : [];
      const old = record.aiBreakdown && record.aiBreakdown.text && !chat.length
        ? [{ role: 'assistant', content: VeloRideBrief.cleanAiText(record.aiBreakdown.text), meta: record.aiBreakdown.label || record.aiBreakdown.model || '' }] : [];
      const msgs = old.concat(chat);
      const busy = this._rideAskBusy === record.id;
      const thread = msgs.map((m, i) => {
        if (m.role === 'error') return `<div class="ask-msg ask-error" role="alert"><div class="ask-bubble">${esc(m.content)}</div></div>`;
        if (m.role === 'user') return `<div class="ask-msg ask-user"><div class="ask-bubble">${esc(m.label || m.content).replace(/\n/g, '<br>')}</div></div>`;
        return `<div class="ask-msg ask-ai"><div class="ask-avatar" aria-hidden="true"><svg class="ic"><use href="#i-sparkles"/></svg></div>
          <div class="ask-body"><div class="ask-bubble md">${md(VeloRideBrief.cleanAiText(m.content))}</div>${m.meta ? `<div class="ask-meta"><span>${esc(m.meta)}</span></div>` : ''}</div></div>`;
      }).join('') + (busy ? `<div class="ask-msg ask-ai pending"><div class="ask-avatar" aria-hidden="true"><svg class="ic"><use href="#i-sparkles"/></svg></div>
          <div class="ask-body"><div class="ask-bubble"><span class="ask-dots" aria-hidden="true"><i></i><i></i><i></i></span> Reading this ride's data</div></div></div>` : '');
      const asked = new Set(chat.filter(m => m.role === 'user').map(m => m.label || m.content));
      const chips = [VeloRideBrief.REVIEW_LABEL, ...VeloRideBrief.SUGGESTIONS].filter(q => !asked.has(q)).slice(0, msgs.length ? 4 : 7);
      return `<div class="sub-title"><span>Ask the coach about this ride</span><span class="hint">${live ? `${esc(VeloAiCoach.labelFor(coach.model))} reads the whole recording: every step, heart rate, cadence and your earlier rides of this workout` : 'Add an Anthropic, Gemini or OpenAI key to .env for an AI coach breakdown - the summary above is computed offline.'}</span></div>
        ${thread ? `<div class="ride-coach-thread" aria-live="polite">${thread}</div>` : ''}
        ${busy ? '' : `<div class="ride-coach-chips" role="list">${chips.map(q => `<button type="button" class="ask-chip" role="listitem" data-ride-ask="${esc(record.id)}" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`}
        <form class="ride-coach-form" data-ride-form="${esc(record.id)}">
          <textarea class="input-field ride-coach-input" rows="2" maxlength="4000" placeholder="Ask anything about this ride, e.g. why did my heart rate climb in set 2?" aria-label="Your question about this ride" ${busy ? 'disabled' : ''}></textarea>
          <div class="ride-coach-actions">
            ${chat.length ? `<button type="button" class="link-btn" data-ride-clear="${esc(record.id)}">Clear chat</button>` : '<span></span>'}
            <button type="submit" class="btn btn-sm btn-ai" ${busy ? 'disabled' : ''}><svg class="ic"><use href="#i-sparkles"/></svg>Ask</button>
          </div>
        </form>`;
    },

    /** What VeloRideBrief.build() needs besides the ride: profile, form, earlier rides of the workout, recent rides. */
    rideBriefOpts(record) {
      const p = this.activeProfile || {};
      const t = Date.parse(record.date);
      const ftp = record.ftpAtRide || p.ftp;
      const rides = (this.cyclingRides ? this.cyclingRides() : this.completedWorkouts).filter(r => r.id !== record.id && Date.parse(r.date) < t);
      const same = (r) => (record.workoutId && r.workoutId === record.workoutId) || (record.title && r.title === record.title);
      const previous = rides.filter(same).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 6).map(r => {
        let workP = null, workHr = null;
        if (VeloInsight.hasSamples(r)) {
          const w = VeloRideBrief.steps(r.samples, r.ftpAtRide || ftp).filter(s => s.work);
          if (w.length) {
            workP = Math.round(VeloRideBrief.mean(w.map(s => s.settledP)));
            const h = VeloRideBrief.mean(w.map(s => (s.hrStart && s.hrEnd ? (s.hrStart + s.hrEnd) / 2 : 0)));
            workHr = h ? Math.round(h) : null;
          }
        }
        return { date: r.date, duration: r.duration, np: r.np, avgWatts: r.avgWatts, avgHr: r.avgHr, maxHr: r.maxHr, if: r.if, tss: r.tss, workP, workHr };
      });
      const recent = rides.filter(r => !same(r) && t - Date.parse(r.date) <= 14 * 86400000).sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
        .map(r => ({ date: r.date, title: r.title, duration: r.duration, tss: r.tss, np: r.np }));
      let form = null;
      try {
        const pmc = this.analytics.calculatePmcHistory(this.completedWorkouts, 0, this.pmcOpts ? this.pmcOpts() : undefined);
        if (pmc && Number.isFinite(pmc.currentCtl)) form = { ctl: pmc.currentCtl, atl: pmc.currentAtl, tsb: pmc.currentTsb };
      } catch (e) { /* no form line */ }
      const restHr = (this.healthDays || []).slice(-7).map(d => Number(d && (d.restingHr || d.rhr)) || 0).filter(Boolean);
      return { ftp, maxHr: p.maxHr, weightKg: p.weightKg, restHr: restHr.length ? Math.round(restHr.reduce((a, b) => a + b, 0) / restHr.length) : null, form, previous, recent };
    },

    /** Kept for older callers: asks for the ride review. */
    requestAiBreakdown(rideId) { return this.sendRideAsk(rideId, VeloRideBrief.REVIEW_PROMPT, VeloRideBrief.REVIEW_LABEL); },

    /** Sends the rider's question with this ride's brief to /api/ask and keeps the chat on the ride. */
    async sendRideAsk(rideId, text, label = null) {
      const record = this.completedWorkouts.find(r => r.id === rideId);
      const q = String(text || '').trim();
      if (!record || !q || this._rideAskBusy) return null;
      const coach = this.aiCoach;
      if (coach && !coach.isLive) await coach.detectEngine();
      if (!coach || !coach.isLive) { this.showToast('The AI coach is offline - add an API key for Claude, Gemini or ChatGPT.', 'warning'); return null; }
      if (!VeloInsight.hasSamples(record)) { this.showToast('This ride has no recorded data to ask about.', 'warning'); return null; }
      let context = '';
      try { context = VeloRideBrief.build(record, this.rideBriefOpts(record)); } catch (e) { console.warn('Ride coach: could not build the ride brief', e); }
      const chat = Array.isArray(record.rideChat) ? record.rideChat.filter(m => m.role !== 'error') : [];
      chat.push({ role: 'user', content: q, ...(label ? { label } : {}), at: Date.now() });
      record.rideChat = chat;
      const messages = [];
      chat.forEach(m => {
        if (m.role !== 'user' && m.role !== 'assistant') return;
        if (messages.length && messages[messages.length - 1].role === m.role) messages[messages.length - 1] = { role: m.role, content: m.content };
        else messages.push({ role: m.role, content: m.content });
      });
      let list = messages.slice(-20);
      while (list.length && list[0].role !== 'user') list = list.slice(1);
      this._rideAskBusy = rideId;
      this.refreshRideCoach(record);
      const started = performance.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 180000);
      try {
        const resp = await fetch('api/ask', {
          method: 'POST', cache: 'no-store', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: list, context, provider: coach.provider, model: coach.model, effort: coach.effort })
        });
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok || !json.text) throw new Error(json.error || `AI coach error (${resp.status})`);
        const secs = ((performance.now() - started) / 1000).toFixed(0);
        chat.push({ role: 'assistant', content: VeloRideBrief.cleanAiText(json.text).slice(0, 12000), meta: `${VeloAiCoach.labelFor(json.model || coach.model)} · ${secs} s`, at: Date.now() });
      } catch (e) {
        chat.pop();
        chat.push({ role: 'error', content: ac.signal.aborted ? 'No answer after 3 minutes. Try again, or ask a shorter question.' : `The coach could not answer: ${e.message}` });
      } finally {
        clearTimeout(timer);
        this._rideAskBusy = null;
        record.rideChat = chat.slice(-40);
        const saved = record.rideChat.filter(m => m.role !== 'error');
        try {
          const keep = record.rideChat;
          record.rideChat = saved;
          this.persistHistoryLocal();
          await VeloDB.saveRide(record);
          record.rideChat = keep;
        } catch (e) { /* kept in memory for this view */ }
        this.refreshRideCoach(record);
      }
      return record.rideChat;
    },

    refreshRideCoach(record) {
      if (this._reviewRideId !== record.id) return;
      document.querySelectorAll('#aiBreakdownArea').forEach(area => {
        area.innerHTML = this.rideCoachHtml(record);
        const thread = area.querySelector('.ride-coach-thread');
        const last = thread && thread.lastElementChild;
        if (last) requestAnimationFrame(() => last.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
      });
    },

    bindInsightActions(container) {
      if (!container) return;
      this.on(container, 'submit', (e) => {
        const form = e.target.closest('[data-ride-form]');
        if (!form) return;
        e.preventDefault();
        const input = form.querySelector('textarea');
        const q = input ? input.value.trim() : '';
        if (q) this.sendRideAsk(form.dataset.rideForm, q);
      });
      this.on(container, 'keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey || !e.target.matches('.ride-coach-input')) return;
        e.preventDefault();
        const form = e.target.closest('form');
        if (form) form.requestSubmit();
      });
      this.on(container, 'click', (e) => {
        const chip = e.target.closest('[data-ride-ask]');
        if (chip) {
          const q = chip.dataset.q;
          if (q === VeloRideBrief.REVIEW_LABEL) this.sendRideAsk(chip.dataset.rideAsk, VeloRideBrief.REVIEW_PROMPT, VeloRideBrief.REVIEW_LABEL);
          else this.sendRideAsk(chip.dataset.rideAsk, q);
          return;
        }
        const clear = e.target.closest('[data-ride-clear]');
        if (clear) {
          const r = this.completedWorkouts.find(x => x.id === clear.dataset.rideClear);
          if (r) { r.rideChat = []; delete r.aiBreakdown; this.persistHistoryLocal(); Promise.resolve(VeloDB.saveRide(r)).catch(() => {}); this.refreshRideCoach(r); }
          return;
        }
        const b = e.target.closest('[data-ftp]');
        if (!b) return;
        if (b.dataset.ftp === 'accept') this.acceptFtpSuggestion(b.dataset.value);
        else this.dismissFtpSuggestion(b.dataset.value);
      });
    }
  });
})();
