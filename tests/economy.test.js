import assert from "node:assert/strict";
import test from "node:test";
import { buildLoop, createRng, dist, generateStations, choice, randRange } from "../game-core.js";
import * as eco from "../economy.js";
const R = 18;
function distSeg(p, a, b) { const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy; let t = l < 1e-6 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l; t = Math.max(0, Math.min(1, t)); return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t); }
export function stationsFor(seed) { return generateStations(createRng(seed), { width: 960, height: 600 }); }
export function sim(seed, pts) {
  const rng = createRng(seed + "#sim"); const stations = stationsFor(seed);
  const loop = buildLoop(pts.map(i => stations[i]));
  const on = stations.map(s => loop.segments.some(g => distSeg(s, g.a, g.b) <= R));
  const colors = ["red", "blue", "gold"].filter(c => stations.some((s, i) => on[i] && s.colorId === c && s.kind === "pickup") && stations.some((s, i) => on[i] && s.colorId === c && s.kind === "drop"));
  if (!colors.length) return null;
  const pickups = stations.filter((s, i) => on[i] && s.kind === "pickup" && colors.includes(s.colorId));
  let t = 0, score = 0, combo = 0, deliv = 0, missed = 0, seg = 0, pos = 0, next = 1000, pk = [], cargo = [], id = 1;
  const dt = 50;
  while (t < 120000) {
    const diff = 1 + (t / 120000) * 6;
    if (t >= next) {
      const p = choice(rng, pickups);
      const d = choice(rng, stations.filter((s, i) => on[i] && s.kind === "drop" && s.colorId === p.colorId));
      const dl = Math.max(8, 22 - diff * 0.9 + randRange(rng, -2, 3));
      pk.push({ id: id++, p, d, exp: t + dl * 1000, picked: false, done: false });
      next = t + eco.spawnIntervalMs(pickups.length, diff, randRange(rng, -450, 650));
    }
    for (const k of pk) if (!k.done && t > k.exp) { k.done = true; missed++; combo = 0; score = Math.max(0, score - eco.MISS_PENALTY); cargo = cargo.filter(x => x !== k); }
    let left = 160 * (0.85 + diff * 0.02) * dt / 1000;
    while (left > 1e-4) { const s = loop.segments[seg]; const rem = s.len - pos; if (left < rem) { pos += left; left = 0; } else { pos = 0; left -= rem; seg = (seg + 1) % loop.segments.length; } }
    const s = loop.segments[seg]; const f = pos / s.len; const bp = { x: s.a.x + (s.b.x - s.a.x) * f, y: s.a.y + (s.b.y - s.a.y) * f };
    for (const k of cargo.slice()) if (dist(bp, k.d) <= R) { k.done = true; cargo = cargo.filter(x => x !== k); combo++; score += eco.deliveryPoints(colors.length, combo); deliv++; }
    if (cargo.length < 3) for (const k of pk.filter(k => !k.picked && !k.done).sort((a, b) => a.exp - b.exp)) { if (cargo.length >= 3) break; if (dist(bp, k.p) <= R) { k.picked = true; cargo.push(k); } }
    t += dt;
  }
  return { score: Math.floor(score), deliv, missed, colors: colors.length };
}
export function triangle(seed) {
  const st = stationsFor(seed); let best = null;
  for (const c of ["red", "blue", "gold"]) {
    const ps = st.flatMap((s, i) => s.colorId === c && s.kind === "pickup" ? [i] : []);
    const ds = st.flatMap((s, i) => s.colorId === c && s.kind === "drop" ? [i] : []);
    for (const a of ps) for (const b of ds) for (let x = 0; x < st.length; x++) { if (x === a || x === b) continue; const d = dist(st[a], st[b]) + dist(st[b], st[x]) + dist(st[x], st[a]); if (!best || d < best.d) best = { d, pts: [a, b, x] }; }
  }
  return best.pts;
}
export function fullLoop(seed) {
  const st = stationsFor(seed); const n = st.length; let tour = [0]; const rest = new Set([...Array(n).keys()].slice(1));
  while (rest.size) { const l = tour.at(-1); let b = null; for (const i of rest) if (b === null || dist(st[l], st[i]) < dist(st[l], st[b])) b = i; tour.push(b); rest.delete(b); }
  const len = t => t.reduce((s, v, i) => s + dist(st[v], st[t[(i + 1) % n]]), 0); let imp = true;
  while (imp) { imp = false; for (let i = 0; i < n - 1; i++) for (let j = i + 2; j < n; j++) { const c = tour.slice(0, i + 1).concat(tour.slice(i + 1, j + 1).reverse(), tour.slice(j + 1)); if (len(c) < len(tour) - 1e-6) { tour = c; imp = true; } } }
  return tour;
}
const seeds = ["2026-10-22", "2026-10-23", "2026-10-24", "LOOP-42", "A", "B", "C", "D", "E", "F"];

test("a planned full loop beats a 3-station triangle on every shipped city", () => {
  for (const seed of seeds) {
    const triangleRun = sim(seed, triangle(seed));
    const loopRun = sim(seed, fullLoop(seed));
    assert.ok(loopRun.score > triangleRun.score * 1.25, `${seed}: loop ${loopRun.score} vs triangle ${triangleRun.score}`);
  }
});

test("delivery points grow with colors and combo, and spawn gaps shrink with coverage", () => {
  assert.ok(eco.deliveryPoints(2, 1) > eco.deliveryPoints(1, 1));
  assert.ok(eco.deliveryPoints(1, 5) > eco.deliveryPoints(1, 1));
  assert.ok(eco.spawnIntervalMs(8, 1, 0) < eco.spawnIntervalMs(2, 1, 0));
});
