/**
 * APEX VELO // LAB - Web Worker for bulk history import: reads archives and parses ride files off the
 * page thread, posting rides back in batches (see js/velo-bulk-import.js).
 *
 * In:  { type: 'start', files, opts: { mode, profile, knownHashes } }, { type: 'cancel' }
 * Out: { type: 'progress', counts, path }, { type: 'rides', rides }, { type: 'index', entries },
 *      { type: 'files', rows }, { type: 'done', counts, cancelled }, { type: 'error', message }
 */
importScripts('../vendor/fflate.min.js', 'velo-metrics.js', 'velo-importer.js', 'velo-bulk-import.js');

let cancelled = false;
self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === 'cancel') { cancelled = true; return; }
  if (msg.type !== 'start') return;
  cancelled = false;
  let rows = [], lastProgress = 0;
  const flushRows = () => { if (rows.length) { self.postMessage({ type: 'files', rows }); rows = []; } };
  try {
    const result = await VeloBulkImport.run(msg.files, { ...msg.opts, isCancelled: () => cancelled }, {
      onProgress: (counts, path) => {
        const now = Date.now();
        if (path && now - lastProgress < 100) return;
        lastProgress = now;
        self.postMessage({ type: 'progress', counts, path });
      },
      onRides: (rides) => { flushRows(); self.postMessage({ type: 'rides', rides }); },
      onIndex: (index) => self.postMessage({ type: 'index', entries: [...index.entries()] }),
      onFile: (row) => { rows.push(row); if (rows.length >= 200) flushRows(); }
    });
    flushRows();
    self.postMessage({ type: 'done', counts: result.counts, cancelled: result.cancelled });
  } catch (err) {
    flushRows();
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
