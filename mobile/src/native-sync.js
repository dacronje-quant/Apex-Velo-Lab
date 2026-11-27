/**
 * Home Server Sync for the Android APK: two-way delta sync with the Desktop / Mac mini server
 * over Tailscale HTTPS (or home Wi-Fi), plus host AI key sharing.
 */

const PREF_URL = 'home_sync_url';
const PREF_TOKEN = 'home_sync_token';
const PREF_USE_HOST_AI = 'home_sync_use_host_ai';
const PREF_LAST_AT = 'home_sync_last_at';
const PREF_LAST_ERR = 'home_sync_last_error';
const PREF_DEVICE_ID = 'home_sync_device_id';
const PING_TIMEOUT_MS = 5000;
const SYNC_TIMEOUT_MS = 60000;

function isPrivateOrTailscaleHost(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (/^(localhost|127\.0\.0\.1|::1)$/.test(h)) return true;
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return true;
  const ts = h.match(/^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ts) {
    const b = Number(ts[1]);
    return b >= 64 && b <= 127 && Number(ts[2]) <= 255 && Number(ts[3]) <= 255;
  }
  return /\.ts\.net$/.test(h);
}

export function normalizeSyncUrl(raw) {
  const text = String(raw || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  let u;
  try { u = new URL(text); } catch { throw new Error('Enter a valid server URL (for example https://mac-mini.tailnet.ts.net).'); }
  if (u.protocol === 'https:') return u.origin;
  if (u.protocol === 'http:' && isPrivateOrTailscaleHost(u.hostname)) return u.origin;
  throw new Error('Use https:// for Tailscale / remote sync (plain http:// is only allowed on local Wi-Fi or Tailscale IPs).');
}

export function parsePairingInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^apexvelo:\/\/sync/i.test(text)) {
    const u = new URL(text);
    const url = normalizeSyncUrl(u.searchParams.get('url') || '');
    const token = String(u.searchParams.get('token') || '').trim();
    if (!url || !token) throw new Error('This pairing link is missing the server URL or token.');
    return { url, token };
  }
  return { url: normalizeSyncUrl(text), token: null };
}

export class NativeSync {
  constructor({ http, prefs, store, wellness = null, getApp = () => null, reloadStorage = null, now = () => Date.now() }) {
    Object.assign(this, { http, prefs, store, wellness, getApp, reloadStorage, now });
    this._busy = null;
    this._rerun = false;
  }

