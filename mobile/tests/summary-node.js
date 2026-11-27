/**
 * The page's ride summary (js/velo-ride-summary.js and the analytics it uses) for node tests of the phone store,
 * as src/index.js passes it from the page. Never part of the app build.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function pageSummary() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../js');
  const ctx = vm.createContext({ window: {}, console });
  const load = (name) => vm.runInContext(fs.readFileSync(path.join(root, `${name}.js`), 'utf8'), ctx);
  for (const name of ['velo-metrics', 'velo-insight', 'velo-trends', 'velo-power']) load(name);
  ctx.window.VeloPower = vm.runInContext('VeloPower', ctx);
  load('velo-ftp-model');
  vm.runInContext('var VeloFtpModel = window.VeloFtpModel;', ctx);
  load('velo-ride-summary');
  const S = vm.runInContext('VeloRideSummary', ctx);
  return { summarize: (ride) => S.of(ride), summaryVersion: S.VERSION, VeloRideSummary: S };
}
