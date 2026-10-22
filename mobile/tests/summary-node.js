/**
 * The page's ride summary (js/velo-ride-summary.js and the analytics it uses) for node tests of the phone store,
 * as src/index.js passes it from the page. Never part of the app build.
 */
import vm from 'node:vm';
import fs from 'node:fs';

export function pageSummary() {
  const root = new URL('../../js/', import.meta.url).pathname;
  const ctx = vm.createContext({ window: {}, console });
  const load = (name) => vm.runInContext(fs.readFileSync(`${root}${name}.js`, 'utf8'), ctx);
  for (const name of ['velo-metrics', 'velo-insight', 'velo-trends', 'velo-power']) load(name);
  ctx.window.VeloPower = vm.runInContext('VeloPower', ctx);
  load('velo-ftp-model');
  vm.runInContext('var VeloFtpModel = window.VeloFtpModel;', ctx);
  load('velo-ride-summary');
  const S = vm.runInContext('VeloRideSummary', ctx);
  return { summarize: (ride) => S.of(ride), summaryVersion: S.VERSION, VeloRideSummary: S };
}
