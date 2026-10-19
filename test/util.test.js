import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysCode, parseDays, fmtTime, fmtTimeInput, toCsv, parseCsv } from '../js/util.js';
import { recordReturn } from '../js/pay.js';

test('client days survive a CSV round trip', () => {
  for (const days of [
    [true, true, true, true, true, true, true],
    [false, true, true, true, true, true, true],
    [false, true, true, true, true, true, false],
    [false, true, false, true, false, true, false],
    [false, false, false, false, false, false, false],
  ]) {
    assert.deepEqual(parseDays(daysCode(days)), days, daysCode(days));
  }
});

test('CSV quoting round trip', () => {
  const rows = [['name', 'notes'], ['Cafe "Luna"', 'back door, ring bell\nsecond line']];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test('time helpers', () => {
  assert.equal(fmtTime(690), '11:30 AM');
  assert.equal(fmtTime(null), '—');
  assert.equal(fmtTimeInput(935), '15:35');
});

test('recordReturn: creates days, keeps typed times, and only reports real changes', () => {
  const h = {};
  assert.equal(recordReturn(h, '2026-10-19', 'Ana', 940, 'truck', 480), true);
  assert.equal(h['2026-10-19'].drivers[0].paid, 460);
  assert.equal(recordReturn(h, '2026-10-19', 'Ana', 940, 'truck', 480), false); // same again
  assert.equal(recordReturn(h, '2026-10-19', 'Ana', 960, 'manual', 480), true);
  assert.equal(recordReturn(h, '2026-10-19', 'Ana', 900, 'truck', 480), false); // typed time wins
  assert.equal(h['2026-10-19'].drivers[0].back, 960);
  // a day planned with a different clock-in keeps it
  h['2026-10-20'] = { drivers: [], shiftStart: 420 };
  recordReturn(h, '2026-10-20', 'Ben', 900, 'truck', 480);
  assert.equal(h['2026-10-20'].drivers[0].paid, 480);
});
