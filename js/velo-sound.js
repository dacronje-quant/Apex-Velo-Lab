    class VeloSoundEngine {
      constructor() {
        this.ctx = null;
        this.muted = false;
        try {
          const saved = localStorage.getItem('apex_sound_muted');
          if (saved !== null) this.muted = JSON.parse(saved);
        } catch (e) {}
      }

      init() {
        if (!this.ctx) {
          const AudioContext = window.AudioContext || window.webkitAudioContext;
          if (AudioContext) this.ctx = new AudioContext();
        }
        if (this.ctx && this.ctx.state === 'suspended') {
          this.ctx.resume().catch(() => {});
        }
      }

      toggleMute() {
        this.muted = !this.muted;
        try {
          localStorage.setItem('apex_sound_muted', JSON.stringify(this.muted));
        } catch (e) {}
        this.updateUi();
        return this.muted;
      }

      updateUi() {
        const btn = document.getElementById('btnToggleAudio');
        if (!btn) return;
        btn.classList.toggle('active', !this.muted);
        btn.title = this.muted ? 'Audio Muted - Click to Enable Beeps (Key: M)' : 'Audio Active - Click to Mute (Key: M)';
        btn.innerHTML = `<svg class="ic"><use href="#${this.muted ? 'i-volume-x' : 'i-volume'}"/></svg>`;
      }

      playTone(freq = 440, duration = 0.1, type = 'sine', gainVal = 0.12) {
        if (this.muted) return;
        try {
          this.init();
          if (!this.ctx) return;
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = type;
          osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
          gain.gain.setValueAtTime(gainVal, this.ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start();
          osc.stop(this.ctx.currentTime + duration);
        } catch (e) {}
      }

      countdownTick(secondsLeft) {
        const freqs = { 3: 440, 2: 520, 1: 620 };
        const f = freqs[secondsLeft] || 440;
        this.playTone(f, 0.08, 'sine', 0.15);
      }

      intervalGo() {
        this.playTone(880, 0.14, 'triangle', 0.22);
        setTimeout(() => {
          this.playTone(1174.66, 0.35, 'triangle', 0.25);
        }, 120);
      }

      complianceAlert() {
        this.playTone(330, 0.12, 'sawtooth', 0.08);
      }

      workoutCompleteFanfare() {
        if (this.muted) return;
        try {
          this.init();
          if (!this.ctx) return;
          const notes = [
            { f: 523.25, d: 0.12, delay: 0 },    // C5
            { f: 659.25, d: 0.12, delay: 130 },  // E5
            { f: 783.99, d: 0.15, delay: 260 },  // G5
            { f: 1046.50, d: 0.45, delay: 420 }  // C6
          ];
          notes.forEach(n => {
            setTimeout(() => this.playTone(n.f, n.d, 'triangle', 0.25), n.delay);
          });
        } catch (e) {}
      }
    }

if (typeof window !== 'undefined') window.VeloSoundEngine = VeloSoundEngine;
