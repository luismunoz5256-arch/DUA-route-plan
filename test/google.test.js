import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePolyline } from '../js/google.js';

test('road shapes from Google decode to map points (Google\'s own example)', () => {
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  assert.deepEqual(decodePolyline(''), []);
});
