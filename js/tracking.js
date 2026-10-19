// Turns MyGeotab trips into a day report: when the truck left and came back, which planned
// stops it actually reached (and how long it stayed), and any stops that weren't planned.
// A Geotab "trip" ends where the truck stopped; it stays there until the next trip starts.

const KM_TO_MI = 0.621371;

// Geotab time spans: "hh:mm:ss", "d.hh:mm:ss" or with fractions -> minutes
export function parseDuration(s) {
  if (!s) return 0;
  const m = String(s).match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 24 + Number(m[2])) * 60 + Number(m[3]) + Number(m[4]) / 60;
}

export function meters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Minutes after local midnight for a timestamp.
export function minuteOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

// trips: [{ start, stop, nextStart, driving, idling, stopFor, km, lat, lng }] (ISO times)
// planned: [{ id, name, lat, lng, plannedArrive (minutes after midnight) }] in planned order
export function analyzeDay({ trips, depot, planned = [], radius = 200, minUnplanned = 3, now = Date.now() }) {
  const sorted = [...(trips || [])].filter((t) => t.start && t.stop).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const events = sorted
    .filter((t) => t.lat != null && t.lng != null)
    .map((t) => {
      const arrive = Date.parse(t.stop);
      const leave = t.nextStart ? Date.parse(t.nextStart) : null;
      return {
        lat: t.lat,
        lng: t.lng,
        arrive,
        leave,
        minutes: leave ? (leave - arrive) / 60000 : Math.max(parseDuration(t.stopFor), (now - arrive) / 60000),
        atDepot: !!depot && meters(t, depot) <= radius,
        tripStart: Date.parse(t.start),
      };
    });

  // Left = start of the first trip that ends away from the warehouse (yard moves don't count).
  const firstAway = events.findIndex((e) => !e.atDepot);
  const left = firstAway >= 0 ? events[firstAway].tripStart : null;
  // Back = arrival at the warehouse after the last stop away from it.
  let lastAway = -1;
  events.forEach((e, i) => {
    if (!e.atDepot) lastAway = i;
  });
  const backEvent = lastAway >= 0 ? events.slice(lastAway + 1).find((e) => e.atDepot) : null;
  const back = backEvent ? backEvent.arrive : null;

  const inDay = sorted.filter((t) => {
    const s = Date.parse(t.start);
    return left != null && s >= left && (back == null || s < back);
  });
  const driveMin = inDay.reduce((a, t) => a + parseDuration(t.driving), 0);
  const idleMin = inDay.reduce((a, t) => a + parseDuration(t.idling), 0);
  const miles = inDay.reduce((a, t) => a + (t.km || 0), 0) * KM_TO_MI;

  // Match each planned stop to the first unused stop event near it.
  const used = new Set();
  const visits = planned.map((p) => {
    let best = -1;
    events.forEach((e, i) => {
      if (used.has(i) || e.atDepot || (left != null && e.arrive < left)) return;
      if (meters(e, p) > radius) return;
      if (best < 0 || e.arrive < events[best].arrive) best = i;
    });
    if (best < 0) return { ...p, visited: false };
    used.add(best);
    const e = events[best];
    const arriveMin = minuteOfDay(e.arrive);
    return {
      ...p,
      visited: true,
      arrive: e.arrive,
      leave: e.leave,
      minutes: e.minutes,
      lateBy: p.plannedArrive != null ? arriveMin - p.plannedArrive : null,
    };
  });

  const unplanned = events
    .map((e, i) => ({ ...e, i }))
    .filter((e) => !used.has(e.i) && !e.atDepot && e.minutes >= minUnplanned)
    .filter((e) => left != null && e.arrive >= left && (back == null || e.arrive < back))
    .map(({ lat, lng, arrive, leave, minutes }) => ({ lat, lng, arrive, leave, minutes }));

  return { left, back, driveMin, idleMin, miles, visits, unplanned, stillOut: left != null && back == null };
}
