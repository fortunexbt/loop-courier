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
  const SERVICE_RADIUS = 18; // Must match pickup/delivery radius for "on-route" logic.
  const STATION_SNAP_RADIUS = 14; // While drawing, snap points to nearby stations for easier routes.
  const TUTORIAL_DONE_KEY = "loopCourierTutorialDone.v1";

  const COLORS = [
    { id: "red", label: "Red", fill: "#ef476f", stroke: "rgba(239, 71, 111, 0.95)" },
    { id: "blue", label: "Blue", fill: "#62c9ef", stroke: "rgba(98, 201, 239, 0.95)" },
    { id: "gold", label: "Gold", fill: "#ffd166", stroke: "rgba(255, 209, 102, 0.95)" },
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

  let virtualNowMs = null;

  function nowMs() {
    return virtualNowMs === null ? performance.now() : virtualNowMs;
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

  function fitCanvasToDisplay(canvas) {
    const rect = canvas.getBoundingClientRect();
    // Keep internal resolution stable but match display ratio via CSS.
    // We still use fixed pixel coordinates for gameplay.
    return { rect };
  }

  function canvasToWorld(canvas, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * canvas.width;
    const y = ((clientY - rect.top) / rect.height) * canvas.height;
    return { x, y };
  }

  // --- Game state

  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("game"));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d", { alpha: true }));

  let storage;
  try { storage = window.localStorage; } catch { /* Session-only records are supported. */ }
  let records = readRecords(storage);
  let unsavedRecords = null;
  let selectedStation = 0;
  let soundEnabled = false;
  let audioContext = null;
  let tutorialPausedRun = false;
  const events = [];
  const effects = [];
  const ui = Object.fromEntries([
    "btnDaily", "bestScore", "seedBadge", "phaseLabel", "routeStatus", "routeLength", "routeCoverage",
    "btnUndo", "btnCloseLoop", "btnSuggest", "stationPicker", "cargoStatus", "dispatchFeed", "btnSound",
    "statDelivered", "statMissed",
  ].map((id) => [id, document.getElementById(id)]));

  const contractElements = Object.fromEntries(COLORS.map((color) => [color.id, document.getElementById(`contract-${color.id}`)]));

  function setText(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  function phaseText() {
    switch (mode) {
      case "draw": return state.loop ? "READY TO DISPATCH" : "PLAN YOUR ROUTE";
      case "over": return "SHIFT COMPLETE";
      case "paused": return "DISPATCH PAUSED";
      case "splice": return "REWIRE THE ROUTE";
      default: return "COURIER IN TRANSIT";
    }
  }

  function routeStatusText() {
    if (state.loop) return state.route.hasContract ? "Your loop is ready" : "Connect a matching pair";
    if (state.draw.points.length) return `${state.draw.points.length} stops drawn · close your loop`;
    return "Every delivery starts with a line.";
  }

  function playTone(kind) {
    if (!soundEnabled || !audioContext) return;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const time = audioContext.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(kind === "delivery" ? 660 : kind === "pickup" ? 440 : 180, time);
    oscillator.frequency.exponentialRampToValueAtTime(kind === "delivery" ? 990 : 220, time + 0.12);
    gain.gain.setValueAtTime(0.055, time);
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
  const elRoute = document.getElementById("statRoute");
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

  const TUTORIAL_STEPS = [
    {
      title: "Connect the network",
      body: "Circles are pickups; squares are dropoffs. Connect a same-color pair in a loop of at least three points, or try Starter route. Undo reopens a loop. On the map, arrows select stations, Space adds one, and C closes the route.",
      target: canvas,
    },
    {
      title: "Dispatch the courier",
      body: "Dispatch unlocks when a color contract is connected. New orders use connected stations only. More connected colors earn bigger delivery bonuses. Your courier carries up to three packages.",
      target: btnStart,
    },
    {
      title: "Splice under pressure",
      body: "Press S or Splice, then choose two non-adjacent edges on a route with four or more points. Rewiring changes the loop while the courier moves. You get three splices. Existing orders keep their destinations.",
      target: btnSplice,
    },
    {
      title: "Beat the mutation clock",
      body: "Tolls drain score and jams slow the courier. Space pauses during a run. Daily city is shared worldwide on UTC time; your best scores stay on this device. Every retry resets the city and its timers.",
      target: btnPause,
    },
  ];

  /** @type {{loop: null | ReturnType<typeof buildLoop>, route: any, draw: {points: {x:number,y:number}[], dragging:boolean, cursor: null | {x:number,y:number}}, splice: {edgeA: null | number, edgeB: null | number}, rng: () => number, seed: string, round: number, roundEndAtMs: number, roundDurationS: number, pausedAtMs: null | number, score: number, combo: number, delivered: number, missed: number, splicesLeft: number, maxSplices: number, bot: {segIndex: number, segPos: number, speed: number, pos: {x:number,y:number}}, stations: any[], packages: any[], nextSpawnAtMs: number, baseDeadlineS: number, cargoCap: number, cargoIds: number[], hazards: any[], nextMutationAtMs: number, difficulty: number }} */
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
    splice: { edgeA: null, edgeB: null },
    rng: createRng(""),
    seed: "",
    round: 1,
    roundEndAtMs: 0,
    roundDurationS: 120,
    pausedAtMs: null,
    score: 0,
    combo: 0,
    bestCombo: 0,
    delivered: 0,
    missed: 0,
    splicesLeft: 3,
    maxSplices: 3,
    bot: { segIndex: 0, segPos: 0, speed: 160, pos: { x: canvas.width / 2, y: canvas.height / 2 } },
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
    tutorialIndex = clamp(index, 0, TUTORIAL_STEPS.length - 1);
    focusBeforeOverlay = document.activeElement;
    tutorialDock.classList.remove("hidden");
    btnTutorial.setAttribute("aria-expanded", "true");
    renderTutorialStep();
    btnTutNext.focus({ preventScroll: true });
  }

  function hideTutorial({ remember = false, restoreFocus = true } = {}) {
    if (tutorialDock.classList.contains("hidden")) return;
    tutorialDock.classList.add("hidden");
    btnTutorial.setAttribute("aria-expanded", "false");
    clearTutorialPulse();
    if (remember) setTutorialDone();
    if (tutorialPausedRun && mode === "paused") pauseToggle();
    tutorialPausedRun = false;
    if (restoreFocus && focusBeforeOverlay instanceof HTMLElement) focusBeforeOverlay.focus({ preventScroll: true });
    focusBeforeOverlay = null;
  }

  function setMode(nextMode) {
    mode = nextMode;
    document.getElementById("app").dataset.mode = mode;
    updateButtons();
    if (mode === "draw") {
      setHint("Draw a closed loop around pickups/dropoffs. Close by clicking near the first point.");
    } else if (mode === "run") {
      setHint("Deliver fast. Press S to splice (click 2 edges).");
    } else if (mode === "splice") {
      setHint("Splice mode: click two loop edges to rewire. Esc to cancel.");
    } else if (mode === "paused") {
      setHint("Paused. Press Space to resume.");
    }
  }

  function pauseToggle() {
    if (mode === "paused") {
      const resumedAtMs = nowMs();
      const pausedForMs = Math.max(0, resumedAtMs - (state.pausedAtMs ?? resumedAtMs));
      state.roundEndAtMs += pausedForMs;
      state.nextSpawnAtMs += pausedForMs;
      state.nextMutationAtMs += pausedForMs;
      for (const pkg of state.packages) {
        pkg.createdAtMs += pausedForMs;
        pkg.expiresAtMs += pausedForMs;
      }
      for (const hazard of state.hazards) hazard.bornAtMs += pausedForMs;
      for (const effect of effects) effect.born += pausedForMs;
      state.pausedAtMs = null;
      setMode(pausedMode);
      return;
    }
    if (mode === "run" || mode === "splice") {
      pausedMode = mode;
      state.pausedAtMs = nowMs();
      setMode("paused");
    }
  }

  function updateButtons() {
    const hasLoop = !!state.loop;
    const canStart = hasLoop && state.route.hasContract && mode === "draw";
    btnStart.disabled = !canStart;
    btnSplice.disabled = !hasLoop || state.loop.points.length < 4 || mode !== "run" || state.splicesLeft <= 0;
    btnResetLoop.disabled = mode !== "draw" || (!hasLoop && !state.draw.points.length);
    ui.btnUndo.disabled = mode !== "draw" || (!hasLoop && !state.draw.points.length);
    ui.btnCloseLoop.disabled = mode !== "draw" || hasLoop || state.draw.points.length < 3;
    ui.btnSuggest.disabled = mode !== "draw" || hasLoop || state.draw.points.length > 0;
    for (const button of ui.stationPicker.querySelectorAll("button")) button.disabled = mode !== "draw" || hasLoop;
    btnPause.disabled = mode === "draw" || mode === "over";
    btnPause.textContent = mode === "paused" ? "Resume" : "Pause";
    btnPause.setAttribute("aria-pressed", String(mode === "paused"));
    btnSplice.setAttribute("aria-pressed", String(mode === "splice"));
  }

  function setSeed(seedStr) {
    state.seed = seedStr;
    elSeed.value = seedStr;
    state.rng = createRng(seedStr);
    state.stations = generateStations(state.rng);
    state.hazards = [];
    state.nextMutationAtMs = Infinity;
    ui.seedBadge.textContent = seedStr === dailySeed() ? "DAILY CITY · UTC" : "CUSTOM CITY";
    const best = bestForSeed(records, seedStr);
    ui.bestScore.textContent = best ? String(best.score) : "—";
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
    state.pausedAtMs = null;
    pkgIdCounter = 1;

    events.length = 0;
    effects.length = 0;
    state.splice.edgeA = null;
    state.splice.edgeB = null;
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
    const t = nowMs();
    state.roundDurationS = 120;
    state.roundEndAtMs = t + state.roundDurationS * 1000;
    state.nextSpawnAtMs = t + 1000;
    state.nextMutationAtMs = t + 16000;
    state.pausedAtMs = null;
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
    score.textContent = `${result.score} pts`;
    const title = document.createElement("p");
    title.className = "result-rank";
    title.textContent = rank.label;
    const grid = document.createElement("div");
    grid.className = "result-grid";
    for (const [label, value] of [["Delivered", result.delivered], ["Missed", result.missed], ["Best combo", result.bestCombo], ["City best", saved.best.score]]) {
      const cell = document.createElement("div");
      const number = document.createElement("strong");
      number.textContent = String(value);
      const caption = document.createElement("span");
      caption.textContent = label;
      cell.append(number, caption);
      grid.append(cell);
    }
    const note = document.createElement("p");
    note.className = "result-note";
    note.textContent = `${rank.detail} City ${state.seed}. ${saved.persisted ? "Best saved on this device." : "Storage unavailable; this result is session only."} Retry starts a fresh attempt on your final route.`;
    modalBody.replaceChildren(score, title, grid, note);
    logEvent(`Shift complete · ${result.score} points`, "delivery");
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

  function generateStations(rng) {
    return generateCityStations(rng, {
      width: canvas.width,
      height: canvas.height,
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
    logEvent(`${getColor(pkg.colorId).label} order · ${Math.ceil(deadlineS)}s to deliver`);
  }

  function mutateCity() {
    const rng = state.rng;
    const kind = rng() < 0.6 ? "toll" : "jam";
    const margin = 70;
    const p = { x: randRange(rng, margin, canvas.width - margin), y: randRange(rng, margin, canvas.height - margin) };
    if (kind === "toll") {
      state.hazards.push({
        kind: "toll",
        x: p.x,
        y: p.y,
        r: randRange(rng, 26, 42),
        cost: randRange(rng, 4, 9) * state.difficulty,
        bornAtMs: nowMs(),
      });
      setHint("City mutation: toll bubble spawned. Splice your loop to dodge it.");
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
      setHint("City mutation: traffic jam. Passing through slows you down.");
    }
    logEvent(kind === "toll" ? "New toll zone. Watch the amber ring." : "Traffic jam. Watch the blue ring.", "warning");
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
        pkg.carried = false;
        state.cargoIds = state.cargoIds.filter((id) => id !== pkgId);
        const base = 30 + 10 * Math.max(0, state.route.contractColors.length - 1);
        state.combo = state.combo + 1;
        state.bestCombo = Math.max(state.bestCombo, state.combo);
        const mult = 1 + Math.min(12, state.combo) * 0.12;
        state.score += base * mult;
        state.delivered += 1;
        effects.push({ x: pkg.drop.x, y: pkg.drop.y, text: `+${Math.round(base * mult)}`, born: nowMs(), color: "#c7f36b" });
        logEvent(`${getColor(pkg.colorId).label} delivered · +${Math.round(base * mult)} · combo ${state.combo}`, "delivery");
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
          pkg.carried = true;
          state.cargoIds.push(pkg.id);
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
        pkg.carried = false;
        // Remove from cargo if it was carried.
        state.cargoIds = state.cargoIds.filter((id) => id !== pkg.id);
        state.missed += 1;
        state.combo = 0;
        state.score = Math.max(0, state.score - 18);
        effects.push({ x: pkg.drop.x, y: pkg.drop.y, text: "−18", born: nowMs(), color: "#fb8299" });
        logEvent(`${getColor(pkg.colorId).label} deadline missed · −18`, "warning");
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
    const baseEveryMs = 2600;
    const accel = clamp(1 - state.difficulty * 0.05, 0.55, 1);
    const jitter = randRange(rng, -450, 650);
    state.nextSpawnAtMs = now + baseEveryMs * accel + jitter;
  }

  function updateDifficulty() {
    // Smooth ramp during the round.
    const remainS = Math.max(0, (state.roundEndAtMs - nowMs()) / 1000);
    const progress = 1 - remainS / state.roundDurationS;
    state.difficulty = 1 + progress * 6 + (state.round - 1) * 1.5;
  }

  function displayNowMs() {
    return mode === "paused" && state.pausedAtMs !== null ? state.pausedAtMs : nowMs();
  }

  function updateHud() {
    const covered = state.route.pickupsCovered + state.route.dropsCovered;
    const total = state.route.pickupsTotal + state.route.dropsTotal;
    setText(elScore, String(Math.floor(state.score)));
    setText(elCombo, `${state.combo}×`);
    setText(ui.statDelivered, String(state.delivered));
    setText(ui.statMissed, String(state.missed));
    setText(ui.phaseLabel, phaseText());
    setText(ui.routeStatus, routeStatusText());
    setText(ui.routeLength, state.loop ? `~${Math.ceil(state.loop.totalLen / (state.bot.speed * 0.87))}s / lap` : "—");
    setText(ui.routeCoverage, `${covered}/${total} stations`);
    setText(ui.cargoStatus, `${state.cargoIds.length} / ${state.cargoCap} packages aboard`);
    for (const color of COLORS) {
      const count = state.route.pickupsByColor[color.id]?.length || 0;
      const drops = state.route.dropsByColor[color.id]?.length || 0;
      const element = contractElements[color.id];
      setText(element, `${count}/2 pickups · ${drops}/2 drops`);
      const connected = String(count > 0 && drops > 0);
      if (element.parentElement.dataset.connected !== connected) element.parentElement.dataset.connected = connected;
    }
    setText(elSplices, String(state.splicesLeft));
    setText(elRoute, state.loop && state.route.hasContract ? `${state.route.contractColors.length} live` : `${covered}/${total}`);

    if (mode === "run" || mode === "splice" || mode === "paused") {
      const t = Math.max(0, (state.roundEndAtMs - displayNowMs()) / 1000);
      setText(elTime, fmtTime(t));
    } else {
      setText(elTime, mode === "draw" ? "2:00" : "0:00");
    }

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

  function drawBackdrop() {
    const w = canvas.width;
    const h = canvas.height;
    const wash = ctx.createLinearGradient(0, 0, w, h);
    wash.addColorStop(0, "#111f2b");
    wash.addColorStop(0.52, "#101a24");
    wash.addColorStop(1, "#14222a");
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, w, h);

    // Quiet city blocks and arterial lines make the route read like a night transit map.
    ctx.save();
    ctx.fillStyle = "rgba(183, 211, 230, 0.025)";
    const blocks = [
      [42, 44, 164, 100],
      [242, 38, 210, 78],
      [500, 56, 124, 118],
      [706, 34, 196, 102],
      [64, 196, 124, 150],
      [250, 180, 178, 116],
      [470, 224, 172, 122],
      [724, 190, 156, 142],
      [32, 416, 196, 118],
      [278, 382, 150, 142],
      [516, 408, 120, 110],
      [714, 392, 204, 140],
    ];
    for (const [x, y, bw, bh] of blocks) ctx.fillRect(x, y, bw, bh);

    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(178, 203, 222, 0.035)";
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.moveTo(-20, 410);
    ctx.bezierCurveTo(210, 330, 430, 410, 985, 250);
    ctx.stroke();
    ctx.strokeStyle = "rgba(17, 138, 178, 0.055)";
    ctx.lineWidth = 46;
    ctx.beginPath();
    ctx.moveTo(660, -30);
    ctx.bezierCurveTo(620, 135, 720, 270, 672, 630);
    ctx.stroke();
    ctx.font = "600 10px ui-monospace, monospace";
    ctx.fillStyle = "rgba(183, 211, 230, 0.3)";
    ctx.fillText("NORTH QUARTER", 42, 30);
    ctx.fillText("RIVERSIDE", 736, 376);
    ctx.fillText("OLD TOWN", 38, 574);
    ctx.fillText("SOUTH TERMINAL", 508, 574);
    ctx.fillStyle = "rgba(183, 211, 230, 0.55)";
    ctx.fillText("N ↑", 909, 34);
    ctx.restore();
  }

  function drawGrid() {
    const w = canvas.width;
    const h = canvas.height;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(230, 238, 252, 0.045)";
    const step = 40;
    for (let x = step; x < w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }
    for (let y = step; y < h; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawStations() {
    const pulse = 0.5 + 0.5 * Math.sin(displayNowMs() / 500);
    for (const [index, s] of state.stations.entries()) {
      const c = getColor(s.colorId);
      const r = s.kind === "pickup" ? 10 : 11;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.shadowColor = c.fill;
      ctx.shadowBlur = state.route.stationOnRoute[index] ? 8 + pulse * 3 : 3;
      ctx.lineWidth = 2;
      ctx.strokeStyle = c.stroke;
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      if (s.kind === "pickup") {
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, TAU);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = c.fill;
        ctx.font = "800 10px ui-sans-serif, system-ui";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("P", 0, 0.5);
      } else {
        ctx.beginPath();
        ctx.rect(-r, -r, r * 2, r * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = c.fill;
        ctx.font = "800 10px ui-sans-serif, system-ui";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("D", 0, 0.5);
      }
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(220, 233, 241, 0.75)";
      ctx.font = "600 10px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText(stationLabel(index), 17, 1);
      if (state.route.stationOnRoute[index]) {
        ctx.strokeStyle = "rgba(199,243,107,0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(0, 0, 17, 0, TAU); ctx.stroke();
      }
      if (mode === "draw" && document.activeElement === canvas && selectedStation === index) {
        ctx.strokeStyle = "#c7f36b";
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(0, 0, 23, 0, TAU); ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawHazards() {
    for (const hz of state.hazards) {
      ctx.save();
      ctx.translate(hz.x, hz.y);
      if (hz.kind === "toll") {
        ctx.fillStyle = "rgba(255, 209, 102, 0.08)";
        ctx.strokeStyle = "rgba(255, 209, 102, 0.35)";
      } else {
        ctx.fillStyle = "rgba(17, 138, 178, 0.08)";
        ctx.strokeStyle = "rgba(17, 138, 178, 0.35)";
      }
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, hz.r, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawPackages() {
    const now = displayNowMs();
    for (const pkg of state.packages) {
      if (pkg.delivered || pkg.missed) continue;
      const c = getColor(pkg.colorId);
      const tLeft = (pkg.expiresAtMs - now) / 1000;
      const frac = clamp(tLeft / state.baseDeadlineS, 0, 1);
      const alpha = 0.35 + 0.55 * frac;

      // Waiting at pickup
      if (!pkg.picked) {
        ctx.save();
        ctx.translate(pkg.pickup.x, pkg.pickup.y);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = c.fill;
        ctx.beginPath();
        ctx.arc(0, 0, 5.5, 0, TAU);
        ctx.fill();
        ctx.restore();
      } else if (pkg.carried) {
        // Draw carried as orbiting dots around bot later.
      }

      // Destination marker
      ctx.save();
      ctx.translate(pkg.drop.x, pkg.drop.y);
      ctx.globalAlpha = 0.18 + 0.22 * frac;
      ctx.strokeStyle = c.stroke;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 16, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawLoop() {
    const pts = state.loop ? state.loop.points : state.draw.points;
    if (pts.length < 1) return;
    const closed = Boolean(state.loop);

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // Glow underlay
    ctx.strokeStyle = "rgba(199, 243, 107, 0.10)";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (closed) ctx.lineTo(pts[0].x, pts[0].y);
    ctx.stroke();

    // Main line
    ctx.strokeStyle = "rgba(199, 243, 107, 0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (closed) ctx.lineTo(pts[0].x, pts[0].y);
    ctx.stroke();

    if (closed) {
      for (const segment of state.loop.segments) {
        if (segment.len < 70) continue;
        ctx.save();
        ctx.translate((segment.a.x + segment.b.x) / 2, (segment.a.y + segment.b.y) / 2);
        ctx.rotate(Math.atan2(segment.b.y - segment.a.y, segment.b.x - segment.a.x));
        ctx.fillStyle = "#c7f36b";
        ctx.beginPath(); ctx.moveTo(5, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    } else {
      const first = pts[0];
      ctx.strokeStyle = "#c7f36b";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.arc(first.x, first.y, 20, 0, TAU); ctx.stroke();
      if (state.draw.cursor) {
        ctx.strokeStyle = "rgba(199,243,107,0.45)";
        ctx.beginPath(); ctx.moveTo(pts.at(-1).x, pts.at(-1).y); ctx.lineTo(state.draw.cursor.x, state.draw.cursor.y); ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Control points in draw mode
    if (mode === "draw" && !state.loop) {
      ctx.fillStyle = "rgba(230, 238, 252, 0.82)";
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const r = i === 0 ? 5 : 3.2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, TAU);
        ctx.fill();
      }
    }

    // Splice selection highlight
    if (mode === "splice" && state.loop) {
      const n = state.loop.points.length;
      const edges = [state.splice.edgeA, state.splice.edgeB].filter((x) => x !== null);
      for (const e of edges) {
        const i = /** @type {number} */ (e);
        if (i < 0 || i >= n) continue;
        const a = state.loop.points[i];
        const b = state.loop.points[(i + 1) % n];
        ctx.strokeStyle = "rgba(255, 209, 102, 0.95)";
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  function drawBot() {
    if (!state.loop) return;
    const p = state.bot.pos;
    const pulse = 0.5 + 0.5 * Math.sin(displayNowMs() / 130);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.shadowColor = "rgba(199, 243, 107, 0.9)";
    ctx.shadowBlur = 18 + pulse * 8;
    ctx.fillStyle = "#e6ffc1";
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(11, 16, 32, 0.9)";
    ctx.beginPath();
    ctx.arc(0, 0, 3.2, 0, TAU);
    ctx.fill();

    // Cargo dots
    const cargo = state.cargoIds.map((id) => state.packages.find((p) => p.id === id)).filter(Boolean);
    const count = cargo.length;
    for (let i = 0; i < count; i++) {
      const pkg = cargo[i];
      const c = getColor(pkg.colorId);
      const ang = (displayNowMs() / 350) * 0.8 + (i / Math.max(1, count)) * TAU;
      const rr = 12 + pulse * 2;
      ctx.fillStyle = c.fill;
      ctx.beginPath();
      ctx.arc(Math.cos(ang) * rr, Math.sin(ang) * rr, 3.4, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawRoundBar() {
    if (!(mode === "run" || mode === "splice" || mode === "paused")) return;
    const remain = Math.max(0, (state.roundEndAtMs - displayNowMs()) / 1000);
    const frac = clamp(remain / state.roundDurationS, 0, 1);
    const w = canvas.width;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = "rgba(230, 238, 252, 0.08)";
    ctx.fillRect(0, canvas.height - 10, w, 10);
    ctx.fillStyle = "rgba(255, 209, 102, 0.9)";
    ctx.fillRect(0, canvas.height - 10, w * frac, 10);
    ctx.restore();
  }

  function draw() {
    drawBackdrop();
    drawGrid();
    drawHazards();
    drawLoop();
    drawStations();
    drawPackages();
    if (mode !== "draw") drawBot();
    drawRoundBar();
    for (let i = effects.length - 1; i >= 0; i--) {
      const effect = effects[i];
      const age = displayNowMs() - effect.born;
      if (age > 1300) { effects.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - age / 1300);
      ctx.fillStyle = effect.color;
      ctx.font = "800 18px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText(effect.text, effect.x, effect.y - 24 - age / 45);
      ctx.restore();
    }
    if (mode === "paused") {
      ctx.save();
      ctx.fillStyle = "rgba(10,17,24,0.5)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#e6ffc1";
      ctx.textAlign = "center";
      ctx.font = "600 26px ui-sans-serif, system-ui";
      ctx.fillText("Take a breath. The city can wait.", canvas.width / 2, canvas.height / 2);
      ctx.font = "14px ui-monospace, monospace";
      ctx.fillText("RESUME WHEN YOU’RE READY", canvas.width / 2, canvas.height / 2 + 32);
      ctx.restore();
    }

    if (!state.loop && mode === "draw") {
      // Light guidance: show nearest pickup -> drop relationship.
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = "rgba(230, 238, 252, 0.22)";
      ctx.lineWidth = 1.5;
      for (const c of COLORS) {
        const pk = state.stations.find((s) => s.kind === "pickup" && s.colorId === c.id);
        const dp = state.stations.find((s) => s.kind === "drop" && s.colorId === c.id);
        if (!pk || !dp) continue;
        ctx.beginPath();
        ctx.moveTo(pk.x, pk.y);
        ctx.lineTo(dp.x, dp.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (mode === "over") {
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(230, 238, 252, 0.9)";
      ctx.font = "900 22px ui-sans-serif, system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Round Over", canvas.width / 2, canvas.height / 2 - 10);
      ctx.font = "600 14px ui-sans-serif, system-ui";
      ctx.fillStyle = "rgba(230, 238, 252, 0.7)";
      ctx.fillText("Use the modal to restart.", canvas.width / 2, canvas.height / 2 + 18);
      ctx.restore();
    }
  }

  // --- Input handling

  function pointerRadius(pointerType, mouseRadius, touchRadius) {
    return pointerType === "touch" ? touchRadius : pointerType === "pen" ? (mouseRadius + touchRadius) / 2 : mouseRadius;
  }

  function snapToStation(point, pointerType) {
    const radius = pointerRadius(pointerType, STATION_SNAP_RADIUS, 28);
    let nearest = null;
    let nearestDistance = radius;
    for (const station of state.stations) {
      const stationDistance = dist(point, station);
      if (stationDistance <= nearestDistance) {
        nearestDistance = stationDistance;
        nearest = station;
      }
    }
    return nearest ? { x: nearest.x, y: nearest.y } : point;
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
    recomputeRouteInfo();
    setHint(`${stationLabel(index)} added. Choose another station, or close the loop after three stops.`);
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
    setHint("Starter route connects all 12 stations. Dispatch it, or Undo to make it your own.");
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
    setMode("draw");
    setHint(state.route.hasContract ? "Loop ready. Dispatch when you are ready; planning has no time limit." : "This loop needs a same-color pickup and dropoff. Undo to edit it.");
    return true;
  }

  function closeLoopIfNearStart(closeDist = 18) {
    const points = state.draw.points;
    if (points.length < 4 || dist(points[0], points.at(-1)) > closeDist) return false;
    return lockLoop(points.slice(0, -1));
  }

  canvas.addEventListener("pointerdown", (e) => {
    canvas.focus({ preventScroll: true });
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    const rawPoint = canvasToWorld(canvas, e.clientX, e.clientY);

    if (mode === "draw") {
      if (state.loop) return; // locked until reset
      if (!insideCanvas(rawPoint, canvas.width, canvas.height)) return;
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
      recomputeRouteInfo();
      return;
    }

    if (mode === "splice") {
      if (!state.loop) return;
      const hit = nearestSegmentIndex(state.loop.points, rawPoint);
      if (hit.idx < 0) return;
      const hitRadius = pointerRadius(e.pointerType, 18, 34);
      if (hit.d2 > hitRadius * hitRadius) return;
      if (state.splice.edgeA === null) {
        state.splice.edgeA = hit.idx;
        return;
      }
      if (state.splice.edgeB === null) {
        state.splice.edgeB = hit.idx;

        const edgeA = state.splice.edgeA;
        const edgeB = state.splice.edgeB;
        if (edgeA === null || edgeB === null) return;
        if (edgeA === edgeB) {
          state.splice.edgeB = null;
          return;
        }

        const beforePos = { x: state.bot.pos.x, y: state.bot.pos.y };
        const beforePoints = state.loop.points;
        const newPoints = twoOptSpliceCycle(beforePoints, edgeA, edgeB);
        const changed =
          newPoints.length !== beforePoints.length || newPoints.some((pt, idx) => pt !== beforePoints[idx]);
        if (!changed) {
          // Invalid/no-op (most commonly adjacent edges). Don't consume a splice.
          state.splice.edgeB = null;
          setHint("Invalid splice. Pick two non-adjacent edges on the loop.");
          return;
        }
        state.loop = buildLoop(newPoints);
        recomputeRouteInfo();

        const proj = projectPointToLoop(state.loop, beforePos);
        state.bot.segIndex = proj.segIndex;
        state.bot.segPos = proj.segPos;
        state.bot.pos = proj.pos;

        state.splicesLeft = Math.max(0, state.splicesLeft - 1);
        state.splice.edgeA = null;
        state.splice.edgeB = null;
        setMode("run");
        return;
      }
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (mode !== "draw") return;
    if (state.loop) return;
    const raw = canvasToWorld(canvas, e.clientX, e.clientY);
    const bounded = { x: clamp(raw.x, 0, canvas.width), y: clamp(raw.y, 0, canvas.height) };
    const p = snapToStation(bounded, e.pointerType);
    state.draw.cursor = p;
    if (!state.draw.dragging) return;
    const pts = state.draw.points;
    if (pts.length === 0) return;
    const last = pts[pts.length - 1];
    if (dist(p, last) < 10) return;
    pts.push({ x: p.x, y: p.y });
    recomputeRouteInfo();
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
      if (mode === "splice") {
        state.splice.edgeA = null;
        state.splice.edgeB = null;
        setMode("run");
      }
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
    if (e.key.toLowerCase() === "s") {
      if (mode === "run" && state.loop && state.loop.points.length >= 4 && state.splicesLeft > 0) {
        state.splice.edgeA = null;
        state.splice.edgeB = null;
        setMode("splice");
      }
    }
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

  btnCopyLink.addEventListener("click", async () => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("seed", state.seed);
      await navigator.clipboard.writeText(url.toString());
      setHint("Share link copied to clipboard.");
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

  btnSplice.addEventListener("click", () => {
    if (mode !== "run") return;
    if (!state.loop || state.loop.points.length < 4 || state.splicesLeft <= 0) return;
    state.splice.edgeA = null;
    state.splice.edgeB = null;
    setMode("splice");
  });

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

  btnModalSecondary.addEventListener("click", () => changeCity(randomSeed(Math.random)));

  // Keep modal keyboard focus within the result actions.
  modal.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const buttons = [...modal.querySelectorAll("button:not(:disabled)")];
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  // --- Main loop

  let lastT = nowMs();

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
    fitCanvasToDisplay(canvas);
    updateHud();
    draw();
  }

  window.render_game_to_text = () => {
    const snapshotNowMs = displayNowMs();
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
      coordinateSystem: `canvas pixels; origin top-left; +x right; +y down; ${canvas.width}x${canvas.height}`,
      mode,
      seed: state.seed,
      round: state.round,
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
      spliceSelection: [state.splice.edgeA, state.splice.edgeB],
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

  window.advanceTime = (ms) => {
    const durationMs = Math.max(0, Number.isFinite(Number(ms)) ? Number(ms) : 0);
    if (virtualNowMs === null) virtualNowMs = lastT;
    const targetMs = virtualNowMs + durationMs;
    const fixedStepMs = 1000 / 60;
    while (targetMs - virtualNowMs > 0.001) {
      const stepMs = Math.min(fixedStepMs, targetMs - virtualNowMs);
      virtualNowMs += stepMs;
      simulate(stepMs / 1000);
    }
    virtualNowMs = targetMs;
    lastT = virtualNowMs;
    renderFrame();
  };

  function tick() {
    const t = nowMs();
    const dt = virtualNowMs === null ? clamp((t - lastT) / 1000, 0, 0.05) : 0;
    lastT = t;
    if (virtualNowMs === null) simulate(dt);
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
    setHint("Draw a closed loop around pickups/dropoffs. Close by clicking near the first point.");
    requestAnimationFrame(tick);
    if (!hasCompletedTutorial()) showTutorial(0);
  }

  boot();
})();
