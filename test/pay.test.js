import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overtimeStart, laborCost, minutesBefore, weekSummary } from '../js/pay.js';

const rules = { shiftStart: 480, regDayMin: 480, regWeekMin: 2400 };

test('overtime starts at 4 PM on a normal week', () => {
  assert.equal(overtimeStart({ ...rules, weekBeforeMin: 4 * 480 }), 960);
  assert.equal(overtimeStart({ ...rules, weekBeforeMin: 0 }), 960);
});

test('overtime starts earlier once the week is nearly at 40 hours', () => {
  // 37 hours already worked -> only 3 regular hours left -> overtime from 11:00
  assert.equal(overtimeStart({ ...rules, weekBeforeMin: 37 * 60 }), 660);
  // already past 40 -> overtime from clock-in
  assert.equal(overtimeStart({ ...rules, weekBeforeMin: 42 * 60 }), 480);
});

test('labor cost pays overtime at time and a half', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(laborCost(480, 0, 14), 112);
  near(laborCost(540, 60, 14), 133); // 9h with 1h OT = 8*14 + 1*21
});

test('hours before today come from this week only', () => {
  const h = {
    '2026-10-16': { drivers: [{ name: 'Ana', paid: 500 }] }, // previous week (Fri)
    '2026-10-19': { drivers: [{ name: 'Ana', paid: 480 }, { name: 'Ben', paid: 400 }] },
    '2026-10-20': { drivers: [{ name: 'Ana', paid: 510 }] },
    '2026-10-21': { drivers: [{ name: 'Ana', paid: 999 }] }, // today, not counted
  };
  assert.equal(minutesBefore(h, '2026-10-21', 'Ana'), 990);
  assert.equal(minutesBefore(h, '2026-10-21', 'Ben'), 400);
});

test('week summary counts daily and weekly overtime', () => {
  const h = {};
  const days = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
  days.forEach((d, i) => (h[d] = { drivers: [{ name: 'Ana', paid: i === 2 ? 540 : 480 }] }));
  const [ana] = weekSummary(h, '2026-10-19', { regDayMin: 480, regWeekMin: 2400, rate: 14 });
  assert.equal(ana.total, 2460);
  assert.equal(ana.ot, 60);
  assert.ok(Math.abs(ana.pay - (14 * 40 + 21 * 1)) < 1e-9);
  assert.equal(ana.days[2], 540);
});

test('for pay, a long day is not overtime unless the week passes 40 hours', () => {
  const h = {
    '2026-10-19': { drivers: [{ name: 'Ana', paid: 9 * 60, source: 'truck' }] },
    '2026-10-20': { drivers: [{ name: 'Ana', paid: 7 * 60 }] },
  };
  const [ana] = weekSummary(h, '2026-10-19', { regWeekMin: 2400, rate: 14 });
  assert.equal(ana.ot, 0);
  assert.equal(ana.pay, 16 * 14);
  assert.deepEqual(ana.fromTruck.slice(0, 2), [true, false]);
});
