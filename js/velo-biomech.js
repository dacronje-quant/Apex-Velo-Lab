/**
 * APEX VELO // LAB - 360 degree polar crank-force renderer.
 *
 * The lobes are a pedal-stroke *model* scaled by the measured L/R balance and the
 * measured power (relative to FTP). CPS does not stream crank-angle-resolved
 * torque, so this view never claims per-degree force measurements.
 *
 * Crisp on HiDPI (transform reset on every resize), sized via ResizeObserver,
 * and animated with a critically damped spring so balance changes glide instead of jump.
 */
class VeloBiomechanicsRenderer {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    // Spring-animated display state
    this.spring = { left: 50, leftV: 0, mag: 0, magV: 0 };
    this.resize();
    if (this.canvas && typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this.canvas);
    }
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.ctx) this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  isVisible() {
    return !!(this.ctx && this.width > 0 && this.height > 0 && this.canvas.offsetParent !== null);
  }

  /** Advances the spring toward the targets. dt in seconds. */
  step(targetLeft, targetMag, dt) {
    const k = 90, c = 2 * Math.sqrt(k); // critically damped
    const s = this.spring;
    const h = Math.min(0.05, Math.max(0, dt || 0.016));
    s.leftV += ((targetLeft - s.left) * k - s.leftV * c) * h;
    s.left += s.leftV * h;
    s.magV += ((targetMag - s.mag) * k - s.magV * c) * h;
    s.mag += s.magV * h;
  }

  /**
   * @param {object} state { crankAngle, leftBalance, rightBalance, power, ftp, dt }
   */
  render(state) {
    if (!state || typeof state !== 'object' || !this.isVisible()) return;
    const leftTarget = Number.isFinite(state.leftBalance) ? state.leftBalance : 50;
    const magTarget = state.ftp > 0 ? Math.max(0, Math.min(1.6, (state.power || 0) / state.ftp)) : 0;
    this.step(leftTarget, magTarget, state.dt);

    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.min(cx, cy) * 0.8;
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    // Grid rings + spokes
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.10)';
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75, 1.0].forEach(f => { ctx.beginPath(); ctx.arc(cx, cy, maxR * f, 0, Math.PI * 2); ctx.stroke(); });
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * maxR * 0.12, cy + Math.sin(a) * maxR * 0.12);
      ctx.lineTo(cx + Math.cos(a) * maxR, cy + Math.sin(a) * maxR);
      ctx.stroke();
    }

    ctx.font = '500 10px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('0° TDC', cx, cy - maxR - 12);
    ctx.fillText('180° BDC', cx, cy + maxR + 12);
    ctx.fillText('90°', cx + maxR + 18, cy);
    ctx.fillText('270°', cx - maxR - 20, cy);

    // Dead-spot markers
    ctx.fillStyle = 'rgba(244, 63, 94, 0.28)';
    ctx.beginPath(); ctx.arc(cx, cy - maxR, 5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy + maxR, 5, 0, Math.PI * 2); ctx.fill();

    const s = this.spring;
    const mag = Math.max(0, s.mag);
    const leftRatio = Math.max(0, Math.min(1, s.left / 100));
    const rightRatio = 1 - leftRatio;
    // Right leg drives 0-180 (downstroke on the drive side), left leg 180-360.
    const scale = 0.3 + 0.7 * Math.min(1, mag);
    if (mag > 0.02) {
      this.drawLobe(ctx, cx, cy, maxR * scale, 0, Math.PI, rightRatio * 2, '#22d3ee', 'rgba(34, 211, 238, 0.16)');
      this.drawLobe(ctx, cx, cy, maxR * scale, Math.PI, Math.PI * 2, leftRatio * 2, '#fbbf24', 'rgba(251, 191, 36, 0.16)');
      this.drawPhaseArc(ctx, cx, cy, maxR + 5, 15, 165, '#22d3ee');
      this.drawPhaseArc(ctx, cx, cy, maxR + 5, 195, 345, '#fbbf24');
    }

    // Crank arm
    const crankRad = (((state.crankAngle || 0) - 90) * Math.PI) / 180;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(crankRad) * maxR * 0.95, cy + Math.sin(crankRad) * maxR * 0.95);
    ctx.stroke();
    ctx.fillStyle = '#0b1220';
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  drawLobe(ctx, cx, cy, radius, a0, a1, share, stroke, fill) {
    const steps = 72;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const th = a0 + (i / steps) * (a1 - a0);
      const f = Math.pow(Math.sin(th - a0), 1.8);
      const r = radius * Math.min(1.25, share) * (0.12 + 0.88 * f);
      const px = cx + Math.sin(th) * r;
      const py = cy - Math.cos(th) * r;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  drawPhaseArc(ctx, cx, cy, r, d0, d1, color) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, ((d0 - 90) * Math.PI) / 180, ((d1 - 90) * Math.PI) / 180);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  }

  destroy() {
    if (this.ro) this.ro.disconnect();
  }
}

if (typeof window !== 'undefined') window.VeloBiomechanicsRenderer = VeloBiomechanicsRenderer;
