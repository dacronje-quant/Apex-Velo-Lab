# FTP estimate history in Analytics

Analytics → Power & CP includes a separate **FTP estimates & evidence over time** chart. Existing monthly NP, setting history and CP/W′ charts remain available. The page time-range controls also filter the new chart.

The main chart shows **FTP in Use** and **Power + Heart Rate**, the leading experimental estimate. Styled checkboxes control the uncertainty band and workout-implied FTP dots. Dots show eligible single-workout HR-power estimates at the assumed threshold heart rate, distinct from the history-based estimate; hover shows the workout title. Both options start enabled. Current values appear above the chart. The band is conditional model uncertainty, not validated FTP coverage. Missing estimates remain gaps; trend-line points are suppressed until hover to keep the chart readable.

**Supporting calculations & history** is collapsed initially and contains a table of Power Curve, Bayesian Power Curve, Workout Capacity Floor, and the prior-dependent Workout Capacity Model alongside the main histories. These checks do not crowd the main chart and are not standalone FTP recommendations. Neither recorded nor forecast TrainerRoad FTP appears in Analytics; it was a research benchmark only. Existing benchmark records remain preserved in old exports/backups for compatibility.

## Calculation histories

This view consumes saved derived calculation results. It does not run the experimental Python estimators in the browser and does not implement automatic FTP setting updates. If workouts postdate the saved snapshot or profile age/max HR/LTHR differ, the chart displays a refresh notice. Settings are never changed by importing estimates.

Use **Import calculation history** to load an `apex-ftp-history` version-1 JSON export for the active profile. Histories are scoped by exact profile ID, persisted through the existing VeloDB/SQLite layer, included in database backups, and isolated when switching profiles. The current rider's research results can be converted to this format using the private research pipeline's export helper after regenerating the model results. No personal data is bundled in the application files.

The schema has `schema`, `version`, `profileId`, `asOf`, `modelVersion`, optional `context` (age/maxHr/lthr), and `series` arrays named `A`, `Aplus`, `B`, `C`, `Cfloor`, and `trainerRoad`. Each point contains `date`, nullable `value`, optional `low`/`high`, `title`, `reason`, `rangeKind`, `dateOnly`, and `order`. TrainerRoad same-day source order is preserved without inventing update times. Imported future points, invalid values/bounds, oversized histories and profile mismatches are rejected.

Actual FTP in use is derived separately from recorded ride settings, profile FTP-change events and the current setting; a current setting alone is not backfilled into invented past history. Only stepped setting series can carry a preceding known value into the selected range. Model estimates are not extrapolated beyond their saved evidence.

## Verification

Run `node --test tests/ftp-history.test.js` and `node tests/ftp-history-browser.cjs`. The browser test uses an isolated temporary SQLite server and synthetic data; it checks import persistence/reload, series/band controls, mobile fit, profile isolation and unchanged rides/training FTP. The feature uses existing local Chart.js and ships its own local CSS/JS in the offline cache.
