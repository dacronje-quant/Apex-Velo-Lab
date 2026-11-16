/**
 * APEX VELO // LAB - What the analytics across rides need from a ride's per-second samples.
 *
 * The power curve and zones, FTP history, FTP evidence, heart-rate drift, efficiency factor and the coach's
 * "last hard session" read a ride's samples when they are in memory. The Android app keeps samples in its
 * database and loads them per ride, when a view needs them; its rides carry `sampleSummary` instead, made
 * here from the same samples by the same functions, so both give the same numbers. Only the parts that do
 * not depend on the rider are kept: FTP and heart-rate settings are applied when the analytics run.
 * On the desktop every ride has its samples in memory and nothing here is used for its data.
 */
class VeloRideSummary {
  static VERSION = 1;

  /** The summary of a ride with samples (5 or more), else null. */
  static of(ride) {
    const samples = ride && ride.samples;
    if (!Array.isArray(samples) || samples.length < 5) return null;
    const prep = VeloPower.prepare(samples);
    const hist = new Map();
    for (let i = 0; i < prep.n; i++) hist.set(prep.power[i], (hist.get(prep.power[i]) || 0) + 1);
    return {
      v: VeloRideSummary.VERSION,
      n: samples.length,
      pn: prep.n,
      curve: VeloPower.mmp(prep),
      power: [...hist].sort((a, b) => a[0] - b[0]),
      decoupling: VeloInsight.decoupling(samples),
      ef: typeof VeloTrends !== 'undefined' ? VeloTrends.efOf(ride) : null,
      efFtp: Number(ride.ftpAtRide) || 0,
      ftp: VeloInsight.ftpEvidenceBase(samples),
      ramp: VeloInsight.rampEvidenceBase(samples),
      hrp: typeof VeloFtpModel !== 'undefined' ? VeloFtpModel.hrPowerBlocks(prep) : null,
      steps: VeloInsight.intervalSteps(samples)
    };
  }

  /** The ride's summary when it is current, else null. */
  static get(r) {
    const s = r && r.sampleSummary;
    return s && s.v === VeloRideSummary.VERSION && s.n >= 5 ? s : null;
  }

  /** Samples in memory, or a current summary: enough for the analytics across rides. */
  static has(r) { return VeloInsight.hasSamples(r) || !!VeloRideSummary.get(r); }

  /** How many samples the ride has, in memory or not. */
  static count(r) {
    if (r && Array.isArray(r.samples)) return r.samples.length;
    const s = VeloRideSummary.get(r);
    return s ? s.n : 0;
  }

  /** VeloPower.zoneSeconds from the summary's power histogram. */
  static zoneSeconds(s, ftp) {
    const z = [0, 0, 0, 0, 0, 0, 0];
    if (!(ftp > 0) || !s) return z;
    const lim = VeloPower.ZONE_MAX;
    for (const [power, count] of s.power) {
      const pct = (power / ftp) * 100;
      if (pct < lim[0]) { z[0] += count; continue; }
      let k = 1;
      while (k < 6 && pct > lim[k]) k++;
      z[k] += count;
    }
    return z;
  }
}

if (typeof window !== 'undefined') window.VeloRideSummary = VeloRideSummary;
