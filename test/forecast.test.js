import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecastFor, isLikely } from '../js/forecast.js';

// Tuesdays: 2026-09-29, 10-06, 10-13, 10-20; a Monday and a Wednesday in between.
const orders = {
  '2026-09-29': { ids: ['a', 'b'] },
  '2026-10-06': { ids: ['a', 'c'] },
  '2026-10-13': { ids: ['a', 'b'] },
  '2026-10-20': { ids: ['a', 'b', 'd'] },
  '2026-10-19': { ids: ['x', 'x'] }, // a Monday
  '2026-10-21': { ids: ['y'] }, // a Wednesday
};

test('counts how often each client ordered on the same weekday', () => {
  const f = forecastFor('2026-10-27', orders); // a Tuesday
  assert.equal(f.days, 4);
  assert.equal(f.clients.get('a'), 4);
  assert.equal(f.clients.get('b'), 3);
  assert.equal(f.clients.get('c'), 1);
  assert.equal(f.clients.get('x'), undefined);
  assert.equal(isLikely(f, 'a'), true);
  assert.equal(isLikely(f, 'b'), true);
  assert.equal(isLikely(f, 'c'), false);
  assert.equal(isLikely(f, 'nobody'), false);
});

test('only looks at days before the date, and needs at least 2 weeks of history', () => {
  const f = forecastFor('2026-10-13', orders);
  assert.equal(f.days, 2);
  assert.equal(isLikely(forecastFor('2026-10-06', orders), 'a'), null);
  // a client counted once per day even if listed twice
  assert.equal(forecastFor('2026-10-26', orders).clients.get('x'), 1);
});

test('looks back 12 weeks at most', () => {
  assert.equal(forecastFor('2027-01-05', orders).days, 2); // 12 weeks back is 2026-10-13: only 10-13 and 10-20 count
  assert.equal(forecastFor('2027-03-30', orders).days, 0);
});
