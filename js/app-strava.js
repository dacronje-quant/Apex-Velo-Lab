/**
 * APEX VELO // LAB - Send to Strava (mixin on VeloApp).
 *
 * One button in the ride summary uploads the ride's FIT file to Strava through the local
 * server (which holds the Strava keys). Each ride remembers its Strava status, shown in the
 * summary and the history table: not sent / sending / processing / sent / already on Strava / failed.
 *
 * Strava's public API does not let personal apps attach photos, so every send also renders a
 * workout image, saves it to Downloads and copies it to the clipboard, ready to drop into the
 * Strava activity with one click.
 */
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pos = (v) => Number.isFinite(Number(v)) && Number(v) > 0;
  const STRAVA_ORANGE = '#fc4c02';
  const POLL_MS = 2000;
  const POLL_MAX = 45; // ~90 s; Strava usually needs 5-20 s

  function toBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }

  Object.assign(VeloApp.prototype, {
    initStravaUi() {
      this.strava = { reachable: false, configured: false, connected: false, athlete: null, canUpload: false };
      this.stravaImages = new Map();   // rideId -> PNG blob of the workout card
      this.stravaPolls = new Map();    // rideId -> true while polling
      // The Strava sign-in tab tells us when it is done.
      this.on(window, 'message', (e) => {
        if (e.origin === location.origin && e.data && e.data.apexStrava === 'connected') this.refreshStravaStatus(true);
      });
      this.on(window, 'focus', () => { if (this._awaitingStravaConnect) this.refreshStravaStatus(true); });
      const details = document.getElementById('modalRideDetails');
      this.on(details, 'click', (e) => {
        const b = e.target.closest('[data-strava]');
        if (!b) return;
        const id = this._reviewRideId;
        const act = b.dataset.strava;
        if (act === 'send') this.sendRideToStrava(id);
        else if (act === 'connect') this.connectStrava();
        else if (act === 'copy-image') this.copyStravaImage(id);
        else if (act === 'save-image') this.saveStravaImage(id);
        else if (act === 'check') this.pollStravaUpload(id);
        else if (act === 'disconnect') this.disconnectStrava();
      });
      this.on(document.getElementById('btnStravaCheckAll'), 'click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true; btn.classList.add('is-loading');
        try { await this.checkRidesOnStrava(this.completedWorkouts, false); }
        finally { btn.disabled = false; btn.classList.remove('is-loading'); }
      });
      this.refreshStravaStatus(false);
    },

    async refreshStravaStatus(rerender) {
      try {
        const r = await fetch('api/strava/status', { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        this.strava = j ? { reachable: true, ...j } : { reachable: false, configured: false, connected: false, athlete: null, canUpload: false };
      } catch (e) {
        this.strava = { reachable: false, configured: false, connected: false, athlete: null, canUpload: false };
      }
      if (this.strava.connected) this._awaitingStravaConnect = false;
      if (rerender) {
        const ride = this.completedWorkouts.find(r => r.id === this._reviewRideId);
        if (ride) { this.renderStravaPanel(ride); this.autoCheckRideOnStrava(ride); }
        if (this.strava.connected) this.showToast(`Strava connected${this.strava.athlete ? ` as ${this.strava.athlete}` : ''}.`, 'success');
      }
      return this.strava;
    },

    connectStrava() {
      this._awaitingStravaConnect = true;
      const w = window.open('api/strava/connect', 'apexStravaConnect', 'width=620,height=760');
      if (!w) location.href = 'api/strava/connect';
    },

    async disconnectStrava() {
      if (!confirm('Disconnect Strava? Rides already sent stay on Strava.')) return;
      try { await fetch('api/strava/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) { /* ignore */ }
      await this.refreshStravaStatus(false);
      const ride = this.completedWorkouts.find(r => r.id === this._reviewRideId);
      if (ride) this.renderStravaPanel(ride);
      this.showToast('Strava disconnected.');
    },

    /** Status of a ride on Strava, normalised. */
    stravaStateOf(ride) {
      const s = ride && ride.strava;
      return s && s.state ? s : { state: 'none' };
    },

    /** Called when a ride summary opens: quietly checks Strava for this ride once per session. */
    async autoCheckRideOnStrava(ride) {
      if (!ride || this.stravaStateOf(ride).state !== 'none') return;
      if (!this.strava || !this.strava.connected || !this.strava.canCheck) return;
      this._stravaAutoChecked = this._stravaAutoChecked || new Set();
      if (this._stravaAutoChecked.has(ride.id)) return;
      this._stravaAutoChecked.add(ride.id);
      this._stravaChecking = ride.id;
      this.renderStravaPanel(ride);
      try { await this.checkRidesOnStrava([ride], true); }
      finally {
        this._stravaChecking = null;
        if (this._reviewRideId === ride.id) this.renderStravaPanel(ride);
      }
    },

    /** Small status chip for the history table. */
    stravaChip(ride) {
      const st = this.stravaStateOf(ride);
      if (st.state === 'imported') return `<a class="chip chip-xs chip-strava chip-strava-imported" href="${this.stravaActivityUrl(st.activityId)}" target="_blank" rel="noopener noreferrer" title="Imported from Strava (activity #${esc(st.activityId)})">from Strava</a>`;
      if (st.state === 'sent' || st.state === 'duplicate' || st.state === 'found') return `<a class="chip chip-xs chip-strava" href="${this.stravaActivityUrl(st.activityId)}" target="_blank" rel="noopener noreferrer" title="On Strava (activity #${esc(st.activityId)})">Strava &#10003;</a>`;
      if (st.state === 'failed') return `<span class="chip chip-xs chip-strava-bad" title="${esc(st.error || 'Upload failed')}">Strava failed</span>`;
      if (st.state === 'processing' || st.state === 'sending') return '<span class="chip chip-xs chip-strava-busy">Strava...</span>';
      return '';
    },

    stravaActivityUrl(id) { return `https://www.strava.com/activities/${encodeURIComponent(id)}`; },

    canSendToStrava(ride) {
      return !!(ride && Array.isArray(ride.samples) && ride.samples.length >= 60);
    },

    renderStravaPanel(ride) {
      const el = document.getElementById('rideStravaPanel');
      if (!el || !ride) return;
      const st = this.stravaStateOf(ride);
      const sv = this.strava || {};
      const when = st.sentAt ? new Date(st.sentAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
      const link = st.activityId ? `<a class="btn btn-strava-link" href="${this.stravaActivityUrl(st.activityId)}" target="_blank" rel="noopener noreferrer">View on Strava<svg class="ic"><use href="#i-right"/></svg></a>` : '';
      const imageRow = (st.state === 'sent' || st.state === 'duplicate' || st.state === 'found') ? `
        <div class="strava-image-row">
          <span><b>Add the workout image:</b> open the activity, choose <i>Add photos</i> and drop in the saved image (or paste it - it is on your clipboard).</span>
          <span class="btn-row btn-row-tight">
            <button type="button" class="btn btn-xs" data-strava="copy-image">Copy image</button>
            <button type="button" class="btn btn-xs" data-strava="save-image">Save image</button>
          </span>
        </div>` : '';
      let state, cls, body, action = '';
      const who = sv.athlete ? ` as ${esc(sv.athlete)}` : '';
      if (st.state === 'imported') {
        cls = 'ok'; state = 'Imported from Strava';
        body = `Summary imported by "Sync from Strava" (activity #${esc(st.activityId)}). It is refreshed on the next sync and removed if you delete it on Strava.${ride.tssEstimated ? ` TSS is estimated from ${esc(ride.tssMethod)}.` : ''}`;
        action = link;
      } else if (st.state === 'sent') {
        cls = 'ok'; state = 'Sent to Strava';
        body = `Uploaded ${esc(when)}${who}. Strava activity #${esc(st.activityId)}.`;
        action = link;
      } else if (st.state === 'found') {
        cls = 'ok'; state = 'Already on Strava';
        body = `Found on Strava${st.name ? `: "${esc(st.name)}"` : ''} (#${esc(st.activityId)}), recorded at the same time - no need to send it.`;
        action = link;
      } else if (this._stravaChecking === ride.id) {
        cls = 'busy'; state = 'Checking Strava...'; body = 'Looking for this ride in your Strava activities.';
      } else if (st.state === 'duplicate') {
        cls = 'ok'; state = 'Already on Strava';
        body = `Strava already has an activity at this time (#${esc(st.activityId)}) - probably uploaded by another app. Nothing was duplicated.`;
        action = link;
      } else if (st.state === 'sending') {
        cls = 'busy'; state = 'Sending to Strava...'; body = 'Uploading the ride file.';
      } else if (st.state === 'processing') {
        cls = 'busy'; state = 'Strava is processing the ride...';
        body = 'Uploaded - waiting for Strava to create the activity (usually 5-20 s).';
        action = this.stravaPolls.has(ride.id) ? '' : '<button type="button" class="btn btn-sm" data-strava="check">Check again</button>';
      } else if (st.state === 'failed') {
        cls = 'bad'; state = 'Not sent - upload failed';
        body = esc(st.error || 'Unknown error');
        action = sv.connected || !sv.reachable ? '<button type="button" class="btn btn-strava" data-strava="send">Retry</button>' : '<button type="button" class="btn btn-strava" data-strava="connect">Connect Strava</button>';
      } else {
        cls = 'idle'; state = 'Not sent to Strava';
        if (!this.canSendToStrava(ride)) {
          body = 'Only rides with second-by-second data can be sent (this one is a summary import).';
        } else if (!sv.reachable) {
          body = 'Open the app with Launch-Apex-Velo.bat to enable Strava.';
        } else if (!sv.configured) {
          body = 'Strava is not set up yet: add STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET to .env (see README) and restart Launch-Apex-Velo.bat.';
        } else if (!sv.connected || !sv.canUpload || !sv.canCheck) {
          body = sv.connected ? 'Reconnect Strava once more to allow checking which rides are already there.' : 'Connect your Strava account once, then send rides with one click.';
          action = '<button type="button" class="btn btn-strava" data-strava="connect">Connect Strava</button>';
        } else {
          body = `Not found on Strava${who}. Ready to upload - a workout image is saved and copied for you to add.`;
          action = '<button type="button" class="btn btn-strava" data-strava="send"><svg class="ic"><use href="#i-upload"/></svg>Send to Strava</button>';
        }
      }
      const disconnect = sv.connected ? `<button type="button" class="link-btn" data-strava="disconnect">Disconnect Strava</button>` : '';
      el.className = `strava-panel strava-${cls}`;
      el.innerHTML = `
        <div class="strava-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M15.4 17.9 13.3 13.7h-3.1l5.2 10.3 5.2-10.3h-3.1M10.4 5.1l2.8 5.5h4.2L10.4 0 3.5 13.7h4.2"/></svg></div>
        <div class="strava-body">
          <div class="strava-state" id="rideStravaState">${cls === 'busy' ? '<span class="spinner"></span>' : ''}${state}</div>
          <div class="strava-detail">${body}</div>
          ${imageRow}
        </div>
        <div class="strava-actions">${action}${disconnect}</div>`;
    },

    /** Plain-text description for Strava (only recorded channels). */
    stravaDescription(ride) {
      const lines = [];
      const parts = [];
      if (pos(ride.avgWatts)) parts.push(`Avg ${ride.avgWatts} W`);
      if (pos(ride.np)) parts.push(`NP ${ride.np} W`);
      if (pos(ride.if)) parts.push(`IF ${Number(ride.if).toFixed(2)}`);
      if (pos(ride.tss)) parts.push(`TSS ${ride.tss}`);
      if (parts.length) lines.push(parts.join(' | '));
      const hr = [];
      if (pos(ride.avgHr)) hr.push(`Avg HR ${ride.avgHr} bpm`);
      if (pos(ride.maxHr)) hr.push(`max ${ride.maxHr}`);
      if (hr.length) lines.push(hr.join(', '));
      if (pos(ride.leftBal) && pos(ride.rightBal)) lines.push(`L/R balance ${ride.leftBal}/${ride.rightBal}`);
      if (pos(ride.kj)) lines.push(`Work ${ride.kj} kJ`);
      lines.push('Recorded with Apex Velo Lab (Assioma DUO-Shi + KICKR SHIFT)');
      return lines.join('\n');
    },

    /**
     * Finds the Strava activity that is the same ride: a ride-type activity (or any trainer activity)
     * starting within 10 min of ours, or overlapping at least half of the shorter of the two.
     */
    matchStravaActivity(ride, activities) {
      const start = new Date(ride.date).getTime();
      if (!Number.isFinite(start)) return null;
      const dur = Math.max(60, Number(ride.duration) || 0) * 1000;
      let best = null, bestScore = 0;
      for (const a of activities || []) {
        const s = Date.parse(a.start);
        if (!Number.isFinite(s)) continue;
        if (!/ride/i.test(a.sport || '') && !a.trainer) continue;
        const e = s + Math.max(60, a.elapsed || a.moving || 0) * 1000;
        const overlap = Math.min(start + dur, e) - Math.max(start, s);
        const shorter = Math.min(dur, e - s);
        const close = Math.abs(s - start) <= 10 * 60000;
        if (!close && overlap < shorter * 0.5) continue;
        const score = Math.max(0, overlap) / shorter + (close ? 1 : 0);
        if (score > bestScore) { best = a; bestScore = score; }
      }
      return best;
    },

    /** Marks rides that already exist on Strava. Returns { checked, found } or null when not possible. */
    async checkRidesOnStrava(rides, silent = false) {
      const sv = this.strava || {};
      if (!sv.connected || !sv.canCheck) {
        if (!silent) this.showToast(sv.connected ? 'Reconnect Strava to allow checking your activities (Disconnect, then Connect Strava).' : 'Connect Strava first (open a ride summary, click Connect Strava).', 'warning');
        return null;
      }
      // Only app-recorded cycling rides; Strava-imported records are managed by "Sync from Strava".
      const todo = rides.filter(r => r && r.source !== 'Strava' && VeloMetrics.isCycling(r) && !['sent', 'duplicate', 'found', 'imported'].includes(this.stravaStateOf(r).state) && Number.isFinite(new Date(r.date).getTime()));
      if (!todo.length) { if (!silent) this.showToast('Every ride is already linked to Strava.', 'success'); return { checked: 0, found: 0 }; }
      const starts = todo.map(r => new Date(r.date).getTime() / 1000);
      const ends = todo.map(r => new Date(r.date).getTime() / 1000 + (Number(r.duration) || 0));
      const after = Math.floor(Math.min(...starts) - 3600), before = Math.ceil(Math.max(...ends) + 3600);
      let j;
      try {
        const r = await fetch(`api/strava/activities?after=${after}&before=${before}`, { cache: 'no-store' });
        j = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (j.needsConnect) { this.strava.canCheck = false; }
          if (!silent) this.showToast(j.error || `Strava check failed (HTTP ${r.status}).`, 'error');
          return null;
        }
      } catch (e) {
        if (!silent) this.showToast('Could not reach the local server. Is Launch-Apex-Velo.bat running?', 'error');
        return null;
      }
      let found = 0;
      const now = Date.now();
      for (const ride of todo) {
        const a = this.matchStravaActivity(ride, j.activities);
        if (a) { ride.strava = { state: 'found', activityId: String(a.id), name: a.name, checkedAt: now }; found++; }
        else if (this.stravaStateOf(ride).state === 'none') ride.stravaCheckedAt = now;
      }
      await this.saveHistory();
      this.renderHistoryTable();
      const cur = this.completedWorkouts.find(r => r.id === this._reviewRideId);
      if (cur && todo.includes(cur)) this.renderStravaPanel(cur);
      if (!silent) this.showToast(`Checked ${todo.length} ride${todo.length === 1 ? '' : 's'}: ${found} already on Strava, ${todo.length - found} not on Strava yet.`, 'success');
      return { checked: todo.length, found };
    },

    async sendRideToStrava(rideId) {
      const ride = this.completedWorkouts.find(r => r.id === rideId);
      if (!ride || !this.canSendToStrava(ride)) return;
      if (this.stravaPolls.has(rideId) || this.stravaStateOf(ride).state === 'sending') return;

      // The image is prepared first, while the click still counts as a user action (clipboard needs that).
      this.prepareStravaImage(ride, true);

      ride.strava = { state: 'sending', startedAt: Date.now() };
      this.renderStravaPanel(ride);
      let res, json;
      try {
        const fit = VeloExport.buildFit(ride, ride.samples);
        res = await fetch('api/strava/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fitBase64: toBase64(fit), name: ride.title || 'Indoor ride', description: this.stravaDescription(ride), externalId: `apexvelo-${ride.id}` })
        });
        json = await res.json().catch(() => ({}));
      } catch (e) {
        json = { error: `Could not reach the local server (${e.message}). Is Launch-Apex-Velo.bat running?` };
      }
      if (!res || !res.ok) {
        if (json && json.needsConnect) { this.strava.connected = false; this.strava.canUpload = false; }
        return this.finishStrava(ride, { state: 'failed', error: (json && json.error) || `HTTP ${res ? res.status : '?'}` });
      }
      if (json.state === 'processing') {
        ride.strava = { state: 'processing', uploadId: json.uploadId, startedAt: ride.strava.startedAt };
        this.saveHistory();
        this.renderStravaPanel(ride);
        return this.pollStravaUpload(rideId);
      }
      return this.finishStrava(ride, json);
    },

    async pollStravaUpload(rideId) {
      const ride = this.completedWorkouts.find(r => r.id === rideId);
      const st = ride && this.stravaStateOf(ride);
      if (!ride || !st.uploadId || this.stravaPolls.has(rideId)) return;
      this.stravaPolls.set(rideId, true);
      this.renderStravaPanel(ride);
      try {
        for (let i = 0; i < POLL_MAX; i++) {
          await new Promise(r => setTimeout(r, i === 0 ? 1200 : POLL_MS));
          let j;
          try {
            const r = await fetch(`api/strava/upload/${encodeURIComponent(st.uploadId)}`, { cache: 'no-store' });
            j = await r.json().catch(() => ({}));
            if (!r.ok) { if (r.status >= 500) continue; return this.finishStrava(ride, { state: 'failed', error: j.error || `HTTP ${r.status}` }); }
          } catch (e) { continue; }
          if (j.state && j.state !== 'processing') return this.finishStrava(ride, j);
        }
        this.showToast('Strava is still processing the ride. Use "Check again" in a moment.', 'warning');
      } finally {
        this.stravaPolls.delete(rideId);
        if (this.stravaStateOf(ride).state === 'processing' && this._reviewRideId === rideId) this.renderStravaPanel(ride);
      }
    },

    finishStrava(ride, result) {
      const ok = result.state === 'sent' || result.state === 'duplicate';
      ride.strava = ok
        ? { state: result.state, activityId: String(result.activityId), uploadId: result.uploadId || (ride.strava && ride.strava.uploadId) || null, sentAt: Date.now() }
        : { state: 'failed', error: String(result.error || 'Upload failed'), failedAt: Date.now() };
      this.saveHistory();
      this.renderHistoryTable();
      if (this._reviewRideId === ride.id) this.renderStravaPanel(ride);
      if (result.state === 'sent') this.showToast('Sent to Strava. The workout image is saved and on your clipboard - add it to the activity.', 'success');
      else if (result.state === 'duplicate') this.showToast('Already on Strava - linked to the existing activity.', 'success');
      else this.showToast(/^strava/i.test(ride.strava.error) ? ride.strava.error : `Strava upload failed: ${ride.strava.error}`, 'error');
    },

    // ------------------------------------------------------------ workout image --
    /** Renders (once per ride) and optionally saves + copies the workout image. */
    prepareStravaImage(ride, deliver) {
      const blobPromise = this.stravaImages.has(ride.id)
        ? Promise.resolve(this.stravaImages.get(ride.id))
        : new Promise((resolve) => this.renderWorkoutCard(ride).toBlob((b) => resolve(b), 'image/png'));
      blobPromise.then((b) => { if (b) this.stravaImages.set(ride.id, b); });
      if (deliver) {
        // ClipboardItem accepts a promise, so the copy still counts as part of the click.
        try {
          if (navigator.clipboard && window.ClipboardItem) navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]).catch(() => {});
        } catch (e) { /* clipboard not available */ }
        blobPromise.then((b) => { if (b) this.downloadBlob(`${VeloExport.fileStem(ride)}_workout.png`, b); });
      }
      return blobPromise;
    },

    async copyStravaImage(rideId) {
      const ride = this.completedWorkouts.find(r => r.id === rideId);
      if (!ride) return;
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': this.prepareStravaImage(ride, false) })]);
        this.showToast('Workout image copied - paste it into the Strava activity.', 'success');
      } catch (e) {
        this.showToast('Could not copy the image here - use "Save image" instead.', 'warning');
      }
    },

    async saveStravaImage(rideId) {
      const ride = this.completedWorkouts.find(r => r.id === rideId);
      if (!ride) return;
      const b = await this.prepareStravaImage(ride, false);
      if (b) this.downloadBlob(`${VeloExport.fileStem(ride)}_workout.png`, b);
    },

    downloadBlob(filename, blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    },

    /** Draws a 1600x1000 workout card: headline stats, power trace coloured by zone, HR, zone time, peaks. */
    renderWorkoutCard(ride) {
      const W = 1600, H = 1000;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const FONT = 'Inter, "Segoe UI", system-ui, sans-serif';
      const MONO = '"JetBrains Mono", Consolas, ui-monospace, monospace';
      const ftp = this.activeProfile && this.activeProfile.ftp > 0 ? this.activeProfile.ftp : 200;
      const samples = ride.samples || [];

      const bg = g.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, '#0b1222'); bg.addColorStop(1, '#070a12');
      g.fillStyle = bg; g.fillRect(0, 0, W, H);

      // Header
      g.fillStyle = '#22d3ee'; g.font = `700 22px ${FONT}`;
      g.fillText('APEX VELO LAB', 64, 76);
      const d = new Date(ride.date);
      g.fillStyle = '#94a3b8'; g.font = `500 22px ${FONT}`;
      const dateTxt = isNaN(d) ? '' : d.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      g.textAlign = 'right'; g.fillText(dateTxt, W - 64, 76); g.textAlign = 'left';
      g.fillStyle = '#f1f5f9'; g.font = `800 56px ${FONT}`;
      let title = ride.title || 'Indoor ride';
      while (g.measureText(title).width > W - 128 && title.length > 8) title = title.slice(0, -2);
      if (title !== (ride.title || 'Indoor ride')) title = title.trim() + '...';
      g.fillText(title, 64, 146);

      // Stat tiles (only recorded values)
      const fmtDur = (sec) => { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60); return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; };
      const tiles = [
        ['TIME', pos(ride.duration) ? fmtDur(ride.duration) : '--', ''],
        ['AVG POWER', pos(ride.avgWatts) ? String(ride.avgWatts) : '--', 'W'],
        ['NORM. POWER', pos(ride.np) ? String(ride.np) : '--', 'W'],
        ['TSS', pos(ride.tss) ? String(ride.tss) : '--', ''],
        ['IF', pos(ride.if) ? Number(ride.if).toFixed(2) : '--', ''],
        ['AVG HR', pos(ride.avgHr) ? String(ride.avgHr) : '--', 'bpm'],
        ['WORK', pos(ride.kj) ? String(ride.kj) : '--', 'kJ']
      ];
      const tw = (W - 128 - 6 * 16) / 7;
      tiles.forEach(([lbl, val, unit], i) => {
        const x = 64 + i * (tw + 16), y = 186;
        g.fillStyle = 'rgba(148,163,184,0.08)'; this._roundRect(g, x, y, tw, 118, 14); g.fill();
        g.fillStyle = '#94a3b8'; g.font = `700 16px ${FONT}`; g.fillText(lbl, x + 18, y + 34);
        g.fillStyle = '#f8fafc'; g.font = `700 44px ${MONO}`; g.fillText(val, x + 18, y + 90);
        if (unit && val !== '--') { const vw = g.measureText(val).width; g.fillStyle = '#64748b'; g.font = `600 18px ${FONT}`; g.fillText(unit, x + 24 + vw, y + 90); }
      });

      // Power trace coloured by zone + target + HR
      const cx = 64, cy = 340, cw = W - 128, ch = 380;
      g.fillStyle = 'rgba(148,163,184,0.05)'; this._roundRect(g, cx, cy, cw, ch, 14); g.fill();
      const n = samples.length;
      if (n >= 2) {
        const smooth = samples.map((s, i) => { let sum = 0, k = 0; for (let j = Math.max(0, i - 4); j <= i; j++) { sum += Number(samples[j].power) || 0; k++; } return sum / k; });
        const maxP = Math.max(ftp * 1.3, ...smooth, ...samples.map(s => Number(s.target) || 0)) * 1.05;
        const px = (i) => cx + 16 + (i / (n - 1)) * (cw - 32);
        const py = (w) => cy + ch - 20 - (w / maxP) * (ch - 40);
        // FTP reference
        g.strokeStyle = 'rgba(248,250,252,0.25)'; g.setLineDash([8, 8]); g.lineWidth = 2;
        g.beginPath(); g.moveTo(cx + 16, py(ftp)); g.lineTo(cx + cw - 16, py(ftp)); g.stroke(); g.setLineDash([]);
        g.fillStyle = '#94a3b8'; g.font = `600 15px ${FONT}`; g.fillText(`FTP ${ftp} W`, cx + 24, py(ftp) - 8);
        // Bars by zone (one column per pixel bucket)
        const cols = Math.min(n, cw - 32);
        for (let b = 0; b < cols; b++) {
          const i0 = Math.floor((b / cols) * n), i1 = Math.max(i0 + 1, Math.floor(((b + 1) / cols) * n));
          let sum = 0; for (let i = i0; i < i1; i++) sum += smooth[i];
          const w = sum / (i1 - i0);
          const z = VeloMetrics.zoneForPct((w / ftp) * 100);
          const x0 = Math.floor(cx + 16 + (b / cols) * (cw - 32));
          const x1 = Math.ceil(cx + 16 + ((b + 1) / cols) * (cw - 32));
          const top = Math.round(py(w));
          g.fillStyle = z.color; g.globalAlpha = 0.9;
          g.fillRect(x0, top, Math.max(1, x1 - x0), cy + ch - 20 - top);
        }
        g.globalAlpha = 1;
        // Target
        if (samples.some(s => Number(s.target) > 0)) {
          g.strokeStyle = '#f8fafc'; g.lineWidth = 2.5; g.beginPath();
          samples.forEach((s, i) => { const y = py(Number(s.target) || 0); if (i === 0) g.moveTo(px(i), y); else g.lineTo(px(i), y); });
          g.stroke();
        }
        // Heart rate on its own scale
        // Heart rate on its own scale; values outside 40-230 bpm are sensor noise and are skipped.
        const hrs = samples.map(s => { const h = Number(s.hr) || 0; return h >= 40 && h <= 230 ? h : 0; });
        const hrMax = Math.max(...hrs);
        if (hrMax > 0) {
          const hrMin = Math.max(40, Math.min(...hrs.filter(h => h > 0)) - 10);
          const top = cy + 44, bottom = cy + ch - 20;
          const hy = (h) => Math.max(top, Math.min(bottom, bottom - ((h - hrMin) / Math.max(1, hrMax + 10 - hrMin)) * (bottom - top)));
          g.strokeStyle = '#fb7185'; g.lineWidth = 2.5; g.beginPath(); let started = false;
          hrs.forEach((h, i) => { if (h <= 0) { started = false; return; } if (!started) { g.moveTo(px(i), hy(h)); started = true; } else g.lineTo(px(i), hy(h)); });
          g.stroke();
          g.fillStyle = '#fb7185'; g.font = `600 15px ${FONT}`; g.textAlign = 'right';
          g.fillText(`max ${hrMax} bpm`, cx + cw - 16, Math.max(top + 16, hy(hrMax) - 8));
          g.textAlign = 'left';
        }
        // Legend
        g.font = `600 16px ${FONT}`;
        const legend = [['Power (zone colours)', '#a3e635'], ['Target', '#f8fafc'], ...(hrMax > 0 ? [['Heart rate', '#fb7185']] : [])];
        let lx = cx + cw - 16;
        g.textAlign = 'right';
        for (let i = legend.length - 1; i >= 0; i--) {
          const [t, col] = legend[i];
          g.fillStyle = '#cbd5e1'; g.fillText(t, lx, cy + 30); const tw2 = g.measureText(t).width;
          g.fillStyle = col; g.fillRect(lx - tw2 - 22, cy + 20, 14, 4);
          lx -= tw2 + 44;
        }
        g.textAlign = 'left';
      }

      // Time in zone bar
      const zy = 760;
      g.fillStyle = '#94a3b8'; g.font = `700 16px ${FONT}`; g.fillText('TIME IN ZONE', 64, zy);
      const zones = VeloMetrics.ZONES.map(z => ({ ...z, sec: 0 }));
      samples.forEach(s => { const z = VeloMetrics.zoneForPct(((Number(s.power) || 0) / ftp) * 100); const t = zones.find(x => x.key === z.key); if (t) t.sec++; });
      const total = zones.reduce((a, z) => a + z.sec, 0) || 1;
      let bx = 64; const bw = W - 128;
      zones.forEach(z => { const w = (z.sec / total) * bw; if (w <= 0) return; g.fillStyle = z.color; g.fillRect(bx, zy + 14, Math.max(0, w - 2), 26); bx += w; });
      let lx2 = 64;
      g.font = `600 16px ${FONT}`;
      zones.forEach(z => {
        if (!z.sec) return;
        const t = `${z.short} ${Math.round((z.sec / total) * 100)}%`;
        g.fillStyle = z.color; g.fillRect(lx2, zy + 58, 12, 12);
        g.fillStyle = '#cbd5e1'; g.fillText(t, lx2 + 18, zy + 70);
        lx2 += g.measureText(t).width + 44;
      });

      // Peaks + balance footer
      const powers = samples.map(s => Number(s.power) || 0);
      const peaks = [[5, '5 s'], [60, '1 min'], [300, '5 min'], [1200, '20 min']]
        .map(([sec, l]) => [l, powers.length >= sec ? VeloMetrics.bestRollingAvg(powers, sec) : 0]).filter(p => p[1] > 0);
      g.fillStyle = '#94a3b8'; g.font = `700 16px ${FONT}`; g.fillText('PEAK POWER', 64, 890);
      g.font = `700 30px ${MONO}`;
      let fx = 64;
      peaks.forEach(([l, v]) => {
        g.fillStyle = '#f8fafc'; g.fillText(`${v} W`, fx, 934); const vw = g.measureText(`${v} W`).width;
        g.fillStyle = '#64748b'; g.font = `600 17px ${FONT}`; g.fillText(l, fx + vw + 10, 934); fx += vw + g.measureText(l).width + 48;
        g.font = `700 30px ${MONO}`;
      });
      g.textAlign = 'right';
      if (pos(ride.leftBal) && pos(ride.rightBal)) {
        g.fillStyle = '#94a3b8'; g.font = `700 16px ${FONT}`; g.fillText('L / R BALANCE', W - 64, 890);
        g.fillStyle = '#f8fafc'; g.font = `700 30px ${MONO}`; g.fillText(`${ride.leftBal} / ${ride.rightBal}`, W - 64, 934);
      }
      g.fillStyle = '#475569'; g.font = `500 15px ${FONT}`; g.fillText('Assioma DUO-Shi  ·  Wahoo KICKR SHIFT', W - 64, 972);
      g.textAlign = 'left';
      return c;
    },

    _roundRect(g, x, y, w, h, r) {
      g.beginPath();
      g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
    }
  });
})();
