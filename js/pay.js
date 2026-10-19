// Pay rules. Texas follows the federal rule: 1.5x pay for hours over 40 in a workweek.
// With a 5-day, 8-hour schedule, time past 8 hours in a day is counted as overtime,
// and so is anything that pushes a driver past 40 hours for the week (Mon–Sun).
import { weekStart, addDays } from './util.js';

// Time of day (minutes) when driver goes into overtime today.
export function overtimeStart({ shiftStart, regDayMin, regWeekMin, weekBeforeMin }) {
  return shiftStart + Math.max(0, Math.min(regDayMin, regWeekMin - weekBeforeMin));
}

export function laborCost(paidMin, otMin, rate) {
  return (rate / 60) * (paidMin + 0.5 * otMin);
}

// Paid minutes a driver already has this week before `date`, from route history.
export function minutesBefore(history, date, name) {
  let sum = 0;
  for (let d = weekStart(date); d < date; d = addDays(d, 1)) {
    const drv = history[d]?.drivers?.find((x) => x.name === name);
    if (drv) sum += drv.paid;
  }
  return sum;
}

// Per-driver totals for the week starting on Monday `monday`, for paying people:
// overtime is only the hours past the weekly limit (40), as Texas / federal law counts it.
export function weekSummary(history, monday, { regWeekMin, rate }) {
  const byName = new Map();
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    for (const d of history[date]?.drivers || []) {
      if (!byName.has(d.name)) byName.set(d.name, { name: d.name, days: Array(7).fill(null), fromTruck: Array(7).fill(false), total: 0 });
      const row = byName.get(d.name);
      row.days[i] = d.paid;
      row.total += d.paid;
      row.fromTruck[i] = d.source === 'truck';
    }
  }
  return [...byName.values()].map((row) => {
    const ot = Math.max(0, row.total - regWeekMin);
    return { ...row, ot, pay: laborCost(row.total, ot, rate) };
  });
}

// Puts a driver's real return time (minutes after midnight) into `history`, changing it in place,
// so a whole week can be updated and then saved once. A day with no plan gets created.
// A time from the truck never replaces one typed in by hand. Returns true if anything changed.
export function recordReturn(history, date, name, back, source, shiftStart) {
  if (back == null) return false;
  const h = (history[date] ||= { drivers: [], stops: 0, miles: 0, shiftStart });
  let d = h.drivers.find((x) => x.name === name);
  if (!d) h.drivers.push((d = { name, stops: 0 }));
  if (source === 'truck' && d.source === 'manual') return false;
  if (d.source === source && Math.abs(d.back - back) < 1) return false;
  d.back = back;
  d.source = source;
  d.paid = Math.max(0, back - (h.shiftStart ?? shiftStart));
  h.updated = Date.now();
  return true;
}
