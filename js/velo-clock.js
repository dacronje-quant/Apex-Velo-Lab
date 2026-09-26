/**
 * APEX VELO // LAB - Drift-free 1 Hz workout clock.
 *
 * Browsers throttle main-thread timers in background tabs (Chrome's "intensive
 * throttling" can delay chained timers to once per minute), which would stall a
 * workout when the rider switches to another window. The tick source therefore
 * lives in a tiny dedicated Worker, whose timers are not subject to that
 * throttling. Ticks are scheduled against the absolute start time, so a
 * multi-hour ride accumulates no drift. Falls back to a self-correcting
 * setTimeout chain when Workers are unavailable (e.g. file:// in some browsers).
 */
class VeloClock {
  constructor(onTick) {
    this.onTick = onTick;
    this.running = false;
    this.worker = null;
    this.workerUrl = null;
    this.timeoutId = null;
    this.expected = 0;
    this.lastTickAt = 0;
  }

  static WORKER_SRC = `
    let t = null, expected = 0, gen = 0;
    function loop() {
      const now = Date.now();
      if (now - expected > 3000) expected = now; // machine slept: resync instead of replaying missed seconds
      postMessage(gen);
      expected += 1000;
      t = setTimeout(loop, Math.max(0, expected - Date.now()));
    }
    onmessage = (e) => {
      if (e.data && e.data.cmd === 'start') { clearTimeout(t); gen = e.data.gen; expected = Date.now() + 1000; t = setTimeout(loop, 1000); }
      else if (e.data && e.data.cmd === 'stop') { clearTimeout(t); t = null; }
    };`;

  start() {
    this.stop();
    this.gen = (this.gen || 0) + 1;
    this.running = true;
    this.lastTickAt = performance.now();
    if (this._ensureWorker()) {
      this.worker.postMessage({ cmd: 'start', gen: this.gen });
      return;
    }
    this.expected = Date.now() + 1000;
    const loop = () => {
      if (!this.running) return;
      if (Date.now() - this.expected > 3000) this.expected = Date.now();
      this._fire();
      this.expected += 1000;
      this.timeoutId = setTimeout(loop, Math.max(0, this.expected - Date.now()));
    };
    this.timeoutId = setTimeout(loop, 1000);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timeoutId);
    this.timeoutId = null;
    if (this.worker) this.worker.postMessage({ cmd: 'stop' });
  }

  _fire() {
    this.lastTickAt = performance.now();
    try { this.onTick(); } catch (e) { console.error('[VeloClock] tick handler failed', e); }
  }

  _ensureWorker() {
    if (this.worker) return true;
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') return false;
    try {
      this.workerUrl = URL.createObjectURL(new Blob([VeloClock.WORKER_SRC], { type: 'text/javascript' }));
      this.worker = new Worker(this.workerUrl);
      // Ignore ticks queued by a previous start/stop cycle (pause/resume races).
      this.worker.onmessage = (e) => { if (this.running && e.data === this.gen) this._fire(); };
      this.worker.onerror = () => { this._disposeWorker(); if (this.running) this.start(); };
      return true;
    } catch (e) {
      this._disposeWorker();
      return false;
    }
  }

  _disposeWorker() {
    if (this.worker) { try { this.worker.terminate(); } catch (e) { /* ignore */ } }
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.worker = null;
    this.workerUrl = null;
  }

  /** Fraction (0..1) of the current second already elapsed - used for 60 fps playhead interpolation. */
  subSecondProgress() {
    if (!this.running) return 0;
    return Math.max(0, Math.min(1, (performance.now() - this.lastTickAt) / 1000));
  }

  destroy() {
    this.stop();
    this._disposeWorker();
  }
}

if (typeof window !== 'undefined') window.VeloClock = VeloClock;
