// Entirely synthetic rides for the opt-in playground and isolated browser suite.
(function (root) {
  const profile = { id: 'prof_demo', name: 'Demo rider', ftp: 185, weightKg: 75, maxHr: 175 };
  function history() {
    const today = new Date(); today.setHours(8, 0, 0, 0);
    const rides = Array.from({ length: 104 }, (_, i) => {
      const date = new Date(today); date.setDate(date.getDate() - i * 2 - 1);
      const duration = 1800 + (i % 5) * 600, avgPower = 105 + (i % 6) * 12, np = avgPower + 6;
      return { id: `demo_ride_${i}`, date: date.toISOString(), name: ['Endurance', 'Tempo', 'Easy spin'][i % 3] + ' (synthetic)',
        profileName: profile.name, title: ['Endurance', 'Tempo', 'Easy spin'][i % 3] + ' (synthetic)', duration, durationMin: duration / 60, avgWatts: avgPower, maxWatts: avgPower + 35, np, if: np / profile.ftp,
        tss: Math.round(duration / 3600 * (np / profile.ftp) ** 2 * 100), distanceKm: duration / 3600 * 27,
        totalDistanceMeters: duration / 3600 * 27000, totalCalories: Math.round(avgPower * duration / 1000), kj: Math.round(avgPower * duration / 1000), avgHr: 115 + i % 25, maxHr: 150 + i % 15,
        avgCadence: 88, source: 'Synthetic demo', ftpAtRide: profile.ftp };
    });
    return { riderName: profile.name, estimatedFtp: profile.ftp, maxHeartRate: profile.maxHr, rides,
      allTimeMmp: { durations: [5, 15, 30, 60, 180, 300, 600, 1200, 3600], watts: [520, 450, 380, 310, 260, 240, 220, 205, 185] } };
  }
  root.VeloDemo = { profile, history };
})(typeof window === 'undefined' ? globalThis : window);
