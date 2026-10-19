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

// Per-driver totals for the week starting on Monday `monday`.
export function weekSummary(history, monday, { regDayMin, regWeekMin, rate }) {
  const byName = new Map();
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    for (const d of history[date]?.drivers || []) {
      if (!byName.has(d.name)) byName.set(d.name, { name: d.name, days: Array(7).fill(null), total: 0, dailyOt: 0 });
      const row = byName.get(d.name);
      row.days[i] = d.paid;
      row.total += d.paid;
      row.dailyOt += Math.max(0, d.paid - regDayMin);
    }
  }
  return [...byName.values()].map((row) => {
    const ot = Math.max(row.dailyOt, row.total - regWeekMin);
    return { ...row, ot, pay: laborCost(row.total, ot, rate) };
  });
}
