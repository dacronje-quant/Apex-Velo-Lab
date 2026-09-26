    class VeloAiWorkoutArchitect {
      static parsePrompt(promptText) {
        const text = promptText.toLowerCase().trim();
        let totalDurationMin = 45;

        const durMatch = text.match(/(\d+)\s*(?:min|mins|minute|minutes|m\b)/);
        if (durMatch) totalDurationMin = parseInt(durMatch[1], 10);
        else if (text.includes('1 hour') || text.includes('60m')) totalDurationMin = 60;
        else if (text.includes('30 min') || text.includes('30m')) totalDurationMin = 30;

        const intervals = [];
        intervals.push({ name: 'Warmup', duration: 300, pctFtp: 50 });

        if (text.includes('hard start') || text.includes('hard-start') || text.includes('hardstart') || text.includes('fast start')) {
          const isSweetSpot = text.includes('sweetspot') || text.includes('sweet spot') || text.includes('ss');
          const setsMatch = text.match(/(\d+)\s*(?:sets|x)/);
          const sets = setsMatch ? Math.min(6, parseInt(setsMatch[1], 10)) : 4;
          
          if (isSweetSpot) {
            // Hard-start SweetSpot: 45s surge at 120% FTP into sustained 90% FTP SweetSpot hold
            const holdMin = (totalDurationMin >= 60) ? 8 : (totalDurationMin >= 45 ? 6 : 4);
            for (let s = 1; s <= sets; s++) {
              intervals.push({ name: `Set ${s} Hard Surge`, duration: 45, pctFtp: 120 });
              intervals.push({ name: `Set ${s} SweetSpot Hold`, duration: holdMin * 60 - 45, pctFtp: 90 });
              if (s < sets) intervals.push({ name: `Recovery ${s}`, duration: 180, pctFtp: 50 });
            }
          } else {
            // Hard-start VO2max (Rønnestad protocol): 45s surge at 125% FTP into 106% FTP VO2 Plateau
            const holdMin = (totalDurationMin >= 50) ? 4 : 3;
            for (let s = 1; s <= sets; s++) {
              intervals.push({ name: `Set ${s} Hard Surge`, duration: 45, pctFtp: 125 });
              intervals.push({ name: `Set ${s} VO2 Plateau`, duration: holdMin * 60 - 45, pctFtp: 106 });
              if (s < sets) intervals.push({ name: `Recovery ${s}`, duration: 180, pctFtp: 50 });
            }
          }
        }
        else if (text.includes('over-under') || text.includes('over under') || text.includes('under-over')) {
          const setsMatch = text.match(/(\d+)\s*(?:sets|x)/);
          const sets = setsMatch ? Math.min(6, parseInt(setsMatch[1], 10)) : 3;
          for (let s = 1; s <= sets; s++) {
            intervals.push({ name: `Set ${s} Under`, duration: 120, pctFtp: 95 });
            intervals.push({ name: `Set ${s} Over`, duration: 60, pctFtp: 105 });
            intervals.push({ name: `Set ${s} Under`, duration: 120, pctFtp: 95 });
            intervals.push({ name: `Set ${s} Over`, duration: 60, pctFtp: 105 });
            if (s < sets) intervals.push({ name: `Recovery ${s}`, duration: 180, pctFtp: 50 });
          }
        }
        else if (text.includes('30/30') || text.includes('15/15') || text.includes('microburst') || text.includes('tabata')) {
          const isOn30 = text.includes('30/30');
          const onSec = isOn30 ? 30 : 15;
          const offSec = isOn30 ? 30 : 15;
          const onWattsPct = text.includes('150%') ? 150 : 130;
          const reps = isOn30 ? 8 : 12;
          for (let r = 1; r <= reps; r++) {
            intervals.push({ name: `Burst ${r}`, duration: onSec, pctFtp: onWattsPct });
            intervals.push({ name: `Rest ${r}`, duration: offSec, pctFtp: 40 });
          }
        }
        else if (text.match(/(\d+)\s*x\s*(\d+)/)) {
          const m = text.match(/(\d+)\s*x\s*(\d+)/);
          const sets = parseInt(m[1], 10);
          const minutes = parseInt(m[2], 10);
          let targetPct = 90;
          if (text.includes('threshold') || text.includes('100%')) targetPct = 100;
          else if (text.includes('vo2') || text.includes('115%')) targetPct = 115;
          else if (text.includes('sweetspot')) targetPct = 90;

          const pctMatch = text.match(/(\d+)%/);
          if (pctMatch) targetPct = parseInt(pctMatch[1], 10);

          for (let s = 1; s <= sets; s++) {
            intervals.push({ name: `Work Interval ${s}`, duration: minutes * 60, pctFtp: targetPct });
            if (s < sets) intervals.push({ name: `Recovery ${s}`, duration: Math.max(120, Math.round(minutes * 30)), pctFtp: 50 });
          }
        }
        else if (text.includes('pyramid') || text.includes('ladder')) {
          [65, 80, 95, 110, 120, 110, 95, 80, 65].forEach((pct, idx) => {
            intervals.push({ name: `Step ${idx + 1} (${pct}%)`, duration: 180, pctFtp: pct });
          });
        }
        else if (text.includes('easy') || text.includes('recovery') || text.includes('spin') || text.includes('flush')) {
          intervals.push({ name: 'Active Recovery Spin 1', duration: 600, pctFtp: 50 });
          intervals.push({ name: 'Cadence Flush', duration: 480, pctFtp: 55 });
          intervals.push({ name: 'Active Recovery Spin 2', duration: 600, pctFtp: 50 });
        }
        else {
          let genericPct = 85;
          if (text.includes('vo2')) genericPct = 115;
          else if (text.includes('tempo')) genericPct = 80;
          else if (text.includes('threshold')) genericPct = 98;
          intervals.push({ name: 'Main Block 1', duration: 600, pctFtp: genericPct });
          intervals.push({ name: 'Mid Valley', duration: 180, pctFtp: 50 });
          intervals.push({ name: 'Main Block 2', duration: 600, pctFtp: genericPct + 5 });
        }

        intervals.push({ name: 'Cooldown', duration: 300, pctFtp: 40 });

        const totalSec = intervals.reduce((acc, iv) => acc + iv.duration, 0);
        const avgPct = Math.round(intervals.reduce((acc, iv) => acc + iv.pctFtp * iv.duration, 0) / totalSec);
        const estTss = Math.round((totalSec / 3600) * (avgPct / 100) * (avgPct / 100) * 100);

        return {
          id: 'ai_' + Date.now(),
          category: 'custom',
          title: `AI: ${promptText.slice(0, 34)}`,
          desc: `Generated based on prompt: "${promptText}"`,
          durationMin: Math.round(totalSec / 60),
          tss: estTss,
          if: (avgPct / 100).toFixed(2),
          intervals
        };
      }
    }

if (typeof window !== 'undefined') window.VeloAiWorkoutArchitect = VeloAiWorkoutArchitect;
