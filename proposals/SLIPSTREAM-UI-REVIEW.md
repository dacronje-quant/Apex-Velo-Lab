# Slipstream UI review — Apex Velo Lab

Reviewed 3 October 2026 in `C:\Users\dacro\Documents\Apex-Velo-Lab`, on the local `slipstream-redesign` branch. The starting commit was `d2a1e6f`. This review covers the working app and phone interface. The separate three-direction design study was excluded after scope was clarified.

The redesign gives Apex a coherent visual identity: the power ring, zone lighting, translucent surfaces and consistent controls make the riding screen immediately recognisable. Its main weakness is how the large display typography and spacious desktop composition behave in small containers. Several confirmed text-fit problems have been corrected. The next improvements should focus on navigation, riding priorities and keyboard access, while retaining the Slipstream appearance.

## What was checked

An isolated, headless Microsoft Edge session rendered the app with the current local files and its bundled fonts. It used a separate browser context, the app's test storage, mocked phone snapshots and blocked service calls. It did not connect to Bluetooth hardware, use the running rider server, send AI requests or change recorded rides.

| Coverage | Checks |
|---|---|
| Main views | Cockpit, Workouts, Coach, Ask, Analytics, History and Calendar |
| Dialogs | Settings, Devices and rider profiles |
| Additional views | Zen; the AI, Apple Health, Backups, Phone and Training guide Settings sections; Calendar month, year-to-date and all-time presets |
| Phone views | Ride, Focus, Session, Balance, Pedal and Devices |
| Screen sizes | 1920×1080, 1440×900, 1280×800, 1024×768, 900×700, 768×1024, 560×800, 430×932, 390×844, 360×800, 320×568 and 844×390 |
| Stress cases | Long workout and interval names; text enlarged to 150% at 768px width |
| Interactions | Tab navigation; Settings entry; graph tap and keyboard switching between full workout and the six-minute view |

The completed layout matrix contains **227 rendered cases**. Its final pass detected **no horizontal text clipping, clipped button content or page-width overflow** in those cases, and no JavaScript runtime errors. The targeted phone graph check was run separately after the requested graph change. Its results are saved alongside the screenshots.

These are bounds checks plus visual inspection of representative screenshots, not a guarantee for every future string or device. Tables, navigation and the interval queue deliberately scroll. Tall content can scroll vertically; the phone and Zen controls remain separate from their scrolling content. Canvas labels are not covered by the DOM text checks. Native Safari, browser chrome, a physical phone, connected-device errors and streamed AI answers still need a real-device pass.

## Confirmed fit problems corrected

| Problem | Change | Result |
|---|---|---|
| The wide Unbounded countdown exceeded its available card width at 1920px and 1440px. | Size the countdown from the card's width. | The timer retains its hierarchy without crossing the card's content boundary. |
| “Readiness: No Apple Health data” was clipped by its Analytics card across numerous widths. | Give readiness messages a bounded width, flexible height and wrapping. | The complete status remains visible. |
| Analytics explanations such as “Recovery sign from heartbeats” and “Energy put into the pedals” were ellipsised on phones. | Let explanatory labels wrap. | Users can read the meaning of the metric without guessing the missing words. |
| A duration value extended beyond its narrow Analytics tile at 320px. Enlarged intensity-mix values also exceeded their allotted width. | Scale KPI values within their tiles and allow the mix values their required text width. | Values fit without overflowing the page. |
| The Analytics range selector pushed its final option past the page edge at 320px. | Allow the selector to wrap within the header. | All period choices remain within the page width. |
| Long interval names were truncated in the upcoming queue. | Allow the names to wrap within the cards. | The full workout instruction is available; the queue remains horizontally scrollable. |
| Five narrow Ride tiles under the power ring cut off ordinary phone labels and elapsed time. | Use three columns in portrait, a smaller ring, and six columns in landscape. | Metric labels and time values remain readable at tested widths. |
| The phone put the whole interval name into the small interval tile. | Keep the step count in the tile and show the full name on a separate line. | The tile remains compact while preserving the actual instruction. |
| Long phone workout and Focus-step names were ellipsised. The small-screen title also competed with status indicators. | Wrap the names and give the header title its own row at narrow widths. | Full names are available without pushing the status indicators sideways. |
| The narrow “Stand 30s” phone control could show an ellipsis. | Permit control labels to wrap. | The action remains understandable on the smallest tested screen. |
| Zen pushed the watts unit and Exit button off small screens; short landscape layouts lost access to lower controls. | Constrain the power panel, wrap the header, scroll the central content and keep the controls outside that scrolling area. | Exit, Start/Pause and power adjustment remain reachable while the content reflows. |
| The phone viewport explicitly disabled zoom. | Remove that restriction. | The page no longer asks the browser to prevent user zoom. |

