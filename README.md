# Loop Courier

A seeded transit-routing game about drawing one resilient delivery loop, then rewiring it while the city fights back.

![Loop Courier running a spliced route after a successful delivery](assets/loop-courier-showcase.png)

## Why it is interesting

- Every city is reproducible from a shareable `?seed=` URL.
- Freehand and tap-built routes snap to stations and must connect a same-color pickup/dropoff contract.
- The courier moves continuously while packages expire, jams slow segments, and tolls drain score.
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
| Draw route | Click, tap, or drag; return near the first point to close | — |
| Start | **Start** | `Enter` |
| Splice | **Splice**, then choose two non-adjacent edges | `S` |
| Pause / resume | **Pause** | `Space` |
| Reset route | **Reset Loop** | `R` |
| New seeded city | **New Seed** | `N` |
| Tutorial | **Tutorial** | `T` |
| Fullscreen | **Fullscreen** | `F`; `Escape` exits |

Circles are pickups, squares are dropoffs, and colors define delivery contracts.

## Verification

```bash
npm run verify
```

The unit suite locks down seeded RNG output, deterministic city generation, route projection, and valid/invalid two-opt rewires.

For the real-browser smoke, run the server in one terminal and Playwright in another:

```bash
LOOP_COURIER_URL=http://127.0.0.1:4173 npm run test:browser
```

That smoke proves a complete seeded pickup → delivery, pause-time freezing, splice consumption, fullscreen/Escape, tutorial and modal actions, seed controls, and a 390 px touch layout. It also refreshes the showcase capture and writes inspection artifacts under `output/`.

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
game-core.js            deterministic algorithms shared with tests
tests/                  core tests and replayable client choreography
scripts/                local server and browser smoke
assets/                 favicon and real gameplay capture
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for extension ideas and [CHANGELOG.md](CHANGELOG.md) for release notes. Licensed under the [MIT License](LICENSE).
