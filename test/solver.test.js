import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve, simulateRoute, makeRng } from '../js/solver.js';

// Random city: warehouse at the centre, stops within ~25 minutes' drive.
function makeProblem({ n = 30, vehicles = 4, seed = 1, due = {} } = {}) {
  const rng = makeRng(seed);
  const pts = [[0, 0]];
  for (let i = 0; i < n; i++) pts.push([(rng() - 0.5) * 40, (rng() - 0.5) * 40]);
  const time = pts.map((a) => pts.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1]) * 0.9));
  const service = pts.map((_, i) => (i === 0 ? 0 : 10));
  const dueArr = pts.map((_, i) => due[i] ?? null);
  return {
    time,
    service,
    open: pts.map(() => null),
    due: dueArr,
    start: 690, // 11:30
    endBy: 960, // 16:00
    vehicles,
  };
}

function assertValid(result, p) {
  const seen = result.routes.flatMap((r) => r.order).sort((a, b) => a - b);
  assert.deepEqual(seen, Array.from({ length: p.service.length - 1 }, (_, i) => i + 1));
}

test('every stop is visited exactly once', () => {
  const p = makeProblem();
  const r = solve(p, { timeLimitMs: 400 });
  assertValid(r, p);
  assert.equal(r.routes.length, 4);
});

test('30 stops with 4 drivers are back before 4 PM and use every driver', () => {
  const p = makeProblem();
  const r = solve(p, { timeLimitMs: 800 });
  assert.equal(r.overtimeMinutes, 0);
  assert.ok(r.lastFinish <= 960, `last finish ${r.lastFinish}`);
  for (const route of r.routes) assert.ok(route.order.length > 0);
});

test('optimized plan beats a naive split', () => {
  const p = makeProblem();
  const r = solve(p, { timeLimitMs: 800 });
  const naive = [[], [], [], []];
  for (let i = 1; i <= 30; i++) naive[i % 4].push(i);
  const naiveMinutes = naive.reduce((s, route) => s + simulateRoute(route, p).duration, 0);
  assert.ok(r.totalMinutes < naiveMinutes * 0.7, `${r.totalMinutes} vs naive ${naiveMinutes}`);
});

test('priority deadline is respected', () => {
  // Stop 7 must be reached by 11:45 (15 minutes after leaving).
  const p = makeProblem({ due: { 7: 705 } });
  const r = solve(p, { timeLimitMs: 600 });
  const stop = r.routes.flatMap((x) => x.stops).find((s) => s.stop === 7);
  assert.ok(stop.arrive <= 705 + 0.01, `arrived ${stop.arrive}`);
  assert.deepEqual(r.lateStops, []);
});

test('higher balance weight brings finish times closer together', () => {
  const p = makeProblem({ seed: 3 });
  const low = solve(p, { timeLimitMs: 600, weights: { balance: 0 } });
  const high = solve(p, { timeLimitMs: 600, weights: { balance: 3 } });
  assert.ok(
    high.lastFinish - high.firstFinish <= low.lastFinish - low.firstFinish + 0.01,
    `high spread ${high.lastFinish - high.firstFinish}, low spread ${low.lastFinish - low.firstFinish}`,
  );
});

test('waits for a client that is not open yet', () => {
  const p = makeProblem({ n: 3, vehicles: 1 });
  p.open[2] = 800;
  const r = solve(p, { timeLimitMs: 100 });
  const stop = r.routes[0].stops.find((s) => s.stop === 2);
  assert.ok(stop.arrive >= 800);
});

test('handles a single stop and more drivers than stops', () => {
  const p = makeProblem({ n: 2, vehicles: 4 });
  const r = solve(p, { timeLimitMs: 100 });
  assertValid(r, p);
});

test('same seed gives the same answer', () => {
  const p = makeProblem({ seed: 9 });
  const a = solve(p, { iterations: 2000, timeLimitMs: 60000, seed: 5 });
  const b = solve(p, { iterations: 2000, timeLimitMs: 60000, seed: 5 });
  assert.deepEqual(
    a.routes.map((r) => r.order),
    b.routes.map((r) => r.order),
  );
});
