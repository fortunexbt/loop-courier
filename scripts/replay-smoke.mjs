import assert from "node:assert/strict";
import { launchBrowser } from "./browser-engine.mjs";

const baseUrl = process.env.LOOP_COURIER_URL || "http://127.0.0.1:4189";
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    // Raster output is checked by browser-smoke; this suite exercises the real
    // RAF/simulation path across thousands of frames without replaying pixels.
    for (const method of ["fillRect", "fill", "stroke", "fillText"]) {
      CanvasRenderingContext2D.prototype[method] = () => {};
    }
    let time = 0;
    let callbacks = [];
    Object.defineProperty(performance, "now", { value: () => time });
    window.requestAnimationFrame = (callback) => { callbacks.push(callback); return callbacks.length; };
    window.elapseWithoutFrame = (elapsed) => { time += elapsed; };
    window.driveFrames = (frames) => {
      for (const elapsed of frames) {
        time += elapsed;
        const pending = callbacks;
        callbacks = [];
        for (const callback of pending) callback(time);
      }
    };
  });
  async function run(seed, profile) {
    await page.goto(`${baseUrl}/?seed=${seed}`);
    return page.evaluate(({ profile }) => {
      document.getElementById("btnTutSkip").click();
      document.getElementById("btnSuggest").click();
      document.getElementById("btnStart").click();
      if (profile === "virtual") window.advanceTime(121000);
      else {
        const frames = [];
        let remaining = 121000;
        while (remaining > 0.000001) {
          const elapsed = Math.min(remaining, profile === "stalls" ? (frames.length % 20 === 0 ? 450 : 1000 / 60) : 1000 / profile);
          frames.push(elapsed);
          remaining -= elapsed;
        }
        window.driveFrames(frames);
      }
      const state = JSON.parse(window.render_game_to_text());
      return Object.fromEntries(["mode", "score", "combo", "bestCombo", "delivered", "missed", "bot", "packages", "hazards"].map((key) => [key, state[key]]));
    }, { profile });
  }
  for (const seed of ["METRO-7", "CONTROL-9", "2026-09-08"]) {
    const expected = await run(seed, "virtual");
    assert.equal(expected.mode, "over");
    for (const profile of [30, 144, "stalls"]) {
      assert.deepEqual(await run(seed, profile), expected, `${seed}: live ${profile} profile must match virtual time`);
    }
    console.log(`Replay parity: ${seed}, ${expected.score} points, same at 30/144 fps and with stalls.`);
  }
  await page.goto(`${baseUrl}/?seed=METRO-7`);
  const boundaries = await page.evaluate(() => {
    const click = (id) => document.getElementById(id).click();
    const state = () => JSON.parse(window.render_game_to_text());
    click("btnTutSkip");
    click("btnSuggest");
    click("btnStart");
    window.driveFrames([1000]);
    window.elapseWithoutFrame(450);
    click("btnPause");
    const paused = state();
    window.elapseWithoutFrame(5000);
    click("btnPause");
    window.driveFrames([50]);
    const resumed = state();
    window.elapseWithoutFrame(450);
    click("btnSplice");
    const splicing = state();
    window.elapseWithoutFrame(450);
    click("btnSplice");
    const cancelled = state();
    window.driveFrames([117350]);
    window.elapseWithoutFrame(450);
    click("btnTutorial");
    return { paused, resumed, splicing, cancelled, ended: state() };
  });
  assert.equal(boundaries.paused.elapsedMs, 1450, "pause must preserve elapsed time before the next frame");
  assert.equal(boundaries.paused.mode, "paused");
  assert.equal(boundaries.resumed.elapsedMs, 1500, "resume must exclude only paused wall time");
  assert.equal(boundaries.splicing.elapsedMs, 1950, "splice must synchronize pending live time");
  assert.equal(boundaries.splicing.mode, "splice");
  assert.equal(boundaries.cancelled.elapsedMs, 2400);
  assert.equal(boundaries.cancelled.mode, "run");
  assert.equal(boundaries.ended.mode, "over", "catch-up must finish a shift before opening the guide");
  assert.equal(boundaries.ended.modal.visible, true);
  assert.equal(boundaries.ended.tutorial.visible, false);
  console.log("Action timing: stalled pause, resume, splice, and guide at shift end passed.");
} finally {
  await browser.close();
}
