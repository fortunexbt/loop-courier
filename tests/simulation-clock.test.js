import assert from "node:assert/strict";
import test from "node:test";
import { createSimulationClock } from "../simulation-clock.js";

test("frame rate and chunk boundaries produce the same fixed simulation steps", () => {
  function run(intervals) {
    const times = [];
    const clock = createSimulationClock((dt) => times.push([dt, clock.timeMs]));
    for (const elapsed of intervals) clock.advance(elapsed);
    return { times, time: clock.timeMs };
  }
  const reference = run([120000]);
  assert.equal(reference.times.length, 7200);
  assert.equal(reference.time, 120000);
  assert.deepEqual(run(Array(3600).fill(1000 / 30)), reference);
  assert.deepEqual(run(Array(17280).fill(1000 / 144)), reference);
  assert.deepEqual(run(Array(12000).fill(10)), reference);
});

test("reset discards fractional progress and callback can stop at an exact tick", () => {
  let calls = 0;
  const clock = createSimulationClock(() => ++calls < 3);
  clock.advance(1);
  assert.equal(calls, 0);
  clock.reset();
  clock.advance(16);
  assert.equal(calls, 0);
  clock.advance(10000);
  assert.equal(calls, 3);
  assert.equal(clock.timeMs, 50);
  clock.reset();
  assert.equal(clock.timeMs, 0);
  assert.throws(() => clock.advance(Infinity), RangeError);
  assert.throws(() => clock.advance(-1), RangeError);
});
