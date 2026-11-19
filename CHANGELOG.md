# Changelog

## Unreleased

- Redesigned the game screen around a full-screen night transit map. The seeded 960x600 city is unchanged and fitted to any screen, turned a quarter turn on portrait phones.
- Each city code now draws its own street plan, river and parks, and stations light up in their line color once the route serves them.
- Replaced the stat strip with a station clock, one score with a combo plate, and three splice tokens. Route coverage, tallies and the dispatch radio moved onto a manifest docket.
- Countdown rings on pickups and destinations, a courier trail, a light that runs around a newly closed loop, delivery bursts and crossed-out misses.
- The shift report prints as a receipt with the rank stamped on it. City options live behind the city plate in the top bar.
- Self-hosted Overpass as the typeface.
- First visit traces a sample loop on the map instead of opening the guide; Dispatch pulses once a loop is ready.
- Station pings, a loop-close flash and short tones confirm each step of drawing.
- Shift report can share the score with a link to the same city.
- Deploy to Vercel with an Open Graph image, touch icon and 404 page.
- Run live play and virtual replays through one fixed simulation clock; preserve pending time at pause and splice boundaries and verify identical unchanged-route outcomes across frame rates and stalls.
- Move phase-specific controls and cargo destinations beside the map; keep personal bests and station labels readable on phones.
- Reject splices that disconnect the final contract; support keyboard edge selection and touch cancellation.
- Keep the guide in view and prevent resuming behind it; allow editing a finished route in the same city.
- Add Chromium/WebKit test selection and full-shift replay and interaction regressions.
- Rebuilt the interface as a responsive dispatch console with an unobstructed map, clearer contract coverage, lap estimate, cargo, and delivery feed.
- Added starter routes, Undo/reopen, explicit loop closure, labeled stations, keyboard route construction, and optional synthesized delivery sounds.
- Added global UTC daily cities, per-city personal records, run ratings, and actual best-combo tracking.
- Made new orders serviceable by the current route and rewarded additional connected colors.
- Limited hazard penalties to the courier being inside the visible zone instead of anywhere on a crossing route segment.
- Fixed replay state and planning-time mutation drift, stale coverage after reset, native keyboard button activation, and freehand angle cleanup.
- Pause on tab hiding and while reading the tutorial; preserve package visuals while paused.
- Expanded unit and browser verification for progression and the full planning/retry flow.


All notable changes to Loop Courier are documented here.

## 1.0.0 — 2026-07-22

- Revived the prototype as a public-ready, responsive browser game.
- Preserved deterministic seeded cities, freehand route drawing, route projection, and two-opt splicing.
- Added a canvas-native night transit map, live route coverage, touch snapping, larger coarse-pointer targets, fullscreen, and a four-step tutorial.
- Added pause-correct timers, accessibility labels/live state, reduced-motion behavior, and keyboard-safe seed editing.
- Extracted the deterministic core with unit coverage and browser automation hooks.
- Added an asserted end-to-end delivery/splice/mobile smoke, real gameplay capture, CI, GitHub Pages deployment, and project documentation.
