export function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function xmur3(value) {
  let hash = 1779033703 ^ value.length;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  return function nextHash() {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    return (hash ^= hash >>> 16) >>> 0;
  };
}

export function mulberry32(seed) {
  let value = seed >>> 0;
  return function nextRandom() {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let result = Math.imul(value ^ (value >>> 15), 1 | value);
    result = (result + Math.imul(result ^ (result >>> 7), 61 | result)) ^ result;
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed) {
  return mulberry32(xmur3(seed)());
}

export function randRange(rng, minimum, maximum) {
  return minimum + (maximum - minimum) * rng();
}

export function randInt(rng, minimumInclusive, maximumExclusive) {
  return Math.floor(randRange(rng, minimumInclusive, maximumExclusive));
}

export function choice(rng, values) {
  return values[randInt(rng, 0, values.length)];
}

export function twoOptSpliceCycle(points, segmentA, segmentB) {
  const count = points.length;
  if (count < 4) return points.slice();

  const edgeA = ((segmentA % count) + count) % count;
  const edgeB = ((segmentB % count) + count) % count;
  if (edgeA === edgeB) return points.slice();
  if ((edgeA + 1) % count === edgeB || (edgeB + 1) % count === edgeA) return points.slice();

  let rotation = 0;
  for (; rotation < count; rotation += 1) {
    const wrapSegment = (rotation - 1 + count) % count;
    if (wrapSegment !== edgeA && wrapSegment !== edgeB) break;
  }
  if (rotation >= count) return points.slice();

  const rotated = Array.from(
    { length: count },
    (_, index) => points[(index + rotation) % count],
  );

  let first = (edgeA - rotation + count) % count;
  let second = (edgeB - rotation + count) % count;
  if (first === count - 1 || second === count - 1) return points.slice();
  if (first > second) [first, second] = [second, first];
  if (first + 1 === second) return points.slice();

  const rewired = rotated
    .slice(0, first + 1)
    .concat(rotated.slice(first + 1, second + 1).reverse(), rotated.slice(second + 1));

  const result = new Array(count);
  for (let index = 0; index < count; index += 1) {
    result[(index + rotation) % count] = rewired[index];
  }
  return result;
}

export function buildLoop(points) {
  const loopPoints = points.map((point) => ({ x: point.x, y: point.y }));
  const segments = [];
  let totalLen = 0;

  for (let index = 0; index < loopPoints.length; index += 1) {
    const start = loopPoints[index];
    const end = loopPoints[(index + 1) % loopPoints.length];
    const length = Math.max(0.0001, dist(start, end));
    segments.push({ a: start, b: end, len: length });
    totalLen += length;
  }

  return { points: loopPoints, segments, totalLen };
}

export function projectPointToLoop(loop, point) {
  const count = loop.points.length;
  if (count < 2) {
    return { segIndex: 0, segPos: 0, pos: { x: point.x, y: point.y } };
  }

  let best = { segIndex: 0, t: 0, distanceSquared: Infinity };
  for (let index = 0; index < count; index += 1) {
    const start = loop.points[index];
    const end = loop.points[(index + 1) % count];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const amount = lengthSquared < 1e-6
      ? 0
      : clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
    const projectedX = start.x + dx * amount;
    const projectedY = start.y + dy * amount;
    const offsetX = point.x - projectedX;
    const offsetY = point.y - projectedY;
    const distanceSquared = offsetX * offsetX + offsetY * offsetY;

    if (distanceSquared < best.distanceSquared) {
      best = { segIndex: index, t: amount, distanceSquared };
    }
  }

  const segment = loop.segments[best.segIndex];
  return {
    segIndex: best.segIndex,
    segPos: segment.len * best.t,
    pos: {
      x: lerp(segment.a.x, segment.b.x, best.t),
      y: lerp(segment.a.y, segment.b.y, best.t),
    },
  };
}

export function generateStations(
  rng,
  {
    width = 960,
    height = 600,
    margin = 70,
    minimumSpacing = 70,
    colorIds = ["red", "blue", "gold"],
  } = {},
) {
  const stations = [];
  const taken = new Set();

  function placeOne(colorId, kind) {
    for (let attempt = 0; attempt < 800; attempt += 1) {
      const point = {
        x: randRange(rng, margin, width - margin),
        y: randRange(rng, margin, height - margin),
      };
      const key = `${Math.round(point.x)}:${Math.round(point.y)}`;
      if (taken.has(key) || stations.some((station) => dist(station, point) < minimumSpacing)) {
        continue;
      }
      taken.add(key);
      stations.push({ ...point, colorId, kind });
      return;
    }

    stations.push({
      x: randRange(rng, margin, width - margin),
      y: randRange(rng, margin, height - margin),
      colorId,
      kind,
    });
  }

  for (const colorId of colorIds) {
    placeOne(colorId, "pickup");
    placeOne(colorId, "pickup");
    placeOne(colorId, "drop");
    placeOne(colorId, "drop");
  }

  return stations;
}
