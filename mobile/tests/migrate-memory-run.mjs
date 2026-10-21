// Child process of native-store.test.mjs, run with a capped heap: moves `rides` rides of `samples` samples
// from a fake WebView storage (built one ride at a time, never all at once) into a store on node:sqlite,
// then loads the history the way js/velo-storage.js does (GET /api/storage). Prints one JSON line.
import path from 'node:path';
import { NativeStore } from '../src/native-store.js';
import { WebViewMigration } from '../src/native-migrate.js';
import { nodeDriver, folderFiles } from './sqlite-node.js';

const [dir, rideArg, sampleArg] = process.argv.slice(2);
const RIDES = Number(rideArg), SAMPLES = Number(sampleArg);
const start = Date.now();
let heapPeak = 0, rssPeak = 0;
const sample = () => { const m = process.memoryUsage(); heapPeak = Math.max(heapPeak, m.heapUsed); rssPeak = Math.max(rssPeak, m.rss); };
const timer = setInterval(sample, 20);

const ride = (i) => ({ id: 'ride_' + String(i).padStart(4, '0'), date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString(), title: `Ride ${i}`, duration: SAMPLES,
  samples: Array.from({ length: SAMPLES }, (_, t) => ({ time: t + 1, timestamp: Date.UTC(2025, 0, 1) + i * 86400000 + t * 1000, power: 150 + ((t * 7 + i) % 120), hr: 120 + (t % 40), cadence: 85 + (t % 11), speed: 30.5 })) });
const source = {
  historyText: () => null, localHistory: () => null, settings: () => ({ apex_velo_profiles: '[{"id":"r","name":"Memory","ftp":250}]' }),
  dbSettings: async () => [],
  ride: async (id) => ride(Number(String(id).slice(5))),
  async ridesAfter(key, n) { const from = key === null ? 0 : Number(String(key).slice(5)) + 1; const out = []; for (let i = from; i < Math.min(RIDES, from + n); i++) out.push(ride(i)); return out; },
  rideKeys: async () => Array.from({ length: RIDES }, (_, i) => 'ride_' + String(i).padStart(4, '0'))
};
const store = await NativeStore.open({ db: nodeDriver(path.join(dir, 'apex.sqlite')), files: folderFiles(path.join(dir, 'backups')), backupDelayMs: 3600000 });
const moved = await new WebViewMigration({ store, source }).run();
sample();
const movePeak = { heap: heapPeak, rss: rssPeak };
const r = await store.route('/api/storage', 'GET');
const state = await new Response(new Blob(r.chunks)).json(); // as velo-storage reads it
sample();
const result = { rides: moved.rides, loaded: state.rides.length, samples: state.rides.reduce((n, x) => n + x.samples.length, 0),
  historyMB: Math.round(JSON.stringify(ride(0)).length * RIDES / 1e6), moveHeapPeakMB: Math.round(movePeak.heap / 1048576), moveRssPeakMB: Math.round(movePeak.rss / 1048576),
  heapPeakMB: Math.round(heapPeak / 1048576), rssPeakMB: Math.round(rssPeak / 1048576), seconds: Math.round((Date.now() - start) / 1000) };
clearInterval(timer);
await store.close();
console.log(JSON.stringify(result));
