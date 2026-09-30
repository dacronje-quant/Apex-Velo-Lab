# Apex Velo Lab review and improvement proposals

Reviewed 30 September 2026 against the current working tree, including existing uncommitted changes. This is a review and proposal document; application code was not changed.

## Validation and limits

- The isolated browser suite completed successfully: **104 checks passed**. It covers recording, pause handling, FIT/TCX/CSV exports, calendar/history, coach logic, training blocks, BLE and ERG mocks, backup behavior, Strava sync and storage isolation.
- The Node test runner reported **27 passing entries and one failing entry**. Passing entries include metrics, sleep processing, pause and ride edge cases. The failing entry is the server integration script: its Node server checks passed, but its PowerShell server could not start on test port 18612.
- PowerShell labels every listener startup exception as a busy port. The actual cause is unverified; it could be a listener permission/reservation issue. Do not treat this as a verified port collision.
- Inspected the rendered cockpit, Analytics, History and Coach in isolated test mode, plus source for storage, backups, dialogs, responsive layout, phone controls and offline caching.
- Real Bluetooth devices, a physical phone and live Strava operations were not exercised. Most integration checks use mocks. The local server logged failed Claude fetch attempts during browser testing, so live AI responses remain unverified. Responsive findings below are based on CSS, not a full device matrix.
- Existing worktree changes were preserved. A temporary Node server was used for browser review.

## Fix first: confirmed reliability and interaction problems

| Priority | Finding and evidence | Proposed change | Acceptance check |
|---|---|---|---|
| High | `js/app.js`, `initKeyboardShortcuts`: Tab prevents normal focus movement and calls `skipInterval`. Space and arrow shortcuts also run while buttons or unrelated screens have focus. | Reserve Tab for navigation. Scope ride controls to Cockpit/Zen; suspend shortcuts in dialogs and editable content; respect native button activation. Keep an explicit next-step shortcut and update shortcut labels. | Tab/Shift+Tab navigate without changing the interval. Space activates a focused button once. Opening Settings cannot change the workout through navigation keys. |
| High | `js/app.js`, `openModal`/`closeModal` only toggle a class. CSS hides closed overlays with opacity and pointer events; closed dialogs appeared in the browser accessibility tree. There is no focus trap or restoration. | Make closed overlays hidden/inert, move focus into the opened dialog, contain focus, restore it on close and make background controls inert while a modal is open. | Only the open dialog is exposed; keyboard focus cannot enter a closed dialog or the page behind an open one. |
| High | `js/app-history.js`, `deleteCompletedRide` removes the in-memory ride before awaiting `VeloDB.deleteRide` and ignores its boolean result. `clearAllWorkouts` likewise changes memory/local storage before checking database success. | Commit database deletion first; update memory and the mirror only after success. Show a useful error on failure. Add recoverable deletion/Undo and a restore point for bulk operations. | Simulated database failure leaves history and totals unchanged and shows no success message. Undo restores samples as well as summaries. |
| High | `js/app-backup.js`, `backupSignature` uses counts, rounded TSS and profile JSON length. Same-length profile edits, renamed rides and edits to existing health days can leave its signature unchanged. | Track a persisted data revision for every meaningful mutation, or fingerprint actual backup content. Preserve the revision changed during an upload so it triggers a follow-up backup. | Renaming a ride, changing FTP from 185 to 195, editing a workout without changing its count, and updating an existing health day all trigger a backup within the normal debounce. |
| Medium | `css/style.css`, the 860px breakpoint hides header tools except Zen, including the Settings button. | Keep Settings reachable at every width through a labelled overflow menu or persistent button. Keep sensor labels readable instead of reducing them to unlabeled dots. | At 390px and 768px, users can reach Settings, backups, profiles and device status without keyboard shortcuts. |
| Medium | Rendered idle cockpit shows 50/50 balance with a MEASURED badge although no pedals are connected; `index.html` contains these defaults. It also shows ERG READY alongside NO SOURCE. | Use `--` and Waiting for pedals until fresh measured balance exists. Distinguish ERG selected, trainer connected, control granted and active control. | Disconnected or stale devices never appear to provide a measured value or active trainer control. |

