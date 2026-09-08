# Contributing

Loop Courier is intentionally small: browser APIs at runtime, deterministic functions in `game-core.js`, and no framework build pipeline.

## Development

1. Install with `npm ci`.
2. Start the site with `npm run dev`.
3. Run `npm run verify` before submitting a change.
4. For input, timing, layout, or rendering changes, also run the browser smoke described in the README and inspect both generated screenshots.

Keep random decisions behind the seeded RNG, keep application paths relative for GitHub Pages, and do not add external media without documenting its license and provenance.

## Good expansion points

- Export/import of local daily-seed score summaries.
- More city mutations with deterministic visual telegraphing.
- Spatial keyboard station selection and configurable route objectives.
- Additional contract colors or round modifiers that remain readable on small screens.

When changing route math, add a focused test in `tests/game-core.test.js`. When changing a control, update the tutorial, README control table, text-state snapshot, and browser smoke together.
