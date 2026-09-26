    class VeloPip {
      constructor(app) {
        this.app = app;
        this.canvas = document.getElementById('pipCanvas');
        this.video = document.getElementById('pipVideo');
        this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
        this.active = false;
        this.stream = null;

        if (this.video) {
          this.video.addEventListener('enterpictureinpicture', () => {
            this.active = true;
            document.getElementById('btnTogglePip')?.classList.add('active');
          });
          this.video.addEventListener('leavepictureinpicture', () => {
            this.active = false;
            document.getElementById('btnTogglePip')?.classList.remove('active');
          });
        }
      }

      async toggle() {
        if (!document.pictureInPictureEnabled) {
          this.app.showToast('Picture-in-Picture is not supported in this browser.', 'warning');
          return;
        }
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture().catch(() => {});
          this.active = false;
          return;
        }
        try {
          this.renderMiniHud();
          if (!this.stream && this.canvas && this.canvas.captureStream) {
            this.stream = this.canvas.captureStream(10);
            this.video.srcObject = this.stream;
          }
          await this.video.play().catch(() => {});
          await this.video.requestPictureInPicture();
          this.active = true;
        } catch (err) {
          console.warn('PiP launch error', err);
          this.app.showToast('Could not start the mini HUD: ' + err.message, 'error');
        }
      }

      renderMiniHud() {
        if (!this.ctx || !this.canvas) return;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.ctx;

        ctx.fillStyle = '#090d16';
        ctx.fillRect(0, 0, w, h);

        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, w, 30);
        ctx.fillStyle = '#22d3ee';
        ctx.font = 'bold 11px Inter, sans-serif';
        ctx.fillText('APEX VELO // MINI HUD', 12, 20);

        const iv = this.app.currentWorkout.intervals[this.app.intervalIndex];
        const ivName = iv ? iv.name : 'Interval';
        ctx.fillStyle = '#94a3b8';
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(ivName, w - 12, 20);
        ctx.textAlign = 'left';

        const power = this.app.currentPower || 0;
        const target = this.app.getCurrentTargetWatts();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 44px "JetBrains Mono", monospace';
        ctx.fillText(power.toString(), 14, 82);
        ctx.font = 'bold 16px "JetBrains Mono", monospace';
        ctx.fillStyle = '#64748b';
        ctx.fillText('W', 14 + ctx.measureText(power.toString()).width + 6, 68);

        ctx.fillStyle = '#1e293b';
        ctx.fillRect(14, 96, 135, 24);
        ctx.fillStyle = '#22d3ee';
        ctx.font = 'bold 11px "JetBrains Mono", monospace';
        ctx.fillText(`TARGET: ${target}W`, 22, 112);

        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 15px "JetBrains Mono", monospace';
        ctx.fillText(`${this.app.currentCadence || 0} RPM`, 195, 66);

        ctx.fillStyle = '#fb7185';
        ctx.fillText(`${this.app.currentHeartRate || 0} BPM`, 195, 88);

        const timeStr = this.app.fmtTime(this.app.intervalSecondsRemaining);
        ctx.fillStyle = '#a3e635';
        ctx.font = 'bold 18px "JetBrains Mono", monospace';
        ctx.fillText(timeStr, 195, 114);

        // Speed & Distance in PiP
        const speedStr = `${(this.app.currentSpeed || 0).toFixed(1)} km/h`;
        const distStr = `${(this.app.totalDistanceKm || 0).toFixed(2)} km`;
        ctx.fillStyle = '#22d3ee';
        ctx.font = 'bold 13px "JetBrains Mono", monospace';
        ctx.fillText(`SPD: ${speedStr}`, 195, 140);
        ctx.fillStyle = '#a78bfa';
        ctx.fillText(`DST: ${distStr}`, 195, 164);

        // Smoothed Power stats on left
        const p3s = this.app.getSmoothedPower ? this.app.getSmoothedPower(3) : power;
        ctx.fillStyle = '#94a3b8';
        ctx.font = 'bold 12px "JetBrains Mono", monospace';
        ctx.fillText(`3s AVG: ${p3s}W`, 22, 140);
        const wkg = (power / (this.app.activeProfile ? this.app.activeProfile.weightKg : 75)).toFixed(2);
        ctx.fillText(`${wkg} W/kg`, 22, 164);

        if (iv && iv.duration) {
          const pct = Math.max(0, Math.min(1, (iv.duration - this.app.intervalSecondsRemaining) / iv.duration));
          ctx.fillStyle = '#334155';
          ctx.fillRect(0, h - 6, w, 6);
          ctx.fillStyle = '#22d3ee';
          ctx.fillRect(0, h - 6, w * pct, 6);
        }
      }
    }

if (typeof window !== 'undefined') window.VeloPip = VeloPip;