  async _deviceId() {
    let id = await this.prefs.get(PREF_DEVICE_ID);
    if (!id) {
      id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `android_${this.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await this.prefs.set(PREF_DEVICE_ID, id);
    }
    return id;
  }

  async config() {
    const [url, token, useHostAi, lastAt, lastError] = await Promise.all([
      this.prefs.get(PREF_URL),
      this.prefs.get(PREF_TOKEN),
      this.prefs.get(PREF_USE_HOST_AI),
      this.prefs.get(PREF_LAST_AT),
      this.prefs.get(PREF_LAST_ERR)
    ]);
    return {
      url: url || '',
      token: token || '',
      configured: !!(url && token),
      useHostAi: useHostAi !== '0',
      lastAt: lastAt ? Number(lastAt) : null,
      lastError: lastError || null
    };
  }

  async hostAiConfig() {
    const cfg = await this.config();
    return cfg.configured && cfg.useHostAi ? { url: cfg.url, token: cfg.token, useHostAi: true } : null;
  }

  async setUseHostAi(enabled) {
    await this.prefs.set(PREF_USE_HOST_AI, enabled ? '1' : '0');
  }

  async setConfig({ url, token, useHostAi } = {}) {
    const cleanUrl = normalizeSyncUrl(url);
    const cleanToken = String(token || '').trim();
    if (!cleanUrl) throw new Error('Enter your Home Server URL.');
    if (!/^[A-Za-z0-9._~-]{16,}$/.test(cleanToken)) throw new Error('Enter the sync token from your Home Server (Settings > Sync).');
    await this.prefs.set(PREF_URL, cleanUrl);
    await this.prefs.set(PREF_TOKEN, cleanToken);
    if (useHostAi !== undefined) await this.setUseHostAi(!!useHostAi);
    await this.prefs.remove(PREF_LAST_ERR);
    return this.config();
  }

  async clearConfig() {
    for (const k of [PREF_URL, PREF_TOKEN, PREF_LAST_AT, PREF_LAST_ERR]) await this.prefs.remove(k);
  }

  isPairingUrl(raw) {
    return /^apexvelo:\/\/sync/i.test(String(raw || '').trim());
  }

  async handlePairingLink(raw) {
    const parsed = parsePairingInput(raw);
    if (!parsed || !parsed.url || !parsed.token) throw new Error('Invalid sync pairing link.');
    await this.setConfig({ url: parsed.url, token: parsed.token });
    const ping = await this.ping().catch((e) => ({ ok: false, error: (e && e.message) || String(e) }));
    const synced = ping.ok ? await this.sync({ reason: 'pair' }).catch((e) => ({ ok: false, error: (e && e.message) || String(e) })) : null;
    return { ok: true, ping, synced };
  }

  async _request(cfg, path, method = 'GET', data = undefined, timeout = SYNC_TIMEOUT_MS) {
    const opts = {
      url: `${cfg.url}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      readTimeout: timeout,
      connectTimeout: PING_TIMEOUT_MS
    };
    if (data !== undefined) opts.data = data;
    const r = await this.http.request(opts);
    let body = r.data;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = { error: body.slice(0, 200) }; } }
    if (r.status === 401 || r.status === 403) {
      throw Object.assign(new Error((body && body.error) || 'Home Server rejected the sync token. Re-pair in You > Connections > Home server.'), { status: r.status });
    }
    if (r.status < 200 || r.status >= 300) {
      throw Object.assign(new Error((body && body.error) || `Home Server answered HTTP ${r.status}.`), { status: r.status });
    }
    return body || {};
  }

  async ping() {
    const cfg = await this.config();
    if (!cfg.configured) return { ok: false, configured: false };
    const r = await this._request(cfg, '/api/sync/ping', 'GET', undefined, PING_TIMEOUT_MS);
    return { ok: true, configured: true, ...r };
  }

  async status() {
    const cfg = await this.config();
    return { ...cfg, syncing: !!this._busy };
  }

  async sync({ reason = 'auto', announce = false } = {}) {
    if (this._busy) {
      this._rerun = true;
      return this._busy;
    }
    this._busy = this._runSync({ reason, announce }).finally(() => { this._busy = null; });
    const res = await this._busy;
    if (this._rerun) {
      this._rerun = false;
      this.sync({ reason: 'queued', announce: false }).catch(() => {});
    }
    return res;
  }

  async _runSync({ reason, announce }) {
    const cfg = await this.config();
    const app = this.getApp();
    if (!cfg.configured) return { ok: false, skipped: 'unconfigured' };
    if (!this.store) return { ok: false, skipped: 'no-store' };
    if (app && (app.isPlaying || (app.hasUnsavedRide && app.hasUnsavedRide()))) {
      return { ok: false, skipped: 'riding' };
    }

    try {
      const store = await this.store;
      if (typeof window !== 'undefined' && window.VeloStorage?.enabled && window.VeloStorage.flush) {
        await window.VeloStorage.flush().catch(() => {});
      }

      const manifest = await store.syncManifest();
      const manRes = await this._request(cfg, '/api/sync/manifest', 'POST', manifest);

      const pushRides = manRes.wantRideIds?.length ? await store.ridesByIds(manRes.wantRideIds) : [];
      const pushSettings = manRes.wantSettingKeys?.length ? await store.settingsWithMeta(manRes.wantSettingKeys) : {};
      const pushWellness = manRes.wantWellnessKeys?.length ? await store.wellnessByKeys(manRes.wantWellnessKeys) : [];

      const haveRideHashes = Object.fromEntries(manifest.rides.map((r) => [String(r.id), r.contentHash]));
      const haveWellnessHashes = Object.fromEntries(manifest.wellness.map((w) => [`${w.day}|${w.source}`, w.hash]));

      const pushRes = await this._request(cfg, '/api/sync/push', 'POST', {
        clientId: await this._deviceId(),
        clientName: 'Android',
        reason,
        rides: pushRides,
        settings: pushSettings,
        wellness: pushWellness,
        tombstones: manifest.tombstones,
        haveRideHashes,
        haveWellnessHashes
      });

      const tombMap = new Map();
      for (const t of pushRes.tombstones || []) {
        if (t && t.kind && t.id !== undefined) tombMap.set(`${t.kind}|${t.id}`, Number(t.deletedAt) || 0);
      }
      const delRideIds = manifest.rides
        .filter((r) => {
          const dt = tombMap.get(`ride|${r.id}`);
          return dt !== undefined && dt >= (r.updatedAt || 0);
        })
        .map((r) => r.id);
      const delSettingKeys = Object.entries(manifest.settings || {})
        .filter(([k, s]) => {
          const dt = tombMap.get(`setting|${k}`);
          return dt !== undefined && dt >= (s.updatedAt || 0);
        })
        .map(([k]) => k);

      const batch = await store.applySyncBatch({
        putRides: pushRes.rides || [],
        delRideIds,
        putSettings: pushRes.settings || {},
        delSettingKeys,
        putWellness: pushRes.wellness || [],
        tombstones: pushRes.tombstones || [],
        now: Number(pushRes.serverTime) || this.now()
      });

      const shouldRefresh = batch.changed || (pushRes.wellness && pushRes.wellness.length);
      if (shouldRefresh && app) await this._refreshUi(app);

      const wellSources = this.wellness ? await this.wellness.catch(() => null) : null;
      if (wellSources && app && app.healthStore && shouldRefresh) {
        const wChanged = await wellSources.remerge(app.healthStore.days);
        if (wChanged) {
          if (app.saveHealthStore) app.saveHealthStore();
          if (app.refreshHealthDerived) app.refreshHealthDerived();
          if (app.afterHealthChange) app.afterHealthChange();
        }
      }

      await this.prefs.set(PREF_LAST_AT, String(this.now()));
      await this.prefs.remove(PREF_LAST_ERR);
      if (announce && app && app.showToast) {
        app.showToast(batch.changed ? 'Synced with Home Server.' : 'Already up to date with Home Server.', 'success');
      }
      return { ok: true, changed: batch.changed, revision: batch.revision };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      await this.prefs.set(PREF_LAST_ERR, msg);
      if (announce && app && app.showToast) app.showToast(`Sync failed: ${msg}`, 'warning');
      return { ok: false, error: msg };
    }
  }

  async _refreshUi(app) {
    let state = null;
    if (this.reloadStorage) state = await this.reloadStorage().catch(() => null);
    else if (typeof window !== 'undefined' && window.VeloStorage?.reloadFromServer) state = await window.VeloStorage.reloadFromServer().catch(() => null);
    if (!state || !Array.isArray(state.rides)) return;

    // Phone rides stay summary-only in memory (samples are loaded lazily on open).
    app.completedWorkouts = state.rides;
    if (app.loadProfiles) app.profiles = app.loadProfiles();
    if (app.setActiveProfile && state.settings?.apex_velo_active_prof_id && app.profiles?.some((p) => p.id === state.settings.apex_velo_active_prof_id)) {
      app.setActiveProfile(state.settings.apex_velo_active_prof_id, false);
    }
    if (app.loadHealthStore && app.refreshHealthDerived) {
      app.healthStore = app.loadHealthStore();
      app.refreshHealthDerived();
    }
    if (app.blockPlanner && typeof window !== 'undefined' && window.VeloBlockPlanner) {
      app.blockPlanner.block = window.VeloBlockPlanner.load();
      app.renderTrainingBlock && app.renderTrainingBlock();
    }
    if (app._coachReady && typeof localStorage !== 'undefined') {
      try {
        const s = JSON.parse(localStorage.getItem('apex_ask_v1') || 'null');
        if (s && Array.isArray(s.messages)) {
          app.askMessages = s.messages;
          app.askClearedAt = Number(s.clearedAt) || 0;
          if (s.period) app.askPeriod = s.period;
          if (s.from !== undefined) app.askFrom = s.from;
          if (s.to !== undefined) app.askTo = s.to;
          app._coachShown = app.askMessages.length;
          app.renderAskThread && app.renderAskThread();
        }
      } catch { /* ignore */ }
    }
    app.renderHistoryTable && app.renderHistoryTable();
    app.recalculatePmc && app.recalculatePmc();
    app.refreshAnalytics && app.refreshAnalytics();
    app.renderCalendarView && app.renderCalendarView();
    app.renderRiderSummary && app.renderRiderSummary();
    app.updateHeroStats && app.updateHeroStats();
  }
}
