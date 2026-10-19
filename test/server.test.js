import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './fake-apps-script.cjs';

function setupServer() {
  const s = createServer();
  const admin = s.call({ action: 'setup', setupCode: 'test-setup-code', username: 'Boss', password: 'secret123' });
  assert.ok(admin.token, JSON.stringify(admin));
  s.call({ action: 'saveUser', token: admin.token, user: { username: 'sec', role: 'secretary', password: 'secret123' } });
  s.call({ action: 'saveUser', token: admin.token, user: { username: 'ana', role: 'driver', driverName: 'Ana', password: 'secret123' } });
  s.call({ action: 'saveUser', token: admin.token, user: { username: 'ben', role: 'driver', driverName: 'Ben', password: 'secret123' } });
  const login = (u) => s.call({ action: 'login', username: u, password: 'secret123' }).token;
  return { s, admin: admin.token, sec: login('sec'), ana: login('ana'), ben: login('ben') };
}

const DATA = {
  clients: [{ id: 'c1', name: 'Cafe' }],
  settings: { payRate: 14 },
  settingsUpdated: 1,
  routes: {
    '2026-10-21': { updated: 1, drivers: { Ana: { stops: [{ id: 'c1', n: 'Cafe' }] }, Ben: { stops: [{ id: 'c2', n: 'Deli' }] } } },
  },
};

test('first admin needs the setup code, and only once', () => {
  const s = createServer();
  assert.equal(s.call({ action: 'status' }).needsSetup, true);
  assert.match(s.call({ action: 'setup', setupCode: 'nope', username: 'boss', password: 'secret123' }).error, /setup code/);
  assert.ok(s.call({ action: 'setup', setupCode: 'test-setup-code', username: 'boss', password: 'secret123' }).token);
  assert.equal(s.call({ action: 'status' }).needsSetup, false);
  assert.match(s.call({ action: 'setup', setupCode: 'test-setup-code', username: 'x', password: 'secret123' }).error, /already/);
});

test('login checks the password and usernames ignore case', () => {
  const { s } = setupServer();
  assert.match(s.call({ action: 'login', username: 'boss', password: 'wrong!!' }).error, /Wrong/);
  const ok = s.call({ action: 'login', username: 'BOSS ', password: 'secret123' });
  assert.equal(ok.user.role, 'admin');
});

test('too many wrong passwords locks the account for a while', () => {
  const { s } = setupServer();
  for (let i = 0; i < 5; i++) s.call({ action: 'login', username: 'ana', password: 'bad-pass' });
  assert.match(s.call({ action: 'login', username: 'ana', password: 'secret123' }).error, /Too many/);
});

test('calls without a valid session are refused', () => {
  const { s } = setupServer();
  assert.equal(s.call({ action: 'pull' }).error, 'Not logged in');
  assert.equal(s.call({ action: 'pull', token: 'made-up' }).error, 'Not logged in');
});

test('drivers only see their own routes and cannot save data', () => {
  const { s, sec, ana } = setupServer();
  assert.ok(s.call({ action: 'push', token: sec, data: DATA }).ok);
  const pulled = s.call({ action: 'pull', token: ana });
  assert.deepEqual(Object.keys(pulled.data), ['routes', 'done']);
  assert.deepEqual(Object.keys(pulled.data.routes['2026-10-21'].drivers), ['Ana']);
  assert.equal(pulled.data.clients, undefined);
  assert.match(s.call({ action: 'push', token: ana, data: {} }).error, /Not allowed/);
  assert.match(s.call({ action: 'listUsers', token: ana }).error, /Not allowed/);
});

test('done ticks are kept by the server even when the office saves', () => {
  const { s, sec, ana } = setupServer();
  s.call({ action: 'push', token: sec, data: DATA });
  assert.ok(s.call({ action: 'done', token: ana, date: '2026-10-21', stopId: 'c1', done: true }).done.c1);
  s.call({ action: 'push', token: sec, data: { ...DATA, done: {} } });
  const office = s.call({ action: 'pull', token: sec }).data;
  assert.ok(office.done['2026-10-21'].Ana.c1);
  assert.match(s.call({ action: 'done', token: ana, date: '2026-10-22', stopId: 'c1', done: true }).error, /No route/);
});

