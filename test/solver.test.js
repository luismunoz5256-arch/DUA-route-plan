import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve, simulateRoute, makeRng, insertStop, summarize } from '../js/solver.js';

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
  assert.equal(r.pastEndMinutes, 0);
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

test('paid time runs from clock-in and overtime is charged at 1.5x', () => {
  const p = makeProblem({ n: 3, vehicles: 1 });
  p.shiftStart = 480; // 8:00
  p.otAt = [480 + 60]; // pretend overtime starts at 9:00
  const r = simulateRoute([1, 2, 3], p, 0);
  assert.equal(r.paid, r.finish - 480);
  assert.equal(r.ot, r.finish - 540);
});

test('overtime can be cheaper than adding a driver', () => {
  // 3 drivers, routes that run a bit past 8h: cost per extra driver includes the 3.5h morning.
  const p = makeProblem({ seed: 4 });
  p.shiftStart = 480;
  p.otAt = [960, 960, 960, 960, 960];
  p.endBy = 1080; // hard limit 6 PM
  const three = solve({ ...p, vehicles: 3 }, { timeLimitMs: 500 });
  const four = solve({ ...p, vehicles: 4 }, { timeLimitMs: 500 });
  const cost = (x) => x.paidMinutes + 0.5 * x.otMinutes;
  assert.ok(cost(three) < cost(four), `3 drivers ${cost(three)} vs 4 drivers ${cost(four)}`);
});

test('a driver already at 40 hours this week gets the lighter route', () => {
  const p = makeProblem({ seed: 2, vehicles: 2 });
  p.shiftStart = 480;
  p.otAt = [480, 960]; // driver 0 is on overtime all day
  const r = solve(p, { timeLimitMs: 500, weights: { balance: 0 } });
  assert.ok(r.routes[0].paid < r.routes[1].paid, `${r.routes[0].paid} vs ${r.routes[1].paid}`);
});

test('fuel cost uses the distance table', () => {
  const p = makeProblem({ n: 2, vehicles: 1 });
  p.dist = p.time.map((row) => row.map((t) => t / 2));
  const r = summarize([[1, 2]], p);
  const expected = (p.time[0][1] + p.time[1][2] + p.time[2][0]) / 2;
  assert.ok(Math.abs(r.miles - expected) < 1e-9);
});

test('insertStop adds a stop without reshuffling and respects done stops', () => {
  const p = makeProblem({ n: 6, vehicles: 2 });
  const orders = [[1, 2, 3], [4, 5]];
  const out = insertStop(orders, p, 6, [3, 2]);
  assert.deepEqual(out[0].slice(0, 3), [1, 2, 3]);
  assert.deepEqual(out[1].slice(0, 2), [4, 5]);
  assert.equal(out.flat().length, 6);
  // only the end positions were allowed
  assert.ok(out[0][3] === 6 || out[1][2] === 6);
});

test('insertStop can be limited to one driver', () => {
  const p = makeProblem({ n: 6, vehicles: 3 });
  const out = insertStop([[1, 2], [3, 4], [5]], p, 6, [Infinity, 0, Infinity]);
  assert.ok(out[1].includes(6));
  assert.deepEqual(out[0], [1, 2]);
  assert.deepEqual(out[2], [5]);
});

const routeOf = (orders) => {
  const where = [null];
  orders.forEach((o, r) => o.forEach((i) => (where[i] = r)));
  return where;
};

test('regular clients stay with their usual driver unless moving saves more than the set amount', () => {
  const base = makeProblem({ n: 20, vehicles: 3, seed: 7 });
  // Usual drivers from an unrelated split (round robin), so the cheapest plan disagrees with them.
  const home = [null, ...Array.from({ length: 20 }, (_, i) => i % 3)];
  const free = solve(base, { timeLimitMs: 300 });
  const sticky = solve({ ...base, home, away: 1000 }, { timeLimitMs: 300 });
  const where = routeOf(sticky.routes.map((r) => r.order));
  for (let i = 1; i <= 20; i++) assert.equal(where[i], home[i], `stop ${i} left its usual driver`);
  // A small preference lets some stops move, and the result is never cheaper than the free plan.
  const some = solve({ ...base, home, away: 5 }, { timeLimitMs: 300 });
  const moved = routeOf(some.routes.map((r) => r.order)).filter((r, i) => i && r !== home[i]).length;
  assert.ok(moved > 0 && moved < 20);
  assert.ok(some.paidMinutes >= free.paidMinutes - 1);
});

test('locked stops stay on their truck and only the driving order changes', () => {
  const p = makeProblem({ n: 15, vehicles: 3, seed: 3 });
  const given = [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12, 13, 14, 15]];
  const lock = routeOf(given);
  const r = solve({ ...p, lock }, { timeLimitMs: 300 });
  r.routes.forEach((x, k) => assert.deepEqual([...x.order].sort((a, b) => a - b), given[k]));
  assert.ok(r.paidMinutes <= summarize(given, p).paidMinutes + 1e-9);
});

test('insertStop prefers the usual driver of a new order', () => {
  const p = makeProblem({ n: 6, vehicles: 2 });
  const home = [null, null, null, null, null, null, 1];
  const out = insertStop([[1, 2, 3], [4, 5]], { ...p, home, away: 1000 }, 6);
  assert.ok(out[1].includes(6));
});

test('keeping drivers in their own area breaks ties in favour of compact routes', () => {
  // Every trip goes through the warehouse, so any split costs the same: only the area goal decides.
  const xy = [[0, 0], [10, 0], [9, 2], [10, -2], [-10, 0], [-9, 2], [-10, -2]];
  const leg = 15;
  const time = xy.map((a, i) => xy.map((b, j) => (i === j ? 0 : (i ? leg : 0) + (j ? leg : 0))));
  const p = { time, service: xy.map((_, i) => (i ? 10 : 0)), open: xy.map(() => null), due: xy.map(() => null), start: 690, endBy: 1200, vehicles: 2, px: xy.map((q) => q[0]), py: xy.map((q) => q[1]), compact: 0.5 };
  for (const seed of [1, 2, 3]) {
    const r = solve(p, { timeLimitMs: 200, seed });
    for (const x of r.routes) assert.equal(new Set(x.order.map((i) => Math.sign(xy[i][0]))).size, 1, `seed ${seed}: a route crosses town`);
  }
});

test('the area goal costs little on an ordinary day', () => {
  const p = makeProblem({ n: 30, vehicles: 3, seed: 4 });
  const rng = makeRng(9);
  const pts = p.time.map(() => [(rng() - 0.5) * 40, (rng() - 0.5) * 40]);
  const plain = solve(p, { timeLimitMs: 400 });
  const compact = solve({ ...p, px: pts.map((q) => q[0]), py: pts.map((q) => q[1]), compact: 0.5 }, { timeLimitMs: 400 });
  assert.ok(compact.totalMinutes <= plain.totalMinutes * 1.05, `${compact.totalMinutes} vs ${plain.totalMinutes}`);
});
