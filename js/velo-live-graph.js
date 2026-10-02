/** Camera for the phone's whole-workout / following graph. Times are workout seconds. */
(function (root) {
  const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

  class Viewport {
    constructor({ reduceMotion = false } = {}) {
      this.mode = 'full';
      this.reduceMotion = reduceMotion;
      this.current = null;
      this.transition = null;
    }

    setMode(mode, now) {
      const next = mode === 'follow' ? 'follow' : 'full';
      if (next === this.mode) return;
      this.mode = next;
      this.transition = this.current && !this.reduceMotion
        ? { from: { ...this.current }, at: now } : null;
    }

    reset() { this.current = null; this.transition = null; }

    // Keep requesting frames until range() has painted the exact final camera position.
    isAnimating() { return !!this.transition; }

    range(total, progress, now) {
      total = Math.max(0, Number(total) || 0);
      const position = clamp(Number(progress) || 0, 0, 1) * total;
      const span = this.mode === 'follow' ? Math.min(total, 360) : total;
      // Keep four minutes of recent effort and two minutes of upcoming steps in view.
      const start = this.mode === 'follow' ? clamp(position - span * .65, 0, total - span) : 0;
      let view = { start, end: start + span };
      if (this.transition) {
        const fraction = clamp((now - this.transition.at) / 480, 0, 1);
        const ease = fraction * fraction * (3 - 2 * fraction);
        const from = this.transition.from;
        view = {
          start: clamp(from.start + (view.start - from.start) * ease, 0, total),
          end: clamp(from.end + (view.end - from.end) * ease, 0, total)
        };
        if (fraction === 1) this.transition = null;
      }
      this.current = view;
      return { ...view, position };
    }
  }

  const api = { Viewport };
  root.VeloLiveGraph = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