test('secretary cannot change settings or manage users; admin can', () => {
  const { s, admin, sec } = setupServer();
  s.call({ action: 'push', token: admin, data: DATA });
  s.call({ action: 'push', token: sec, data: { ...DATA, settings: { payRate: 99, driverCount: 4 }, settingsUpdated: 5 } });
  const after = s.call({ action: 'pull', token: admin }).data.settings;
  assert.equal(after.payRate, 14);
  assert.equal(after.driverCount, 4); // allowed: chosen on the Plan screen
  assert.match(s.call({ action: 'saveUser', token: sec, user: { username: 'x', role: 'admin', password: 'secret123' } }).error, /Not allowed/);
  s.call({ action: 'push', token: admin, data: { ...DATA, settings: { payRate: 15 }, settingsUpdated: 6 } });
  assert.equal(s.call({ action: 'pull', token: sec }).data.settings.payRate, 15);
});

test('role changes and removals apply to existing sessions', () => {
  const { s, admin, ben } = setupServer();
  s.call({ action: 'deleteUser', token: admin, username: 'ben' });
  assert.equal(s.call({ action: 'pull', token: ben }).error, 'Not logged in');
  assert.match(s.call({ action: 'deleteUser', token: admin, username: 'boss' }).error, /own account/);
  assert.match(s.call({ action: 'saveUser', token: admin, user: { username: 'boss', role: 'driver' } }).error, /at least one admin/);
});

test('users can change their password; logout ends the session', () => {
  const { s, ana } = setupServer();
  assert.match(s.call({ action: 'changePassword', token: ana, oldPassword: 'nope', newPassword: 'newpass1' }).error, /wrong/);
  assert.ok(s.call({ action: 'changePassword', token: ana, oldPassword: 'secret123', newPassword: 'newpass1' }).ok);
  assert.ok(s.call({ action: 'login', username: 'ana', password: 'newpass1' }).token);
  s.call({ action: 'logout', token: ana });
  assert.equal(s.call({ action: 'me', token: ana }).error, 'Not logged in');
});

test('password hashes are stored, not passwords', () => {
  const { s, admin } = setupServer();
  const users = s.call({ action: 'listUsers', token: admin }).users;
  assert.equal(users.length, 4);
  for (const u of users) {
    assert.equal(u.hash, undefined);
    assert.equal(u.salt, undefined);
  }
});

// A tiny stand-in for MyGeotab.
function fakeGeotab() {
  const calls = [];
  let sessionOk = true;
  const fn = (method, params, host) => {
    calls.push({ method, host, params });
    if (method === 'Authenticate') {
      if (params.password !== 'geo-pass') throw { name: 'InvalidUserException', message: 'Incorrect login credentials' };
      sessionOk = true;
      return { credentials: { database: params.database, userName: params.userName, sessionId: 's1' }, path: 'my5.geotab.com' };
    }
    if (!sessionOk || params.credentials?.sessionId !== 's1') throw { name: 'InvalidUserException', message: 'expired' };
    if (method === 'Get' && params.typeName === 'Device') return [{ id: 'b2', name: 'Truck 2' }, { id: 'b1', name: 'Truck 1', licensePlate: 'ABC' }];
    if (method === 'Get' && params.typeName === 'DeviceStatusInfo') {
      return [{ device: { id: 'b1' }, latitude: 31.8, longitude: -106.4, speed: 30, isDriving: true, currentStateDuration: '00:05:00', dateTime: '2026-10-21T18:00:00Z' }];
    }
    if (method === 'ExecuteMultiCall') {
      return params.calls.map((c) =>
        c.params.typeName === 'Trip'
          ? [{ start: '2026-10-21T17:30:00Z', stop: '2026-10-21T17:50:00Z', nextTripStart: '2026-10-21T18:05:00Z', stopPoint: { x: -106.4, y: 31.8 }, distance: 12, drivingDuration: '00:20:00', idlingDuration: '00:01:00', stopDuration: '00:15:00' }]
          : Array.from({ length: 3000 }, (_, k) => ({ latitude: 31.7 + k / 1e5, longitude: -106.4 })),
      );
    }
    throw { name: 'Error', message: 'unexpected ' + method };
  };
  return { fn, calls, expire: () => (sessionOk = false) };
}

function geotabServer() {
  const g = fakeGeotab();
  const s = createServer({ geotab: g.fn });
  const admin = s.call({ action: 'setup', setupCode: 'test-setup-code', username: 'boss', password: 'secret123' }).token;
  s.call({ action: 'saveUser', token: admin, user: { username: 'sec', role: 'secretary', password: 'secret123' } });
  const sec = s.call({ action: 'login', username: 'sec', password: 'secret123' }).token;
  return { s, g, admin, sec };
}

