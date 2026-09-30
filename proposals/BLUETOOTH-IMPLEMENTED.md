# Bluetooth updates

Implemented on `codex/bluetooth-updates`. Existing uncommitted changes were preserved; no merge or deployment was performed.

## What changed

- One Devices entry point with a saved setup, generic device types and one pairing flow.
- Sequential saved-device connections, cancellation, retries and recovery help on both PC and phone.
- Device aliases, replacement and Forget in Apex. A cancelled replacement keeps the connection; a failed replacement keeps the old device saved for reconnect. Duplicate assignments are rejected.
- Separate link, data and trainer-control status. Calibration requires a connected control point and a paused ride. Optional measurements remain unavailable when the device does not report them.
- Independent power/cadence preferences, consistent in preview, riding and ERG startup. Changes clear averaging and PowerMatch memory and are recorded with the ride. Existing ERG, balance, speed/distance and diagnostics remain available.
- HEADWIND vendor adapter, manual airflow, Off and presets, optional automatic cooling and phone controls. Connecting sends no airflow command. Requested and confirmed airflow are separate; automatic cooling holds on pause/missing data and stops on a failed command.
- Dialog focus isolation/restoration, normal Tab navigation, touch controls and responsive layouts.
- Updated both servers' command allowlists and the offline cache.

## Validation

- Browser suite: 106 checks passed, including Devices focus/keyboard behavior, source selection, calibration, fan feedback and existing riding/history/analytics/remote checks.
- Node metrics, imports, ride and Bluetooth tests: 47 test entries passed. Bluetooth regressions cover 20 connection, replacement, cancellation, source, fan and phone cases, including recovery after a timed-out fan write.
- Node and Windows PowerShell server integration checks passed, including new fan/Stop commands, ordered command delivery, rejected invalid commands and existing backup/health/Strava behavior. PowerShell required running the isolated harness outside the sandbox because its listener is unavailable inside it. The external-client network-address check was skipped by the harness when no usable address was detected.
- JavaScript and PowerShell syntax checks and Git whitespace checks passed.
- Desktop and 390px mobile layouts inspected; no horizontal overflow in the Devices drawer or phone page. A phone fan command reached the simulated adapter and returned confirmed airflow through the live server.

## Preview screenshots

These show the implemented interface with **simulated devices**, not hardware verification:

- [Desktop Devices](bluetooth-implemented-desktop.png)
- [Mobile Devices drawer](bluetooth-implemented-mobile.png)
- [Fan controls](bluetooth-implemented-fan.png)
- [Phone remote fan controls](bluetooth-implemented-phone.png)

The visual fixture in `tests/bluetooth-ui-fixture.js` only runs with isolated test mode. It is not loaded by the production app.

## Hardware check still required

Pair your actual trainer, meter, HR sensor and HEADWIND in Chrome/Edge on localhost. Verify live data, trainer control, calibration while paused, reconnection after a power interruption, and HEADWIND Off/presets/confirmation. HEADWIND's protocol is proprietary, so compatibility with your particular firmware remains unverified until this physical check.

Restart the launcher/server after updating, then refresh the app (Ctrl+F5). Previously saved device IDs and browser history remain compatible.
