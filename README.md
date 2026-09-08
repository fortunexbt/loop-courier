# Loop Courier

A two-minute transit-routing game about drawing a delivery loop, dispatching a courier, and rewiring the route while the city changes.

![Loop Courier dispatch console](assets/loop-courier-showcase.png)

![Loop Courier running a spliced route after a successful delivery](assets/loop-courier-showcase.png)

## Why it is interesting

- Every city is reproducible from a shareable `?seed=` URL. **Daily city** gives everyone the same UTC date seed.
- A one-click starter route, undo/reopen, explicit closure, and a keyboard station builder make the first run easy to start.
- A dedicated dispatch panel shows color contracts, station coverage, estimated lap time, cargo, and a short event feed.
- Per-city personal bests and run ratings are stored on your device for your 30 most recently played cities.
- Freehand and tap-built routes snap to stations and must connect a same-color pickup/dropoff contract.
- New orders use connected pickup/dropoff pairs. The courier moves continuously while packages expire, jams slow segments, and tolls drain score.
- A delivery earns 30 base points plus 10 per extra connected color, multiplied by the current combo bonus. A missed delivery costs 18 points.
- Retry resets hazards, orders, random state, and timers. Planning has no time limit; leaving the tab pauses an active run.
- Three mid-run **two-opt splices** let you rewire non-adjacent loop edges without resetting the courier.
- The whole game is browser-native: canvas, ES modules, and no runtime dependencies or external assets.

## Play locally

```bash
npm ci
npm run dev
```

Open <http://127.0.0.1:4173>. No build step is required.

## Controls

| Action | Mouse / touch | Keyboard |
| --- | --- | --- |
| Draw route | Click, tap, or drag; use Starter route for a complete network | Focus map: arrows select a station, `Space` adds it |
| Close route | Close loop, or return near the first point (at least 3 points) | `C` |
| Undo / reopen | Undo removes a point or reopens a closed route | `Backspace` / `Z` |
| Start | **Dispatch courier** | `Enter` |
| Splice | **Splice route**, then choose two non-adjacent edges | `S` |
| Pause / resume | **Pause** | `Space` |
| Reset route | **Clear** | `R` |
| New seeded city | **New city** (starts a fresh plan) | `N` |
| Daily city | **Daily city** | — |
| Delivery sounds | **Sound on/off** (off by default) | — |
| Tutorial | **How to play** | `T` |
| Fullscreen | **Fullscreen** | `F`; `Escape` exits |

Circles are pickups, squares are dropoffs, and colors define delivery contracts. Labels R1–R4, B1–B4, and G1–G4 match the station builder. A splice needs at least four route points. Existing orders keep their destinations after a splice.

Enter and Space preserve native button behavior; form inputs keep normal text editing. Tutorial pauses an active run and resumes when dismissed; an already paused run stays paused. Scores are local personal records, not an online leaderboard. If storage is unavailable, the game remains playable and reports that a result could not be saved.

## Verification

```bash
npm run verify
```

The unit suite locks down seeded RNG output, deterministic city generation, route projection, two-opt rewires, UTC daily seeds, record validation, best-score retention, eviction, and blocked storage.

For the real-browser smoke, run the server in one terminal and Playwright in another:

```bash
LOOP_COURIER_URL=http://127.0.0.1:4173 npm run test:browser
```

The browser suites prove seeded pickup → delivery, pause-time freezing, splice consumption, fullscreen/Escape, tutorial and modal actions, seed controls, a 390 px touch layout, starter routes, replay equivalence, planning-time independence, saved records, route editing, and keyboard construction. They also refresh the showcase capture and writes inspection artifacts under `output/`.

For lower-level automation, the page exposes:

- `window.render_game_to_text()` — concise JSON describing the current interactable state and canvas coordinates.
- `window.advanceTime(ms)` — synchronous fixed-step virtual time for deterministic scenarios.

## Deploy

All application URLs are relative, so the repository works from a GitHub Pages project subpath. The included Pages workflow publishes the static root on pushes to `main`; enable **GitHub Actions** as the Pages source in repository settings.

## Project map

```text
index.html              accessible game shell
style.css               responsive/coarse-pointer presentation
main.js                 game state, input, simulation, and canvas renderer
progression.js          UTC daily cities and validated local best scores
game-core.js            deterministic algorithms shared with tests
tests/                  core tests and replayable client choreography
scripts/                local server and browser smoke
assets/                 favicon and real gameplay capture
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for extension ideas and [CHANGELOG.md](CHANGELOG.md) for release notes. Licensed under the [MIT License](LICENSE).