### Requested Ride graph correction

Tapping the Ride graph still switches between the full workout and the six-minute Following view. The miniature overview previously drawn inside the graph has been removed, along with its reserved vertical space. The **existing workout strip above the controls** now highlights the visible time window within the full workout and retains its playhead.

The highlight clears when returning to the full view or leaving Ride. It follows the same camera range during a paused zoom transition and behaves correctly when the workout is shorter than six minutes. No additional workout bar is created.

## Remaining issues and recommended priorities

### 1. Give all dialogs the keyboard behaviour already implemented for Devices

**Priority: high.** Settings opens without moving keyboard focus into the dialog; this was reproduced in the browser. The generic modal helper mainly toggles a CSS class. Closed generic overlays use opacity and pointer-event changes, while Devices has explicit hiding, background isolation, focus containment and restoration.

Apply the Devices interaction pattern to Settings, rider profiles, ride review and other generic dialogs. Opening should focus a useful control inside the dialog, Tab should remain there, closing should restore focus, and closed dialogs should be excluded from keyboard navigation and assistive technology. The Tab check confirmed that normal navigation no longer skips workout intervals; retain that behaviour.

**Acceptance:** a keyboard user can open Settings, navigate every section, close it and return to the original control without entering the page behind it.

### 2. Preserve clear page names at normal laptop widths

**Priority: high.** At 1440px, most inactive main views appear as icons. The capsule looks polished, but it makes Workouts, Coach, Ask, Analytics, History and Calendar harder to identify. On phones, several labels sit beyond the visible portion of a navigation strip whose scrollbar is hidden.

Give the main navigation its own row earlier, or reduce the competing header tools, so page labels can remain visible. For any strip that still scrolls, provide a visible overflow cue and scroll the selected tab into view. Add an explicit accessible current-page state.

**Acceptance:** users can identify every destination at 1280px and 1440px, and can discover and reach Calendar at 320px without knowing that the capsule scrolls.

### 3. Put riding decisions nearer the top on mobile

**Priority: high for riding usability.** At 390px, the main cockpit spans several screen heights. The ring comes first, while the current interval card and timer come after the control dock, followed by several more cards before the workout overview. Text can fit while the information users need together remains far apart.

Use a compact mobile order: current interval and countdown, power and target, Start/Pause, HR and cadence, then the workout profile. Move reserve modelling, balance analysis, detailed statistics and the complete queue into expandable sections. Keep the six-view phone remote for riding away from the PC.

**Acceptance:** the rider can see the current instruction, remaining interval time, target, measured power and Pause together on an ordinary phone screen with a typical workout title.

### 4. Improve secondary-text legibility

**Priority: medium.** Slipstream's bright headline values are easy to spot. Some units, helper labels, sparkline captions and explanatory text are much smaller and more subdued, especially against the zone-coloured glass. They are difficult to read at riding distance even when they fit.

Raise the contrast and size of text that affects a decision: units, source status, targets, remaining time and action explanations. Use the faintest treatment for decoration. Keep Unbounded for the prominent values and headings; use the text font for dense labels. Check contrast against each rendered zone background, since translucent surfaces change the effective background.

**Acceptance:** power-source state and units can be read at arm's length in a lit room, across all zone colours.

### 5. Reduce duplicate riding information and ambiguous idle states

**Priority: medium.** The cockpit repeats power at multiple smoothing windows while also offering a smoothing selector. It shows measured power, target in the ring, a target badge, and target in the interval card. This supports detailed analysis, but competes with the main riding instruction. Disconnected HR and cadence still show zero in the inspected idle state, which can resemble a valid reading.

Choose one primary measured-power display and one primary target. Keep smoothing comparison behind Details. Use a clear waiting state for absent sensors, and distinguish selected ERG mode from connection and active trainer control. Avoid “Push harder” advice in Zen before a ride is running and valid sensor data is available.

