const RECORDS_KEY = "loopCourierRecords.v1";
const MAX_CITIES = 30;
const RESULT_FIELDS = ["score", "delivered", "missed", "bestCombo"];

const emptyRecords = () => ({ version: 1, entries: [] });

function nonnegativeInteger(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function normalizeResult(result) {
  return Object.fromEntries(RESULT_FIELDS.map((field) => [field, nonnegativeInteger(result?.[field])]));
}

function validEntry(entry) {
  return entry !== null
    && typeof entry === "object"
    && !Array.isArray(entry)
    && typeof entry.seed === "string"
    && RESULT_FIELDS.every((field) => Number.isSafeInteger(entry[field]) && entry[field] >= 0)
    && Number.isSafeInteger(entry.attempts)
    && entry.attempts >= 1;
}

function normalizeRecords(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.entries)) return emptyRecords();

  // A Map preserves recency and treats every seed as data, including "__proto__".
  const entries = new Map();
  for (const candidate of value.entries) {
    if (!validEntry(candidate)) continue;
    const entry = { seed: candidate.seed, ...normalizeResult(candidate), attempts: candidate.attempts };
    const existing = entries.get(entry.seed);
    if (existing) {
      const strongest = entry.score > existing.score ? entry : existing;
      entries.set(entry.seed, { ...strongest, attempts: Math.max(entry.attempts, existing.attempts) });
    } else {
      entries.set(entry.seed, entry);
    }
  }
  return { version: 1, entries: [...entries.values()].slice(0, MAX_CITIES) };
}

/** The daily city changes at midnight UTC for everyone. */
export function dailySeed(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** Read only validated version-one records; storage may be absent or blocked. */
export function readRecords(storage) {
  try {
    return normalizeRecords(JSON.parse(storage.getItem(RECORDS_KEY)));
  } catch {
    return emptyRecords();
  }
}

/** Return a city's saved best, including its total number of attempts. */
export function bestForSeed(records, seed) {
  if (!Array.isArray(records?.entries)) return null;
  return records.entries.find((entry) => entry?.seed === seed) ?? null;
}

/**
 * Count a completed attempt and replace the best only for a strictly higher score.
 * Entries are ordered by most recent attempt. The returned result is usable even
 * when the browser cannot persist it; callers can check `persisted` to say so.
 */
export function saveResult(storage, seed, result, unsavedRecords = null) {
  const persistedRecords = readRecords(storage);
  // Merge a failed write's session history with current disk data, including other tabs.
  const records = unsavedRecords ? normalizeRecords({
    version: 1,
    entries: [...normalizeRecords(unsavedRecords).entries, ...persistedRecords.entries],
  }) : persistedRecords;
  if (typeof seed !== "string") {
    return { records, best: null, isPersonalBest: false, persisted: false };
  }

  const previous = bestForSeed(records, seed);
  const current = normalizeResult(result);
  const isPersonalBest = previous === null || current.score > previous.score;
  const best = {
    seed,
    ...(isPersonalBest ? current : previous),
    attempts: Math.min(Number.MAX_SAFE_INTEGER, (previous?.attempts ?? 0) + 1),
  };
  const nextRecords = {
    version: 1,
    entries: [best, ...records.entries.filter((entry) => entry.seed !== seed)].slice(0, MAX_CITIES),
  };

  let persisted = false;
  try {
    storage.setItem(RECORDS_KEY, JSON.stringify(nextRecords));
    persisted = true;
  } catch {
    // Private browsing, denied storage, and full quotas must not interrupt a run.
  }
  return { records: nextRecords, best, isPersonalBest, persisted };
}

/** A local run rating based on deliveries; this is not a competitive ranking. */
export function rankForResult(result) {
  const delivered = nonnegativeInteger(result?.delivered);
  const missed = nonnegativeInteger(result?.missed);
  if (delivered >= 20 && delivered / (delivered + missed) >= 0.8) {
    return { label: "Master dispatcher", detail: "20+ deliveries with at least 80% of parcels delivered." };
  }
  if (delivered >= 10) {
    return { label: "Route specialist", detail: "10+ deliveries. Aim for 20 with at least 80% delivered to become a Master dispatcher." };
  }
  if (delivered >= 1) {
    return { label: "City courier", detail: "Your city is moving. Reach 10 deliveries to become a Route specialist." };
  }
  return { label: "New recruit", detail: "Connect pickup and drop-off stations to make your first delivery." };
}
