import assert from "node:assert/strict";
import test from "node:test";
import { bestForSeed, dailySeed, rankForResult, readRecords, saveResult } from "../progression.js";

const KEY = "loopCourierRecords.v1";
const result = { score: 140, delivered: 12, missed: 3, bestCombo: 5 };

function memoryStorage(initial = null) {
  let value = initial;
  return {
    getItem(key) {
      assert.equal(key, KEY);
      return value;
    },
    setItem(key, next) {
      assert.equal(key, KEY);
      value = next;
    },
  };
}

test("daily cities share a UTC date across timezone and year boundaries", () => {
  assert.equal(dailySeed(new Date("2026-09-08T01:30:00+02:00")), "2026-09-07");
  assert.equal(dailySeed(new Date("2026-09-07T20:30:00-04:00")), "2026-09-08");
  assert.equal(dailySeed(new Date("2027-01-01T00:30:00+01:00")), "2026-12-31");
  assert.throws(() => dailySeed(new Date("invalid")), RangeError);
});

test("missing, corrupt, unsupported, and inaccessible storage safely starts empty", () => {
  const empty = { version: 1, entries: [] };
  for (const input of [null, "{bad json", "null", "[]", "{}", '{"version":2,"entries":[]}', '{"version":1,"entries":{}}']) {
    assert.deepEqual(readRecords(memoryStorage(input)), empty);
  }
  assert.deepEqual(readRecords(undefined), empty);
  assert.deepEqual(readRecords({ getItem() { throw new Error("blocked"); } }), empty);
});

test("a first run persists a personal best and survives a storage round trip", () => {
  const storage = memoryStorage();
  const saved = saveResult(storage, "2026-09-08", result);
  assert.equal(saved.persisted, true);
  assert.equal(saved.isPersonalBest, true);
  assert.deepEqual(saved.best, { seed: "2026-09-08", ...result, attempts: 1 });
  assert.deepEqual(readRecords(storage), saved.records);
  assert.deepEqual(bestForSeed(saved.records, "2026-09-08"), saved.best);
  assert.equal(bestForSeed(saved.records, "unknown"), null);
});

test("a valid zero-score first run is a personal best", () => {
  const saved = saveResult(memoryStorage(), "ZERO", { score: 0, delivered: 0, missed: 0, bestCombo: 0 });
  assert.equal(saved.isPersonalBest, true);
  assert.equal(saved.best.score, 0);
  assert.equal(saved.best.attempts, 1);
});

test("consecutive blocked writes retain session bests and recover without losing other cities", () => {
  const backing = memoryStorage();
  let blocked = true;
  const storage = {
    getItem: backing.getItem,
    setItem(key, value) {
      if (blocked) throw new Error("quota exceeded");
      backing.setItem(key, value);
    },
  };
  const first = saveResult(storage, "CITY-A", result);
  const second = saveResult(storage, "CITY-A", { ...result, score: 1 }, first.records);
  assert.equal(second.best.score, result.score);
  assert.equal(second.best.attempts, 2);
  assert.equal(second.isPersonalBest, false);
  assert.equal(second.persisted, false);

  // Another tab may have saved a city while this session could not write.
  saveResult(backing, "CITY-C", result);
  blocked = false;
  const recovered = saveResult(storage, "CITY-B", result, second.records);
  assert.equal(recovered.persisted, true);
  assert.equal(bestForSeed(readRecords(storage), "CITY-A").score, result.score);
  assert.equal(bestForSeed(readRecords(storage), "CITY-A").attempts, 2);
  assert.equal(bestForSeed(readRecords(storage), "CITY-C").score, result.score);
  assert.equal(bestForSeed(readRecords(storage), "CITY-B").score, result.score);
});

test("worse runs and score ties retain the best metrics while counting attempts", () => {
  const storage = memoryStorage();
  saveResult(storage, "CITY", result);
  const worse = saveResult(storage, "CITY", { score: 139, delivered: 30, missed: 0, bestCombo: 20 });
  const tie = saveResult(storage, "CITY", { score: 140, delivered: 50, missed: 0, bestCombo: 50 });
  assert.equal(worse.isPersonalBest, false);
  assert.equal(tie.isPersonalBest, false);
  assert.deepEqual(tie.best, { seed: "CITY", ...result, attempts: 3 });
  const better = saveResult(storage, "CITY", { score: 141, delivered: 10, missed: 2, bestCombo: 4 });
  assert.equal(better.isPersonalBest, true);
  assert.deepEqual(better.best, { seed: "CITY", score: 141, delivered: 10, missed: 2, bestCombo: 4, attempts: 4 });
});

