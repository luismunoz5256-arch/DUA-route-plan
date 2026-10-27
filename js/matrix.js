// Drive-time table between today's stops. Google times are saved once and reused,
// so normal daily planning makes no Google requests at all.
import { routeMatrix } from './google.js';

export function locKey(p) {
  return `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
}

// Straight-line fallback when no Google time is available (city driving ~24 mph).
function straightKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// rates: { minPerKm } learned from Google's times nearby (see calibrate), else city driving.
export function estimateMinutes(a, b, rates = null) {
  const km = straightKm(a, b);
  if (km < 0.01) return 0;
  return rates ? km * rates.minPerKm : ((km * 1.35) / 38) * 60 + 2;
}

// Next weekday at the given "HH:MM" that is still in the future (Google needs a future time for traffic).
export function nextTrafficDeparture(hhmm, now = new Date()) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m || 0, 0, 0);
  while (d.getTime() < now.getTime() + 10 * 60000 || d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

// Each place gets Google drive times to and from the warehouse and its NEIGHBORS nearest places.
// Trucks go from a stop to a nearby one, so far-apart pairs (which are almost never driven back to
// back) are estimated instead of bought. That keeps lookups growing with the number of places
// instead of with its square: 150 clients need about 2,900 lookups instead of 22,650, and in
// tests the routes cost within about 0.1% of what they would with every pair looked up.
export const NEIGHBORS = 15;

// The pairs worth a Google lookup among `points` (index 0 = the warehouse), as "a|b" keys.
export function neededPairs(points, k = NEIGHBORS) {
  const where = new Map(points.map((p) => [locKey(p), p]));
  const depot = locKey(points[0]);
  const places = [...where.keys()].filter((key) => key !== depot);
  const pairs = new Set();
  const add = (a, b) => {
    pairs.add(`${a}|${b}`);
    pairs.add(`${b}|${a}`);
  };
  for (const a of places) {
    add(depot, a);
    const near = places
      .filter((b) => b !== a)
      .map((b) => [b, straightKm(where.get(a), where.get(b))])
      .sort((x, y) => x[1] - y[1])
      .slice(0, k);
    for (const [b] of near) add(a, b);
  }
  return pairs;
}

// Which needed pairs aren't saved yet, grouped by where they start, and how many billable lookups
// (elements) that is.
export function missingPlan(points, cache, k = NEIGHBORS) {
  const pairs = neededPairs(points, k);
  const byOrigin = new Map();
  let elements = 0;
  for (const pair of pairs) {
    if (cache[pair]) continue;
    const [a, b] = pair.split('|');
    byOrigin.set(a, [...(byOrigin.get(a) || []), b]);
    elements++;
  }
  return { pairs, byOrigin, elements, places: byOrigin.size };
}

function keyToPoint(k) {
  const [lat, lng] = k.split(',').map(Number);
  return { lat, lng };
}

// Fetch the missing pairs from Google and add them to the cache (mutates `cache`): one request per
// starting place, asking only for the destinations it needs, so nothing extra is billed.
// onStatus("2/5") reports progress; onElements(n) reports billed lookups as they happen.
export async function fillMissing(plan, cache, apiKey, departure, { onStatus, onElements } = {}) {
  let count = 0;
  let done = 0;
  for (const [origin, dests] of plan.byOrigin) {
    const rows = await routeMatrix(apiKey, [keyToPoint(origin)], dests.map(keyToPoint), departure, (_d, _t, n) => onElements?.(n));
    for (const r of rows) {
      cache[`${origin}|${dests[r.to]}`] = [Math.round(r.minutes * 100) / 100, r.meters];
      count++;
    }
    onStatus?.(`${++done}/${plan.byOrigin.size}`);
  }
  return count;
}

// How Google's drive times compare with straight-line distance in this area (minutes and meters
// per straight km, from saved pairs at least 2 km apart), to estimate the pairs not looked up.
function calibrate(cache) {
  const perKm = [];
  const meters = [];
  for (const [pair, [min, m]] of Object.entries(cache)) {
    const [a, b] = pair.split('|').map(keyToPoint);
    const km = straightKm(a, b);
    if (km < 2) continue;
    perKm.push(min / km);
    meters.push(m / km);
  }
  if (perKm.length < 20) return null;
  const mid = (v) => v.sort((x, y) => x - y)[Math.floor(v.length / 2)];
  return { minPerKm: mid(perKm), metersPerKm: mid(meters) };
}

// Square matrix of minutes for `points` (index 0 = warehouse). Pairs missing from `cache` come
// from `fallback` (e.g. midday times when an afternoon time isn't saved yet), else an estimate.
// `estimated` counts only needed pairs (see neededPairs) that had to be estimated; far-apart pairs
// are estimated on purpose.
export function assemble(points, cache, fallback = {}) {
  const keys = points.map(locKey);
  const needed = neededPairs(points);
  const rates = calibrate(Object.keys(cache).length ? cache : fallback);
  let fromGoogle = 0;
  let estimated = 0;
  const meters = [];
  const time = points.map((a, i) => {
    meters[i] = [];
    return points.map((b, j) => {
      if (i === j || keys[i] === keys[j]) {
        meters[i][j] = 0;
        return 0;
      }
      const hit = cache[`${keys[i]}|${keys[j]}`] || fallback[`${keys[i]}|${keys[j]}`];
      if (hit) {
        fromGoogle++;
        meters[i][j] = hit[1];
        return hit[0];
      }
      if (needed.has(`${keys[i]}|${keys[j]}`)) estimated++;
      meters[i][j] = straightKm(a, b) * (rates ? rates.metersPerKm : 1350);
      return estimateMinutes(a, b, rates);
    });
  });
  return { time, meters, fromGoogle, estimated };
}
