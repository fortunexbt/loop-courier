# Contributing

Loop Courier is intentionally small: browser APIs at runtime, seeded simulation, and no framework build pipeline.

## Development

Use Node.js 22 or newer, matching CI.

```bash
npm ci
npm run dev
```

Open [localhost:4173](http://127.0.0.1:4173). `PORT` overrides the server port.

Run `npm run verify` before submitting a change. For input, timing, layout, or rendering changes, also run the browser suites below and inspect the generated screenshots.

Keep random decisions behind the seeded RNG, application paths relative for GitHub Pages, and external media accompanied by its license and provenance.

## Verification

```bash
npm run verify
```

This checks JavaScript syntax and runs unit tests for route geometry, seeded city generation, the simulation clock, daily seeds, and local records, including unavailable storage.

With the development server running in a separate terminal:

```bash
npx playwright install chromium webkit
LOOP_COURIER_URL=http://127.0.0.1:4173 npm run test:browser
LOOP_COURIER_BROWSER=webkit LOOP_COURIER_URL=http://127.0.0.1:4173 npm run test:browser
```

CI runs the same four suites in Chromium and WebKit:

| Suite | Coverage |
| --- | --- |
| `scripts/browser-smoke.mjs` | Deliveries, splices, pause, fullscreen, modal actions, seed controls, and touch routing |
| `scripts/experience-smoke.mjs` | Starter routes, retry equivalence, records, daily cities, editing, and keyboard construction |
| `scripts/replay-smoke.mjs` | Complete seeded runs at 30 fps, 144 fps, with stalls, and through virtual time; pause/splice boundaries and guide activation at shift end |
| `scripts/interaction-smoke.mjs` | Guarded and keyboard splicing, guide focus/pause, replanning, cargo deadlines, and phone controls beside the map |

The browser suites write inspection artifacts under `output/` and refresh `assets/loop-courier-showcase.png`. The replay suite skips canvas raster calls to keep timing checks fast; the other suites render the actual canvas.

For custom scenarios, the page exposes:

- `window.render_game_to_text()` — JSON describing the current game state and canvas coordinates.
- `window.advanceTime(ms)` — advances the shared fixed-step simulation synchronously and switches the page to manual time. Reload to return to live timing.

## Project map

| File | Responsibility |
| --- | --- |
| `index.html` | Game shell, controls, and accessible descriptions |
| `style.css` | Responsive layout and touch presentation |
| `main.js` | Game state, input, simulation, and canvas rendering |
| `game-core.js` | Seeded generation and route algorithms |
| `simulation-clock.js` | Fixed ticks shared by live play and replay |
| `progression.js` | UTC daily cities and validated local best scores |
| `tests/` | Unit tests |
| `scripts/` | Local server, build, and browser tests |
| `assets/` | Favicon and gameplay capture |

When changing route math, add a focused test in `tests/game-core.test.js`. When changing a control, update the in-game guide, README control table, text-state snapshot, and relevant browser test together.

## Static deployment

```bash
npm run build
```

Deploy the generated `site/` directory with any static host. Application URLs are relative, so the game also works under a project subpath.

The included GitHub Pages workflow verifies and builds the site, then publishes `site/` on pushes to `main`. Set **GitHub Actions** as the Pages source in repository settings.

## Good expansion points

- Export/import of local daily-seed score summaries.
- More city mutations with deterministic visual telegraphing.
- Spatial keyboard station selection and configurable route objectives.
- Additional contract colors or round modifiers that remain readable on small screens.
