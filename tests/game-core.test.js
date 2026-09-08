import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLoop,
  createRng,
  dist,
  generateStations,
  hazardEffectsAtPoint,
  projectPointToLoop,
  twoOptSpliceCycle,
} from "../game-core.js";

test("hazard effects apply inside the visible zone, not along an entire crossing edge", () => {
  const hazards = [
    { kind: "toll", x: 50, y: 0, r: 10, cost: 6 },
    { kind: "jam", x: 50, y: 0, r: 20, slow: 0.5, bornAtMs: 0, ttlMs: 1000 },
  ];
  assert.deepEqual(hazardEffectsAtPoint(hazards, { x: 0, y: 0 }, 500), { slowMult: 1, tollCost: 0 });
  assert.deepEqual(hazardEffectsAtPoint(hazards, { x: 40, y: 0 }, 500), { slowMult: 0.5, tollCost: 6 });
  assert.deepEqual(hazardEffectsAtPoint(hazards, { x: 50, y: 0 }, 1001), { slowMult: 1, tollCost: 6 });
  assert.deepEqual(hazardEffectsAtPoint([], { x: 50, y: 0 }, 500), { slowMult: 1, tollCost: 0 });
});

test("seeded RNG is stable and seed-sensitive", () => {
  const sample = (seed) => {
    const rng = createRng(seed);
    return Array.from({ length: 5 }, () => Number(rng().toFixed(10)));
  };

  assert.deepEqual(sample("LOOP-42"), [
    0.6309091453,
    0.7849148519,
    0.4821066004,
    0.2952273928,
    0.8313326957,
  ]);
  assert.deepEqual(sample("LOOP-42"), sample("LOOP-42"));
  assert.notDeepEqual(sample("LOOP-42"), sample("LOOP-43"));
});

test("route projection returns the nearest segment and distance along it", () => {
  const loop = buildLoop([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ]);

  assert.equal(loop.totalLen, 400);
  assert.deepEqual(projectPointToLoop(loop, { x: 48, y: -20 }), {
    segIndex: 0,
    segPos: 48,
    pos: { x: 48, y: 0 },
  });
  assert.deepEqual(projectPointToLoop(loop, { x: 130, y: 75 }), {
    segIndex: 1,
    segPos: 75,
    pos: { x: 100, y: 75 },
  });
});

test("two-opt rewires non-adjacent edges and rejects adjacent selections", () => {
  const points = ["A", "B", "C", "D", "E", "F"].map((id, index) => ({ id, x: index, y: 0 }));
  const rewired = twoOptSpliceCycle(points, 0, 3);

  assert.deepEqual(rewired.map((point) => point.id), ["A", "D", "C", "B", "E", "F"]);
  assert.deepEqual(
    new Set(rewired.map((point) => point.id)),
    new Set(points.map((point) => point.id)),
  );
  assert.deepEqual(twoOptSpliceCycle(points, 1, 2), points);
  assert.deepEqual(twoOptSpliceCycle(points, -1, 0), points);
});

test("a fixed seed produces the same complete city state", () => {
  const first = generateStations(createRng("METRO-7"));
  const second = generateStations(createRng("METRO-7"));

  assert.deepEqual(first, second);
  assert.equal(first.length, 12);
  assert.deepEqual(
    first.slice(0, 4).map((station) => ({
      ...station,
      x: Number(station.x.toFixed(3)),
      y: Number(station.y.toFixed(3)),
    })),
    [
      { x: 117.4, y: 99.229, colorId: "red", kind: "pickup" },
      { x: 109.101, y: 319.065, colorId: "red", kind: "pickup" },
      { x: 185.207, y: 325.51, colorId: "red", kind: "drop" },
      { x: 85.124, y: 501.933, colorId: "red", kind: "drop" },
    ],
  );

  for (let firstIndex = 0; firstIndex < first.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < first.length; secondIndex += 1) {
      assert.ok(dist(first[firstIndex], first[secondIndex]) >= 70);
    }
  }

  for (const colorId of ["red", "blue", "gold"]) {
    assert.equal(first.filter((station) => station.colorId === colorId && station.kind === "pickup").length, 2);
    assert.equal(first.filter((station) => station.colorId === colorId && station.kind === "drop").length, 2);
  }
});
