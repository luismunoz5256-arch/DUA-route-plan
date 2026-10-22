// Real stop times learned from the trucks (MyGeotab): how long each truck stayed at each client.
// Each client keeps its recent visits as client.stays = { "2026-10-21": minutes }. Once there are
// enough of them, the typical one (the median, so a long lunch stop doesn't skew it) is used as
// the client's unload time when planning.

export const MIN_VISITS = 3; // visits needed before the trucks' time is used
const KEEP = 20; // most recent visits kept per client
const SHORTEST = 1; // shorter stops are drive-bys or traffic lights, not deliveries
const LONGEST = 90; // longer stops are breaks or the truck parked, not a delivery

// Records one day's visits ([{ id, minutes }]) on the matching clients. Returns how many changed.
export function recordStays(clients, date, visits) {
  const byId = new Map(clients.map((c) => [c.id, c]));
  let changed = 0;
  for (const v of visits) {
    const c = byId.get(v.id);
    if (!c || !(v.minutes >= SHORTEST && v.minutes <= LONGEST)) continue;
    const minutes = Math.round(v.minutes * 2) / 2;
    if (c.stays?.[date] === minutes) continue;
    const stays = { ...(c.stays || {}), [date]: minutes };
    c.stays = Object.fromEntries(Object.entries(stays).sort().slice(-KEEP));
    changed++;
  }
  return changed;
}

// { minutes, visits } from the trucks, or null if there aren't enough visits yet.
export function learnedStop(c) {
  const values = Object.values(c.stays || {}).sort((a, b) => a - b);
  if (values.length < MIN_VISITS) return null;
  const mid = values.length / 2;
  const median = values.length % 2 ? values[Math.floor(mid)] : (values[mid - 1] + values[mid]) / 2;
  return { minutes: Math.max(1, Math.round(median)), visits: values.length };
}
