import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./browser-engine.mjs";

const baseUrl = process.env.LOOP_COURIER_URL || "http://127.0.0.1:4189";
await mkdir("output", { recursive: true });
const browser = await launchBrowser();
const state = (page) => page.evaluate(() => JSON.parse(window.render_game_to_text()));
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/?seed=METRO-7`);
  await page.locator("#btnTutSkip").click();
  assert.equal(await page.locator("#btnSuggest").count(), 1, "a first playable route should be one click away");
  await page.evaluate(() => window.advanceTime(20000));
  await page.locator("#btnSuggest").click();
  const planned = await state(page);
  assert.equal(planned.route.ready, true);
  assert.equal(planned.route.contractColors.length, 3);
  await page.locator("#btnStart").click();
  await page.locator("#btnSound").focus();
  await page.keyboard.press("s");
  assert.equal((await state(page)).mode, "splice", "letter shortcuts still work from a focused button");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.advanceTime(1));
  assert.equal((await state(page)).hazards.length, 0, "planning time must not consume the mutation countdown");
  await page.evaluate(() => window.advanceTime(12000));
  const first = await state(page);
  const peakCombo = await page.evaluate(() => {
    let peak = JSON.parse(window.render_game_to_text()).combo;
    for (let i = 0; i < 1100; i++) {
      window.advanceTime(100);
      peak = Math.max(peak, JSON.parse(window.render_game_to_text()).combo);
    }
    return peak;
  });
  const finished = await state(page);
  assert.equal(finished.mode, "over");
  assert.ok(peakCombo > finished.combo, "the fixture must lose a positive combo before the round ends");
  assert.equal(finished.bestCombo, peakCombo, "the shift report retains the actual peak combo");
  assert.ok(finished.record);
  const savedBest = finished.record.score;
  await page.screenshot({ path: "output/shift-report.png", fullPage: true });
  await page.locator("#btnModalPrimary").click();
  assert.equal((await state(page)).hazards.length, 0);
  await page.evaluate(() => window.advanceTime(1));
  await page.evaluate(() => window.advanceTime(12000));
  const retry = await state(page);
  assert.deepEqual(retry.packages, first.packages, "retry must reproduce orders and deadlines");
  assert.deepEqual(retry.bot, first.bot, "retry must reproduce courier movement");
  assert.equal(retry.score, first.score);
  await page.locator("#btnNewSeed").click();
  assert.equal((await state(page)).mode, "draw");
  assert.equal((await state(page)).route.closed, false);
  await page.locator("#btnDaily").click();
  assert.equal((await state(page)).seed, new Date().toISOString().slice(0, 10));
  await page.locator("#btnSuggest").click();
  await page.locator("#btnUndo").click();
  assert.equal((await state(page)).route.closed, false);
  await page.locator("#btnCloseLoop").click();
  assert.equal((await state(page)).route.ready, true);
  await page.locator("#btnResetLoop").click();
  assert.equal((await state(page)).route.ready, false);
  assert.deepEqual((await state(page)).route.contractColors, []);
  await page.locator("#game").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  assert.equal((await state(page)).route.pointCount, 2);
  await page.keyboard.press("Backspace");
  assert.equal((await state(page)).route.pointCount, 1);
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  await page.keyboard.press("c");
  assert.equal((await state(page)).route.ready, true, "a keyboard-built triangle can dispatch");
  assert.equal((await state(page)).route.pointCount, 3);
  await page.locator("#btnStart").focus();
  await page.keyboard.press("Space");
  assert.equal((await state(page)).mode, "run", "Space activates a focused native button");
  assert.equal(await page.locator("#btnSplice").isDisabled(), true, "a triangle has no non-adjacent edges");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    delete document.hidden;
  });
  const hiddenPause = await state(page);
  assert.equal(hiddenPause.mode, "paused");
  await page.evaluate(() => window.advanceTime(5000));
  assert.equal((await state(page)).roundTimeRemainingMs, hiddenPause.roundTimeRemainingMs);
  await page.locator("#btnPause").click();
  await page.locator("#btnTutorial").click();
  assert.equal((await state(page)).mode, "paused");
  await page.locator("#btnTutSkip").click();
  assert.equal((await state(page)).mode, "run");
  await page.locator("#btnPause").click();
  await page.locator("#btnTutorial").click();
  await page.locator("#btnTutSkip").click();
  assert.equal((await state(page)).mode, "paused", "tutorial must preserve a pre-existing pause");
  await page.goto(`${baseUrl}/?seed=METRO-7`);
  assert.equal((await state(page)).record.score, savedBest, "personal best survives reload");
  await page.locator("#btnSuggest").click();
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
      canvas: document.querySelector("#game").getBoundingClientRect().toJSON(),
    }));
    assert.ok(metrics.width <= metrics.viewport, `layout must fit at ${width}px`);
    assert.ok(Math.abs(metrics.canvas.width / metrics.canvas.height - 1.6) < 0.01);
  }
  await page.screenshot({ path: "output/dispatch-desktop.png", fullPage: true });
  const blocked = await browser.newPage();
  await blocked.addInitScript(() => { Storage.prototype.setItem = () => { throw new Error("blocked"); }; });
  await blocked.goto(`${baseUrl}/?seed=METRO-7`);
  await blocked.locator("#btnTutSkip").click();
  await blocked.evaluate(() => window.advanceTime(0));
  await blocked.locator("#btnSuggest").click();
  await blocked.locator("#btnStart").click();
  await blocked.evaluate(() => window.advanceTime(121000));
  const firstBlocked = await state(blocked);
  assert.match(await blocked.locator(".result-note").textContent(), /session only/);
  await blocked.locator("#btnModalPrimary").click();
  await blocked.evaluate(() => window.advanceTime(121000));
  const secondBlocked = await state(blocked);
  assert.equal(secondBlocked.record.attempts, 2);
  assert.ok(secondBlocked.record.score >= firstBlocked.record.score);
  await blocked.close();
  assert.deepEqual(errors, []);
  console.log("Experience smoke passed: starter route, fair replay, records, daily city, editing, keyboard, no page errors.");
} finally {
  await browser.close();
}
