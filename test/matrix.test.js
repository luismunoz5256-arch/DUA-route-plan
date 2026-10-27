import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neededPairs, missingPlan, fillMissing, assemble, locKey, NEIGHBORS } from '../js/matrix.js';
import { makeRng } from '../js/solver.js';

const town = (n, seed = 1) => {
  const rng = makeRng(seed);
  return [{ lat: 31.775, lng: -106.38 }, ...Array.from({ length: n }, () => ({ lat: 31.65 + rng() * 0.3, lng: -106.6 + rng() * 0.4 }))];
};

test('lookups grow with the number of places, not its square', () => {
  for (const n of [20, 60, 150]) {
    const pairs = neededPairs(town(n));
    assert.ok(pairs.size <= 2 * n + 2 * n * NEIGHBORS, `${n} places: ${pairs.size}`);
    if (n === 150) assert.ok(pairs.size < 0.2 * (n + 1) * n, 'far fewer than every pair');
  }
});

test('every place is linked to and from the warehouse and its nearest places, both ways', () => {
  const pts = town(30);
  const pairs = neededPairs(pts);
  const key = pts.map(locKey);
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pairs.has(`${key[0]}|${key[i]}`) && pairs.has(`${key[i]}|${key[0]}`));
    // its single nearest place
    let best = -1;
    for (let j = 1; j < pts.length; j++) if (j !== i && (best < 0 || Math.hypot(pts[j].lat - pts[i].lat, pts[j].lng - pts[i].lng) < Math.hypot(pts[best].lat - pts[i].lat, pts[best].lng - pts[i].lng))) best = j;
    assert.ok(pairs.has(`${key[i]}|${key[best]}`) && pairs.has(`${key[best]}|${key[i]}`));
  }
  for (const p of pairs) assert.ok(pairs.has(p.split('|').reverse().join('|')), 'symmetric');
});

test('only missing pairs are requested from Google, one request per starting place', async () => {
  const pts = town(25);
  const cache = {};
  const plan = missingPlan(pts, cache);
  let requested = 0;
  let requests = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    requests++;
    requested += body.origins.length * body.destinations.length;
    const rows = body.destinations.map((_, j) => ({ originIndex: 0, destinationIndex: j, duration: '600s', distanceMeters: 5000, condition: 'ROUTE_EXISTS' }));
    return { ok: true, json: async () => rows };
  };
  try {
    let billed = 0;
    const got = await fillMissing(plan, cache, 'key', new Date(Date.now() + 3600000), { onElements: (n) => (billed += n) });
    assert.equal(got, plan.elements);
    assert.equal(requested, plan.elements, 'nothing extra billed');
    assert.equal(billed, plan.elements);
    assert.equal(requests, plan.places);
    assert.equal(missingPlan(pts, cache).elements, 0, 'all saved now');
    // a new client only needs its own pairs and the neighbours that now have it nearby
    const more = [...pts, { lat: 31.77, lng: -106.45 }];
    assert.ok(missingPlan(more, cache).elements <= 2 + 4 * NEIGHBORS);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('far pairs are estimated from Google times nearby, and only needed pairs count as missing', () => {
  const pts = town(40);
  const keys = pts.map(locKey);
  const cache = {};
  // Google says driving takes 2 minutes per straight-line km here
  const km = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 95);
  for (const p of neededPairs(pts)) {
    const [a, b] = p.split('|').map((k) => pts[keys.indexOf(k)]);
    cache[p] = [km(a, b) * 2, km(a, b) * 1400];
  }
  const m = assemble(pts, cache);
  assert.equal(m.estimated, 0, 'far-apart pairs are not reported as missing');
  // a far pair not looked up comes out close to 2 min per km
  let checked = 0;
  for (let i = 1; i < pts.length && checked < 5; i++) for (let j = 1; j < pts.length && checked < 5; j++) {
    if (i === j || cache[`${keys[i]}|${keys[j]}`]) continue;
    const expect = km(pts[i], pts[j]) * 2;
    assert.ok(Math.abs(m.time[i][j] - expect) / expect < 0.15, `${m.time[i][j]} vs ${expect}`);
    checked++;
  }
  assert.ok(checked > 0);
});
