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

export function estimateMinutes(a, b) {
  const km = straightKm(a, b);
  if (km < 0.01) return 0;
  return ((km * 1.35) / 38) * 60 + 2;
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

// Which pairs still need a Google lookup, and how many billable elements that costs.
export function missingPlan(points, cache) {
  const keys = [...new Set(points.map(locKey))];
  const isNew = new Set();
  for (const a of keys) {
    for (const b of keys) {
      if (a !== b && !cache[`${a}|${b}`]) {
        isNew.add(a);
        isNew.add(b);
      }
    }
  }
  const newKeys = keys.filter((k) => isNew.has(k));
  const oldKeys = keys.filter((k) => !isNew.has(k));
  const elements = newKeys.length ? newKeys.length * keys.length + oldKeys.length * newKeys.length : 0;
  return { keys, newKeys, oldKeys, elements };
}

function keyToPoint(k) {
  const [lat, lng] = k.split(',').map(Number);
  return { lat, lng };
}

// Fetch missing pairs from Google and add them to the cache (mutates `cache`).
// onStatus(text) reports progress; onElements(n) reports billed lookups as they happen.
export async function fillMissing(plan, cache, apiKey, departure, { onStatus, onElements } = {}) {
  const { keys, newKeys, oldKeys } = plan;
  if (!newKeys.length) return 0;
  let count = 0;
  const store = (origins, dests, rows) => {
    for (const r of rows) {
      cache[`${origins[r.from]}|${dests[r.to]}`] = [Math.round(r.minutes * 100) / 100, r.meters];
      count++;
    }
  };
  const progress = (label) => (d, t, n) => {
    onElements?.(n);
    onStatus?.(`${label} ${d}/${t}`);
  };
  store(newKeys, keys, await routeMatrix(apiKey, newKeys.map(keyToPoint), keys.map(keyToPoint), departure, progress('Getting traffic times')));
  if (oldKeys.length) {
    store(oldKeys, newKeys, await routeMatrix(apiKey, oldKeys.map(keyToPoint), newKeys.map(keyToPoint), departure, progress('Getting traffic times (return trips)')));
  }
  return count;
}

// Square matrix of minutes for `points` (index 0 = warehouse).
export function assemble(points, cache) {
  const keys = points.map(locKey);
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
      const hit = cache[`${keys[i]}|${keys[j]}`];
      if (hit) {
        fromGoogle++;
        meters[i][j] = hit[1];
        return hit[0];
      }
      estimated++;
      meters[i][j] = straightKm(a, b) * 1350;
      return estimateMinutes(a, b);
    });
  });
  return { time, meters, fromGoogle, estimated };
}
