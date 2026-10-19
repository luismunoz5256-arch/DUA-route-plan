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
