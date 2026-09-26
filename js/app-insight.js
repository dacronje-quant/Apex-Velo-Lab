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
    /** Best powers for the medal durations; cached per ride (samples never change). */
    ridePeaks(r) {
      if (!VeloInsight.hasSamples(r)) return null;
      this._peaksCache = this._peaksCache || new Map();
      const key = `${r.id}|${r.samples.length}`;
      if (!this._peaksCache.has(key)) this._peaksCache.set(key, VeloInsight.peaksOf(r.samples));
      return this._peaksCache.get(key);
    },

    medalHistory() {
      return this.cyclingRides().filter(VeloInsight.hasSamples).map(r => ({ id: r.id, date: r.date, peaks: this.ridePeaks(r) }));
    },

    medalArchive() {
      const a = (typeof DIVAN_HEALTHFIT_DATA !== 'undefined' && DIVAN_HEALTHFIT_DATA.allTimeMmp && Array.isArray(DIVAN_HEALTHFIT_DATA.allTimeMmp.watts))
        ? DIVAN_HEALTHFIT_DATA.allTimeMmp.watts : null;
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
      if (!VeloInsight.hasSamples(r) || !VeloMetrics.isCycling(r)) return null;
      const p = this.activeProfile || {};
      this._ftpEvCache = this._ftpEvCache || new Map();
      const key = `${r.id}|${r.samples.length}|${p.maxHr || 0}|${p.lthr || 0}`;
      if (!this._ftpEvCache.has(key)) this._ftpEvCache.set(key, VeloInsight.ftpEvidence(r.samples, { maxHr: p.maxHr, lthr: p.lthr }));
      return this._ftpEvCache.get(key);
    },

    dismissedFtp() {
      try { return (JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}') || {})[this.activeProfileId || 'default'] || 0; } catch (e) { return 0; }
    },

    /** A higher-FTP suggestion from this ride (and, if needed, a confirming ride), or null. */
    ftpSuggestionFor(record) {
      if (!record || !VeloInsight.hasSamples(record) || Date.now() - Date.parse(record.date) > FRESH_DAYS * VeloInsight.DAY) return null;
      const t = Date.parse(record.date);
      const rides = this.cyclingRides().filter(r => VeloInsight.hasSamples(r) && Date.parse(r.date) <= t && t - Date.parse(r.date) <= FRESH_DAYS * VeloInsight.DAY)
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
      const list = rides.filter(r => r.id !== record.id).concat([record]).map(r => ({ id: r.id, date: r.date, evidence: this.ftpEvidenceOf(r) }));
      return VeloInsight.ftpSuggestion(list, this.activeProfile.ftp, { dismissed: this.dismissedFtp() });
    },

    acceptFtpSuggestion(value) {
      const v = Math.round(Number(value));
      if (!(v >= 50)) return;
      const from = this.activeProfile.ftp;
      this.activeProfile.ftp = v;
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
      const dec = VeloInsight.decoupling(record.samples);
      const sug = this.ftpSuggestionFor(record);
      const decHtml = dec.status === 'ok'
        ? `<span class="chip decoupling decoupling-${dec.level}" title="Power per heartbeat, first vs second half of ${dec.minutes} min after the warm-up (under 5% = aerobically coupled)">Pw:HR drift ${dec.pct}% &middot; ${esc(dec.label)}</span>`
        : dec.status === 'not-steady' ? '<span class="chip chip-ghost" title="Decoupling is measured on steady rides (Z2, tempo, sweet spot)">Pw:HR drift: not a steady ride - not measured</span>'
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

    // ------------------------------------------------- interval diagnosis --
    /** Offline breakdown (always) + the AI coach's breakdown (saved with the ride) or a button for it. */
    intervalBreakdownHtml(record) {
      if (!VeloInsight.hasSamples(record)) return '';
      const ftp = record.ftpAtRide || this.activeProfile.ftp;
      const rows = VeloInsight.intervalRows(record.samples, ftp);
      if (rows.length < 2 || !rows.some(r => r.work)) return '';
      const lines = VeloInsight.offlineBreakdown(rows);
      const ai = record.aiBreakdown;
      const coach = this.aiCoach;
      const live = !!(coach && coach.isLive);
      const md = (t) => (window.VeloMarkdown ? window.VeloMarkdown.render(t) : `<p>${esc(t)}</p>`);
      const aiHtml = ai && ai.text
        ? `<div class="ai-breakdown md-body">${md(ai.text)}</div><div class="hint">AI coach: ${esc(ai.label || ai.model)}${ai.effort ? `, ${esc(ai.effort)} effort` : ''} &middot; ${esc(new Date(ai.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))} <button type="button" class="link-btn" data-ai-breakdown="${esc(record.id)}">Ask again</button></div>`
        : live
          ? `<button type="button" class="btn btn-sm" data-ai-breakdown="${esc(record.id)}"><svg class="ic"><use href="#i-sparkles"/></svg>Ask the AI coach (${esc(VeloAiCoach.labelFor(coach.model))}, low effort)</button>`
          : '<span class="hint">Add an Anthropic or Gemini key to .env for an AI coach breakdown - the summary above is computed offline.</span>';
      return `
        <div class="review-block interval-diagnosis" id="intervalDiagnosis">
          <div class="sub-title"><span>Interval diagnosis</span><span class="hint">hard steps (88% FTP+): target, cadence fade, heart-rate drift</span></div>
          <ul class="diag-list">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
          <div class="ai-breakdown-area" id="aiBreakdownArea">${aiHtml}</div>
        </div>`;
    },

    /** Sends the step table (not raw samples) to /api/coach at low effort and saves the answer on the ride. */
    async requestAiBreakdown(rideId) {
      const record = this.completedWorkouts.find(r => r.id === rideId);
      const area = document.getElementById('aiBreakdownArea');
      if (!record || this._aiBreakdownBusy) return null;
      const coach = this.aiCoach;
      if (coach && !coach.isLive) await coach.detectEngine();
      if (!coach || !coach.isLive) { this.showToast('The AI coach is offline - start Launch-Apex-Velo.bat and add an API key.', 'warning'); return null; }
      const ftp = record.ftpAtRide || this.activeProfile.ftp;
      const rows = VeloInsight.intervalRows(record.samples, ftp);
      const prompt = VeloInsight.breakdownPrompt(rows, { title: record.title, ftp, minutes: Math.round((record.duration || record.samples.length) / 60), avgHr: record.avgHr, maxHr: this.activeProfile.maxHr });
      const model = coach.model;
      const effort = VeloAiCoach.supportsEffort(model) ? 'low' : null; // always the cheapest reasoning level
      this._aiBreakdownBusy = true;
      if (area) area.innerHTML = `<span class="hint is-busy">Asking ${esc(VeloAiCoach.labelFor(model))} (low effort)...</span>`;
      try {
        const resp = await fetch(VeloAiCoach.COACH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, provider: coach.provider, model, effort }) });
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok || !json.text) throw new Error(json.error || `AI coach error (${resp.status})`);
        record.aiBreakdown = { text: String(json.text).trim().slice(0, 4000), model: json.model || model, label: VeloAiCoach.labelFor(json.model || model), effort: json.effort || effort, at: Date.now() };
        this.persistHistoryLocal();
        await VeloDB.saveRide(record);
        return record.aiBreakdown;
      } catch (e) {
        this.showToast(`AI breakdown failed: ${e.message}`, 'error');
        return null;
      } finally {
        this._aiBreakdownBusy = false;
        const block = document.getElementById('intervalDiagnosis');
        if (block && this._reviewRideId === rideId) block.outerHTML = this.intervalBreakdownHtml(record);
      }
    },

    bindInsightActions(container) {
      if (!container) return;
      this.on(container, 'click', (e) => {
        const ai = e.target.closest('[data-ai-breakdown]');
        if (ai) { this.requestAiBreakdown(ai.dataset.aiBreakdown); return; }
        const b = e.target.closest('[data-ftp]');
        if (!b) return;
        if (b.dataset.ftp === 'accept') this.acceptFtpSuggestion(b.dataset.value);
        else this.dismissFtpSuggestion(b.dataset.value);
      });
    }
  });
})();
