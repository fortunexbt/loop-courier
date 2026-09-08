const TICKS_PER_SECOND = 60;
const STEP_MS = 1000 / TICKS_PER_SECOND;

/** Fixed simulation ticks shared by live frames and deterministic replays. */
export function createSimulationClock(onStep) {
  let ticks = 0;
  let remainderMs = 0;
  return {
    get timeMs() { return ticks * 1000 / TICKS_PER_SECOND; },
    reset() { ticks = 0; remainderMs = 0; },
    advance(elapsedMs) {
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RangeError("Elapsed time must be finite and nonnegative");
      remainderMs += elapsedMs;
      // Tolerate roundoff when frame intervals sum to an exact simulation tick.
      const steps = Math.floor((remainderMs + 1e-7) / STEP_MS);
      remainderMs = Math.max(0, remainderMs - steps * STEP_MS);
      for (let index = 0; index < steps; index++) {
        ticks++;
        if (onStep(STEP_MS / 1000) === false) {
          remainderMs = 0;
          break;
        }
      }
    },
  };
}
