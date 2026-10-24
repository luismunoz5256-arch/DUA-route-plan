// Order forecast: how likely each client is to order on a date, from which clients got deliveries
// on the same weekday in the past (like the last 12 Tuesdays).
import { weekdayOf, addDays } from './util.js';

export const MIN_WEEKS = 2; // past same-weekdays needed before the forecast is used
const WEEKS = 12; // how far back it looks
export const LIKELY = 0.5; // ordered at least half of those days

// orders: { "2026-10-20": { ids: [clientId, ...] } }. Returns { days, clients: Map(id -> times) }:
// how many past same-weekdays have orders recorded, and how many of them each client ordered.
export function forecastFor(date, orders) {
  const wd = weekdayOf(date);
  const from = addDays(date, -7 * WEEKS);
  const clients = new Map();
  let days = 0;
  for (const [d, day] of Object.entries(orders || {})) {
    if (d >= date || d < from || weekdayOf(d) !== wd || !day?.ids?.length) continue;
    days++;
    for (const id of new Set(day.ids)) clients.set(id, (clients.get(id) || 0) + 1);
  }
  return { days, clients };
}

// True / false when there's enough history to say, else null.
export function isLikely(forecast, id) {
  if (forecast.days < MIN_WEEKS) return null;
  return (forecast.clients.get(id) || 0) / forecast.days >= LIKELY;
}