## Make daily use easier

1. **A short pre-ride checklist.** Show rider/FTP, workout duration, trainer control, power source, HR availability and calibration status above Start. Offer direct Connect actions. Allow recording without optional sensors, with a clear explanation of what will be missing. Simulation should have an unmistakable banner.

2. **A calmer riding screen.** Keep power, target, cadence, HR, remaining interval time and Pause prominent. Show the current and next interval; collapse the full queue and advanced metrics behind Details. Keep Stop & save separate from Reset. The existing Zen mode is a useful foundation for a Simple/Advanced preference.

3. **Clearer navigation.** At ordinary desktop widths the inactive page labels disappear below 1760px, leaving mostly icons. Retain readable labels, possibly by separating page navigation from device controls. Add the active page state for assistive technology. Avoid adding another top-level page.

4. **History search and filters.** Add title search, date range, rider, activity type, source and data-quality filters. Default to the useful columns; let users expand a ride for the rest. Give ride titles an explicit keyboard-accessible Open action and sortable headers actual buttons with sort state. Preserve filter/sort choices.

5. **One consistent import preview.** Strava already has preview, deduplication and Undo. Apply the same model to file/folder/backup imports: New, Matched, Possible duplicate, Invalid; then one Apply action and one result summary. Currently file imports are processed independently, added immediately and saved without awaiting completion before showing success. Include a clear restore mode explaining whether profiles and workouts will merge or replace.

6. **Analytics that answers a question first.** Keep the useful readiness/fitness strip, then present three summaries: readiness today, trend over the selected period, and the main reason. Put detailed curves below. Use the selected period consistently or clearly label fixed 30/90-day comparisons. Show plain-language definitions beside CTL, ATL, TSB, NP and IF, plus measurement source, missing-data reasons and latest data date.

7. **Simpler coaching requests.** Lead with goal, time and how the rider feels. Move history look-back and model options into Advanced. For the result, lead with duration, difficulty, reason and Start this workout; collapse interval tables and reasoning. Keep Training block as a distinct secondary workflow. Explicitly mark offline fallback and stale history.

8. **Calendar as the daily starting point.** Offer a Today card with the planned session, recovery context and Start action. Clearly distinguish planned, completed, missed and rest days. For changing sessions, provide a simple reschedule action before adding drag-and-drop; ensure every change has keyboard support.

9. **Visible save and backup state.** Show Recording / Saving / Saved / Backup pending / Backup failed near the session controls and post-ride summary. Add periodic recoverable in-progress checkpoints; the current unsaved-ride unload warning does not recover a ride after a browser crash. Preserve samples and mark interruption boundaries on resume.

10. **Phone controls with obvious connection state.** Existing long polling, command acknowledgements and double-tap disconnect behavior are good foundations. Make the age of the last update visible and pending/applied/failed commands easy to distinguish. Keep Pause/Resume and power adjustment large and stable; move calibration and device management to a separate screen. Validate on a physical iPhone and Android device before accepting the work.

## Maintenance proposals

- Give the PowerShell launcher an actionable listener error instead of always saying port busy. Use available test ports in integration tests and distinguish startup failure from assertion failure.
- Update README test counts and its statement that Banister PMC is expected to fail: the current browser suite passed that check and completed 104 checks.
- Verify offline upgrades as a complete app version. Network-first per-file caching can mix old and new files when connectivity drops during an update; test that scenario and offer a refresh notice when an update is ready.
- Add targeted regression checks for shortcut scope, focus/dialog behavior, failed deletion, backup change detection and narrow-screen Settings access. These gaps remain despite the broad existing suite.

## Suggested delivery order

1. **Reliability and access:** keyboard behavior, dialogs, deletion outcomes, backup detection, narrow-screen Settings, truthful device states.
2. **Daily workflow:** pre-ride checklist, calmer cockpit, history filters, import preview and visible save states.
3. **Deeper improvements:** interrupted-ride recovery, calendar actions, coach/analytics simplification and offline upgrade validation.

Keep the existing visual identity and domain calculations. These proposals improve the interaction around the functionality already present.
