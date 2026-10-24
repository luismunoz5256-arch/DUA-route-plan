// Driver scorecards: each driver's day from the trucks (MyGeotab), and weekly totals.
import { minuteOfDay } from './tracking.js';
import { addDays } from './util.js';

export const ON_TIME_MIN = 15; // a stop reached up to this many minutes after its planned time is on time

// One truck's day (an analyzeDay report) -> numbers kept in History. plannedBack: minutes, or null.
export function dayStats(report, plannedBack = null) {
  const visited = report.visits.filter((v) => v.visited);
  return {
    planned: report.visits.length,
    visited: visited.length,
    onTime: visited.filter((v) => v.lateBy == null || v.lateBy <= ON_TIME_MIN).length,
    left: report.left == null ? null : Math.round(minuteOfDay(report.left)),
    back: report.back == null ? null : Math.round(minuteOfDay(report.back)),
    plannedBack: plannedBack == null ? null : Math.round(plannedBack),
    driveMin: Math.round(report.driveMin),
    idleMin: Math.round(report.idleMin),
    miles: Math.round(report.miles * 10) / 10,
    unplanned: report.unplanned.length,
  };
}

// history: { date: { stats: { name: dayStats } } }. Returns one row per driver for the week from
// `monday`: days, stops reached/planned, on-time %, stops per hour on the road, average day
// (left to back), average minutes back later (+) or earlier (-) than planned, idle, miles.
export function weekScores(history, monday) {
  const rows = new Map();
  for (let i = 0; i < 7; i++) {
    const stats = history[addDays(monday, i)]?.stats || {};
    for (const [name, s] of Object.entries(stats)) {
      const r = rows.get(name) || { name, days: 0, planned: 0, visited: 0, onTime: 0, roadMin: 0, roadDays: 0, vsPlan: [], idleMin: 0, miles: 0, unplanned: 0 };
      r.days++;
      r.planned += s.planned;
      r.visited += s.visited;
      r.onTime += s.onTime;
      if (s.left != null && s.back != null && s.back > s.left) {
        r.roadMin += s.back - s.left;
        r.roadDays++;
      }
      if (s.back != null && s.plannedBack != null) r.vsPlan.push(s.back - s.plannedBack);
      r.idleMin += s.idleMin;
      r.miles += s.miles;
      r.unplanned += s.unplanned;
      rows.set(name, r);
    }
  }
  return [...rows.values()]
    .map((r) => ({
      name: r.name,
      days: r.days,
      visited: r.visited,
      planned: r.planned,
      onTimePct: r.visited ? Math.round((r.onTime / r.visited) * 100) : null,
      stopsPerHour: r.roadMin ? Math.round((r.visited / (r.roadMin / 60)) * 10) / 10 : null,
      avgDayMin: r.roadDays ? Math.round(r.roadMin / r.roadDays) : null,
      vsPlanMin: r.vsPlan.length ? Math.round(r.vsPlan.reduce((a, b) => a + b, 0) / r.vsPlan.length) : null,
      idleMin: r.idleMin,
      miles: Math.round(r.miles),
      unplanned: r.unplanned,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
