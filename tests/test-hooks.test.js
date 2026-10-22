import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripTestHooks } from "../scripts/strip-test-hooks.mjs";

test("the production bundle drops the test hooks and keeps the game", async () => {
  const source = await readFile(new URL("../main.js", import.meta.url), "utf8");
  assert.match(source, /window\.render_game_to_text/);
  assert.match(source, /window\.advanceTime/);
  const bundle = stripTestHooks(source);
  assert.doesNotMatch(bundle, /render_game_to_text|advanceTime|test-hooks/);
  assert.match(bundle, /function syncLiveTime/);
});

test("stripping a file without hook markers is an error", () => {
  assert.throws(() => stripTestHooks("const a = 1;\n"), /markers not found/);
});
