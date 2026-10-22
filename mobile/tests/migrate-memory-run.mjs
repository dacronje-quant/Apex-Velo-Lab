// Child process of native-store.test.mjs, run with a capped heap. `move`: moves `rides` rides of `samples` samples
// from a fake WebView storage (built one ride at a time, never all at once) into a store on node:sqlite. `start`:
// opens that store as the app does at a later start and loads the history the way js/velo-storage.js does
// (GET /api/storage, summary-only). Prints one JSON line with the memory peaks.
import path from 'node:path';
import { NativeStore } from '../src/native-store.js';
import { WebViewMigration } from '../src/native-migrate.js';
import { nodeDriver, folderFiles } from './sqlite-node.js';
import { pageSummary } from './summary-node.js';

const [mode, dir, rideArg, sampleArg] = process.argv.slice(2);
const RIDES = Number(rideArg), SAMPLES = Number(sampleArg);
const start = Date.now();
let heapPeak = 0, rssPeak = 0;
const sample = () => { const m = process.memoryUsage(); heapPeak = Math.max(heapPeak, m.heapUsed); rssPeak = Math.max(rssPeak, m.rss); };
const timer = setInterval(sample, 10);
const mb = (b) => Math.round(b / 1048576);

const ride = (i) => ({ id: 'ride_' + String(i).padStart(4, '0'), date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString(), title: `Ride ${i}`, duration: SAMPLES, ftpAtRide: 250,
  samples: Array.from({ length: SAMPLES }, (_, t) => ({ time: t + 1, timestamp: Date.UTC(2025, 0, 1) + i * 86400000 + t * 1000, power: 150 + ((t * 7 + i) % 120), hr: 120 + (t % 40), cadence: 85 + (t % 11), speed: 30.5 })) });
const source = {
  historyText: () => null, localHistory: () => null, settings: () => ({ apex_velo_profiles: '[{"id":"r","name":"Memory","ftp":250}]' }),
  dbSettings: async () => [],
  ride: async (id) => ride(Number(String(id).slice(5))),
  async ridesAfter(key, n) { const from = key === null ? 0 : Number(String(key).slice(5)) + 1; const out = []; for (let i = from; i < Math.min(RIDES, from + n); i++) out.push(ride(i)); return out; },
  rideKeys: async () => Array.from({ length: RIDES }, (_, i) => 'ride_' + String(i).padStart(4, '0'))
};
const { summarize, summaryVersion, VeloRideSummary } = pageSummary();
const store = await NativeStore.open({ db: nodeDriver(path.join(dir, 'apex.sqlite')), files: folderFiles(path.join(dir, 'backups')), backupDelayMs: 3600000, summarize, summaryVersion });
let result;
if (mode === 'move') {
  const moved = await new WebViewMigration({ store, source }).run();
  sample();
  result = { rides: moved.rides, historyMB: Math.round(JSON.stringify(ride(0)).length * RIDES / 1e6) };
} else {
  const r = await store.route('/api/storage', 'GET');
  const state = await new Response(new Blob(r.chunks)).json(); // as velo-storage reads it
  sample();
  result = { loaded: state.rides.length, withSamples: state.rides.filter((x) => Array.isArray(x.samples)).length,
    withSummary: state.rides.filter((x) => VeloRideSummary.get(x)).length, samples: state.rides.reduce((n, x) => n + VeloRideSummary.count(x), 0) };
}
clearInterval(timer);
await store.close();
console.log(JSON.stringify({ ...result, heapPeakMB: mb(heapPeak), rssPeakMB: mb(rssPeak), seconds: Math.round((Date.now() - start) / 1000) }));