**Acceptance:** the idle view explains what is needed before starting; an active ride clearly distinguishes the prescription from the measured response.

### 6. Make the overview in Analytics answer a daily question

**Priority: medium.** The view contains useful readiness, fitness, volume, power and recovery information, but the phone page is very long. Some summaries use fixed look-back periods alongside the selected period, so users need to read the small captions carefully.

Lead with readiness today, the direction of the fitness trend, and one suggested next action. Keep detailed sections below, with collapsible groups on phones. Clearly label fixed 30-day and 90-day calculations beside values rather than relying on distant explanatory text. Keep the newly wrapped plain-language labels.

**Acceptance:** the first screen answers “How am I doing?” and “What should I do next?” before the user reaches the detailed curves.

## View-specific refinements

| View | Recommended refinement |
|---|---|
| Cockpit | Tighten the large blank space in the stretched current-step card. Keep the countdown large enough to scan, but let the content determine the panel height. Make the next interval consistently visible immediately after loading a workout. |
| Workouts | Keep duration, purpose and difficulty easy to compare before loading. Give the selected workout a clear preview and primary Load action; leave detailed interval editing as a secondary task. Stress-test custom workout titles and unusually long interval instructions. |
| Coach | Lead with goal, time and how the rider feels. Group model options and look-back controls under Advanced. Lead results with the recommended session, duration, reason and Load action; keep reasoning and detailed tables expandable. |
| Ask | Keep the input easy to reach while reading a long answer. Test long URLs, lists, tables and error messages from actual responses. Indicate which time period and ride history the answer uses. |
| Analytics | Keep section navigation discoverable on phones. Reduce the number of expanded chart panels initially and provide a useful empty-state action for missing recovery or critical-power data. |
| History | A wide table can remain scrollable, but offer a compact phone row with title, date, duration and load, then expandable details. Make the scrolling affordance clear and retain row actions when inspecting other columns. |
| Calendar | Lead with Today's planned session and a Load action. Make planned, completed, missed and rest states distinguishable through text or icons as well as colour. The smaller month view hides mini ride cards; provide a clear route to a day's details. |
| Devices / Settings | Preserve the stronger Devices keyboard behaviour. Improve the hierarchy between connection status, received measurements and trainer control. Use a clear Copied response for setup addresses and tokens. |
| Phone | Keep the corrected full labels and existing single workout strip. Consider expanding short secondary actions such as Stand into a brief explanation before the first use. Test long connected-device names, reconnecting messages and two-hour time values on physical phones. |
| Zen | Keep the fixed control area and scrollable centre. Consider a compact landscape composition showing the power and countdown together, with fewer secondary tiles, so riding needs less scrolling. |

## Suggested next delivery

1. Standardise dialog focus and hiding, and make main page labels consistently discoverable.
2. Compact the mobile cockpit around the current instruction, power and Pause.
3. Improve secondary-text contrast, disconnected states and the daily Analytics summary.
4. Verify the result on iPhone Safari and Android Chrome, including portrait/landscape rotation, browser bars, zoom, screen keep-awake and actual device reconnect messages.

The text-fit corrections are implemented in the working tree. The broader workflow changes above are proposals.

## Evidence and reproduction

- Layout audit: [audit.json](ui-review/audit.json), with the initial findings in [audit-before.json](ui-review/audit-before.json).
- Phone graph audit: [phone-follow-audit.json](ui-review/phone-follow-audit.json).
- Representative renders: [desktop cockpit](ui-review/app-cockpit-1440.png), [phone Ride](ui-review/phone-0-390.png), [six-minute phone view](ui-review/phone-follow-390.png), [landscape six-minute view](ui-review/phone-follow-844.png), [mobile Zen](ui-review/zen-390.png), [landscape Zen](ui-review/zen-844.png).
- Reproduce the full rendering review: `node tests/ui-responsive-review.cjs`.
- Reproduce the targeted phone check: `node tests/ui-responsive-review.cjs --phone-only`.
- The 19 focused unit tests for phone rendering, graph camera, power averaging, workout overview and glossary passed. Run them with `node --test tests/phone-ride-strip.test.js tests/phone-ride-graph.test.js tests/phone-power-averages.test.js tests/workout-overview.test.js tests/glossary.test.js`.

The layout audit records findings for review; it is not an accessibility certification or a complete integration suite. Live services and physical trainer behaviour were outside this UI review.
