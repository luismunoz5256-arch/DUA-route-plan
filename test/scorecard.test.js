import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayStats, weekScores } from '../js/scorecard.js';

const at = (h, m) => new Date(2026, 9, 19, h, m).getTime();
const report = (visits, left, back, extra = {}) => ({ visits, left, back, driveMin: 120.4, idleMin: 14.6, miles: 61.27, unplanned: [], ...extra });

test("a driver's day: stops reached, on time (up to 15 min after plan), times and miles", () => {
  const s = dayStats(report([{ visited: true, lateBy: -5 }, { visited: true, lateBy: 15 }, { visited: true, lateBy: 40 }, { visited: false }], at(11, 30), at(16, 10), { unplanned: [{}] }), 15 * 60 + 50);
  assert.deepEqual(s, { planned: 4, visited: 3, onTime: 2, left: 690, back: 970, plannedBack: 950, driveMin: 120, idleMin: 15, miles: 61.3, unplanned: 1 });
});

test('weekly scorecard per driver', () => {
  const history = {
    '2026-10-19': { stats: { Ana: { planned: 10, visited: 10, onTime: 9, left: 690, back: 960, plannedBack: 950, driveMin: 120, idleMin: 10, miles: 60, unplanned: 0 }, Ben: { planned: 8, visited: 7, onTime: 7, left: 690, back: 900, plannedBack: 930, driveMin: 100, idleMin: 30, miles: 50, unplanned: 2 } } },
    '2026-10-20': { stats: { Ana: { planned: 12, visited: 12, onTime: 12, left: 690, back: 990, plannedBack: 980, driveMin: 130, idleMin: 5, miles: 70, unplanned: 1 } } },
    '2026-10-27': { stats: { Ana: { planned: 99, visited: 99, onTime: 0, left: 600, back: 700, plannedBack: null, driveMin: 1, idleMin: 1, miles: 1, unplanned: 0 } } }, // next week
  };
  const [ana, ben] = weekScores(history, '2026-10-19');
  assert.deepEqual(ana, { name: 'Ana', days: 2, visited: 22, planned: 22, onTimePct: 95, stopsPerHour: 2.3, avgDayMin: 285, vsPlanMin: 10, idleMin: 15, miles: 130, unplanned: 1 });
  assert.equal(ben.vsPlanMin, -30);
  assert.equal(ben.stopsPerHour, 2);
  assert.deepEqual(weekScores({}, '2026-10-19'), []);
});
