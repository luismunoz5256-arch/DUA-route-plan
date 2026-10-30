import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insidePolygon, areaOwner, allowedMask } from '../js/areas.js';

// A square west of downtown and an L-shaped (concave) area east of it.
const west = [[31.70, -106.60], [31.90, -106.60], [31.90, -106.50], [31.70, -106.50]];
const eastL = [[31.70, -106.30], [31.90, -106.30], [31.90, -106.25], [31.75, -106.25], [31.75, -106.15], [31.70, -106.15]];
const areas = { 'Driver 1': { poly: west }, 'Driver 2': { poly: eastL }, 'Driver 4': { poly: [], flex: true } };
const order = ['Driver 1', 'Driver 2', 'Driver 3', 'Driver 4'];

test('points inside and outside polygons, including a concave one', () => {
  assert.equal(insidePolygon(31.8, -106.55, west), true);
  assert.equal(insidePolygon(31.8, -106.45, west), false);
  assert.equal(insidePolygon(31.72, -106.20, eastL), true); // in the foot of the L
  assert.equal(insidePolygon(31.85, -106.20, eastL), false); // in the notch
});

test('a client belongs to the driver whose area it is in', () => {
  assert.equal(areaOwner({ lat: 31.8, lng: -106.55 }, areas, order), 'Driver 1');
  assert.equal(areaOwner({ lat: '31.72', lng: '-106.20' }, areas, order), 'Driver 2');
  assert.equal(areaOwner({ lat: 31.78, lng: -106.40 }, areas, order), '');
  assert.equal(areaOwner({ lat: 31.8, lng: -106.55 }, {}, order), '');
});

test('the area driver plus flexible drivers may take a stop', () => {
  assert.equal(allowedMask('Driver 1', areas, order, 4), 0b1001);
  assert.equal(allowedMask('Driver 2', areas, order, 4), 0b1010);
  assert.equal(allowedMask('', areas, order, 4), null);
  // the flexible driver isn't working today: only the area driver
  assert.equal(allowedMask('Driver 1', areas, order, 3), 0b001);
  // the area's driver isn't working today: anyone
  assert.equal(allowedMask('Driver 4', areas, order, 3), null);
});
