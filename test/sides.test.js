import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sideOf, sideDriver, defaultSides } from '../js/sides.js';

const depot = { lat: 31.7836, lng: -106.3874 }; // 840 N Hawkins Blvd

test('El Paso places land on the expected side of town', () => {
  const places = {
    'Sunland Park': [31.796, -106.58, 'west'],
    Canutillo: [31.911, -106.598, 'west'],
    Anthony: [31.999, -106.605, 'west'],
    'West side (Coronado)': [31.82, -106.56, 'west'],
    Downtown: [31.759, -106.487, 'central'],
    Northeast: [31.88, -106.43, 'central'],
    'Near the warehouse': [31.79, -106.37, 'central'],
    'East side': [31.78, -106.30, 'east'],
    'Far east': [31.80, -106.22, 'east'],
    Ysleta: [31.69, -106.32, 'southeast'],
    Socorro: [31.654, -106.303, 'southeast'],
    'Horizon City': [31.693, -106.207, 'southeast'],
  };
  for (const [name, [lat, lng, side]] of Object.entries(places)) assert.equal(sideOf({ lat, lng }, depot), side, name);
});

test('each side belongs to the driver set for it', () => {
  const order = ['Driver 1', 'Driver 2', 'Driver 3', 'Driver 4'];
  const sides = defaultSides(order);
  assert.deepEqual(sides, { 'Driver 1': 'west', 'Driver 2': 'east', 'Driver 3': 'southeast', 'Driver 4': 'central' });
  assert.equal(sideDriver({ lat: 31.796, lng: -106.58 }, depot, sides, order), 'Driver 1');
  assert.equal(sideDriver({ lat: 31.654, lng: -106.303 }, depot, sides, order), 'Driver 3');
  assert.equal(sideDriver({ lat: 31.759, lng: -106.487 }, depot, { 'Driver 1': 'west' }, order), '');
  assert.equal(sideDriver({ lat: 31.759, lng: -106.487 }, null, sides, order), '');
});
