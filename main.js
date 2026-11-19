import { createSimulationClock } from "./simulation-clock.js";
import { MISS_PENALTY, deliveryPoints, spawnIntervalMs } from "./economy.js";
import { dailySeed, readRecords, saveResult, bestForSeed, rankForResult } from "./progression.js";
import {
  buildLoop,
  choice,
  clamp,
  createRng,
  dist,
  generateStations as generateCityStations,
  lerp,
  hazardEffectsAtPoint,
  projectPointToLoop,
  randRange,
  twoOptSpliceCycle,
} from "./game-core.js";

/* Loop Courier - dependency-free browser game
 *
 * Core: draw a closed loop, bot runs it, packages spawn at pickups and must be delivered
 * to matching dropoffs before a deadline. Limited "splices" perform a 2-opt rewire on
 * the loop edges (click two edges).
 */

(function () {
  "use strict";

  const TAU = Math.PI * 2;
  // The city is always simulated in a fixed 960x600 world so seeds stay identical on every screen.
  const WORLD_W = 960;
  const WORLD_H = 600;
  // World units per CSS pixel. Markers and hit areas grow with it so small screens stay playable.
  let canvasScale = 1;
  const SERVICE_RADIUS = 18; // Must match pickup/delivery radius for "on-route" logic.
  const STATION_SNAP_RADIUS = 14; // While drawing, snap points to nearby stations for easier routes.
  const TUTORIAL_DONE_KEY = "loopCourierTutorialDone.v1";
  const FONT = "Overpass, system-ui, sans-serif";
  const LED = "#f6f1e3";
  const GROUND = "#0e1c33";
  const MISS_RED = "#ff5a6e";

  const COLORS = [
    { id: "red", label: "Red", fill: "#ff5a6e", glow: "rgba(255, 90, 110, 0.55)" },
    { id: "blue", label: "Blue", fill: "#4cc3ff", glow: "rgba(76, 195, 255, 0.55)" },
    { id: "gold", label: "Gold", fill: "#ffc94a", glow: "rgba(255, 201, 74, 0.55)" },
  ];

  function dot(ax, ay, bx, by) {
    return ax * bx + ay * by;
  }

  function fmtTime(sec) {
    const s = Math.max(0, Math.ceil(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  let manualClock = false;
  let lastFrameAtMs = performance.now();
  const simulationClock = createSimulationClock((dt) => {
    simulate(dt);
    return mode === "run" || mode === "splice";
  });

  function nowMs() {
    return simulationClock.timeMs;
  }

  function round(value, places = 1) {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
  }

  function uniqByKey(points, minDistPx) {
    const out = [];
    let last = null;
    for (const p of points) {
      if (!last || dist(p, last) >= minDistPx) {
        out.push({ x: p.x, y: p.y });
        last = p;
      }
    }
    return out;
  }

  function simplifyByAngle(points, minAngleDeg) {
    if (points.length < 4) return points.slice();
    const out = [points[0]];
    const minAngle = (minAngleDeg * Math.PI) / 180;
    for (let i = 1; i < points.length - 1; i++) {
      const a = out[out.length - 1];
      const b = points[i];
      const c = points[i + 1];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const bcx = c.x - b.x;
      const bcy = c.y - b.y;
      const abLen = Math.hypot(abx, aby);
      const bcLen = Math.hypot(bcx, bcy);
      if (abLen < 1e-6 || bcLen < 1e-6) continue;
      const cos = clamp(dot(abx / abLen, aby / abLen, bcx / bcLen, bcy / bcLen), -1, 1);
      const ang = Math.acos(cos);
      if (ang > minAngle || state.stations.some((station) => dist(station, b) < 1)) out.push(b);
    }
    out.push(points[points.length - 1]);
    return out;
  }

  function nearestSegmentIndex(points, p) {
    const n = points.length;
    if (n < 2) return { idx: -1, t: 0, d2: Infinity };
    let best = { idx: -1, t: 0, d2: Infinity };
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const apx = p.x - a.x;
      const apy = p.y - a.y;
      const abLen2 = abx * abx + aby * aby;
      const t = abLen2 < 1e-6 ? 0 : clamp((apx * abx + apy * aby) / abLen2, 0, 1);
      const px = a.x + abx * t;
      const py = a.y + aby * t;
      const dx = p.x - px;
      const dy = p.y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < best.d2) best = { idx: i, t, d2 };
    }
    return best;
  }

  function pointSegDistance2(p, a, b) {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const apx = p.x - a.x;
    const apy = p.y - a.y;
    const abLen2 = abx * abx + aby * aby;
    const t = abLen2 < 1e-6 ? 0 : clamp((apx * abx + apy * aby) / abLen2, 0, 1);
    const px = a.x + abx * t;
    const py = a.y + aby * t;
    const dx = p.x - px;
    const dy = p.y - py;
    return dx * dx + dy * dy;
  }

  function insideCanvas(p, w, h) {
    return p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h;
  }

  // --- View: the canvas fills the screen and the world is fitted into the stage cell,
  // turned a quarter turn on portrait screens so a phone gets a tall map.
  const view = { cssW: 1, cssH: 1, dpr: 1, scale: 1, rotated: false, matrix: new DOMMatrix(), inverse: new DOMMatrix(), stageCenter: { x: 0, y: 0 }, key: "", dirty: true };

  // Layout is only read when something resized, not on every frame.
  function fitCanvasToDisplay(force = false) {
    if (!view.dirty && !force) return;
    view.dirty = false;
    const rect = canvas.getBoundingClientRect();
    const stage = stageElement.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const key = [rect.width, rect.height, stage.left, stage.top, stage.width, stage.height, dpr].map(Math.round).join(",");
    if (key === view.key) return;
    view.key = key;
    view.cssW = Math.max(1, rect.width);
    view.cssH = Math.max(1, rect.height);
    view.dpr = dpr;
    canvas.width = Math.round(view.cssW * dpr);
    canvas.height = Math.round(view.cssH * dpr);
    const left = stage.left - rect.left;
    const top = stage.top - rect.top;
    view.rotated = stage.height > stage.width * 1.1;
    const spanW = view.rotated ? WORLD_H : WORLD_W;
    const spanH = view.rotated ? WORLD_W : WORLD_H;
    view.scale = Math.max(0.05, Math.min(stage.width / spanW, stage.height / spanH));
    view.stageCenter = { x: left + stage.width / 2, y: top + stage.height / 2 };
    const offsetX = left + (stage.width - spanW * view.scale) / 2;
    const offsetY = top + (stage.height - spanH * view.scale) / 2;
    const s = view.scale;
    // Rotated: world +x runs down the screen and world +y runs right to left.
    view.matrix = view.rotated
      ? new DOMMatrix([0, s, -s, 0, offsetX + WORLD_H * s, offsetY])
      : new DOMMatrix([s, 0, 0, s, offsetX, offsetY]);
    view.inverse = view.matrix.inverse();
    canvasScale = 1 / s;
    backdrop = null;
  }

  function canvasToWorld(clientX, clientY) {
    fitCanvasToDisplay();
    const rect = canvas.getBoundingClientRect();
    const point = new DOMPoint(clientX - rect.left, clientY - rect.top).matrixTransform(view.inverse);
    return { x: point.x, y: point.y };
  }

  function useWorldTransform() {
    const m = view.matrix;
    const d = view.dpr;
    ctx.setTransform(m.a * d, m.b * d, m.c * d, m.d * d, m.e * d, m.f * d);
  }

  function useScreenTransform() {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  }

  // Text and labels stay upright when the map is turned for a portrait screen.
  function uprightAt(x, y) {
    ctx.translate(x, y);
    if (view.rotated) ctx.rotate(-Math.PI / 2);
  }

  // --- Game state

  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("game"));
  const stageElement = document.getElementById("stage");
  const appElement = document.getElementById("app");
  const spliceTokens = [...document.querySelectorAll(".splice-token")];
  const markViewDirty = () => { view.dirty = true; };
  new ResizeObserver(markViewDirty).observe(stageElement);
  new ResizeObserver(markViewDirty).observe(canvas);
  window.addEventListener("resize", markViewDirty);
  window.matchMedia("(resolution: 2dppx)").addEventListener?.("change", markViewDirty);
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d", { alpha: true }));

  let storage;
  try { storage = window.localStorage; } catch { /* Session-only records are supported. */ }
  let records = readRecords(storage);
  let unsavedRecords = null;
  let selectedStation = 0;
  let focusedEdge = 0;
  let lastCargoKey = "";
  let cargoDirty = true;
  let nextCargoUpdateAtMs = 0;
  let soundEnabled = false;
  let audioContext = null;
  let tutorialPausedRun = false;
  let coachActive = false;
  let coachPath = null;
  let loopClosedAtMs = -Infinity;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const coarsePointer = window.matchMedia("(pointer: coarse)");
  const events = [];
  const effects = [];
  const ui = Object.fromEntries([
    "btnDaily", "bestScore", "seedBadge", "phaseLabel", "routeStatus", "routeLength", "routeCoverage",
    "btnUndo", "btnCloseLoop", "btnSuggest", "stationPicker", "cargoStatus", "dispatchFeed", "btnSound",
    "statDelivered", "statMissed", "btnShareResult", "shareStatus", "cityCode", "clock", "clockRing", "comboCount", "cityMenu",
  ].map((id) => [id, document.getElementById(id)]));

  const contractElements = Object.fromEntries(COLORS.map((color) => [color.id, document.getElementById(`contract-${color.id}`)]));

  function setText(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  function phaseText() {
    switch (mode) {
      case "draw": return state.loop ? "Ready to dispatch" : "Draw your route";
      case "over": return "Shift complete";
      case "paused": return "Dispatch paused";
      case "splice": return "Rewire the route";
      default: return "Courier in transit";
    }
  }

  function routeStatusText() {
    if (state.loop) return state.route.hasContract ? "Your loop is ready." : "Connect a matching pair.";
    if (state.draw.points.length) {
      const stops = state.stations.filter((station, index) => state.route.stationOnRoute[index] || state.draw.points.some((point) => dist(point, station) < 1)).length;
      return `${stops} station${stops === 1 ? "" : "s"} on your route. Finish where you started.`;
    }
    return "Drag a loop through a circle and the square of the same color.";
  }

  function playTone(kind) {
    if (!soundEnabled || !audioContext) return;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const time = audioContext.currentTime;
    oscillator.type = "sine";
    const [from, to, volume] = {
      delivery: [660, 990, 0.055],
      pickup: [440, 220, 0.055],
      station: [880, 1180, 0.03],
      loop: [520, 1040, 0.05],
      miss: [180, 220, 0.055],
    }[kind];
    oscillator.frequency.setValueAtTime(from, time);
    oscillator.frequency.exponentialRampToValueAtTime(to, time + 0.12);
    gain.gain.setValueAtTime(volume, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(time);
    oscillator.stop(time + 0.21);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }

  function logEvent(message, kind = "info") {
    events.unshift({ message, kind });
    events.splice(4);
    ui.dispatchFeed.replaceChildren(...events.map((event) => {
      const item = document.createElement("li");
      item.className = `event-${event.kind}`;
      item.textContent = event.message;
      return item;
    }));
  }

  const elScore = document.getElementById("statScore");
  const elCombo = document.getElementById("statCombo");
  const elTime = document.getElementById("statTime");
  const elSplices = document.getElementById("statSplices");
  const elHint = document.getElementById("hint");
  const elAccessibleState = document.getElementById("accessibleState");

  const elSeed = /** @type {HTMLInputElement} */ (document.getElementById("seedInput"));
  const btnNewSeed = document.getElementById("btnNewSeed");
  const btnCopyLink = document.getElementById("btnCopyLink");
  const btnTutorial = document.getElementById("btnTutorial");
  const btnFullscreen = document.getElementById("btnFullscreen");
  const btnResetLoop = document.getElementById("btnResetLoop");
  const btnStart = document.getElementById("btnStart");
  const btnSplice = document.getElementById("btnSplice");
  const btnPause = document.getElementById("btnPause");

  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modalTitle");
  const modalBody = document.getElementById("modalBody");
  const btnModalPrimary = document.getElementById("btnModalPrimary");
  const btnModalSecondary = document.getElementById("btnModalSecondary");
  const btnModalReplan = document.getElementById("btnModalReplan");

  const tutorialDock = document.getElementById("tutorialDock");
  const tutorialTitle = document.getElementById("tutorialTitle");
  const tutorialStep = document.getElementById("tutorialStep");
  const tutorialBody = document.getElementById("tutorialBody");
  const btnTutSkip = document.getElementById("btnTutSkip");
  const btnTutNext = document.getElementById("btnTutNext");

  /** @type {"draw"|"run"|"splice"|"paused"|"over"} */
  let mode = "draw";
  let pausedMode = "run";
  let tutorialIndex = 0;
  let lastAccessibleKey = "";
  let focusBeforeOverlay = null;

  const DRAW_HINT = "Finish where you started to close the loop. You can also tap stations one at a time, or use Starter route.";

  const TUTORIAL_STEPS = [
    {
      title: "Connect the network",
      body: "Circles are pickups, squares are dropoffs. Drag a loop that passes through a circle and the square of the same color, and finish where you started. Starter route draws one for you, and Undo reopens a closed loop. Keyboard: arrows pick a station, Space adds it, C closes the loop.",
      target: canvas,
    },
    {
      title: "Dispatch the courier",
      body: "Dispatch unlocks when a color contract is connected. New orders use connected stations only. A loop that covers more stations draws more orders, and each extra color pays more per delivery. Your courier carries up to three packages.",
      target: btnStart,
    },
    {
      title: "Splice under pressure",
      body: "Press S or Splice, then choose two non-adjacent edges on a route with four or more points. On the focused map, arrows select an edge and Space confirms it. Escape or Cancel splice exits. A splice must keep at least one contract. Cargo chips show each parcel’s destination and time left.",
      target: btnSplice,
    },
    {
      title: "Beat the mutation clock",
      body: "Tolls drain score and jams slow the courier. Space pauses during a run. Daily city is shared worldwide on UTC time; your best scores stay on this device. Every retry resets the city and its timers.",
      target: btnPause,
    },
  ];

  /** @type {{loop: null | ReturnType<typeof buildLoop>, route: any, draw: {points: {x:number,y:number}[], dragging:boolean, cursor: null | {x:number,y:number}}, splice: {edgeA: null | number}, rng: () => number, seed: string, round: number, roundEndAtMs: number, roundDurationS: number, score: number, combo: number, delivered: number, missed: number, splicesLeft: number, maxSplices: number, bot: {segIndex: number, segPos: number, speed: number, pos: {x:number,y:number}}, stations: any[], packages: any[], nextSpawnAtMs: number, baseDeadlineS: number, cargoCap: number, cargoIds: number[], hazards: any[], nextMutationAtMs: number, difficulty: number }} */
  const state = {
    loop: null,
    route: {
      stationOnRoute: [],
      pickupsCovered: 0,
      dropsCovered: 0,
      pickupsTotal: 0,
      dropsTotal: 0,
      pickupsByColor: {},
      dropsByColor: {},
      contractColors: [],
      hasContract: false,
    },
    draw: { points: [], dragging: false, cursor: null },
    splice: { edgeA: null },
    rng: createRng(""),
    seed: "",
    round: 1,
    roundEndAtMs: 0,
    roundDurationS: 120,
    score: 0,
    combo: 0,
    bestCombo: 0,
    delivered: 0,
    missed: 0,
    splicesLeft: 3,
    maxSplices: 3,
    bot: { segIndex: 0, segPos: 0, speed: 160, pos: { x: WORLD_W / 2, y: WORLD_H / 2 } },
    stations: [],
    packages: [],
    nextSpawnAtMs: 0,
    baseDeadlineS: 22,
    cargoCap: 3,
    cargoIds: [],
    hazards: [],
    nextMutationAtMs: 0,
    difficulty: 1,
  };

  let pkgIdCounter = 1;
  let lastResult = null;

  function minDist2ToLoop(loop, p) {
    let best = Infinity;
    for (const seg of loop.segments) {
      const d2 = pointSegDistance2(p, seg.a, seg.b);
      if (d2 < best) best = d2;
    }
    return best;
  }

  function computeRouteInfo(loop) {
    const stationOnRoute = [];
    const pickupsByColor = {};
    const dropsByColor = {};
    for (const c of COLORS) {
      pickupsByColor[c.id] = [];
      dropsByColor[c.id] = [];
    }

    let pickupsTotal = 0;
    let dropsTotal = 0;
    let pickupsCovered = 0;
    let dropsCovered = 0;

    const r2 = SERVICE_RADIUS * SERVICE_RADIUS;
    for (let i = 0; i < state.stations.length; i++) {
      const s = state.stations[i];
      if (s.kind === "pickup") pickupsTotal++;
      else dropsTotal++;

      let onRoute = false;
      if (loop) {
        const d2 = minDist2ToLoop(loop, s);
        onRoute = d2 <= r2;
      }
      stationOnRoute.push(onRoute);

      if (onRoute) {
        if (s.kind === "pickup") {
          pickupsCovered++;
          pickupsByColor[s.colorId].push(s);
        } else {
          dropsCovered++;
          dropsByColor[s.colorId].push(s);
        }
      }
    }

    const contractColors = COLORS.filter(
      (c) => pickupsByColor[c.id].length > 0 && dropsByColor[c.id].length > 0,
    ).map((c) => c.id);

    return {
      stationOnRoute,
      pickupsCovered,
      dropsCovered,
      pickupsTotal,
      dropsTotal,
      pickupsByColor,
      dropsByColor,
      contractColors,
      hasContract: contractColors.length > 0,
    };
  }

  function recomputeRouteInfo() {
    cargoDirty = true;
    const points = state.draw.points;
    const preview = !state.loop && points.length > 1 ? buildLoop(points) : null;
    if (preview) preview.segments.pop();
    state.route = computeRouteInfo(state.loop || preview);
    updateButtons();
  }

  function setHint(msg) {
    elHint.textContent = msg;
  }

  function clearTutorialPulse() {
    canvas.classList.remove("canvas-focus");
    for (const step of TUTORIAL_STEPS) step.target.classList.remove("pulse");
  }

  function renderTutorialStep() {
    const step = TUTORIAL_STEPS[tutorialIndex];
    clearTutorialPulse();
    tutorialTitle.textContent = step.title;
    tutorialStep.textContent = `${tutorialIndex + 1}/${TUTORIAL_STEPS.length}`;
    tutorialBody.textContent = step.body;
    btnTutNext.textContent = tutorialIndex === TUTORIAL_STEPS.length - 1 ? "Start routing" : "Next";
    step.target.classList.add(step.target === canvas ? "canvas-focus" : "pulse");
  }

  function setTutorialDone() {
    try {
      localStorage.setItem(TUTORIAL_DONE_KEY, "true");
    } catch {
      // The tutorial remains usable when storage is unavailable.
    }
  }

  function hasCompletedTutorial() {
    try {
      return localStorage.getItem(TUTORIAL_DONE_KEY) === "true";
    } catch {
      return false;
    }
  }

  function showTutorial(index = 0) {
    tutorialPausedRun = mode === "run" || mode === "splice";
    if (tutorialPausedRun) pauseToggle();
    if (mode === "over") {
      tutorialPausedRun = false;
      return;
    }
    tutorialIndex = clamp(index, 0, TUTORIAL_STEPS.length - 1);
    focusBeforeOverlay = document.activeElement;
    tutorialDock.classList.remove("hidden");
    btnTutorial.setAttribute("aria-expanded", "true");
    renderTutorialStep();
    updateButtons();
    btnTutNext.focus();
    tutorialDock.scrollIntoView({ block: "nearest" });
  }

  function hideTutorial({ remember = false, restoreFocus = true } = {}) {
    if (tutorialDock.classList.contains("hidden")) return;
    tutorialDock.classList.add("hidden");
    btnTutorial.setAttribute("aria-expanded", "false");
    clearTutorialPulse();
    if (remember) setTutorialDone();
    if (tutorialPausedRun && mode === "paused") pauseToggle();
    tutorialPausedRun = false;
    updateButtons();
    if (restoreFocus) {
      const target = focusBeforeOverlay instanceof HTMLElement && focusBeforeOverlay !== document.body ? focusBeforeOverlay : canvas;
      target.focus();
    }
    focusBeforeOverlay = null;
  }

  function setMode(nextMode) {
    mode = nextMode;
    cargoDirty = true;
    document.getElementById("app").dataset.mode = mode;
    updateButtons();
    if (mode === "draw") {
      setHint(DRAW_HINT);
    } else if (mode === "run") {
      setHint("Deliver fast. Press S to splice (click 2 edges).");
    } else if (mode === "splice") {
      setHint("Pick two non-adjacent edges. On the map: arrows choose an edge, Space selects. Esc or Cancel splice exits.");
    } else if (mode === "paused") {
      setHint("Paused. Press Space to resume.");
    }
  }

  function pauseToggle() {
    if (!tutorialDock.classList.contains("hidden")) return;
    if (mode === "paused") {
      lastFrameAtMs = performance.now();
      setMode(pausedMode);
    } else if (mode === "run" || mode === "splice") {
      syncLiveTime();
      if (mode !== "run" && mode !== "splice") return;
      pausedMode = mode;
      setMode("paused");
    }
  }

  function updateButtons() {
    const hasLoop = !!state.loop;
    const canStart = hasLoop && state.route.hasContract && mode === "draw";
    btnStart.disabled = !canStart;
    btnStart.classList.toggle("nudge", canStart && coachActive);
    btnSplice.disabled = !hasLoop || state.loop.points.length < 4 || !["run", "splice"].includes(mode) || state.splicesLeft <= 0;
    setText(btnSplice, mode === "splice" ? "Cancel splice" : "Splice route");
    btnResetLoop.disabled = mode !== "draw" || (!hasLoop && !state.draw.points.length);
    ui.btnUndo.disabled = mode !== "draw" || (!hasLoop && !state.draw.points.length);
    ui.btnCloseLoop.disabled = mode !== "draw" || hasLoop || state.draw.points.length < 3;
    ui.btnSuggest.disabled = mode !== "draw" || hasLoop || state.draw.points.length > 0;
    for (const button of ui.stationPicker.querySelectorAll("button")) button.disabled = mode !== "draw" || hasLoop;
    btnPause.disabled = mode === "draw" || mode === "over" || !tutorialDock.classList.contains("hidden");
    btnPause.textContent = mode === "paused" ? "Resume" : "Pause";
    btnPause.setAttribute("aria-pressed", String(mode === "paused"));
    btnSplice.setAttribute("aria-pressed", String(mode === "splice"));
  }

  function setSeed(seedStr) {
    state.seed = seedStr;
    elSeed.value = seedStr;
    state.rng = createRng(seedStr);
    state.stations = generateStations(state.rng);
    coachPath = buildCoachPath();
    state.hazards = [];
    state.nextMutationAtMs = Infinity;
    ui.seedBadge.textContent = seedStr === dailySeed() ? "Today’s city" : "City code";
    ui.cityCode.textContent = seedStr;
    const best = bestForSeed(records, seedStr);
    ui.bestScore.textContent = best ? String(best.score) : "none yet";
    backdrop = null;
    selectedStation = 0;
    ui.stationPicker.replaceChildren(...state.stations.map((station, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${stationLabel(index)} ${station.kind === "pickup" ? "○" : "□"}`;
      button.dataset.color = station.colorId;
      button.setAttribute("aria-label", `${getColor(station.colorId).label} ${station.kind === "pickup" ? "pickup" : "dropoff"} ${index % 4 + 1}, add to route`);
      button.addEventListener("click", () => addStation(index));
      return button;
    }));
    state.difficulty = 1;
    recomputeRouteInfo();
  }

  function parseSeedFromUrl() {
    const url = new URL(window.location.href);
    const s = url.searchParams.get("seed");
    if (s && s.trim()) return s.trim();
    return dailySeed();
  }

  function randomSeed(rng) {
    const a = Math.floor(rng() * 1e9)
      .toString(36)
      .toUpperCase();
    const b = Math.floor(rng() * 1e9)
      .toString(36)
      .toUpperCase();
    return `${a}-${b}`;
  }

  function resetRun({ keepLoop = true } = {}) {
    simulationClock.reset();
    lastFrameAtMs = performance.now();
    state.score = 0;
    state.combo = 0;
    state.bestCombo = 0;
    state.delivered = 0;
    state.missed = 0;
    state.round = 1;
    state.maxSplices = 3;
    state.splicesLeft = state.maxSplices;
    state.baseDeadlineS = 22;
    state.cargoCap = 3;
    state.cargoIds = [];
    state.packages = [];
    pkgIdCounter = 1;

    events.length = 0;
    effects.length = 0;
    state.splice.edgeA = null;
    state.roundEndAtMs = 0;
    // Regenerate the same city to restore the post-city RNG position on every attempt.
    setSeed(state.seed);
    logEvent("City ready. Connect matching stations.");
    if (!keepLoop) {
      state.loop = null;
      state.draw.points = [];
      state.draw.dragging = false;
      state.draw.cursor = null;
      recomputeRouteInfo();
      setMode("draw");
      return;
    }

    if (state.loop) {
      state.bot.segIndex = 0;
      state.bot.segPos = 0;
      const seg = state.loop.segments[0];
      state.bot.pos = { x: seg.a.x, y: seg.a.y };
    }

    if (!state.loop || !state.route.hasContract) {
      setMode("draw");
      setHint("This loop does not connect a same-color pickup and dropoff. Reset it and redraw the route.");
      return;
    }

    startRound();
  }

  function startRound() {
    hideTutorial({ restoreFocus: false });
    if (coachActive) {
      coachActive = false;
      setTutorialDone();
    }
    const t = nowMs();
    state.roundDurationS = 120;
    state.roundEndAtMs = t + state.roundDurationS * 1000;
    state.nextSpawnAtMs = t + 1000;
    state.nextMutationAtMs = t + 16000;
    state.splicesLeft = state.maxSplices;
    setMode("run");
    logEvent("Courier dispatched. Two minutes on the clock.");
  }

  function endRun() {
    setMode("over");
    const result = { score: Math.floor(state.score), delivered: state.delivered, missed: state.missed, bestCombo: state.bestCombo };
    const saved = saveResult(storage, state.seed, result, unsavedRecords);
    records = saved.records;
    unsavedRecords = saved.persisted ? null : records;
    ui.bestScore.textContent = String(saved.best.score);
    const rank = rankForResult(result);
    showModal(saved.isPersonalBest ? "New personal best" : "Shift complete", "");
    const score = document.createElement("div");
    score.className = "result-score";
    const unit = document.createElement("span");
    unit.textContent = "pts";
    score.append(String(result.score), unit);
    const title = document.createElement("p");
    title.className = "result-rank";
    title.textContent = rank.label;
    const grid = document.createElement("dl");
    grid.className = "result-lines";
    for (const [label, value] of [["Parcels delivered", result.delivered], ["Parcels missed", result.missed], ["Best combo", result.bestCombo], ["Best for this city", saved.best.score]]) {
      const line = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = String(value);
      line.append(term, detail);
      grid.append(line);
    }
    const note = document.createElement("p");
    note.className = "result-note";
    note.textContent = `${rank.detail} City ${state.seed}. ${saved.persisted ? "Best saved on this device." : "Storage is unavailable, so this result is session only."} Retry starts a fresh attempt on your final route.`;
    modalBody.replaceChildren(score, title, grid, note);
    lastResult = { ...result, rank: rank.label };
    setText(ui.shareStatus, "");
    logEvent(`Shift complete with ${result.score} points.`, "delivery");
  }

  function cityUrl() {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set("seed", state.seed);
    return url.toString();
  }

  async function shareResult() {
    const city = state.seed === dailySeed() ? `today's daily city (${state.seed})` : `city ${state.seed}`;
    const text = `Loop Courier, ${city}: ${lastResult.score} pts, ${lastResult.delivered} delivered, best combo ${lastResult.bestCombo}. Same map for you:`;
    const url = cityUrl();
    if (navigator.share && coarsePointer.matches) {
      try {
        await navigator.share({ title: "Loop Courier", text, url });
        setText(ui.shareStatus, "Shared.");
        return;
      } catch (error) {
        if (error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      setText(ui.shareStatus, "Result and city link copied.");
    } catch {
      setText(ui.shareStatus, `Clipboard blocked. City link: ${url}`);
    }
  }

  function showModal(title, body) {
    focusBeforeOverlay = document.activeElement;
    modalTitle.textContent = title;
    modalBody.textContent = body;
    modal.classList.remove("hidden");
    btnModalPrimary.focus({ preventScroll: true });
  }

  function hideModal({ restoreFocus = false } = {}) {
    modal.classList.add("hidden");
    if (restoreFocus && focusBeforeOverlay instanceof HTMLElement) focusBeforeOverlay.focus({ preventScroll: true });
    focusBeforeOverlay = null;
  }

  // First-run demo: a loop through a same-color pickup and dropoff, traced on the map.
  // Prefer a pair that is a comfortable drag apart and sits near the middle of the city.
  function buildCoachPath() {
    const center = { x: WORLD_W / 2, y: WORLD_H / 2 };
    let best = null;
    for (const pickup of state.stations) {
      if (pickup.kind !== "pickup") continue;
      for (const drop of state.stations) {
        if (drop.kind !== "drop" || drop.colorId !== pickup.colorId) continue;
        const length = dist(pickup, drop);
        const cost = Math.abs(length - 240) + 0.5 * dist(center, { x: (pickup.x + drop.x) / 2, y: (pickup.y + drop.y) / 2 });
        if (!best || cost < best.cost) best = { pickup, drop, length, cost };
      }
    }
    const { pickup, drop, length } = best;
    const mid = { x: (pickup.x + drop.x) / 2, y: (pickup.y + drop.y) / 2 };
    const normal = { x: -(drop.y - pickup.y) / length, y: (drop.x - pickup.x) / length };
    const offset = clamp(length * 0.6, 70, 150);
    const pad = 40;
    let corner = { x: mid.x + normal.x * offset, y: mid.y + normal.y * offset };
    if (!insideCanvas({ x: corner.x - pad, y: corner.y - pad }, WORLD_W - 2 * pad, WORLD_H - 2 * pad)) {
      corner = { x: mid.x - normal.x * offset, y: mid.y - normal.y * offset };
    }
    corner = { x: clamp(corner.x, pad, WORLD_W - pad), y: clamp(corner.y, pad, WORLD_H - pad) };
    const points = [pickup, drop, corner, pickup].map((point) => ({ x: point.x, y: point.y }));
    const lengths = [0];
    for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + dist(points[i - 1], points[i]));
    return { points, lengths, total: lengths.at(-1), colorId: pickup.colorId };
  }

  function coachVisible() {
    return coachActive && mode === "draw" && !state.loop && state.draw.points.length === 0;
  }

  function generateStations(rng) {
    return generateCityStations(rng, {
      width: WORLD_W,
      height: WORLD_H,
      colorIds: COLORS.map((color) => color.id),
    });
  }

  function getColor(colorId) {
    const c = COLORS.find((x) => x.id === colorId);
    return c || COLORS[0];
  }

  function findNearestStation(p, kind) {
    let best = null;
    let bestD = Infinity;
    for (const s of state.stations) {
      if (s.kind !== kind) continue;
      const d = dist(p, s);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  function spawnPackage() {
    const rng = state.rng;
    const pickups = state.route.contractColors.flatMap((id) => state.route.pickupsByColor[id]);
    if (!pickups.length) return;
    const pick = choice(rng, pickups);
    const drops = state.route.dropsByColor[pick.colorId];
    const drop = choice(rng, drops);
    const deadlineS = Math.max(8, state.baseDeadlineS - state.difficulty * 0.9 + randRange(rng, -2, 3));
    const createdAtMs = nowMs();
    const pkg = {
      id: pkgIdCounter++,
      colorId: pick.colorId,
      pickup: { x: pick.x, y: pick.y },
      drop: { x: drop.x, y: drop.y },
      createdAtMs,
      expiresAtMs: createdAtMs + deadlineS * 1000,
      picked: false,
      delivered: false,
      missed: false,
      carried: false,
    };
    state.packages.push(pkg);
    cargoDirty = true;
    logEvent(`${getColor(pkg.colorId).label} order, ${Math.ceil(deadlineS)} s to deliver.`);
  }

  function mutateCity() {
    const rng = state.rng;
    const kind = rng() < 0.6 ? "toll" : "jam";
    const margin = 70;
    const p = { x: randRange(rng, margin, WORLD_W - margin), y: randRange(rng, margin, WORLD_H - margin) };
    if (kind === "toll") {
      state.hazards.push({
        kind: "toll",
        x: p.x,
        y: p.y,
        r: randRange(rng, 26, 42),
        cost: randRange(rng, 4, 9) * state.difficulty,
        bornAtMs: nowMs(),
      });
      setHint("A toll zone opened. It drains points while you pass through, so splice around it.");
    } else {
      state.hazards.push({
        kind: "jam",
        x: p.x,
        y: p.y,
        r: randRange(rng, 34, 58),
        slow: randRange(rng, 0.25, 0.45),
        ttlMs: randRange(rng, 18000, 26000),
        bornAtMs: nowMs(),
      });
      setHint("Traffic jam ahead. Passing through slows the courier.");
    }
    logEvent(kind === "toll" ? "New toll zone on the map." : "Traffic jam reported.", "warning");
    // Limit hazards
    if (state.hazards.length > 10) state.hazards.splice(0, state.hazards.length - 10);
    state.nextMutationAtMs = nowMs() + randRange(rng, 14000, 20000);
  }

  function updateBot(dt) {
    if (!state.loop) return;
    const loop = state.loop;
    if (loop.segments.length === 0) return;

    // Expire jams
    const now = nowMs();
    state.hazards = state.hazards.filter((hz) => hz.kind !== "jam" || now - hz.bornAtMs <= hz.ttlMs);

    const effects = hazardEffectsAtPoint(state.hazards, state.bot.pos, now);
    const speed = state.bot.speed * (0.85 + state.difficulty * 0.02) * effects.slowMult;
    let distLeft = speed * dt;

    // Toll cost: charge proportionally while traversing.
    if (effects.tollCost > 0) {
      state.score = Math.max(0, state.score - effects.tollCost * dt);
    }

    while (distLeft > 0.0001) {
      const curSeg = loop.segments[state.bot.segIndex];
      const remain = curSeg.len - state.bot.segPos;
      if (distLeft < remain) {
        state.bot.segPos += distLeft;
        distLeft = 0;
      } else {
        state.bot.segPos = 0;
        distLeft -= remain;
        state.bot.segIndex = (state.bot.segIndex + 1) % loop.segments.length;
      }
    }

    const cur = loop.segments[state.bot.segIndex];
    const t = clamp(state.bot.segPos / cur.len, 0, 1);
    state.bot.pos = { x: lerp(cur.a.x, cur.b.x, t), y: lerp(cur.a.y, cur.b.y, t) };
  }

  function tryPickupAndDeliver() {
    const botPos = state.bot.pos;
    const pickupRadius = 18;
    const deliveryRadius = 18;

    // Deliver first (feels better).
    for (const pkgId of state.cargoIds.slice()) {
      const pkg = state.packages.find((p) => p.id === pkgId);
      if (!pkg || pkg.delivered || pkg.missed) continue;
      if (dist(botPos, pkg.drop) <= deliveryRadius) {
        pkg.delivered = true;
        cargoDirty = true;
        pkg.carried = false;
        state.cargoIds = state.cargoIds.filter((id) => id !== pkgId);
        state.combo = state.combo + 1;
        state.bestCombo = Math.max(state.bestCombo, state.combo);
        const points = deliveryPoints(state.route.contractColors.length, state.combo);
        state.score += points;
        state.delivered += 1;
        const color = getColor(pkg.colorId).fill;
        effects.push({ x: pkg.drop.x, y: pkg.drop.y, text: `+${Math.round(points)}`, born: nowMs(), color, burst: true });
        if (!reducedMotion.matches) {
          elScore.animate([{ transform: "scale(1.25)", color }, { transform: "scale(1)", color: LED }], { duration: 420, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
          if (state.combo >= 2) elCombo.animate([{ transform: "scale(1.35) rotate(-4deg)" }, { transform: "none" }], { duration: 360, easing: "cubic-bezier(0.3, 1.6, 0.5, 1)" });
        }
        logEvent(`${getColor(pkg.colorId).label} delivered for ${Math.round(points)} points, combo ${state.combo}.`, "delivery");
        playTone("delivery");
      }
    }

    // Pickup (oldest first) if capacity.
    if (state.cargoIds.length < state.cargoCap) {
      const waiting = state.packages
        .filter((p) => !p.picked && !p.delivered && !p.missed)
        .sort((a, b) => a.expiresAtMs - b.expiresAtMs);
      for (const pkg of waiting) {
        if (state.cargoIds.length >= state.cargoCap) break;
        if (dist(botPos, pkg.pickup) <= pickupRadius) {
          pkg.picked = true;
          cargoDirty = true;
          pkg.carried = true;
          state.cargoIds.push(pkg.id);
          effects.push({ ring: true, x: pkg.pickup.x, y: pkg.pickup.y, born: performance.now(), color: getColor(pkg.colorId).fill });
          playTone("pickup");
        }
      }
    }
  }

  function updatePackages() {
    const now = nowMs();
    for (const pkg of state.packages) {
      if (pkg.delivered || pkg.missed) continue;
      if (now > pkg.expiresAtMs) {
        pkg.missed = true;
        cargoDirty = true;
        pkg.carried = false;
        // Remove from cargo if it was carried.
        state.cargoIds = state.cargoIds.filter((id) => id !== pkg.id);
        state.missed += 1;
        state.combo = 0;
        state.score = Math.max(0, state.score - MISS_PENALTY);
        effects.push({ x: pkg.drop.x, y: pkg.drop.y, text: `−${MISS_PENALTY}`, born: nowMs(), color: MISS_RED, miss: true });
        if (!reducedMotion.matches) {
          elScore.animate([{ color: MISS_RED, transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { color: LED, transform: "none" }], { duration: 360, easing: "ease-out" });
        }
        logEvent(`${getColor(pkg.colorId).label} parcel missed, ${MISS_PENALTY} points lost.`, "warning");
        playTone("miss");
        // Missed deadlines add a toll bubble near the miss location to push reroutes.
        state.hazards.push({
          kind: "toll",
          x: pkg.drop.x,
          y: pkg.drop.y,
          r: 34,
          cost: 6 + state.difficulty * 1.2,
          bornAtMs: nowMs(),
        });
        if (state.hazards.length > 10) state.hazards.splice(0, state.hazards.length - 10);
      }
    }

    // Trim old delivered/missed packages for performance/clarity.
    if (state.packages.length > 120) {
      state.packages = state.packages.filter((p) => !p.delivered && !p.missed);
    }
  }

  function updateSpawn() {
    const now = nowMs();
    if (now < state.nextSpawnAtMs) return;
    spawnPackage();
    const rng = state.rng;
    const coveredPickups = state.route.contractColors.reduce((sum, id) => sum + state.route.pickupsByColor[id].length, 0);
    state.nextSpawnAtMs = now + spawnIntervalMs(coveredPickups, state.difficulty, randRange(rng, -450, 650));
  }

  function updateDifficulty() {
    // Smooth ramp during the round.
    const remainS = Math.max(0, (state.roundEndAtMs - nowMs()) / 1000);
    const progress = 1 - remainS / state.roundDurationS;
    state.difficulty = 1 + progress * 6 + (state.round - 1) * 1.5;
  }

  function updateCargo() {
    if (!cargoDirty && nowMs() < nextCargoUpdateAtMs) return;
    cargoDirty = false;
    const waiting = state.packages.filter((pkg) => !pkg.picked && !pkg.delivered && !pkg.missed).length;
    const parcels = state.cargoIds.map((id) => state.packages.find((pkg) => pkg.id === id)).filter(Boolean).map((pkg) => {
      const destination = state.stations.findIndex((station) => station.kind === "drop" && dist(station, pkg.drop) < 0.1);
      return { pkg, destination, seconds: Math.max(0, Math.ceil((pkg.expiresAtMs - nowMs()) / 1000)), unreachable: !state.route.stationOnRoute[destination] };
    });
    nextCargoUpdateAtMs = Math.min(Infinity, ...parcels.map(({ pkg, seconds }) => seconds > 0 ? pkg.expiresAtMs - (seconds - 1) * 1000 : Infinity));
    const key = JSON.stringify([mode, waiting, parcels.map(({ pkg, destination, seconds, unreachable }) => [pkg.id, destination, seconds, unreachable])]);
    if (key === lastCargoKey) return;
    lastCargoKey = key;
    if (mode === "draw") {
      ui.cargoStatus.replaceChildren();
      return;
    }
    const summary = document.createElement("span");
    summary.className = "cargo-summary";
    summary.textContent = parcels.length ? (waiting ? `${waiting} waiting` : "") : `Nothing aboard, ${waiting} waiting`;
    const chips = parcels.map(({ pkg, destination, seconds, unreachable }) => {
      const chip = document.createElement("span");
      chip.className = "cargo-chip";
      chip.dataset.color = pkg.colorId;
      chip.dataset.urgent = String(seconds <= 6);
      chip.dataset.unreachable = String(unreachable);
      const label = destination >= 0 ? stationLabel(destination) : getColor(pkg.colorId).label;
      chip.append(label);
      if (unreachable) {
        const off = document.createElement("span");
        off.className = "cargo-off";
        off.textContent = "off route";
        chip.append(off);
      }
      const countdown = document.createElement("span");
      countdown.className = "cargo-deadline";
      countdown.textContent = `${seconds}s`;
      chip.append(countdown);
      chip.title = `${getColor(pkg.colorId).label} parcel to ${label}, ${seconds} seconds remaining${unreachable ? ", destination off route" : ""}`;
      return chip;
    });
    ui.cargoStatus.replaceChildren(...(summary.textContent ? [summary] : []), ...chips);
  }

  function updateHud() {
    const covered = state.route.pickupsCovered + state.route.dropsCovered;
    const total = state.route.pickupsTotal + state.route.dropsTotal;
    setText(elScore, String(Math.floor(state.score)));
    setText(ui.comboCount, String(state.combo));
    const comboLive = String(state.combo >= 2);
    if (elCombo.dataset.live !== comboLive) elCombo.dataset.live = comboLive;
    setText(ui.statDelivered, String(state.delivered));
    setText(ui.statMissed, String(state.missed));
    setText(ui.phaseLabel, phaseText());
    setText(ui.routeStatus, routeStatusText());
    setText(ui.routeLength, state.loop ? `About ${Math.ceil(state.loop.totalLen / (state.bot.speed * 0.87))} s` : "not set");
    setText(ui.routeCoverage, `${covered} of ${total}`);
    updateCargo();
    for (const color of COLORS) {
      const count = state.route.pickupsByColor[color.id]?.length || 0;
      const drops = state.route.dropsByColor[color.id]?.length || 0;
      const element = contractElements[color.id];
      setText(element, `${count} of 2 pickups, ${drops} of 2 drops`);
      const connected = String(count > 0 && drops > 0);
      if (element.parentElement.dataset.connected !== connected) element.parentElement.dataset.connected = connected;
    }
    setText(elSplices, `${state.splicesLeft} splice${state.splicesLeft === 1 ? "" : "s"} left`);
    spliceTokens.forEach((token, index) => { token.dataset.used = String(index >= state.splicesLeft); });

    const live = mode === "run" || mode === "splice" || mode === "paused";
    const t = live ? Math.max(0, (state.roundEndAtMs - nowMs()) / 1000) : mode === "draw" ? state.roundDurationS : 0;
    setText(elTime, fmtTime(t));
    const offset = (100 * (1 - t / state.roundDurationS)).toFixed(1);
    if (ui.clockRing.dataset.offset !== offset) {
      ui.clockRing.dataset.offset = offset;
      ui.clockRing.style.strokeDashoffset = offset;
    }
    const urgent = String(live && t <= 15);
    if (ui.clock.dataset.urgent !== urgent) ui.clock.dataset.urgent = urgent;

    const accessibleKey = [
      mode,
      state.route.contractColors.join(","),
      state.route.pickupsCovered,
      state.route.dropsCovered,
      state.packages.filter((pkg) => !pkg.delivered && !pkg.missed).length,
      state.cargoIds.length,
      state.delivered,
      state.missed,
    ].join("|");
    if (accessibleKey !== lastAccessibleKey) {
      lastAccessibleKey = accessibleKey;
      const contracts = state.route.contractColors.length
        ? `${state.route.contractColors.join(", ")} contract${state.route.contractColors.length === 1 ? "" : "s"}`
        : "no complete color contract";
      setText(elAccessibleState, `${mode} mode. Route has ${contracts}. ${state.cargoIds.length} packages carried, ${state.delivered} delivered, ${state.missed} missed.`);
    }
  }

  const DISTRICTS = ["North Quarter", "Riverside", "Old Town", "South Terminal", "Mill End", "Harbour", "Canal Row", "The Junction", "Market Hill", "Eastgate", "Ironworks", "Lantern Yard"];

  function smoothPath(g, points) {
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
      g.quadraticCurveTo(points[i].x, points[i].y, mid.x, mid.y);
    }
    g.lineTo(points.at(-1).x, points.at(-1).y);
  }

  // The street plan is decoration drawn from the city code with its own generator,
  // so every city looks different without touching the gameplay random stream.
  function paintCity(g) {
    const rng = createRng(`${state.seed}#streets`);
    const names = DISTRICTS.slice();
    for (let i = names.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [names[i], names[j]] = [names[j], names[i]];
    }
    const corners = [[0, 0], [view.cssW, 0], [0, view.cssH], [view.cssW, view.cssH]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(view.inverse));
    const minX = Math.min(...corners.map((p) => p.x)) - 60;
    const maxX = Math.max(...corners.map((p) => p.x)) + 60;
    const minY = Math.min(...corners.map((p) => p.y)) - 60;
    const maxY = Math.max(...corners.map((p) => p.y)) + 60;
    const line = Math.max(1, canvasScale);
    g.fillStyle = GROUND;
    g.fillRect(minX, minY, maxX - minX, maxY - minY);

    const angle = randRange(rng, -0.22, 0.22);
    const spacing = randRange(rng, 44, 56);
    const u = { x: Math.cos(angle), y: Math.sin(angle) };
    const v = { x: -u.y, y: u.x };
    const center = { x: WORLD_W / 2, y: WORLD_H / 2 };
    const reach = Math.max(...corners.map((p) => dist(p, center))) + 120;
    const at = (a, b) => ({ x: center.x + u.x * a + v.x * b, y: center.y + u.y * a + v.y * b });

    // Parks sit in whole blocks of the grid.
    g.fillStyle = "#10292f";
    for (let i = 0; i < 5; i++) {
      const a = Math.round(randRange(rng, -12, 12)) * spacing;
      const b = Math.round(randRange(rng, -8, 8)) * spacing;
      const w = spacing * (1 + Math.floor(rng() * 3));
      const h = spacing * (1 + Math.floor(rng() * 2));
      const p = [at(a, b), at(a + w, b), at(a + w, b + h), at(a, b + h)];
      g.beginPath();
      g.moveTo(p[0].x, p[0].y);
      for (const q of p.slice(1)) g.lineTo(q.x, q.y);
      g.closePath();
      g.fill();
    }

    // River: a slow curve across the long axis of the city.
    const horizontal = rng() < 0.6;
    const base = horizontal ? randRange(rng, 140, 460) : randRange(rng, 200, 760);
    const river = [];
    for (let k = -8; k <= 14; k++) {
      const along = k * 160 - (horizontal ? 0 : 180);
      const off = base + randRange(rng, -70, 70);
      river.push(horizontal ? { x: along, y: off } : { x: off, y: along });
    }
    g.lineCap = "round";
    g.lineJoin = "round";

    // Streets: a grid turned to the city's own angle, with every fourth street an avenue.
    const steps = Math.ceil(reach / spacing);
    const gapSalt = Math.floor(rng() * 1e9);
    // Missing street segments are hashed from their grid position so resizing never reshuffles the city.
    const gapAt = (k, t, axis) => createRng(`${gapSalt}:${axis}:${k}:${t}`)() < 0.16;
    for (const pass of ["minor", "avenue"]) {
      g.strokeStyle = pass === "minor" ? "#172c4f" : "#1f3a66";
      g.lineWidth = pass === "minor" ? 1.4 * line : 3.4 * line;
      g.beginPath();
      for (const axis of [0, 1]) {
        for (let k = -steps; k <= steps; k++) {
          const avenue = k % 4 === 0;
          if ((pass === "avenue") !== avenue) continue;
          for (let t = -steps; t < steps; t++) {
            if (!avenue && gapAt(k, t, axis)) continue;
            const a1 = axis ? k * spacing : t * spacing;
            const b1 = axis ? t * spacing : k * spacing;
            const a2 = axis ? a1 : a1 + spacing;
            const b2 = axis ? b1 + spacing : b1;
            const p1 = at(a1, b1);
            const p2 = at(a2, b2);
            g.moveTo(p1.x, p1.y);
            g.lineTo(p2.x, p2.y);
          }
        }
      }
      g.stroke();
    }

    // One boulevard cuts across the grid.
    const boulevard = [0, 1, 2, 3, 4].map((i) => ({
      x: lerp(-900, WORLD_W + 900, i / 4) + randRange(rng, -60, 60),
      y: lerp(WORLD_H + 500, -500, i / 4) * 0.4 + randRange(rng, 100, 500) * 0.6,
    }));
    g.strokeStyle = "#22406f";
    g.lineWidth = 5 * line;
    smoothPath(g, boulevard);
    g.stroke();

    g.strokeStyle = "#1b3358";
    g.lineWidth = 46;
    smoothPath(g, river);
    g.stroke();
    g.strokeStyle = "#08152a";
    g.lineWidth = 40;
    smoothPath(g, river);
    g.stroke();

    // Outside the service area the city recedes, and the area itself gets a dashed boundary.
    g.fillStyle = "rgba(5, 12, 26, 0.5)";
    g.beginPath();
    g.rect(minX, minY, maxX - minX, maxY - minY);
    g.rect(0, 0, WORLD_W, WORLD_H);
    g.fill("evenodd");
    g.strokeStyle = "rgba(246, 241, 227, 0.2)";
    g.lineWidth = 1.2 * line;
    g.setLineDash([6 * line, 6 * line]);
    g.strokeRect(0, 0, WORLD_W, WORLD_H);
    g.setLineDash([]);

    // District names are set upright in screen space at the four corners of the service area.
    g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    g.font = `italic 600 13px ${FONT}`;
    g.fillStyle = "rgba(180, 192, 211, 0.5)";
    const inset = 14;
    [[inset, inset], [WORLD_W - inset, inset], [inset, WORLD_H - inset], [WORLD_W - inset, WORLD_H - inset]].forEach(([x, y], i) => {
      const p = new DOMPoint(x, y).matrixTransform(view.matrix);
      const mid = new DOMPoint(WORLD_W / 2, WORLD_H / 2).matrixTransform(view.matrix);
      g.textAlign = p.x < mid.x ? "left" : "right";
      g.textBaseline = p.y < mid.y ? "top" : "alphabetic";
      g.fillText(names[i], p.x, p.y);
    });
  }

  // The street plan only changes with the city or the screen size, so paint it once and copy it each frame.
  let backdrop = null;
  function drawBackdrop() {
    if (!backdrop) {
      backdrop = document.createElement("canvas");
      backdrop.width = canvas.width;
      backdrop.height = canvas.height;
      const g = backdrop.getContext("2d");
      const m = view.matrix;
      const d = view.dpr;
      g.setTransform(m.a * d, m.b * d, m.c * d, m.d * d, m.e * d, m.f * d);
      paintCity(g);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(backdrop, 0, 0);
  }

  function markerScale() {
    return Math.max(1, canvasScale * 0.85);
  }

  function labelText(text, x, y, color) {
    ctx.lineWidth = 4 * canvasScale;
    ctx.lineJoin = "round";
    ctx.strokeStyle = GROUND;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function stationPath(kind, r) {
    ctx.beginPath();
    if (kind === "pickup") ctx.arc(0, 0, r, 0, TAU);
    else ctx.rect(-r, -r, r * 2, r * 2);
  }

  // Stations read like stops on a transit map: an open ring when idle, lit with the line color once the route serves them.
  function drawStations() {
    const k = markerScale();
    for (const [index, s] of state.stations.entries()) {
      const c = getColor(s.colorId);
      const lit = state.route.stationOnRoute[index];
      const r = (s.kind === "pickup" ? 10.5 : 9.5) * k;
      ctx.save();
      uprightAt(s.x, s.y);
      if (lit) {
        ctx.shadowColor = c.glow;
        ctx.shadowBlur = 16;
      }
      stationPath(s.kind, r);
      ctx.fillStyle = lit ? c.fill : GROUND;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 3 * k;
      ctx.strokeStyle = c.fill;
      ctx.stroke();
      ctx.fillStyle = lit ? GROUND : c.fill;
      stationPath(s.kind, r * 0.32);
      ctx.fill();

      if (mode === "draw" && document.activeElement === canvas && selectedStation === index) {
        ctx.strokeStyle = LED;
        ctx.lineWidth = 2 * canvasScale;
        ctx.setLineDash([4 * canvasScale, 3 * canvasScale]);
        ctx.beginPath(); ctx.arc(0, 0, r + 9 * canvasScale, 0, TAU); ctx.stroke();
      }
      ctx.restore();
    }
  }

  // Labels go on last so countdown rings never cover a station code.
  function drawStationLabels() {
    const k = markerScale();
    ctx.save();
    ctx.font = `800 ${12.5 * canvasScale}px ${FONT}`;
    ctx.textBaseline = "middle";
    for (const [index, s] of state.stations.entries()) {
      const busy = state.packages.some((pkg) => !pkg.delivered && !pkg.missed && ((!pkg.picked && dist(pkg.pickup, s) < 1) || (pkg.carried && dist(pkg.drop, s) < 1)));
      const screenRight = view.rotated ? s.y < 70 : s.x > WORLD_W - 70;
      const offset = (busy ? 30 * k : 11 * k) + 6 * canvasScale;
      ctx.save();
      uprightAt(s.x, s.y);
      ctx.textAlign = screenRight ? "right" : "left";
      labelText(stationLabel(index), (screenRight ? -1 : 1) * offset, canvasScale, state.route.stationOnRoute[index] ? LED : "rgba(180, 192, 211, 0.85)");
      ctx.restore();
    }
    ctx.restore();
  }

  function drawHazards() {
    const now = nowMs();
    const spin = reducedMotion.matches ? 0 : performance.now() / 60;
    for (const hz of state.hazards) {
      const toll = hz.kind === "toll";
      const fade = toll ? 1 : clamp((hz.ttlMs - (now - hz.bornAtMs)) / 2500, 0, 1);
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(hz.x, hz.y);
      ctx.fillStyle = toll ? "rgba(255, 201, 74, 0.08)" : "rgba(76, 195, 255, 0.07)";
      ctx.beginPath(); ctx.arc(0, 0, hz.r, 0, TAU); ctx.fill();
      ctx.strokeStyle = toll ? "rgba(255, 201, 74, 0.7)" : "rgba(76, 195, 255, 0.6)";
      ctx.lineWidth = 2 * canvasScale;
      ctx.setLineDash(toll ? [2 * canvasScale, 5 * canvasScale] : [10 * canvasScale, 6 * canvasScale]);
      ctx.lineDashOffset = toll ? 0 : -spin;
      ctx.stroke();
      ctx.setLineDash([]);
      uprightAt(0, 0);
      ctx.font = `800 ${11 * canvasScale}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.globalAlpha = fade;
      labelText(toll ? "Toll" : "Jam", 0, -hz.r - 3 * canvasScale, toll ? "#ffc94a" : "#4cc3ff");
      ctx.restore();
    }
  }

  function deadlineArc(x, y, radius, frac, color, width) {
    ctx.save();
    uprightAt(x, y);
    ctx.lineCap = "round";
    ctx.lineWidth = width;
    ctx.strokeStyle = "rgba(9, 20, 38, 0.85)";
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, TAU); ctx.stroke();
    ctx.strokeStyle = frac < 0.28 ? MISS_RED : color;
    ctx.beginPath(); ctx.arc(0, 0, radius, -Math.PI / 2, -Math.PI / 2 + TAU * frac); ctx.stroke();
    ctx.restore();
  }

  // Waiting parcels show a countdown ring at their pickup; carried parcels mark their destination.
  function drawPackages() {
    const now = nowMs();
    const k = markerScale();
    const waitingByStop = new Map();
    for (const pkg of state.packages) {
      if (pkg.delivered || pkg.missed) continue;
      const frac = clamp((pkg.expiresAtMs - now) / (pkg.expiresAtMs - pkg.createdAtMs), 0, 1);
      if (!pkg.picked) {
        const key = `${pkg.pickup.x}:${pkg.pickup.y}`;
        const stop = waitingByStop.get(key) || { pkg, frac, count: 0 };
        stop.count += 1;
        if (frac < stop.frac) Object.assign(stop, { pkg, frac });
        waitingByStop.set(key, stop);
      } else if (pkg.carried) {
        const c = getColor(pkg.colorId);
        ctx.save();
        uprightAt(pkg.drop.x, pkg.drop.y);
        ctx.strokeStyle = c.fill;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1.5 * canvasScale;
        ctx.setLineDash([3 * canvasScale, 4 * canvasScale]);
        ctx.lineDashOffset = reducedMotion.matches ? 0 : -performance.now() / 50;
        ctx.beginPath(); ctx.arc(0, 0, 27 * k, 0, TAU); ctx.stroke();
        ctx.restore();
        deadlineArc(pkg.drop.x, pkg.drop.y, 20 * k, frac, c.fill, 3.5 * k);
      }
    }
    for (const { pkg, frac, count } of waitingByStop.values()) {
      const c = getColor(pkg.colorId);
      deadlineArc(pkg.pickup.x, pkg.pickup.y, 17 * k, frac, c.fill, 3 * k);
      // One parcel tag per waiting order, stacked above the stop.
      ctx.save();
      uprightAt(pkg.pickup.x, pkg.pickup.y);
      for (let i = 0; i < Math.min(3, count); i++) {
        const y = -(26 + i * 9) * k;
        ctx.fillStyle = c.fill;
        ctx.strokeStyle = GROUND;
        ctx.lineWidth = 2 * canvasScale;
        ctx.beginPath(); ctx.rect(-4.5 * k, y - 3.5 * k, 9 * k, 7 * k); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }
  }

  function tracePath(pts, closed) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (closed) ctx.closePath();
  }

  function loopPointAt(loop, distance) {
    let d = ((distance % loop.totalLen) + loop.totalLen) % loop.totalLen;
    for (const seg of loop.segments) {
      if (d <= seg.len) {
        const t = seg.len ? d / seg.len : 0;
        return { x: lerp(seg.a.x, seg.b.x, t), y: lerp(seg.a.y, seg.b.y, t) };
      }
      d -= seg.len;
    }
    return { ...loop.segments[0].a };
  }

  function drawLoop() {
    const pts = state.loop ? state.loop.points : state.draw.points;
    if (pts.length < 1) return;
    const closed = Boolean(state.loop);
    const ls = Math.max(1, canvasScale * 0.75);

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    const sinceClose = performance.now() - loopClosedAtMs;
    const flash = closed ? clamp(1 - sinceClose / 700, 0, 1) : 0;
    if (pts.length > 1) {
      if (flash > 0) {
        ctx.strokeStyle = `rgba(246, 241, 227, ${0.35 * flash})`;
        ctx.lineWidth = (12 + 20 * flash) * ls;
        tracePath(pts, closed);
        ctx.stroke();
      }
      // Cased line, the way transit maps draw a route over the street plan.
      ctx.strokeStyle = "#060e1c";
      ctx.lineWidth = 11 * ls;
      tracePath(pts, closed);
      ctx.stroke();
      ctx.strokeStyle = closed && !state.route.hasContract ? "rgba(246, 241, 227, 0.55)" : LED;
      ctx.lineWidth = 5 * ls;
      tracePath(pts, closed);
      ctx.stroke();
    }

    if (closed) {
      for (const segment of state.loop.segments) {
        if (segment.len < 70 * ls) continue;
        ctx.save();
        ctx.translate((segment.a.x + segment.b.x) / 2, (segment.a.y + segment.b.y) / 2);
        ctx.rotate(Math.atan2(segment.b.y - segment.a.y, segment.b.x - segment.a.x));
        ctx.strokeStyle = GROUND;
        ctx.lineWidth = 1.8 * ls;
        ctx.beginPath(); ctx.moveTo(-2.5 * ls, -2.5 * ls); ctx.lineTo(1.5 * ls, 0); ctx.lineTo(-2.5 * ls, 2.5 * ls); ctx.stroke();
        ctx.restore();
      }
      // A light runs once around a freshly closed loop.
      if (!reducedMotion.matches && sinceClose < 1100 && state.loop.totalLen > 0) {
        const t = 1 - (1 - sinceClose / 1100) ** 3;
        const head = loopPointAt(state.loop, t * state.loop.totalLen);
        ctx.shadowColor = "rgba(246, 241, 227, 0.9)";
        ctx.shadowBlur = 24;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath(); ctx.arc(head.x, head.y, 7 * ls, 0, TAU); ctx.fill();
        ctx.shadowBlur = 0;
      }
    } else {
      const first = pts[0];
      ctx.strokeStyle = LED;
      ctx.lineWidth = 2 * ls;
      ctx.setLineDash([4 * ls, 5 * ls]);
      ctx.lineDashOffset = reducedMotion.matches ? 0 : -performance.now() / 40;
      if (pts.length >= 3) { ctx.beginPath(); ctx.arc(first.x, first.y, 22 * ls, 0, TAU); ctx.stroke(); }
      if (state.draw.cursor) {
        ctx.strokeStyle = "rgba(246, 241, 227, 0.6)";
        ctx.beginPath(); ctx.moveTo(pts.at(-1).x, pts.at(-1).y); ctx.lineTo(state.draw.cursor.x, state.draw.cursor.y); ctx.stroke();
      }
      ctx.setLineDash([]);
      // Only the start and the stops that snapped to a station get a marker, not every sample of the stroke.
      for (let i = 0; i < pts.length; i++) {
        if (i > 0 && !state.stations.some((station) => dist(station, pts[i]) < 1)) continue;
        ctx.fillStyle = i === 0 ? LED : GROUND;
        ctx.strokeStyle = LED;
        ctx.lineWidth = 2 * ls;
        ctx.beginPath(); ctx.arc(pts[i].x, pts[i].y, (i === 0 ? 5.5 : 3.5) * ls, 0, TAU); ctx.fill(); ctx.stroke();
      }
    }

    if (mode === "splice" && state.loop) {
      const n = state.loop.points.length;
      const focusSegment = state.loop.segments[focusedEdge];
      ctx.strokeStyle = "rgba(255, 201, 74, 0.75)";
      ctx.lineWidth = 7 * ls;
      ctx.setLineDash([8 * ls, 8 * ls]);
      ctx.beginPath(); ctx.moveTo(focusSegment.a.x, focusSegment.a.y); ctx.lineTo(focusSegment.b.x, focusSegment.b.y); ctx.stroke();
      ctx.setLineDash([]);
      const i = state.splice.edgeA;
      if (i !== null && i >= 0 && i < n) {
        const a = state.loop.points[i];
        const b = state.loop.points[(i + 1) % n];
        ctx.strokeStyle = "#ffc94a";
        ctx.lineWidth = 8 * ls;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }

    ctx.restore();
  }

  // Positions the courier has just passed, walked back along the loop so the trail follows corners.
  function trailPoints(length, step) {
    const loop = state.loop;
    const points = [state.bot.pos];
    let segIndex = state.bot.segIndex;
    let back = state.bot.segPos;
    let left = length;
    let guard = 0;
    while (left > 0 && guard++ < 200) {
      const seg = loop.segments[segIndex];
      const take = Math.min(back, step, left);
      back -= take;
      left -= take;
      const t = seg.len ? back / seg.len : 0;
      points.push({ x: lerp(seg.a.x, seg.b.x, t), y: lerp(seg.a.y, seg.b.y, t) });
      if (back <= 0.0001) {
        segIndex = (segIndex - 1 + loop.segments.length) % loop.segments.length;
        back = loop.segments[segIndex].len;
      }
    }
    return points;
  }

  function drawBot() {
    if (!state.loop || !state.loop.totalLen) return;
    const p = state.bot.pos;
    const k = markerScale();
    const trail = trailPoints(140, 10);
    ctx.save();
    ctx.lineCap = "round";
    for (let i = 1; i < trail.length; i++) {
      const fade = 1 - i / trail.length;
      ctx.strokeStyle = `rgba(255, 250, 235, ${0.75 * fade * fade})`;
      ctx.lineWidth = (2 + 6 * fade) * k;
      ctx.beginPath(); ctx.moveTo(trail[i - 1].x, trail[i - 1].y); ctx.lineTo(trail[i].x, trail[i].y); ctx.stroke();
    }

    const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 30 * k);
    halo.addColorStop(0, "rgba(255, 250, 235, 0.45)");
    halo.addColorStop(1, "rgba(255, 250, 235, 0)");
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(p.x, p.y, 30 * k, 0, TAU); ctx.fill();

    const seg = state.loop.segments[state.bot.segIndex];
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x));
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#060e1c";
    ctx.lineWidth = 2.5 * k;
    ctx.beginPath(); ctx.moveTo(12 * k, 0); ctx.lineTo(-7 * k, 8 * k); ctx.lineTo(-4 * k, 0); ctx.lineTo(-7 * k, -8 * k); ctx.closePath();
    ctx.stroke(); ctx.fill();
    ctx.restore();

    const cargo = state.cargoIds.map((id) => state.packages.find((pkg) => pkg.id === id)).filter(Boolean);
    const spin = reducedMotion.matches ? 0 : nowMs() / 420;
    ctx.save();
    ctx.translate(p.x, p.y);
    cargo.forEach((pkg, i) => {
      const ang = spin + (i / Math.max(1, cargo.length)) * TAU;
      ctx.fillStyle = getColor(pkg.colorId).fill;
      ctx.strokeStyle = "#060e1c";
      ctx.lineWidth = 2 * k;
      ctx.beginPath(); ctx.arc(Math.cos(ang) * 17 * k, Math.sin(ang) * 17 * k, 4.5 * k, 0, TAU); ctx.stroke(); ctx.fill();
    });
    ctx.restore();
  }

  function coachPointAt(distance) {
    const { points, lengths } = coachPath;
    let i = 1;
    while (i < lengths.length - 1 && lengths[i] < distance) i++;
    const k = clamp((distance - lengths[i - 1]) / Math.max(1, lengths[i] - lengths[i - 1]), 0, 1);
    return { x: lerp(points[i - 1].x, points[i].x, k), y: lerp(points[i - 1].y, points[i].y, k), segment: i };
  }

  function drawCoach() {
    if (!coachVisible()) return;
    const { points, total, colorId } = coachPath;
    const traceMs = 2400;
    const cycleMs = 3800;
    const elapsed = reducedMotion.matches ? traceMs : performance.now() % cycleMs;
    const t = clamp(elapsed / traceMs, 0, 1);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    const fade = reducedMotion.matches ? 1 : clamp((cycleMs - 250 - elapsed) / 450, 0, 1);
    const head = coachPointAt(eased * total);
    const scale = Math.max(1, canvasScale * 0.8);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = LED;
    ctx.lineWidth = 4 * scale;
    ctx.setLineDash([12 * scale, 9 * scale]);
    ctx.lineDashOffset = reducedMotion.matches ? 0 : -performance.now() / 40;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < head.segment; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.lineTo(head.x, head.y);
    ctx.stroke();
    ctx.setLineDash([]);
    // Highlight the pair the demo connects.
    ctx.strokeStyle = getColor(colorId).fill;
    ctx.lineWidth = 1.5 * scale;
    for (const point of points.slice(0, 2)) {
      ctx.beginPath(); ctx.arc(point.x, point.y, 22 * scale, 0, TAU); ctx.stroke();
    }
    if (!reducedMotion.matches && t < 1) {
      // A fingertip pressing the route into the map.
      ctx.fillStyle = "rgba(246, 241, 227, 0.22)";
      ctx.strokeStyle = "rgba(246, 241, 227, 0.9)";
      ctx.lineWidth = 2 * scale;
      ctx.beginPath(); ctx.arc(head.x, head.y, 15 * scale, 0, TAU); ctx.fill(); ctx.stroke();
    } else {
      ctx.strokeStyle = LED;
      ctx.lineWidth = 2 * scale;
      ctx.beginPath(); ctx.arc(points[0].x, points[0].y, 15 * scale, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }

  function drawEffects() {
    const k = markerScale();
    for (let i = effects.length - 1; i >= 0; i--) {
      const effect = effects[i];
      if (effect.ring) {
        // Station pings are interface feedback, so they age in wall time even while planning.
        const ringAge = performance.now() - effect.born;
        if (ringAge > 480) { effects.splice(i, 1); continue; }
        const t = ringAge / 480;
        ctx.save();
        ctx.globalAlpha = (1 - t) * 0.9;
        ctx.strokeStyle = effect.color;
        ctx.lineWidth = 2.5 * k;
        ctx.beginPath();
        ctx.arc(effect.x, effect.y, (13 + (reducedMotion.matches ? 6 : 22 * (1 - (1 - t) ** 3))) * k, 0, TAU);
        ctx.stroke();
        ctx.restore();
        continue;
      }
      const age = nowMs() - effect.born;
      if (age > 1300) { effects.splice(i, 1); continue; }
      const t = age / 1300;
      ctx.save();
      if (effect.burst && !reducedMotion.matches) {
        // A delivery lands: two rings and a spray of short rays in the line color.
        const e = 1 - (1 - Math.min(1, age / 700)) ** 3;
        ctx.globalAlpha = Math.max(0, 1 - age / 700);
        ctx.strokeStyle = effect.color;
        ctx.lineWidth = 3 * k;
        ctx.beginPath(); ctx.arc(effect.x, effect.y, (14 + 40 * e) * k, 0, TAU); ctx.stroke();
        ctx.lineWidth = 1.5 * k;
        ctx.beginPath(); ctx.arc(effect.x, effect.y, (10 + 24 * e) * k, 0, TAU); ctx.stroke();
        ctx.lineCap = "round";
        ctx.lineWidth = 2.5 * k;
        for (let ray = 0; ray < 10; ray++) {
          const a = (ray / 10) * TAU + 0.3;
          ctx.beginPath();
          ctx.moveTo(effect.x + Math.cos(a) * (18 + 30 * e) * k, effect.y + Math.sin(a) * (18 + 30 * e) * k);
          ctx.lineTo(effect.x + Math.cos(a) * (24 + 44 * e) * k, effect.y + Math.sin(a) * (24 + 44 * e) * k);
          ctx.stroke();
        }
      }
      if (effect.miss) {
        // A missed parcel crosses out its destination.
        ctx.globalAlpha = Math.max(0, 1 - t);
        ctx.strokeStyle = MISS_RED;
        ctx.lineCap = "round";
        ctx.lineWidth = 4 * k;
        const r = 13 * k;
        ctx.beginPath(); ctx.moveTo(effect.x - r, effect.y - r); ctx.lineTo(effect.x + r, effect.y + r); ctx.moveTo(effect.x + r, effect.y - r); ctx.lineTo(effect.x - r, effect.y + r); ctx.stroke();
      }
      ctx.globalAlpha = Math.max(0, 1 - t ** 2);
      uprightAt(effect.x, effect.y);
      ctx.font = `900 ${(effect.miss ? 20 : 24) * canvasScale}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      const rise = (reducedMotion.matches ? 0 : 26 * (1 - (1 - t) ** 2)) + 26;
      labelText(effect.text, 0, -rise * canvasScale, effect.color);
      ctx.restore();
    }
  }

  function drawScreenOverlay() {
    useScreenTransform();
    if (mode === "paused") {
      ctx.fillStyle = "rgba(5, 12, 26, 0.62)";
      ctx.fillRect(0, 0, view.cssW, view.cssH);
      const { x: cx, y: cy } = view.stageCenter;
      ctx.textAlign = "center";
      ctx.fillStyle = LED;
      ctx.font = `900 34px ${FONT}`;
      ctx.fillText("Dispatch paused", cx, cy);
      ctx.fillStyle = "#b4c0d3";
      ctx.font = `600 16px ${FONT}`;
      ctx.fillText("Press Space or Resume when you are ready.", cx, cy + 30);
    } else if (mode === "over") {
      ctx.fillStyle = "rgba(5, 12, 26, 0.4)";
      ctx.fillRect(0, 0, view.cssW, view.cssH);
    }
  }

  function draw() {
    drawBackdrop();
    useWorldTransform();
    // Keyboard focus, or the guide pointing at the map, outlines the service area.
    if (appElement.dataset.canvasFocus === "true" || canvas.classList.contains("canvas-focus")) {
      ctx.strokeStyle = LED;
      ctx.lineWidth = 2.5 * canvasScale;
      ctx.strokeRect(-6 * canvasScale, -6 * canvasScale, WORLD_W + 12 * canvasScale, WORLD_H + 12 * canvasScale);
    }
    drawHazards();
    drawLoop();
    drawStations();
    drawPackages();
    drawStationLabels();
    if (mode !== "draw") drawBot();
    drawEffects();
    drawCoach();
    drawScreenOverlay();
  }

  // --- Input handling

  function pointerRadius(pointerType, mouseRadius, touchRadius) {
    return pointerType === "touch" ? touchRadius : pointerType === "pen" ? (mouseRadius + touchRadius) / 2 : mouseRadius;
  }

  function snapToStation(point, pointerType) {
    const radius = pointerType === "touch" ? Math.max(28, 22 * canvasScale) : pointerRadius(pointerType, STATION_SNAP_RADIUS, 28);
    let nearest = null;
    let nearestDistance = radius;
    for (const station of state.stations) {
      const stationDistance = dist(point, station);
      if (stationDistance <= nearestDistance) {
        nearestDistance = stationDistance;
        nearest = station;
      }
    }
    return nearest ? { x: nearest.x, y: nearest.y, station: nearest } : point;
  }

  function pingStation(station) {
    effects.push({ ring: true, x: station.x, y: station.y, born: performance.now(), color: getColor(station.colorId).fill });
    playTone("station");
  }

  function stationLabel(index) {
    const station = state.stations[index];
    return `${station.colorId === "gold" ? "G" : station.colorId[0].toUpperCase()}${index % 4 + 1}`;
  }

  function resetDrawing() {
    if (mode !== "draw") return;
    state.loop = null;
    state.draw = { points: [], dragging: false, cursor: null };
    recomputeRouteInfo();
    setMode("draw");
  }

  function changeCity(seed) {
    if (ui.cityMenu.matches?.(":popover-open")) ui.cityMenu.hidePopover();
    hideModal();
    hideTutorial({ restoreFocus: false });
    state.seed = seed;
    resetRun({ keepLoop: false });
    const url = new URL(window.location.href);
    url.searchParams.set("seed", seed);
    window.history.replaceState(null, "", url);
  }

  function addStation(index) {
    if (mode !== "draw" || state.loop) return;
    selectedStation = index;
    const station = state.stations[index];
    if (state.draw.points.length >= 3 && dist(station, state.draw.points[0]) < 1) {
      lockLoop(state.draw.points);
      return;
    }
    if (state.draw.points.length && dist(station, state.draw.points.at(-1)) < 1) return;
    state.draw.points.push({ x: station.x, y: station.y });
    pingStation(station);
    recomputeRouteInfo();
    setHint(`${stationLabel(index)} added. Choose another station, or close the loop. More stations on the loop bring more orders.`);
  }

  function undoPoint() {
    if (mode !== "draw") return;
    if (state.loop) {
      state.draw.points = state.loop.points.map((point) => ({ ...point }));
      state.loop = null;
      setHint("Loop reopened. Adjust your route, then close it again.");
    } else {
      state.draw.points.pop();
      setHint("Last point removed.");
    }
    state.draw.dragging = false;
    recomputeRouteInfo();
  }

  function suggestRoute() {
    if (mode !== "draw" || state.loop || state.draw.points.length) return;
    const remaining = state.stations.map((station) => ({ x: station.x, y: station.y }));
    const points = [remaining.shift()];
    while (remaining.length) {
      let best = 0;
      for (let i = 1; i < remaining.length; i++) {
        if (dist(points.at(-1), remaining[i]) < dist(points.at(-1), remaining[best])) best = i;
      }
      points.push(remaining.splice(best, 1)[0]);
    }
    lockLoop(points);
    setHint("The starter route connects all 12 stations. Dispatch it, or Undo to make it your own.");
  }

  function lockLoop(points) {
    let cleaned = uniqByKey(points, 8);
    cleaned = simplifyByAngle(cleaned, 8);
    cleaned = uniqByKey(cleaned, 8);
    if (cleaned.length < 3) {
      setHint("Add at least three distinct points before closing the loop.");
      return false;
    }
    state.draw.points = [];
    state.draw.dragging = false;
    state.draw.cursor = null;
    state.loop = buildLoop(cleaned);
    state.bot.segIndex = 0;
    state.bot.segPos = 0;
    state.bot.pos = { ...state.loop.points[0] };
    recomputeRouteInfo();
    loopClosedAtMs = performance.now();
    if (state.route.hasContract) playTone("loop");
    setMode("draw");
    setHint(state.route.hasContract ? "Loop ready. Dispatch when you are ready; planning has no time limit." : "This loop needs a same-color pickup and dropoff. Undo to edit it.");
    return true;
  }

  function closeLoopIfNearStart(closeDist = 18) {
    const points = state.draw.points;
    if (points.length < 4 || dist(points[0], points.at(-1)) > closeDist) return false;
    return lockLoop(points.slice(0, -1));
  }

  function toggleSplice() {
    syncLiveTime();
    if (mode === "splice") {
      state.splice.edgeA = null;
      setMode("run");
      return;
    }
    if (mode !== "run" || !state.loop || state.loop.points.length < 4 || state.splicesLeft <= 0) return;
    state.splice.edgeA = null;
    focusedEdge = 0;
    setMode("splice");
    canvas.focus({ preventScroll: true });
  }

  function selectSpliceEdge(index) {
    syncLiveTime();
    if (mode !== "splice" || !state.loop) return;
    focusedEdge = index;
    if (state.splice.edgeA === null) {
      state.splice.edgeA = index;
      setHint(`Edge ${index + 1} selected. Choose a non-adjacent edge to reconnect the route.`);
      return;
    }
    const beforePoints = state.loop.points;
    const newPoints = twoOptSpliceCycle(beforePoints, state.splice.edgeA, index);
    if (!newPoints.some((point, i) => point !== beforePoints[i])) {
      setHint("Choose two different, non-adjacent edges. This selection costs no splice.");
      return;
    }
    const candidate = buildLoop(newPoints);
    const route = computeRouteInfo(candidate);
    if (!route.hasContract) {
      setHint("That splice would disconnect every contract. Choose another edge; no splice was used.");
      return;
    }
    const projection = projectPointToLoop(candidate, state.bot.pos);
    state.loop = candidate;
    state.route = route;
    state.bot.segIndex = projection.segIndex;
    state.bot.segPos = projection.segPos;
    state.bot.pos = projection.pos;
    state.splicesLeft--;
    state.splice.edgeA = null;
    setMode("run");
    logEvent(`Route rewired, ${state.splicesLeft} splice${state.splicesLeft === 1 ? "" : "s"} left.`);
  }

  canvas.addEventListener("pointerdown", (e) => {
    canvas.focus({ preventScroll: true });
    // Focus that comes from a pointer is not shown; the outline is for keyboard users.
    delete appElement.dataset.canvasFocus;
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    const rawPoint = canvasToWorld(e.clientX, e.clientY);

    if (mode === "draw") {
      if (state.loop) return; // locked until reset
      if (!insideCanvas(rawPoint, WORLD_W, WORLD_H)) return;
      const closeRadius = pointerRadius(e.pointerType, 18, 34);

      // If clicking near start, attempt close.
      if (state.draw.points.length >= 3 && dist(rawPoint, state.draw.points[0]) <= closeRadius) {
        state.draw.points.push({ x: state.draw.points[0].x, y: state.draw.points[0].y });
        closeLoopIfNearStart(closeRadius);
        return;
      }

      const p = snapToStation(rawPoint, e.pointerType);
      state.draw.dragging = true;
      state.draw.points.push({ x: p.x, y: p.y });
      if (p.station) pingStation(p.station);
      recomputeRouteInfo();
      return;
    }

    if (mode === "splice") {
      const hit = nearestSegmentIndex(state.loop.points, rawPoint);
      const hitRadius = e.pointerType === "touch" ? Math.max(34, 22 * canvasScale) : pointerRadius(e.pointerType, 18, 34);
      if (hit.idx >= 0 && hit.d2 <= hitRadius * hitRadius) selectSpliceEdge(hit.idx);
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (mode !== "draw") return;
    if (state.loop) return;
    // Fast finger strokes deliver several samples per frame; use them all so the line follows the gesture.
    const samples = state.draw.dragging && e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    let added = false;
    for (const sample of samples.length ? samples : [e]) {
      const raw = canvasToWorld(sample.clientX, sample.clientY);
      const bounded = { x: clamp(raw.x, 0, WORLD_W), y: clamp(raw.y, 0, WORLD_H) };
      const p = snapToStation(bounded, e.pointerType);
      state.draw.cursor = p;
      if (!state.draw.dragging) continue;
      const pts = state.draw.points;
      if (pts.length === 0 || dist(p, pts.at(-1)) < 10) continue;
      pts.push({ x: p.x, y: p.y });
      if (p.station) pingStation(p.station);
      added = true;
    }
    if (added) recomputeRouteInfo();
  });

  canvas.addEventListener("pointerup", (e) => {
    if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (mode !== "draw") return;
    if (!state.draw.dragging) return;
    state.draw.dragging = false;
    // If release near start, close.
    if (state.draw.points.length >= 4) closeLoopIfNearStart(pointerRadius(e.pointerType, 18, 34));
  });

  canvas.addEventListener("pointercancel", (e) => {
    state.draw.dragging = false;
    if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  });

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.getElementById("app").requestFullscreen();
    } catch {
      setHint("Fullscreen is unavailable in this browser context.");
    }
  }

  window.addEventListener("keydown", (e) => {
    const target = e.target;
    const isEditing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (isEditing) {
      if (e.key === "Escape") target.blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // Let focused controls keep native Enter/Space behavior; Escape remains global.
    const nativeActivation = e.key === "Enter" || e.key === " " || e.code === "Space";
    if (nativeActivation && target instanceof Element && target.closest("button, a, summary, select, [contenteditable=true]")) return;
    if (!modal.classList.contains("hidden")) return;
    if (target === canvas && mode === "splice") {
      const direction = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (direction) {
        e.preventDefault();
        focusedEdge = (focusedEdge + direction + state.loop.points.length) % state.loop.points.length;
        setHint(`Edge ${focusedEdge + 1} of ${state.loop.points.length}. Press Space to select it.`);
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        selectSpliceEdge(focusedEdge);
        return;
      }
    }
    if (target === canvas && mode === "draw" && !state.loop) {
      const direction = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (direction) {
        e.preventDefault();
        selectedStation = (selectedStation + direction + state.stations.length) % state.stations.length;
        setHint(`${stationLabel(selectedStation)} selected. Press Space to add this station.`);
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        addStation(selectedStation);
        return;
      }
    }
    if ((e.key === "Backspace" || e.key.toLowerCase() === "z") && mode === "draw") {
      e.preventDefault();
      undoPoint();
      return;
    }
    if (e.key.toLowerCase() === "c" && mode === "draw" && !state.loop) {
      e.preventDefault();
      lockLoop(state.draw.points);
      return;
    }
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      pauseToggle();
      return;
    }
    if (e.key === "Escape") {
      if (document.fullscreenElement) {
        void document.exitFullscreen();
        return;
      }
      if (!tutorialDock.classList.contains("hidden")) {
        hideTutorial({ remember: false });
        return;
      }
      if (mode === "splice") toggleSplice();
      return;
    }
    if (e.key.toLowerCase() === "t") {
      if (tutorialDock.classList.contains("hidden")) showTutorial(0);
      else hideTutorial({ remember: false });
      return;
    }
    if (e.key.toLowerCase() === "f") {
      void toggleFullscreen();
      return;
    }
    if (e.key === "Enter") {
      if (mode === "draw" && state.loop && state.route.hasContract) {
        hideModal();
        resetRun({ keepLoop: true });
      }
      return;
    }
    if (e.key.toLowerCase() === "r") {
      resetDrawing();
      return;
    }
    if (e.key.toLowerCase() === "n") {
      changeCity(randomSeed(Math.random));
      return;
    }
    if (e.key.toLowerCase() === "s") toggleSplice();
  });

  // --- UI events

  btnNewSeed.addEventListener("click", () => changeCity(randomSeed(Math.random)));
  ui.btnDaily.addEventListener("click", () => changeCity(dailySeed()));
  ui.btnUndo.addEventListener("click", undoPoint);
  ui.btnCloseLoop.addEventListener("click", () => lockLoop(state.draw.points));
  ui.btnSuggest.addEventListener("click", suggestRoute);
  ui.btnSound.addEventListener("click", async () => {
    try {
      if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
      await audioContext.resume();
      soundEnabled = !soundEnabled;
      ui.btnSound.textContent = soundEnabled ? "Sound on" : "Sound off";
      ui.btnSound.setAttribute("aria-pressed", String(soundEnabled));
      if (soundEnabled) playTone("pickup");
    } catch { setHint("Audio is unavailable in this browser."); }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && (mode === "run" || mode === "splice")) {
      pauseToggle();
      setHint("Paused while you were away. Resume when you are ready.");
    }
  });
  canvas.addEventListener("pointerleave", () => { state.draw.cursor = null; });
  // The canvas fills the screen, so keyboard focus is shown as an outline around the city itself.
  canvas.addEventListener("focus", () => { if (canvas.matches(":focus-visible")) appElement.dataset.canvasFocus = "true"; });
  canvas.addEventListener("blur", () => { delete appElement.dataset.canvasFocus; });

  btnCopyLink.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(cityUrl());
      setHint("City link copied. Anyone who opens it gets this exact map.");
    } catch {
      setHint("Clipboard blocked. Copy the seed manually.");
    }
  });

  btnTutorial.addEventListener("click", () => {
    if (tutorialDock.classList.contains("hidden")) showTutorial(0);
    else hideTutorial({ remember: false });
  });

  btnTutSkip.addEventListener("click", () => {
    hideTutorial({ remember: true });
  });

  btnTutNext.addEventListener("click", () => {
    if (tutorialIndex < TUTORIAL_STEPS.length - 1) {
      tutorialIndex += 1;
      renderTutorialStep();
      return;
    }
    hideTutorial({ remember: true });
    canvas.focus({ preventScroll: true });
  });

  btnFullscreen.addEventListener("click", () => {
    void toggleFullscreen();
  });

  document.addEventListener("fullscreenchange", () => {
    const active = Boolean(document.fullscreenElement);
    btnFullscreen.setAttribute("aria-label", active ? "Exit fullscreen" : "Enter fullscreen");
    btnFullscreen.title = active ? "Exit fullscreen (F)" : "Enter fullscreen (F)";
    btnFullscreen.setAttribute("aria-pressed", String(active));
  });

  btnResetLoop.addEventListener("click", resetDrawing);

  btnStart.addEventListener("click", () => {
    if (mode !== "draw") return;
    if (!state.loop || !state.route.hasContract) return;
    hideModal();
    resetRun({ keepLoop: true });
  });

  btnSplice.addEventListener("click", toggleSplice);

  btnPause.addEventListener("click", () => {
    pauseToggle();
  });

  elSeed.addEventListener("change", () => {
    const s = elSeed.value.trim();
    if (!s) { elSeed.value = state.seed; return; }
    changeCity(s);
  });

  btnModalPrimary.addEventListener("click", () => {
    hideModal();
    // Keep loop and seed, restart.
    if (state.loop) resetRun({ keepLoop: true });
    else setMode("draw");
  });

  btnModalReplan.addEventListener("click", () => {
    const points = state.loop ? state.loop.points.map((point) => ({ ...point })) : [];
    hideModal();
    resetRun({ keepLoop: false });
    state.draw.points = points;
    recomputeRouteInfo();
    setHint("Your previous route is open for editing. Undo or add stops, then close it and dispatch again.");
    canvas.focus();
  });

  btnModalSecondary.addEventListener("click", () => changeCity(randomSeed(Math.random)));
  ui.btnShareResult.addEventListener("click", () => {
    void shareResult();
  });

  // Keep modal keyboard focus within the result actions.
  modal.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const buttons = [...modal.querySelectorAll("button:not(:disabled)")];
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  // --- Main loop


  function simulate(dt) {
    if (!(mode === "run" || mode === "splice")) return;
    const t = nowMs();
    updateDifficulty();
    if (t >= state.nextMutationAtMs) mutateCity();
    updateSpawn();
    updatePackages();
    updateBot(dt);
    tryPickupAndDeliver();
    if (t >= state.roundEndAtMs) endRun();
  }

  function renderFrame() {
    fitCanvasToDisplay();
    updateHud();
    draw();
  }

  // test-hooks:start (removed from the production bundle by scripts/build-site.mjs)
  window.render_game_to_text = () => {
    const snapshotNowMs = nowMs();
    const routePoints = state.loop ? state.loop.points : state.draw.points;
    const activePackages = state.packages
      .filter((pkg) => !pkg.delivered && !pkg.missed)
      .map((pkg) => ({
        id: pkg.id,
        color: pkg.colorId,
        state: pkg.carried ? "carried" : pkg.picked ? "picked" : "waiting",
        pickup: [round(pkg.pickup.x), round(pkg.pickup.y)],
        drop: [round(pkg.drop.x), round(pkg.drop.y)],
        deadlineRemainingMs: Math.max(0, Math.round(pkg.expiresAtMs - snapshotNowMs)),
      }));

    return JSON.stringify({
      coordinateSystem: `world units; origin top-left; +x right; +y down; ${WORLD_W}x${WORLD_H}`,
      mode,
      seed: state.seed,
      round: state.round,
      elapsedMs: Math.round(nowMs()),
      roundTimeRemainingMs:
        mode === "run" || mode === "splice" || mode === "paused"
          ? Math.max(0, Math.round(state.roundEndAtMs - snapshotNowMs))
          : 0,
      score: Math.floor(state.score),
      combo: state.combo,
      bestCombo: state.bestCombo,
      record: bestForSeed(records, state.seed),
      selectedStation,
      delivered: state.delivered,
      missed: state.missed,
      splicesLeft: state.splicesLeft,
      route: {
        closed: Boolean(state.loop),
        pointCount: routePoints.length,
        points: routePoints.map((point) => [round(point.x), round(point.y)]),
        pickupsCovered: state.route.pickupsCovered,
        dropsCovered: state.route.dropsCovered,
        contractColors: state.route.contractColors.slice(),
        ready: Boolean(state.loop) && state.route.hasContract,
      },
      bot: state.loop
        ? {
            position: [round(state.bot.pos.x), round(state.bot.pos.y)],
            segment: state.bot.segIndex,
            segmentDistance: round(state.bot.segPos),
            speed: state.bot.speed,
            cargo: state.cargoIds.slice(),
            cargoCapacity: state.cargoCap,
          }
        : null,
      stations: state.stations.map((station, index) => ({
        id: index,
        kind: station.kind,
        color: station.colorId,
        position: [round(station.x), round(station.y)],
        onRoute: Boolean(state.route.stationOnRoute[index]),
      })),
      packages: activePackages,
      hazards: state.hazards.map((hazard) => ({
        kind: hazard.kind,
        position: [round(hazard.x), round(hazard.y)],
        radius: round(hazard.r),
        remainingMs:
          hazard.kind === "jam" ? Math.max(0, Math.round(hazard.ttlMs - (snapshotNowMs - hazard.bornAtMs))) : null,
      })),
      spliceSelection: [state.splice.edgeA, null],
      coach: { visible: coachVisible() },
      focusedEdge,
      tutorial: {
        visible: !tutorialDock.classList.contains("hidden"),
        title: tutorialTitle.textContent,
        step: tutorialStep.textContent,
      },
      modal: {
        visible: !modal.classList.contains("hidden"),
        title: modalTitle.textContent,
      },
      controls: {
        startEnabled: !btnStart.disabled,
        spliceEnabled: !btnSplice.disabled,
        pauseEnabled: !btnPause.disabled,
        resetEnabled: !btnResetLoop.disabled,
      },
    });
  };

  window.worldToClient = (x, y) => {
    fitCanvasToDisplay(true);
    const rect = canvas.getBoundingClientRect();
    const point = new DOMPoint(x, y).matrixTransform(view.matrix);
    return { x: rect.left + point.x, y: rect.top + point.y };
  };

  window.advanceTime = (ms) => {
    const durationMs = Math.max(0, Number.isFinite(Number(ms)) ? Number(ms) : 0);
    manualClock = true;
    if (mode === "run" || mode === "splice") simulationClock.advance(durationMs);
    renderFrame();
  };
  // test-hooks:end

  function syncLiveTime(frameAtMs = performance.now()) {
    const elapsedMs = Math.max(0, frameAtMs - lastFrameAtMs);
    lastFrameAtMs = Math.max(lastFrameAtMs, frameAtMs);
    if (!manualClock && (mode === "run" || mode === "splice")) simulationClock.advance(elapsedMs);
  }

  function tick(frameAtMs) {
    syncLiveTime(frameAtMs);
    renderFrame();
    requestAnimationFrame(tick);
  }

  // --- Boot

  function boot() {
    const seed = parseSeedFromUrl();
    setSeed(seed);
    state.loop = null;
    state.draw.points = [];
    setMode("draw");
    btnTutorial.setAttribute("aria-expanded", "false");
    btnFullscreen.disabled = !document.fullscreenEnabled;
    logEvent("City ready. Connect matching stations.");
    coachActive = !hasCompletedTutorial();
    updateButtons();
    // Canvas text only uses a web font once it has loaded, so repaint the street plan when it arrives.
    if (document.fonts) {
      Promise.all([document.fonts.load(`800 12px ${FONT}`), document.fonts.load(`italic 600 12px ${FONT}`)])
        .then(() => { backdrop = null; }, () => {});
    }
    requestAnimationFrame(tick);
  }

  boot();
})();
