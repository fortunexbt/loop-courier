import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.LOOP_COURIER_URL || "http://127.0.0.1:4189";
const seededUrl = `${baseUrl}/?seed=METRO-7`;

await mkdir("output", { recursive: true });
await mkdir("assets", { recursive: true });

function readState(page) {
  return page.evaluate(() => JSON.parse(window.render_game_to_text()));
}

async function clickWorld(page, x, y, { touch = false } = {}) {
  const canvas = page.locator("#game");
  const box = await canvas.boundingBox();
  assert.ok(box, "game canvas must have a bounding box");
  const size = await canvas.evaluate((element) => ({ width: element.width, height: element.height }));
  const clientX = box.x + (x / size.width) * box.width;
  const clientY = box.y + (y / size.height) * box.height;
  if (touch) await page.touchscreen.tap(clientX, clientY);
  else await page.mouse.click(clientX, clientY);
}

async function drawBlueContract(page, options = {}) {
  const state = await readState(page);
  const pickup = state.stations.find((station) => station.id === 5);
  const drop = state.stations.find((station) => station.id === 6);
  assert.equal(pickup.color, "blue");
  assert.equal(drop.color, "blue");
  const points = [drop.position, pickup.position, [800, 250], [120, 280], drop.position];
  for (const [x, y] of points) await clickWorld(page, x, y, options);
  const routeState = await readState(page);
  assert.equal(routeState.route.closed, true);
  assert.equal(routeState.route.ready, true);
  assert.ok(routeState.route.contractColors.includes("blue"));
  return routeState;
}

const browser = await chromium.launch({ headless: true });
const report = {};

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
  const page = await context.newPage();
  await page.goto(seededUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => typeof window.render_game_to_text === "function");
  console.log("desktop: loaded");

  assert.equal((await readState(page)).tutorial.visible, true);
  await page.locator("#btnTutSkip").click();
  await drawBlueContract(page);
  console.log("desktop: route ready");
  await page.keyboard.press("Enter");
  await page.evaluate(() => window.advanceTime(1000));

  await page.keyboard.press("Space");
  const pausedBefore = await readState(page);
  assert.equal(pausedBefore.mode, "paused");
  await page.evaluate(() => window.advanceTime(3000));
  const pausedAfter = await readState(page);
  assert.equal(pausedAfter.roundTimeRemainingMs, pausedBefore.roundTimeRemainingMs);
  await page.keyboard.press("Space");

  await page.evaluate(() => window.advanceTime(12000));
  const deliveredState = await readState(page);
  assert.ok(deliveredState.delivered >= 1, "the seeded blue package must be delivered");
  assert.ok(deliveredState.score > 0, "delivery must increase score");
  console.log(`desktop: delivered ${deliveredState.delivered}`);

  await page.locator("#btnSplice").click();
  const beforeSplice = await readState(page);
  assert.equal(beforeSplice.mode, "splice");
  const route = beforeSplice.route.points;
  const edgeA = [(route[0][0] + route[1][0]) / 2, (route[0][1] + route[1][1]) / 2];
  const edgeB = [(route[2][0] + route[3][0]) / 2, (route[2][1] + route[3][1]) / 2];
  await clickWorld(page, ...edgeA);
  await clickWorld(page, ...edgeB);
  const splicedState = await readState(page);
  assert.equal(splicedState.mode, "run");
  assert.equal(splicedState.splicesLeft, 2);
  assert.ok(splicedState.route.contractColors.includes("blue"));
  console.log("desktop: splice verified");

  await page.locator("#btnTutorial").click();
  for (let index = 0; index < 4; index += 1) await page.locator("#btnTutNext").click();
  assert.equal((await readState(page)).tutorial.visible, false);

  if (await page.evaluate(() => document.fullscreenEnabled)) {
    await page.locator("#btnFullscreen").click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    assert.equal(await page.evaluate(() => document.fullscreenElement?.id), "app");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.fullscreenElement);
  }
  console.log("desktop: tutorial and fullscreen verified");

  await page.screenshot({ path: "assets/loop-courier-showcase.png" });
  await page.locator("#game").screenshot({ path: "output/web-game-delivery.png" });

  await page.evaluate(() => window.advanceTime(110000));
  const overState = await readState(page);
  assert.equal(overState.mode, "over");
  assert.equal(overState.modal.visible, true);
  await page.locator("#btnModalPrimary").click();
  assert.equal((await readState(page)).mode, "run");
  await page.evaluate(() => window.advanceTime(121000));
  const seedBeforeModalNew = (await readState(page)).seed;
  await page.locator("#btnModalSecondary").click();
  const afterModalNew = await readState(page);
  assert.notEqual(afterModalNew.seed, seedBeforeModalNew);
  assert.equal(afterModalNew.modal.visible, false);
  console.log("desktop: modal actions verified");

  await page.locator("#seedInput").fill("CONTROL-9");
  await page.locator("#seedInput").press("Tab");
  assert.equal((await readState(page)).seed, "CONTROL-9");
  await page.locator("#btnCopyLink").click();
  assert.match(await page.locator("#hint").textContent(), /copied|blocked/i);
  const seedBeforeButton = (await readState(page)).seed;
  await page.locator("#btnNewSeed").click();
  assert.notEqual((await readState(page)).seed, seedBeforeButton);
  await page.locator("#btnResetLoop").click();
  assert.equal((await readState(page)).route.closed, false);

  report.desktop = {
    delivered: deliveredState.delivered,
    score: deliveredState.score,
    spliceRemaining: splicedState.splicesLeft,
    pauseFrozenMs: pausedAfter.roundTimeRemainingMs,
    roundOverVerified: true,
    seedControlsVerified: true,
  };
  await context.close();

  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const mobile = await mobileContext.newPage();
  await mobile.goto(seededUrl, { waitUntil: "networkidle" });
  await mobile.waitForFunction(() => typeof window.render_game_to_text === "function");
  console.log("mobile: loaded");
  await mobile.locator("#btnTutSkip").click();
  const metrics = await mobile.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    minButtonHeight: Math.min(
      ...[...document.querySelectorAll("button")]
        .filter((button) => button.getClientRects().length > 0)
        .map((button) => button.getBoundingClientRect().height),
    ),
    canvasWidth: document.querySelector("#game").getBoundingClientRect().width,
  }));
  assert.ok(metrics.documentWidth <= metrics.viewportWidth);
  assert.ok(metrics.minButtonHeight >= 44);
  assert.ok(metrics.canvasWidth <= metrics.viewportWidth);
  const mobileRoute = await drawBlueContract(mobile, { touch: true });
  assert.ok(mobileRoute.route.contractColors.includes("blue"));
  await mobile.screenshot({ path: "output/mobile-layout.png", fullPage: true });
  report.mobile = { ...metrics, touchRouteReady: mobileRoute.route.ready };
  await mobileContext.close();

  await writeFile("output/browser-smoke-state.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
