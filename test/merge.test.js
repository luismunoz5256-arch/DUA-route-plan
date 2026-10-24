import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeData, canonical } from '../js/merge.js';

const base = { clients: [], deletedClients: {}, history: {}, matrix: {}, settings: {}, settingsUpdated: 0, routes: {}, done: {} };

test('newer client edit wins on either side', () => {
  const a = { ...base, clients: [{ id: '1', name: 'Old', updated: 1 }, { id: '2', name: 'Mine', updated: 5 }] };
  const b = { ...base, clients: [{ id: '1', name: 'New', updated: 2 }, { id: '2', name: 'Theirs', updated: 3 }] };
  const m = mergeData(a, b);
  assert.equal(m.clients.find((c) => c.id === '1').name, 'New');
  assert.equal(m.clients.find((c) => c.id === '2').name, 'Mine');
});

test('clients added on different computers are both kept', () => {
  const a = { ...base, clients: [{ id: 'a', updated: 1 }] };
  const b = { ...base, clients: [{ id: 'b', updated: 1 }] };
  assert.deepEqual(mergeData(a, b).clients.map((c) => c.id).sort(), ['a', 'b']);
});

test('a delete spreads unless the client was edited afterwards', () => {
  const a = { ...base, clients: [{ id: '1', updated: 1 }, { id: '2', updated: 9 }], deletedClients: {} };
  const b = { ...base, deletedClients: { 1: 5, 2: 5 } };
  const m = mergeData(a, b);
  assert.deepEqual(m.clients.map((c) => c.id), ['2']);
  assert.deepEqual(m.deletedClients, { 1: 5, 2: 5 });
});

test('history days, drive times and settings merge', () => {
  const a = { ...base, history: { '2026-10-19': { updated: 1, x: 'a' } }, matrix: { p: [1, 2] }, settings: { payRate: 14 }, settingsUpdated: 1 };
  const b = { ...base, history: { '2026-10-19': { updated: 2, x: 'b' }, '2026-10-20': { updated: 1 } }, matrix: { q: [3, 4] }, settings: { payRate: 15 }, settingsUpdated: 2 };
  const m = mergeData(a, b);
  assert.equal(m.history['2026-10-19'].x, 'b');
  assert.ok(m.history['2026-10-20']);
  assert.deepEqual(Object.keys(m.matrix).sort(), ['p', 'q']);
  assert.equal(m.settings.payRate, 15);
});

test('merging is order-independent and canonical text is stable', () => {
  const a = { ...base, clients: [{ id: 'a', updated: 1 }], settings: { x: 1 }, settingsUpdated: 1 };
  const b = { ...base, clients: [{ id: 'b', updated: 2 }], settings: { x: 2 }, settingsUpdated: 2 };
  const ab = mergeData(a, b);
  const ba = mergeData(b, a);
  ab.clients.sort((x, y) => x.id.localeCompare(y.id));
  ba.clients.sort((x, y) => x.id.localeCompare(y.id));
  assert.equal(canonical(ab), canonical(ba));
  assert.equal(canonical({ b: 1, a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}],"b":1}');
});

test('published routes merge by date and done ticks come from the server copy', () => {
  const a = { ...base, routes: { d1: { updated: 2, drivers: { Ana: 'new' } } }, done: { d1: { Ana: { x: 1 } } } };
  const b = { ...base, routes: { d1: { updated: 1, drivers: { Ana: 'old' } }, d0: { updated: 1 } }, done: { d1: { Ana: { x: 1, y: 2 } } } };
  const m = mergeData(a, b);
  assert.equal(m.routes.d1.drivers.Ana, 'new');
  assert.ok(m.routes.d0);
  assert.deepEqual(m.done, b.done);
});

test('picked stops and plans merge by date, newest wins', () => {
  const a = { ...base, days: { d1: { updated: 5, selected: { c1: {} } } }, plans: { d1: { updated: 1, k: 'old' } } };
  const b = { ...base, days: { d1: { updated: 3, selected: {} }, d2: { updated: 1 } }, plans: { d1: { updated: 2, k: 'new' } } };
  const m = mergeData(a, b);
  assert.deepEqual(Object.keys(m.days.d1.selected), ['c1']);
  assert.ok(m.days.d2);
  assert.equal(m.plans.d1.k, 'new');
});

test('afternoon drive times merge like midday ones', () => {
  const m = mergeData({ ...base, matrix2: { 'a|b': [5, 1] } }, { ...base, matrix2: { 'a|c': [7, 2] } });
  assert.deepEqual(Object.keys(m.matrix2).sort(), ['a|b', 'a|c']);
});
