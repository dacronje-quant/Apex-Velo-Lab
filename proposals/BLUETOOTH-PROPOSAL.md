# Bluetooth overhaul proposal

The proposed interface replaces Hardware Lab and three header device buttons with one **Devices** entry showing setup status. The mockup contains sample readings, not live device data.

## Everyday flow

1. Click **Devices**.
2. Click **Connect saved devices** when remembered devices are offline; connect them sequentially and show progress per device. Already connected devices are left alone. Stop cancels queued attempts and pending reconnects.
3. For a new device, **Add device → choose type → browser chooser → verify capabilities → confirm**.
4. Return to the workout. Only actionable connection changes require a banner.

Discovery remains the browser's real chooser. The design does not claim to enumerate all nearby devices itself or to pair three new devices with one click. First pairing requires a user gesture on the PC. Phone requests expose a PC pairing action rather than trying to bypass it.

## Generalize by capability

- Replace the fixed `pedals` category with **Power meter**, including pedal, crank, spider and hub meters that expose supported standard services.
- Model physical devices once, with one connection and a list of capabilities: power, cadence, balance, heart rate, speed, distance, trainer control, calibration, battery.
- Map capabilities to measurement roles explicitly. A trainer can supply power and cadence without appearing twice or opening competing GATT connections. Prefer remembered user selections; explain defaults and let the user change them.
- Discover by advertised service where possible, then inspect granted services and characteristic support. Keep broad discovery as a single recovery action. Name prefixes may remain compatibility fallbacks, never proof of device type.
- Offer only supported actions. Calibration appears only for a meter with the appropriate control point; left/right balance only when reported; absent battery or signal information stays unavailable.
- Standalone cadence/speed support is an extension requiring a CSC parser and wheel circumference handling, not functionality the current app already fully exposes. Nonstandard/proprietary devices need explicit adapters; this proposal does not promise universal compatibility.

## Preserve existing functionality

| Function | Proposed home |
|---|---|
| Trainer, power and HR pairing | Add device, with standard capability checks |
| Known-device reconnect, scan recovery, cancel | Saved device row and Connect saved devices |
| Automatic reconnect/backoff | Per-device status with Retry now and Stop |
| Guided zero-offset, response, offset and failure handling | Calibrate on compatible power-meter row |
| ERG control acquisition and write queues | Existing low-level behavior; clearly separate Connected from Control granted |
| PowerMatch, trim, limits and error | Measurement sources & PowerMatch; full detail under diagnostics |
| Live power/cadence/balance/HR/speed/distance | Compact device readings; full detail on expansion |
| Battery, RSSI, link age, service/characteristic details | Diagnostics; do not fabricate unsupported readings |
| Phone reconnect/disconnect/calibration/scan stop | Same state model and acknowledgements; first pairing handed to PC |
| Disconnect and replacement | Device settings; Replace should keep the old assignment until the new device validates |
| Forget | Clear Apex preference separately from browser permission; explain both |
| Error reporting and troubleshooting | Contextual next action plus expandable technical reason |

## State and failure handling

Use **Not paired → Remembered → Connecting → Connected, waiting for data → Receiving data**. Trainer adds **Control requested / granted / refused**. HR adds **No skin contact** when supported. A connected GATT link is not proof of fresh measurements.

During a dropout, keep time and available channels recording, mark missing samples, suspend PowerMatch, preserve the trainer governor and make reconnect visible. Do not silently substitute simulated values. Offer an explicit switch to trainer power only when supported and fresh; record the source change and reset source-dependent smoothing/PowerMatch state. Source changes during a ride should not blend readings from different devices invisibly.

The ready screen shows all devices connected. Its footer changes to **Connect saved devices** when one or more remembered devices are disconnected. The separate recovery screen illustrates an interrupted ride. The phone screen illustrates reconnecting an already paired device.

## Implementation sequence

1. Replace drawer content and header entry while adapting the current BLE slots. Preserve all existing tests and protocol behavior.
2. Introduce shared device records and capability/role mappings behind the existing interfaces. Keep reconnect safeguards, indication-before-write, serialized writes, calibration parsing, battery warnings and stale-reading rules.
3. Move PC/phone to one device-state contract and verify pending/applied/failed acknowledgements.
4. Add standalone cadence/speed and additional vendor adapters separately, with recorded fixtures and physical-device checks.

Acceptance: existing Assioma/KICKR/HR flows still work; another standard power meter can connect without brand-specific labels; combined-capability devices connect once; no stale numbers claim readiness; canceled choosers do not produce alarming failures; phone pairing remains on the PC; keyboard and touch operation work at narrow widths.
