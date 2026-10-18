// Route optimizer: splits stops across drivers and orders each route.
//
// Problem shape (all times in minutes; index 0 is the warehouse, stops are 1..n):
//   time[i][j]   drive minutes from i to j
//   service[i]   unload minutes at stop i
//   open[i]      earliest arrival (minutes after midnight) or null
//   due[i]       latest arrival (priority "deliver by" / client closing) or null
//   start        departure time from the warehouse
//   endBy        time every driver should be back
//   vehicles     number of drivers
//
// Objective (lower is better):
//   total paid minutes (leave warehouse -> back at warehouse, summed over drivers)
//   + heavy penalty per minute a stop is late or a driver is back after endBy
//   + balance weight x (latest finish - earliest finish)
//   + penalty for a driver with no stops
//
// Search: ruin-and-recreate (remove a few stops, re-insert them at the cheapest
// spots) with simulated-annealing acceptance, then a 2-opt polish.

export const DEFAULT_WEIGHTS = { late: 100, overtime: 100, balance: 0.15, empty: 500 };

export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Full timeline of one route, used for display.
export function simulateRoute(route, p) {
  let t = p.start;
  let prev = 0;
  let drive = 0;
  let wait = 0;
  let late = 0;
  const stops = [];
  for (const i of route) {
    const leg = p.time[prev][i];
    t += leg;
    drive += leg;
    if (p.open[i] != null && t < p.open[i]) {
      wait += p.open[i] - t;
      t = p.open[i];
    }
    const lateBy = p.due[i] != null && t > p.due[i] ? t - p.due[i] : 0;
    late += lateBy;
    stops.push({ stop: i, arrive: t, depart: t + p.service[i], drive: leg, late: lateBy });
    t += p.service[i];
    prev = i;
  }
  let returnDrive = 0;
  if (route.length) {
    returnDrive = p.time[prev][0];
    t += returnDrive;
    drive += returnDrive;
  }
  const finish = route.length ? t : p.start;
  return {
    stops,
    finish,
    duration: finish - p.start,
    drive,
    returnDrive,
    wait,
    late,
    overtime: Math.max(0, finish - p.endBy),
  };
}

// Cost and finish time of `route` with stop `ins` inserted before position `pos`
// (pass ins = -1 to evaluate the route as-is). Allocation-free for the hot loop.
function routeEval(route, p, w, ins, pos, out) {
  const len = route.length + (ins >= 0 ? 1 : 0);
  if (len === 0) {
    out.cost = 0;
    out.finish = p.start;
    return out;
  }
  let t = p.start;
  let prev = 0;
  let late = 0;
  for (let k = 0, r = 0; k < len; k++) {
    let i;
    if (ins >= 0 && k === pos) i = ins;
    else i = route[r++];
    t += p.time[prev][i];
    const o = p.open[i];
    if (o != null && t < o) t = o;
    const d = p.due[i];
    if (d != null && t > d) late += t - d;
    t += p.service[i];
    prev = i;
  }
  t += p.time[prev][0];
  const overtime = t > p.endBy ? t - p.endBy : 0;
  out.cost = t - p.start + w.late * late + w.overtime * overtime;
  out.finish = t;
  return out;
}