test("new results are normalized to nonnegative safe integers without coercing strings", () => {
  const storage = memoryStorage();
  assert.deepEqual(saveResult(storage, "DECIMAL", { score: 12.9, delivered: 2.8, missed: -4, bestCombo: 1.5 }).best,
    { seed: "DECIMAL", score: 12, delivered: 2, missed: 0, bestCombo: 1, attempts: 1 });
  assert.deepEqual(saveResult(storage, "INVALID", { score: Infinity, delivered: "4", missed: NaN }).best,
    { seed: "INVALID", score: 0, delivered: 0, missed: 0, bestCombo: 0, attempts: 1 });
  assert.equal(saveResult(storage, "HUGE", { score: 1e100 }).best.score, Number.MAX_SAFE_INTEGER);
});

test("malformed stored entries are discarded and extra fields do not survive normalization", () => {
  const valid = { seed: "GOOD", ...result, attempts: 2 };
  const entries = [null, [], {}, { ...valid, seed: 12 }, { ...valid, score: "140" },
    { ...valid, score: -1 }, { ...valid, delivered: 1.5 }, { ...valid, missed: null },
    { ...valid, bestCombo: 1e100 }, { ...valid, attempts: 0 }, { ...valid, ignored: true }];
  const records = readRecords(memoryStorage(JSON.stringify({ version: 1, entries, ignored: true })));
  assert.deepEqual(records, { version: 1, entries: [valid] });
});

test("duplicate stored seeds collapse to their strongest result and largest attempt count", () => {
  const entries = [
    { seed: "CITY", ...result, attempts: 4 },
    { seed: "CITY", score: 200, delivered: 20, missed: 1, bestCombo: 9, attempts: 2 },
  ];
  const records = readRecords(memoryStorage(JSON.stringify({ version: 1, entries })));
  assert.deepEqual(records.entries, [{ seed: "CITY", score: 200, delivered: 20, missed: 1, bestCombo: 9, attempts: 4 }]);
});

test("records keep the 30 most recently played distinct cities", () => {
  const storage = memoryStorage();
  for (let i = 0; i < 30; i += 1) saveResult(storage, `CITY-${i}`, result);
  saveResult(storage, "CITY-0", { score: 1 });
  const saved = saveResult(storage, "CITY-30", result);
  assert.equal(saved.records.entries.length, 30);
  assert.equal(saved.records.entries[0].seed, "CITY-30");
  assert.equal(saved.records.entries[1].seed, "CITY-0");
  assert.equal(bestForSeed(saved.records, "CITY-1"), null);
  assert.equal(bestForSeed(saved.records, "CITY-0").attempts, 2);
});

test("reads also cap oversized stored data at 30 distinct cities", () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({ seed: String(i), ...result, attempts: 1 }));
  const records = readRecords(memoryStorage(JSON.stringify({ version: 1, entries })));
  assert.equal(records.entries.length, 30);
  assert.equal(records.entries[29].seed, "29");
});

test("arbitrary string seeds including prototype names remain independent and exact", () => {
  const storage = memoryStorage();
  const seeds = ["__proto__", "constructor", "toString", "", "City 🏙️", "CITY"];
  seeds.forEach((seed, i) => saveResult(storage, seed, { ...result, score: i }));
  const records = readRecords(storage);
  assert.equal(records.entries.length, seeds.length);
  seeds.forEach((seed, i) => assert.equal(bestForSeed(records, seed).score, i));
  assert.equal(bestForSeed(records, "city"), null);
});

test("blocked writes still return the current run result without claiming persistence", () => {
  const storage = { getItem() { return null; }, setItem() { throw new Error("quota exceeded"); } };
  const saved = saveResult(storage, "CITY", result);
  assert.equal(saved.persisted, false);
  assert.equal(saved.isPersonalBest, true);
  assert.equal(saved.best.score, result.score);
  assert.equal(saveResult(undefined, "CITY", result).persisted, false);
});

test("rank thresholds reward deliveries and require an 80 percent ratio for master", () => {
  assert.equal(rankForResult({ delivered: 0, missed: 5 }).label, "New recruit");
  assert.equal(rankForResult({ delivered: 1, missed: 0 }).label, "City courier");
  assert.equal(rankForResult({ delivered: 9, missed: 0 }).label, "City courier");
  assert.equal(rankForResult({ delivered: 10, missed: 0 }).label, "Route specialist");
  assert.equal(rankForResult({ delivered: 20, missed: 6 }).label, "Route specialist");
  assert.equal(rankForResult({ delivered: 20, missed: 5 }).label, "Master dispatcher");
  assert.equal(rankForResult({ delivered: 30, missed: 0 }).label, "Master dispatcher");
  assert.equal(typeof rankForResult({ delivered: 20, missed: 5 }).detail, "string");
});
