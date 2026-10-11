# Coaching and training guide review

Implemented on `codex/bluetooth-updates` alongside the Bluetooth changes.

New AI session advice, training-block descriptions and ride reviews ask for short everyday explanations. Training scores remain available to the AI and the workout engine; numeric targets and scheduling rules still work. The offline coach now explains the same decisions without score dumps. Previously saved answers stay as they were until you ask again. Both server launchers apply the same language policy.

Open **Coach > Training terms explained** or **Settings > Training guide**. The guide introduces these proposed names without renaming existing dashboard labels:

| Acronym | Proposed name | Meaning |
| --- | --- | --- |
| CTL | Fitness base | The amount of training you have been used to recently. |
| ATL | Recent training strain | The amount of recent training you need to recover from. |
| TSB | Freshness | A hint about whether recent training leaves you rested or tired. |
| TSS | Workout load | An estimate of how demanding a ride was. |
| FTP | Sustainable power | A power estimate used to set your workout targets. |
| NP | Overall effort power | A power estimate that gives extra weight to hard bursts. |
| IF | Relative ride effort | How hard a ride was compared with your sustainable power. |
| HRV | Heartbeat variation | Small changes in timing between heartbeats, compared with your own usual pattern. |

The in-app guide also covers pacing variation, power curves, zones, heart rate, energy units, trainer modes and Bluetooth terms.

## Weekly time chosen from history

Leave the weekly-hours field blank to have the connected AI choose each week's allowance. The local planner limits the AI's choice using recent riding, recovery and available days. There is no separate automatic-planning option or local substitute for this choice. If AI fails, is offline or omits weekly hours, the app keeps the existing plan and asks you to enter hours or try again. Recovery weeks are shorter, large jumps are constrained, and re-planning remembers that you delegated hours to AI. Entering hours keeps the original manual plan behavior. This is a practical estimate of suitable time, not proof of an optimal training dose.

## Outdoor distance investigation

The latest local backup confirms that HealthFit outdoor rides can be linked to Strava while lacking distance in the app. The original HealthFit archive does not store distance. Sync protects those original rides and adds only a Strava link, leaving distance missing. Newly imported Strava cycling records do contain distance.

Suggested next change: retain original ride measurements, store missing distance separately from a confirmed Strava match, and display it consistently in History, ride details and Calendar totals. Include it in sync previews and undo. Do not estimate distance from power or change a ride because of an uncertain match. This distance repair has not been implemented in these coaching changes.

## Verification

Automated checks cover blank/entered hours, recent volume and fatigue, bounded AI choices, failures preserving an existing plan, reload/re-plan behavior, selected days and spacing, plus unchanged entered-hours schedules and targets. Existing Bluetooth and ride-metric checks were also run. Live external AI responses were not requested; provider responses are variable, so the writing policy is an instruction rather than a guarantee of exact wording.

Final verification: all 106 browser checks and 58 Node test entries passed. Both Node and PowerShell server integration suites passed. Their external-address client check was skipped because this machine has no suitable non-private address. Physical Bluetooth devices and live AI responses remain untested. The blank-hours screen was checked with AI unavailable: it reports the issue and keeps the setup open without saving a replacement plan.