class State {
  constructor(routes, p, w) {
    this.p = p;
    this.w = w;
    this.routes = routes;
    this.cost = routes.map(() => 0);
    this.finish = routes.map(() => p.start);
    const tmp = {};
    for (let r = 0; r < routes.length; r++) this.refresh(r, tmp);
  }
  refresh(r, tmp = {}) {
    routeEval(this.routes[r], this.p, this.w, -1, 0, tmp);
    this.cost[r] = tmp.cost;
    this.finish[r] = tmp.finish;
  }
  total() {
    let sum = 0;
    let max = -Infinity;
    let min = Infinity;
    let empty = 0;
    for (let r = 0; r < this.routes.length; r++) {
      sum += this.cost[r];
      if (this.finish[r] > max) max = this.finish[r];
      if (this.finish[r] < min) min = this.finish[r];
      if (!this.routes[r].length) empty++;
    }
    return sum + this.w.balance * (max - min) + this.w.empty * empty;
  }
  clone() {
    const s = Object.create(State.prototype);
    s.p = this.p;
    s.w = this.w;
    s.routes = this.routes.map((r) => r.slice());
    s.cost = this.cost.slice();
    s.finish = this.finish.slice();
    return s;
  }
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Spread (max finish - min finish) if route r's finish became f.
function spreadWith(state, r, f) {
  let max = f;
  let min = f;
  for (let k = 0; k < state.finish.length; k++) {
    if (k === r) continue;
    if (state.finish[k] > max) max = state.finish[k];
    if (state.finish[k] < min) min = state.finish[k];
  }
  return max - min;
}

function insertAll(state, stops, rng, noise) {
  const { p, w } = state;
  const tmp = {};
  for (const s of stops) {
    const curSpread = spreadWith(state, -1, state.finish[0]);
    let best = Infinity;
    let bestR = 0;
    let bestPos = 0;
    let bestFinish = 0;
    let bestCost = 0;
    for (let r = 0; r < state.routes.length; r++) {
      const route = state.routes[r];
      const emptyBonus = route.length ? 0 : w.empty;
      for (let pos = 0; pos <= route.length; pos++) {
        routeEval(route, p, w, s, pos, tmp);
        let delta =
          tmp.cost - state.cost[r] + w.balance * (spreadWith(state, r, tmp.finish) - curSpread) - emptyBonus;
        if (noise) delta *= 1 + noise * (rng() - 0.5);
        if (delta < best) {
          best = delta;
          bestR = r;
          bestPos = pos;
          bestFinish = tmp.finish;
          bestCost = tmp.cost;
        }
      }
    }
    state.routes[bestR].splice(bestPos, 0, s);
    state.cost[bestR] = bestCost;
    state.finish[bestR] = bestFinish;
  }
}

function ruin(state, rng, n) {
  const { p } = state;
  const maxRemove = Math.min(12, Math.max(3, Math.ceil(n * 0.3)));
  const k = 1 + Math.floor(rng() * maxRemove);
  const mode = rng();
  let removed;
  if (mode < 0.4) {
    // random stops
    const all = state.routes.flat();
    removed = shuffle(all, rng).slice(0, k);
  } else if (mode < 0.8) {
    // a stop and its nearest neighbours
    const all = state.routes.flat();
    const seed = all[Math.floor(rng() * all.length)];
    removed = all
      .map((x) => [x, p.time[seed][x] + p.time[x][seed]])
      .sort((a, b) => a[1] - b[1])
      .slice(0, k)
      .map((x) => x[0]);
  } else {
    // a consecutive piece of one route
    const nonEmpty = state.routes.map((r, i) => i).filter((i) => state.routes[i].length);
    const r = nonEmpty[Math.floor(rng() * nonEmpty.length)];
    const route = state.routes[r];
    const len = Math.min(k, route.length);
    const start = Math.floor(rng() * (route.length - len + 1));
    removed = route.slice(start, start + len);
  }
  const set = new Set(removed);
  const tmp = {};
  for (let r = 0; r < state.routes.length; r++) {
    const before = state.routes[r].length;
    state.routes[r] = state.routes[r].filter((x) => !set.has(x));
    if (state.routes[r].length !== before) state.refresh(r, tmp);
  }
  return removed;
}

function orderForInsert(removed, p, rng) {
  const r = rng();
  if (r < 0.5) return shuffle(removed, rng);
  if (r < 0.75) {
    // hardest first: stops with a deadline, then far from the warehouse
    return removed.sort((a, b) => (p.due[a] ?? 1e9) - (p.due[b] ?? 1e9) || p.time[0][b] - p.time[0][a]);
  }
  return removed.sort((a, b) => p.time[0][b] - p.time[0][a]);
}

// 2-opt and single-stop moves inside each route until nothing improves.
function polish(state) {
  const { p, w } = state;
  const tmp = {};
  let improved = true;
  while (improved) {
    improved = false;
    for (let r = 0; r < state.routes.length; r++) {
      const route = state.routes[r];
      for (let i = 0; i < route.length - 1; i++) {
        for (let j = i + 1; j < route.length; j++) {
          const cand = route.slice(0, i).concat(route.slice(i, j + 1).reverse(), route.slice(j + 1));
          routeEval(cand, p, w, -1, 0, tmp);
          if (tmp.cost < state.cost[r] - 1e-9) {
            const before = state.total();
            const old = [route, state.cost[r], state.finish[r]];
            state.routes[r] = cand;
            state.cost[r] = tmp.cost;
            state.finish[r] = tmp.finish;
            if (state.total() < before - 1e-9) {
              improved = true;
              break;
            }
            [state.routes[r], state.cost[r], state.finish[r]] = old;
          }
        }
        if (improved) break;
      }
      if (improved) break;
    }
  }
}

export function solve(problem, options = {}) {
  const p = problem;
  const w = { ...DEFAULT_WEIGHTS, ...(options.weights || {}) };
  const n = p.service.length - 1;
  const vehicles = Math.max(1, p.vehicles);
  const rng = makeRng(options.seed ?? 12345);
  const timeLimit = options.timeLimitMs ?? 1500;
  const maxIter = options.iterations ?? 200000;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();

  let cur = new State(Array.from({ length: vehicles }, () => []), p, w);
  const stops = Array.from({ length: n }, (_, i) => i + 1);
  if (n > 0) insertAll(cur, orderForInsert(stops, p, rng), rng, 0);
  let curCost = cur.total();
  let best = cur.clone();
  let bestCost = curCost;

  let iter = 0;
  if (n > 1) {
    const temp0 = Math.max(2, curCost * 0.01);
    while (iter < maxIter) {
      if ((iter & 63) === 0 && now() - t0 > timeLimit) break;
      iter++;
      const progress = Math.min(1, (now() - t0) / timeLimit);
      const temp = temp0 * (1 - progress) + 0.01;
      const cand = cur.clone();
      const removed = ruin(cand, rng, n);
      insertAll(cand, orderForInsert(removed, p, rng), rng, rng() < 0.3 ? 0.2 : 0);
      const c = cand.total();
      if (c < curCost - 1e-9 || rng() < Math.exp(-(c - curCost) / temp)) {
        cur = cand;
        curCost = c;
        if (c < bestCost - 1e-9) {
          best = cand.clone();
          bestCost = c;
        }
      }
    }
  }
  polish(best);
  bestCost = best.total();

  const routes = best.routes.map((route) => ({ order: route.slice(), ...simulateRoute(route, p) }));
  const used = routes.filter((r) => r.order.length);
  const finishes = used.map((r) => r.finish);
  return {
    routes,
    objective: bestCost,
    totalMinutes: routes.reduce((s, r) => s + r.duration, 0),
    totalDrive: routes.reduce((s, r) => s + r.drive, 0),
    lastFinish: finishes.length ? Math.max(...finishes) : p.start,
    firstFinish: finishes.length ? Math.min(...finishes) : p.start,
    lateStops: routes.flatMap((r) => r.stops.filter((s) => s.late > 0.5).map((s) => s.stop)),
    overtimeMinutes: routes.reduce((s, r) => s + r.overtime, 0),
    iterations: iter,
    ms: Math.round(now() - t0),
  };
}