test('Geotab: wrong login is refused and nothing is saved', () => {
  const { s, admin } = geotabServer();
  const r = s.call({ action: 'geotabSave', token: admin, database: 'dua', userName: 'api@dua', password: 'nope' });
  assert.match(r.error, /rejected the login/);
  assert.equal(s.call({ action: 'geotabStatus', token: admin }).connected, false);
});

test('Geotab: connect, never return the password, and use the server Geotab points to', () => {
  const { s, g, admin } = geotabServer();
  const r = s.call({ action: 'geotabSave', token: admin, server: 'https://my.geotab.com/', database: 'dua', userName: 'api@dua', password: 'geo-pass' });
  assert.deepEqual(r, { connected: true, database: 'dua', userName: 'api@dua', server: 'my.geotab.com' });
  assert.equal(JSON.stringify(r).includes('geo-pass'), false);
  const devices = s.call({ action: 'geotabDevices', token: admin }).devices;
  assert.deepEqual(devices.map((d) => d.name), ['Truck 1', 'Truck 2']);
  assert.equal(g.calls.at(-1).host, 'my5.geotab.com');
});

test('Geotab: live positions and a day of trips with a thinned GPS trail', () => {
  const { s, admin } = geotabServer();
  s.call({ action: 'geotabSave', token: admin, database: 'dua', userName: 'api@dua', password: 'geo-pass' });
  const live = s.call({ action: 'geotabLive', token: admin }).trucks;
  assert.equal(live[0].id, 'b1');
  assert.equal(live[0].driving, true);
  const day = s.call({ action: 'geotabDay', token: admin, deviceIds: ['b1'], from: '2026-10-21T06:00:00Z', to: '2026-10-22T06:00:00Z' });
  const t = day.trucks.b1;
  assert.equal(t.trips[0].lat, 31.8);
  assert.equal(t.trips[0].stopFor, '00:15:00');
  assert.ok(t.trail.length <= 800 && t.trail.length > 500, `trail ${t.trail.length}`);
});

test('Geotab: an expired session logs in again by itself', () => {
  const { s, g, admin } = geotabServer();
  s.call({ action: 'geotabSave', token: admin, database: 'dua', userName: 'api@dua', password: 'geo-pass' });
  g.expire();
  assert.equal(s.call({ action: 'geotabDevices', token: admin }).devices.length, 2);
  assert.equal(g.calls.filter((c) => c.method === 'Authenticate').length, 2);
});

test('Geotab: only admins can use it', () => {
  const { s, admin, sec } = geotabServer();
  s.call({ action: 'geotabSave', token: admin, database: 'dua', userName: 'api@dua', password: 'geo-pass' });
  for (const action of ['geotabStatus', 'geotabDevices', 'geotabLive', 'geotabDay', 'geotabSave']) {
    assert.match(s.call({ action, token: sec }).error, /Not allowed/, action);
  }
});

test('Geotab: server box accepts a pasted MyGeotab address or a wrong website', () => {
  for (const [server, host, database] of [
    ['https://my.geotab.com/dua_produce/#map,liveVehicleIds:all', 'my.geotab.com', 'dua_produce'],
    ['  My.Geotab.com  ', 'my.geotab.com', ''],
    ['my457.geotab.com', 'my457.geotab.com', ''],
    ['geotab.com', 'my.geotab.com', ''],
    ['www.geotab.com', 'my.geotab.com', ''],
    ['mygeotab.com', 'my.geotab.com', ''],
    ['', 'my.geotab.com', ''],
  ]) {
    const { s, g, admin } = geotabServer();
    const r = s.call({ action: 'geotabSave', token: admin, server, database: database ? '' : 'dua', userName: 'api@dua', password: 'geo-pass' });
    assert.equal(r.error, undefined, server);
    assert.equal(g.calls[0].host, host, server);
    assert.equal(r.database, database || 'dua', server);
  }
});

test('Geotab: a MyGeotab address pasted into the database box still works', () => {
  const { s, g, admin } = geotabServer();
  const r = s.call({ action: 'geotabSave', token: admin, server: 'my.geotab.com', database: 'https://my.geotab.com/dua_produce/#dashboard', userName: 'api@dua', password: 'geo-pass' });
  assert.equal(r.database, 'dua_produce');
  assert.equal(g.calls[0].params.database, 'dua_produce');
});
