import { clamp } from "./game-core.js";

export const MISS_PENALTY = 18;
export const BASE_SPAWN_MS = 8000;
export const BASE_PAYOUT = 30;
export const COLOR_PAYOUT_BONUS = 35;

/** Orders scale with the pickups the route covers, with diminishing returns because one courier carries three parcels. */
export function spawnIntervalMs(coveredPickups, difficulty, jitterMs) {
  const accel = clamp(1 - difficulty * 0.05, 0.55, 1);
  return (BASE_SPAWN_MS * accel) / Math.sqrt(Math.max(1, coveredPickups)) + jitterMs;
}

export function deliveryBase(contractColors) {
  return BASE_PAYOUT + COLOR_PAYOUT_BONUS * Math.max(0, contractColors - 1);
}

export function deliveryPoints(contractColors, combo) {
  return deliveryBase(contractColors) * (1 + Math.min(12, combo) * 0.12);
}
