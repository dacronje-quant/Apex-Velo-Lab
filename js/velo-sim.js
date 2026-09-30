    class VeloSimulator {
      constructor() {
        this.enabled = false;
        this.crankAngle = 0;
        this.cadence = 0;
        this.power = 0;
        this.heartRate = 0;
        this.leftBalance = 50.0;
        this.rightBalance = 50.0;
        this.leftSmoothness = 24;
        this.rightSmoothness = 25;
        this.leftTorque = 78;
        this.rightTorque = 81;
      }
      reset() {
        this.power = 0;
        this.cadence = 0;
        this.heartRate = 0;
        this.crankAngle = 0;
      }
      step(targetPower, ftp = 185) {
        if (!this.enabled) return;
        const jitter = (Math.random() - 0.5) * 6;
        const targetWithJitter = targetPower + jitter;
        this.power += (targetWithJitter - this.power) * 0.45;

        const cadNoise = (Math.random() - 0.5) * 1.5;
        this.cadence = Math.max(70, Math.min(115, Math.round(91 + (this.power / ftp - 1) * 6 + cadNoise)));

        const targetHr = 95 + (this.power / ftp) * 75;
        this.heartRate += (targetHr - this.heartRate) * 0.08;

        const asymmetry = Math.sin(Date.now() / 15000) * 1.2;
        this.leftBalance = parseFloat((49.8 - asymmetry).toFixed(1));
        this.rightBalance = parseFloat((100 - this.leftBalance).toFixed(1));

        this.leftSmoothness = Math.round(23 + Math.random() * 3);
        this.rightSmoothness = Math.round(24 + Math.random() * 3);
        this.leftTorque = Math.round(76 + Math.random() * 5);
        this.rightTorque = Math.round(78 + Math.random() * 5);
      }
      rotateCrank(fpsDt) {
        if (this.cadence <= 0) return this.crankAngle;
        const degPerSec = (this.cadence / 60) * 360;
        this.crankAngle = (this.crankAngle + degPerSec * fpsDt) % 360;
        return this.crankAngle;
      }
    }

if (typeof window !== 'undefined') window.VeloSimulator = VeloSimulator;
