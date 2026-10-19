import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, analyzeDay, minuteOfDay } from '../js/tracking.js';

const depot = { lat: 31.775, lng: -106.38 };
const A = { id: 'a', name: 'Cafe A', lat: 31.8, lng: -106.4 };
const B = { id: 'b', name: 'Deli B', lat: 31.76, lng: -106.45 };
const C = { id: 'c', name: 'Grill C', lat: 31.72, lng: -106.3 };
const gas = { lat: 31.79, lng: -106.35 };

// Local times on one day, as ISO strings.
const at = (h, m) => new Date(2026, 9, 21, h, m).toISOString();
// A trip that ends at `p` at `stop`, then stays until `next`.
const trip = (start, stop, next, p, extra = {}) => ({ start, stop, nextStart: next, lat: p.lat, lng: p.lng, driving: '00:15:00', idling: '00:02:00', km: 10, ...extra });

test('Geotab durations parse to minutes', () => {
  assert.equal(parseDuration('00:12:30'), 12.5);
  assert.equal(parseDuration('1.02:00:00'), 26 * 60);
  assert.ok(Math.abs(parseDuration('00:00:30.5000000') - 0.5083) < 0.001);
  assert.equal(parseDuration(''), 0);
});

test('day report: left, back, visits, lateness and unplanned stops', () => {
  const trips = [
    trip(at(8, 0), at(8, 5), at(11, 30), { lat: depot.lat + 0.0005, lng: depot.lng }), // yard move
    trip(at(11, 30), at(11, 50), at(12, 5), A),
    trip(at(12, 5), at(12, 20), at(12, 50), gas), // 30 min unplanned stop
    trip(at(12, 50), at(13, 10), at(13, 25), B),
    trip(at(13, 25), at(13, 50), null, depot, { stopFor: '02:00:00' }),
  ];
  const planned = [
    { ...A, plannedArrive: 11 * 60 + 45 },
    { ...B, plannedArrive: 12 * 60 + 30 },
    { ...C, plannedArrive: 13 * 60 },
  ];
  const r = analyzeDay({ trips, depot, planned });
  assert.equal(minuteOfDay(r.left), 11 * 60 + 30);
  assert.equal(minuteOfDay(r.back), 13 * 60 + 50);
  assert.equal(r.stillOut, false);
  assert.equal(r.visits[0].visited, true);
  assert.equal(r.visits[0].lateBy, 5);
  assert.equal(r.visits[0].minutes, 15);
  assert.equal(r.visits[1].lateBy, 40);
  assert.equal(r.visits[2].visited, false);
  assert.equal(r.unplanned.length, 1);
  assert.equal(r.unplanned[0].minutes, 30);
  // 4 trips after leaving (yard move excluded): 4 x 15 min driving, 4 x 10 km
  assert.equal(r.driveMin, 60);
  assert.equal(r.idleMin, 8);
  assert.ok(Math.abs(r.miles - 40 * 0.621371) < 1e-6);
});

test('a truck still out has no return time yet', () => {
  const trips = [trip(at(11, 30), at(11, 50), null, A, { stopFor: '00:10:00' })];
  const r = analyzeDay({ trips, depot, planned: [{ ...A, plannedArrive: 700 }], now: Date.parse(at(12, 0)) });
  assert.equal(r.back, null);
  assert.equal(r.stillOut, true);
  assert.equal(r.visits[0].visited, true);
  assert.equal(r.visits[0].minutes, 10);
});

test('a mid-day reload at the warehouse is not the return', () => {
  const trips = [
    trip(at(11, 30), at(11, 50), at(12, 0), A),
    trip(at(12, 0), at(12, 20), at(12, 40), depot),
    trip(at(12, 40), at(13, 0), at(13, 10), B),
    trip(at(13, 10), at(13, 30), null, depot),
  ];
  const r = analyzeDay({ trips, depot, planned: [] });
  assert.equal(minuteOfDay(r.back), 13 * 60 + 30);
  assert.equal(r.unplanned.length, 2); // A and B weren't planned in this test
});

test('no trips means nothing to report', () => {
  const r = analyzeDay({ trips: [], depot, planned: [{ ...A, plannedArrive: 700 }] });
  assert.equal(r.left, null);
  assert.equal(r.back, null);
  assert.equal(r.visits[0].visited, false);
});
