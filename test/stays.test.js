import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordStays, learnedStop } from '../js/stays.js';

test('stop times are recorded per client and day, ignoring drive-bys and long breaks', () => {
  const clients = [{ id: 'a' }, { id: 'b' }];
  assert.equal(recordStays(clients, '2026-10-21', [{ id: 'a', minutes: 12.2 }, { id: 'b', minutes: 0.4 }, { id: 'b', minutes: 140 }, { id: 'x', minutes: 9 }]), 1);
  assert.deepEqual(clients[0].stays, { '2026-10-21': 12 });
  assert.equal(clients[1].stays, undefined);
  // the same day again changes nothing
  assert.equal(recordStays(clients, '2026-10-21', [{ id: 'a', minutes: 12 }]), 0);
});

test('the typical stop time needs 3 visits and is the median', () => {
  const c = { id: 'a' };
  recordStays([c], '2026-10-19', [{ id: 'a', minutes: 14 }]);
  recordStays([c], '2026-10-20', [{ id: 'a', minutes: 16 }]);
  assert.equal(learnedStop(c), null);
  recordStays([c], '2026-10-21', [{ id: 'a', minutes: 60 }]); // a long stop doesn't pull it up much
  assert.deepEqual(learnedStop(c), { minutes: 16, visits: 3 });
  recordStays([c], '2026-10-22', [{ id: 'a', minutes: 13 }]);
  assert.deepEqual(learnedStop(c), { minutes: 15, visits: 4 });
});

test('only the 20 most recent visits are kept', () => {
  const c = { id: 'a' };
  for (let d = 1; d <= 25; d++) recordStays([c], `2026-10-${String(d).padStart(2, '0')}`, [{ id: 'a', minutes: d }]);
  assert.equal(Object.keys(c.stays).length, 20);
  assert.ok(!('2026-10-05' in c.stays) && '2026-10-25' in c.stays);
});
