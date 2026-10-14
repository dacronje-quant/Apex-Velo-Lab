// Live-refresh, hover, band and date checks for the FTP history card.
// Synthetic data only, isolated temporary SQLite server, rider's browser set west of Greenwich on purpose.
const { chromium } = require('playwright'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fixture } = require('./sqlite-fixture.cjs');
(async () => {
  const f = await fixture(), browser = await chromium.launch(require('./browser-options.cjs'));
  try {
    const state = await (await fetch(f.base + '/api/storage')).json();
    const profile = { id: 'prof_ftp_live', name: 'FTP live fixture', ftp: 210, maxHr: 175, age: 35, weightKg: 95 };
    const asOf = new Date(Date.now() - 86400000).toISOString(), dateOnly = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const bundle = { schema: 'apex-ftp-history', version: 1, profileId: profile.id, asOf, context: { maxHr: 175, age: 35 }, series: {
      B: [{ date: dateOnly, dateOnly: true, value: 201, low: 166, high: 236, workoutImplied: 199, title: 'Hard workout' }],
      trainerRoad: [{ date: '2020-01-01', value: 200 }] } };
    const migration = await fetch(f.base + '/api/storage/migrate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: state.revision, operationId: 'ftp_live_migration', rides: [], settings: { apex_velo_profiles: JSON.stringify([profile]), apex_velo_active_prof_id: profile.id }, dbSettings: [] }) });
    assert.ok(migration.ok);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/New_York' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(f.base);
    await page.waitForFunction(() => window.app && VeloStorage.enabled && app.ftpMetricsChart);
    await page.locator('[data-tab="analytics"]').click();
    await page.waitForFunction(() => document.getElementById('ftpMetricsStatus').textContent.includes('No saved'));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ftp-live-')), 'history.json'); fs.writeFileSync(file, JSON.stringify(bundle));
    await page.locator('#ftpMetricsFile').setInputFiles(file);
    await page.waitForFunction(() => app._ftpMetricBundle?.series.B.length === 1);
    assert.doesNotMatch(await page.locator('#ftpMetricsStatus').innerText(), /new workout/);

    // Date-only points keep their calendar day for a rider west of UTC (tooltip and table).
    const days = await page.evaluate(d => {
      const day = new Date(d + 'T00:00:00Z'), opt = { day: 'numeric', month: 'short', year: 'numeric' };
      return { zone: Intl.DateTimeFormat().resolvedOptions().timeZone, tooltip: day.toLocaleDateString('en-GB', { ...opt, timeZone: 'UTC' }),
        table: day.toLocaleDateString('en-GB', { timeZone: 'UTC' }), naive: day.toLocaleDateString('en-GB') };
    }, dateOnly);
    assert.equal(days.zone, 'America/New_York'); assert.notEqual(days.naive, days.table, 'fixture must sit on a day that local formatting would shift');
    await page.locator('#ftpMetricsHistoryCard').scrollIntoViewIfNeeded();

    // The band is painted (and can be switched off) without adding anything hoverable.
    const bandAlpha = () => page.evaluate(() => {
      const c = app.ftpMetricsChart, b = c.data.datasets.find(d => d.metric === 'B').data[0], dpr = c.currentDevicePixelRatio || 1;
      return c.ctx.getImageData(Math.round(c.scales.x.getPixelForValue(b.x) * dpr), Math.round(c.scales.y.getPixelForValue((b.high + b.y) / 2) * dpr), 1, 1).data[3];
    });
    assert.ok(await bandAlpha() > 0, 'uncertainty band is drawn');
    await page.locator('#ftpMetricsBand').uncheck(); assert.equal(await bandAlpha(), 0, 'band disappears when switched off');
    await page.locator('#ftpMetricsBand').check(); assert.ok(await bandAlpha() > 0);

    // Hovering the band edge always gives a tooltip for a real series (never an empty one); hovering the estimate gives its own, with the right day.
    const hover = async which => {
      const at = await page.evaluate(which => {
        const c = app.ftpMetricsChart, b = c.data.datasets.find(d => d.metric === 'B').data[0], r = c.canvas.getBoundingClientRect();
        return { x: r.left + c.scales.x.getPixelForValue(b.x), y: r.top + c.scales.y.getPixelForValue(which === 'edge' ? b.high : b.y) };
      }, which);
      assert.ok(at.y > 0 && at.y < 1000, which + ' is inside the viewport');
      await page.mouse.move(at.x - 20, at.y); await page.mouse.move(at.x, at.y); await page.waitForTimeout(150);
      return page.evaluate(() => ({ labels: app.ftpMetricsChart.tooltip.dataPoints?.map(p => p.dataset.label) || [], title: app.ftpMetricsChart.tooltip.title || [] }));
    };
    const edge = await hover('edge');
    assert.ok(edge.labels.length > 0 && edge.labels.every(l => !/range/i.test(l)), 'band edge never yields an empty tooltip (got ' + JSON.stringify(edge.labels) + ')');
    const onPoint = await hover('point');
    assert.deepEqual(onPoint.labels, ['Power + Heart Rate']);
    assert.equal(onPoint.title[0], days.tooltip + ' · date only');
    await page.locator('#ftpMetricsHistoryCard summary').click();
    await page.waitForFunction(() => document.querySelectorAll('#ftpMetricsTable tr').length > 0);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('#ftpMetricsTable tr')].find(r => r.cells[1].textContent === 'Power + Heart Rate').cells[0].textContent), days.table);
    await page.locator('#ftpMetricsHistoryCard summary').click();

    // "All" starts at the first drawn point, not at the preserved 2020 benchmark.
    await page.evaluate(() => app.setAnalyticsRange('all'));
    assert.ok(await page.evaluate(() => app.ftpMetricsChart.options.scales.x.min) > Date.parse('2024-01-01'), 'hidden benchmark must not stretch the axis');
    await page.evaluate(() => app.setAnalyticsRange('6m'));

    // A workout finishes while the analytics tab is hidden: every view updates without a reload.
    const activeBefore = await page.evaluate(() => app.ftpMetricsChart.data.datasets.find(d => d.metric === 'active').data.length);
    const tilesBefore = await page.evaluate(() => JSON.stringify(app._dashData.tiles.map(t => t.now)));
    const pmcBefore = await page.evaluate(() => document.getElementById('pmcValCtl').textContent);
    const otherTab = await page.evaluate(() => [...document.querySelectorAll('[data-tab]')].map(b => b.dataset.tab).find(t => t !== 'analytics'));
    await page.locator(`[data-tab="${otherTab}"]`).first().click();
    await page.evaluate(async () => {
      const samples = Array.from({ length: 1800 }, (_, i) => ({ time: i + 1, power: 200 + (i % 20), hr: 140 + (i % 10), cadence: 85 }));
      app.recordedSamples = samples; app.totalElapsedSeconds = 1800; app.sessionStartedAt = Date.now() - 1800000; app.isWorkoutCompleted = false;
      await app.finishWorkout(true); await VeloStorage.flush();
      app.closeModal('rideSummaryModal');
    });
    await page.locator('[data-tab="analytics"]').click();
    await page.waitForFunction(() => /1 new workout since this snapshot/.test(document.getElementById('ftpMetricsStatus').textContent), null, { timeout: 5000 });
    const after = await page.evaluate(() => {
      const c = app.ftpMetricsChart, active = c.data.datasets.find(d => d.metric === 'active').data;
      return { activeCount: active.length, hasRideEvent: active.some(p => /this ride/.test(p.reason || '')), tiles: JSON.stringify(app._dashData.tiles.map(t => t.now)),
        pmc: document.getElementById('pmcValCtl').textContent, width: c.width, estimate: document.getElementById('ftpMetricsEstimateValue').textContent };
    });
    assert.ok(after.activeCount > activeBefore, 'FTP in Use gains the new ride without a reload');
    assert.ok(after.hasRideEvent, 'new ride is recorded as an FTP-in-use event');
    assert.notEqual(after.tiles, tilesBefore, 'analytics tiles recalculated after the workout');
    assert.notEqual(after.pmc, pmcBefore, 'fitness/fatigue recalculated after the workout');
    assert.ok(after.width > 200, 'chart is sized correctly after the tab was hidden during the workout');
    assert.equal(after.estimate, '201 W', 'saved model estimate is kept and flagged as stale, never invented');

    // Accepting a new training FTP updates the card straight away.
    await page.evaluate(() => app.acceptFtpSuggestion(220));
    assert.equal(await page.locator('#ftpMetricsActiveValue').innerText(), '220 W');
    assert.equal(await page.evaluate(() => app.ftpMetricsChart.data.datasets.find(d => d.metric === 'active').data.at(-1).y), 220);
    assert.deepEqual(errors, []);
    console.log('PASS FTP live refresh: workout completion with hidden tab, FTP change, band hover, date-only day, All range and lazy table.');
  } finally { await browser.close(); await f.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
