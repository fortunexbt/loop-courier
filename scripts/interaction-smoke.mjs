import assert from "node:assert/strict";
import { launchBrowser } from "./browser-engine.mjs";

const baseUrl = process.env.LOOP_COURIER_URL || "http://127.0.0.1:4189";
const browser = await launchBrowser();
const state = (page) => page.evaluate(() => JSON.parse(window.render_game_to_text()));
async function load(page) {
  await page.goto(`${baseUrl}/?seed=METRO-7`);
  if (await page.locator("#btnTutSkip").isVisible()) await page.locator("#btnTutSkip").click();
  await page.evaluate(() => window.advanceTime(0));
}
async function point(page, x, y) {
  await page.locator("#game").scrollIntoViewIfNeeded();
  const box = await page.locator("#game").boundingBox();
  const size = await page.locator("#game").evaluate((canvas) => ({ width: canvas.width, height: canvas.height }));
  await page.mouse.click(box.x + x * box.width / size.width, box.y + y * box.height / size.height);
}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${baseUrl}/?seed=METRO-7`);
  const guideAction = await page.locator("#btnTutNext").boundingBox();
  assert.ok(guideAction.y >= 0 && guideAction.y + guideAction.height <= 720, "focused guide action must be on screen");
  await page.locator("#btnTutSkip").click();
  await page.evaluate(() => window.advanceTime(0));
  const points = [[104, 54], [199, 370], [800, 500], [800, 70], [104, 54]];
  for (const p of points) await point(page, ...p);
  assert.equal((await state(page)).route.ready, true);
  await page.locator("#btnStart").click();
  const before = await state(page);
  await page.locator("#btnSplice").click();
  await point(page, 151.5, 212);
  await point(page, 800, 285);
  const rejected = await state(page);
  assert.equal(rejected.splicesLeft, before.splicesLeft, "disconnecting the last contract must not consume a splice");
  assert.deepEqual(rejected.route.points, before.route.points);
  assert.equal(rejected.route.ready, true);

  await load(page);
  await page.locator("#btnSuggest").click();
  await page.locator("#btnStart").click();
  await page.keyboard.press("s");
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  assert.equal((await state(page)).mode, "run");
  assert.equal((await state(page)).splicesLeft, 2, "keyboard-only splicing must work");
  await page.locator("#btnSplice").click();
  await page.locator("#btnSplice").click();
  assert.equal((await state(page)).mode, "run", "the splice button cancels a selection");
  await page.locator("#btnTutorial").click();
  assert.equal(await page.locator("#btnPause").isDisabled(), true);
  await page.locator("#game").focus();
  await page.keyboard.press("Space");
  assert.equal((await state(page)).mode, "paused", "guide must keep the run paused");
  await page.locator("#btnTutSkip").click();
  assert.equal((await state(page)).mode, "run");
  await page.evaluate(() => window.advanceTime(121000));
  const ended = await state(page);
  await page.locator("#btnModalReplan").click();
  const editing = await state(page);
  assert.equal(editing.mode, "draw");
  assert.equal(editing.seed, ended.seed);
  assert.deepEqual(editing.route.points, ended.route.points);
  assert.equal(editing.route.closed, false);
  await page.locator("#btnCloseLoop").click();
  await page.locator("#btnStart").click();
  for (let i = 0; i < 20 && !(await state(page)).bot.cargo.length; i++) await page.evaluate(() => window.advanceTime(1000));
  assert.ok((await state(page)).bot.cargo.length > 0);
  assert.equal(await page.locator(".cargo-chip").count(), (await state(page)).bot.cargo.length);
  assert.match(await page.locator(".cargo-chip").first().textContent(), /[RBG][1-4].*\d+s/);
  await page.locator("#btnPause").click();
  const cargoBefore = await page.locator("#cargoStatus").textContent();
  await page.evaluate(() => window.advanceTime(5000));
  assert.equal(await page.locator("#cargoStatus").textContent(), cargoBefore);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await load(mobile);
  assert.equal(await mobile.locator("#bestScore").isVisible(), true);
  await mobile.locator("#btnSuggest").tap();
  const canvas = await mobile.locator("#game").boundingBox();
  const dispatch = await mobile.locator("#btnStart").boundingBox();
  assert.ok(canvas.y >= 0 && dispatch.y + dispatch.height <= 844, "phone map and Dispatch must be visible together");
  assert.ok(dispatch.y - canvas.y - canvas.height < 180, "dispatch must be next to the map");
  await mobile.locator("#btnStart").tap();
  await mobile.locator("#btnPause").tap();
  assert.equal((await state(mobile)).mode, "paused");
  await mobile.waitForFunction(() => document.getElementById("phaseLabel").textContent === "DISPATCH PAUSED");
  await mobile.evaluate(() => window.scrollTo(0, 0));
  await mobile.screenshot({ path: "output/mobile-playable.png", fullPage: true });
  console.log("Interaction smoke: guarded splices, keyboard splicing, guide pause, replan, cargo, and mobile controls passed.");
} finally {
  await browser.close();
}
