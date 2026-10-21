// Server for the DUA Route Planner: logins and shared data, kept in a Google Sheet you own.
//
// Setup: paste this into Extensions → Apps Script of a new Google Sheet, change SETUP_CODE,
// then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
// SETUP_CODE creates the first admin account, and later lets you get admin access back
// ("Admin recovery" on the login page) if no admin can log in.
//
// Roles:
//   admin      everything, including settings and user accounts
//   secretary  clients, daily stops, routes and history (cannot change settings or users)
//   driver     only their own routes; can tick stops as done
//
// Optional: MyGeotab truck tracking (admin only). The Geotab login is entered in the
// planner's Settings, kept in this script's properties, and never sent back to browsers.
//
// Optional: QuickBooks Desktop link. A helper script on the office PC (quickbooks/qb-sync.ps1)
// sends the invoices dated over the next few days, using a key the admin creates in Settings.

const SETUP_CODE = 'change-this-to-something-long';
const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const ROLES = ['admin', 'secretary', 'driver'];
// The only settings a secretary may change (they're on the Plan screen).
const SECRETARY_SETTINGS = ['driverCount', 'drivers', 'balance'];

function doGet() {
  return reply({ ok: true, app: 'dua-route-plan' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ error: 'Bad request' });
  }
  try {
    return reply(handle(req));
  } catch (err) {
    return reply({ error: String((err && err.message) || err) });
  }
}

function handle(req) {
  switch (req.action) {
    case 'status':
      return { needsSetup: loadUsers().length === 0 };
    case 'setup':
      return withLock(() => setup(req));
    case 'recoverAdmin':
      return withLock(() => recoverAdmin(req));
    case 'login':
      return withLock(() => login(req));
    case 'qbPush':
      return withLock(() => qbPush(req));
  }
  const user = auth(req.token);
  switch (req.action) {
    case 'logout':
      props().deleteProperty('s_' + req.token);
      return { ok: true };
    case 'me':
      return { user: publicUser(user) };
    case 'pull':
      return { user: publicUser(user), data: pullFor(user) };
    case 'push':
      requireRole(user, ['admin', 'secretary']);
      return withLock(() => push(user, req.data));
    case 'done':
      requireRole(user, ['driver']);
      return withLock(() => markDone(user, req));
    case 'changePassword':
      return withLock(() => changePassword(user, req));
    case 'listUsers':
      requireRole(user, ['admin']);
      return { users: loadUsers().map(publicUser) };
    case 'saveUser':
      requireRole(user, ['admin']);
      return withLock(() => saveUser(req.user));
    case 'deleteUser':
      requireRole(user, ['admin']);
      return withLock(() => deleteUser(user, req.username));
    case 'geotabSave':
      requireRole(user, ['admin']);
      return geotabSave(req);
    case 'geotabStatus':
      requireRole(user, ['admin']);
      return geotabStatus();
    case 'geotabDevices':
      requireRole(user, ['admin']);
      return { devices: geotabDevices() };
    case 'geotabLive':
      requireRole(user, ['admin']);
      return { trucks: geotabLive() };
    case 'geotabDay':
      requireRole(user, ['admin']);
      return geotabDay(req);
    case 'qbKey':
      requireRole(user, ['admin']);
      return withLock(() => qbKey());
  }
  throw new Error('Unknown action');
}

// ---------- Accounts ----------

function setup(req) {
  if (loadUsers().length) throw new Error('Setup was already done. Log in instead.');
  checkSetupCode(req.setupCode);
  const user = newUser({ username: req.username, role: 'admin', password: req.password });
  saveUsers([user]);
  return startSession(user);
}

// Makes the given username an admin with the given password (creating it if needed).
// Needs the SETUP_CODE from this script, so only someone who can edit the script can do it.
function recoverAdmin(req) {
  checkSetupCode(req.setupCode);
  checkPassword(req.password);
  const users = loadUsers();
  let user = users.find((u) => u.username === clean(req.username));
  if (user) {
    user.role = 'admin';
    user.driverName = '';
    user.salt = Utilities.getUuid();
    user.hash = hash(req.password, user.salt);
  } else {
    user = newUser({ username: req.username, role: 'admin', password: req.password });
    users.push(user);
  }
  saveUsers(users);
  props().deleteProperty('f_' + user.username);
  return startSession(user);
}

function checkSetupCode(code) {
  limitTries('f_setupcode', () => code === SETUP_CODE && SETUP_CODE !== 'change-this-to-something-long', 'Wrong setup code (change SETUP_CODE in the script first).');
}

// Runs check(); after MAX_FAILS failures under `key`, refuses for LOCK_MINUTES.
function limitTries(key, check, message) {
  const fails = JSON.parse(props().getProperty(key) || '{"n":0,"until":0}');
  if (fails.until > Date.now()) throw new Error(`Too many tries. Wait ${LOCK_MINUTES} minutes and try again.`);
  if (!check()) {
    fails.n += 1;
    if (fails.n >= MAX_FAILS) {
      fails.n = 0;
      fails.until = Date.now() + LOCK_MINUTES * 60000;
    }
    props().setProperty(key, JSON.stringify(fails));
    throw new Error(message);
  }
  props().deleteProperty(key);
}

function login(req) {
  const username = clean(req.username);
  let user;
  limitTries('f_' + username, () => {
    user = loadUsers().find((u) => u.username === username);
    return user && user.hash === hash(String(req.password || ''), user.salt);
  }, 'Wrong username or password.');
  cleanSessions();
  return startSession(user);
}

function startSession(user) {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  props().setProperty('s_' + token, JSON.stringify({ u: user.username, exp: Date.now() + SESSION_DAYS * 86400000 }));
  return { token, user: publicUser(user) };
}

// Looks the user up on every call, so role changes and removals apply at once.
function auth(token) {
  const raw = token && props().getProperty('s_' + token);
  const s = raw && JSON.parse(raw);
  const user = s && s.exp > Date.now() && loadUsers().find((u) => u.username === s.u);
  if (!user) throw new Error('Not logged in');
  return user;
}

function requireRole(user, roles) {
  if (roles.indexOf(user.role) < 0) throw new Error('Not allowed for your account');
}

function changePassword(user, req) {
  const users = loadUsers();
  const me = users.find((u) => u.username === user.username);
  if (me.hash !== hash(String(req.oldPassword || ''), me.salt)) throw new Error('Current password is wrong.');
  checkPassword(req.newPassword);
  me.salt = Utilities.getUuid();
  me.hash = hash(req.newPassword, me.salt);
  saveUsers(users);
  return { ok: true };
}

function saveUser(input) {
  const users = loadUsers();
  const username = clean(input && input.username);
  const existing = users.find((u) => u.username === username);
  if (ROLES.indexOf(input.role) < 0) throw new Error('Pick a role.');
  if (existing) {
    if (existing.role === 'admin' && input.role !== 'admin' && users.filter((u) => u.role === 'admin').length === 1) {
      throw new Error('Keep at least one admin.');
    }
    existing.role = input.role;
    existing.driverName = input.role === 'driver' ? String(input.driverName || '') : '';
    if (input.password) {
      checkPassword(input.password);
      existing.salt = Utilities.getUuid();
      existing.hash = hash(input.password, existing.salt);
    }
  } else {
    users.push(newUser(input));
  }
  saveUsers(users);
  return { users: users.map(publicUser) };
}

function deleteUser(me, username) {
  const users = loadUsers();
  if (clean(username) === me.username) throw new Error("You can't remove your own account.");
  const left = users.filter((u) => u.username !== clean(username));
  saveUsers(left);
  return { users: left.map(publicUser) };
}

function newUser(input) {
  const username = clean(input.username);
  if (!/^[a-z0-9._-]{2,30}$/.test(username)) throw new Error('Username: 2–30 letters, numbers, dots or dashes.');
  if (loadUsers().some((u) => u.username === username)) throw new Error('That username is taken.');
  checkPassword(input.password);
  const salt = Utilities.getUuid();
  return {
    username,
    role: input.role,
    driverName: input.role === 'driver' ? String(input.driverName || '') : '',
    salt,
    hash: hash(input.password, salt),
  };
}

function checkPassword(p) {
  if (!p || String(p).length < 6) throw new Error('Passwords need at least 6 characters.');
}

function clean(name) {
  return String(name || '').trim().toLowerCase();
}

function publicUser(u) {
  return { username: u.username, role: u.role, driverName: u.driverName || '' };
}

function hash(password, salt) {
  let h = salt + ':' + password;
  for (let i = 0; i < 200; i++) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8);
    h = bytes.map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
  }
  return h;
}

function cleanSessions() {
  const p = props();
  const now = Date.now();
  p.getKeys()
    .filter((k) => k.indexOf('s_') === 0)
    .forEach((k) => {
      const s = JSON.parse(p.getProperty(k) || '{}');
      if (!(s.exp > now)) p.deleteProperty(k);
    });
}

// ---------- Shared data ----------

function pullFor(user) {
  const data = load() || {};
  if (user.role !== 'driver') return data;
  // Drivers get only their own routes (last 3 days that have one) and their done ticks.
  const name = user.driverName;
  const routes = {};
  const done = {};
  Object.keys(data.routes || {})
    .filter((d) => data.routes[d].drivers && data.routes[d].drivers[name])
    .sort()
    .slice(-3)
    .forEach((d) => {
      routes[d] = { updated: data.routes[d].updated, drivers: { [name]: data.routes[d].drivers[name] } };
      done[d] = { [name]: ((data.done || {})[d] || {})[name] || {} };
    });
  return { routes, done };
}

function push(user, incoming) {
  if (!incoming || typeof incoming !== 'object') throw new Error('Nothing to save');
  const cur = load() || {};
  const next = Object.assign({}, incoming);
  next.done = cur.done || {}; // only drivers change these, through markDone
  next.qb = cur.qb; // only the QuickBooks helper changes this, through qbPush
  if (user.role !== 'admin') {
    const settings = Object.assign({}, cur.settings);
    SECRETARY_SETTINGS.forEach((k) => {
      if (incoming.settings && k in incoming.settings) settings[k] = incoming.settings[k];
    });
    next.settings = settings;
  }
  save(next);
  return { ok: true };
}

function markDone(user, req) {
  const data = load() || {};
  const route = data.routes && data.routes[req.date] && data.routes[req.date].drivers && data.routes[req.date].drivers[user.driverName];
  if (!route) throw new Error('No route for you on that day.');
  data.done = data.done || {};
  const day = (data.done[req.date] = data.done[req.date] || {});
  const mine = (day[user.driverName] = day[user.driverName] || {});
  if (req.done) mine[req.stopId] = Date.now();
  else delete mine[req.stopId];
  save(data);
  return { done: mine };
}

// ---------- QuickBooks Desktop link ----------

// A new key for the QuickBooks helper; the old one stops working. Only a hash is kept.
function qbKey() {
  const key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const salt = Utilities.getUuid();
  props().setProperty('qb_key', JSON.stringify({ salt: salt, hash: hash(key, salt), created: Date.now() }));
  return { key: key };
}

// The helper sends every invoice dated from..to (at most two weeks). Each of those days is
// replaced as a whole, so deleted invoices drop off. Shape kept in data.qb:
//   { lastSeen, days: { "2026-10-21": [{ id, ref, cid, cname, address, voided }] } }
function qbPush(req) {
  const saved = JSON.parse(props().getProperty('qb_key') || 'null');
  limitTries('f_qbkey', () => !!saved && saved.hash === hash(String(req.key || ''), saved.salt), 'Wrong QuickBooks key. Create a new one in the planner\'s Settings.');
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d));
  if (!isDate(req.from) || !isDate(req.to) || req.to < req.from) throw new Error('Bad dates');
  const dates = [];
  for (let d = new Date(req.from + 'T12:00:00Z'); dates.length < 15; d.setUTCDate(d.getUTCDate() + 1)) {
    const text = d.toISOString().slice(0, 10);
    if (text > req.to) break;
    dates.push(text);
  }
  const text = (v, max) => String(v == null ? '' : v).slice(0, max);
  const data = load() || {};
  const qb = (data.qb = data.qb || { days: {} });
  dates.forEach((d) => (qb.days[d] = []));
  (Array.isArray(req.invoices) ? req.invoices : []).slice(0, 3000).forEach((inv) => {
    if (!qb.days[inv.date]) return;
    qb.days[inv.date].push({
      id: text(inv.id, 60),
      ref: text(inv.ref, 30),
      cid: text(inv.cid, 60),
      cname: text(inv.cname, 200),
      address: text(inv.address, 300),
      voided: !!inv.voided,
    });
  });
  // keep the last 14 days
  Object.keys(qb.days).sort().slice(0, -14).forEach((d) => delete qb.days[d]);
  qb.lastSeen = Date.now();
  save(data);
  return { ok: true, days: dates.length };
}

// ---------- MyGeotab (JSON-RPC API, https://developers.geotab.com) ----------

function geotabSave(req) {
  if (req.clear) {
    ['g_login', 'g_session'].forEach((k) => props().deleteProperty(k));
    return { connected: false };
  }
  const where = geotabAddress(req.server);
  const login = {
    server: where.host,
    // Someone may paste the whole MyGeotab address into the database box too.
    database: (/geotab\./i.test(req.database || '') ? geotabAddress(req.database).database : String(req.database || '').trim()) || where.database,
    userName: String(req.userName || '').trim(),
    password: String(req.password || ''),
  };
  if (!login.database || !login.userName || !login.password) throw new Error('Fill in database, username and password.');
  geotabAuthenticate(login); // throws if wrong
  props().setProperty('g_login', JSON.stringify(login));
  return geotabStatus();
}

// Accepts "my.geotab.com", "my123.geotab.com" or a whole MyGeotab address pasted from the
// browser (https://my.geotab.com/dua_produce/#map…). Anything that isn't a MyGeotab server
// (geotab.com, www.geotab.com, mygeotab.com…) becomes my.geotab.com, which works for every account.
function geotabAddress(input) {
  const text = String(input || '').trim().toLowerCase().replace(/^https?:\/\//, '');
  const host = text.split(/[/?#]/)[0];
  const database = (text.split('#')[0].split('/')[1] || '').trim();
  const ok = /^my[0-9]*\.geotab\.[a-z.]+$/.test(host);
  return { host: ok ? host : 'my.geotab.com', database: database };
}

function geotabStatus() {
  const raw = props().getProperty('g_login');
  if (!raw) return { connected: false };
  const login = JSON.parse(raw);
  return { connected: true, database: login.database, userName: login.userName, server: login.server };
}

function geotabRpc(server, method, params) {
  const url = 'https://' + server + '/apiv1';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ method: method, params: params }),
    muteHttpExceptions: true,
  });
  let body;
  try {
    body = JSON.parse(res.getContentText());
  } catch (err) {
    throw new Error('Geotab did not answer at ' + url + ' (HTTP ' + res.getResponseCode() + ').');
  }
  if (body.error) {
    const inner = (body.error.errors && body.error.errors[0]) || body.error.data || {};
    const e = new Error('Geotab: ' + (inner.message || body.error.message || 'error'));
    e.geotabName = inner.name || body.error.name || '';
    throw e;
  }
  return body.result;
}

function geotabAuthenticate(login) {
  let result;
  try {
    result = geotabRpc(login.server, 'Authenticate', { database: login.database, userName: login.userName, password: login.password });
  } catch (err) {
    if (/InvalidUser/.test(err.geotabName || '') || /incorrect|invalid/i.test(err.message)) {
      throw new Error('Geotab rejected the login. Check database, username and password.');
    }
    throw err;
  }
  const session = { credentials: result.credentials, server: result.path && result.path !== 'ThisServer' ? result.path : login.server };
  props().setProperty('g_session', JSON.stringify(session));
  return session;
}

// Calls Geotab with the saved session, logging in again once if the session has expired.
function geotab(method, params) {
  const raw = props().getProperty('g_login');
  if (!raw) throw new Error('Geotab is not connected yet (Settings → Truck tracking).');
  const login = JSON.parse(raw);
  let session = JSON.parse(props().getProperty('g_session') || 'null') || geotabAuthenticate(login);
  try {
    return geotabRpc(session.server, method, Object.assign({}, params, { credentials: session.credentials }));
  } catch (err) {
    if (!/InvalidUser/.test(err.geotabName || '')) throw err;
    session = geotabAuthenticate(login);
    return geotabRpc(session.server, method, Object.assign({}, params, { credentials: session.credentials }));
  }
}

function geotabDevices() {
  const devices = geotab('Get', { typeName: 'Device', search: { fromDate: new Date().toISOString() } }) || [];
  return devices
    .map((d) => ({ id: d.id, name: d.name || d.id, plate: d.licensePlate || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function geotabLive() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('g_live');
  if (hit) return JSON.parse(hit);
  const rows = geotab('Get', { typeName: 'DeviceStatusInfo' }) || [];
  const trucks = rows.map((r) => ({
    id: r.device && r.device.id,
    lat: r.latitude,
    lng: r.longitude,
    speed: r.speed || 0,
    bearing: r.bearing || 0,
    driving: !!r.isDriving,
    communicating: r.isDeviceCommunicating !== false,
    stateFor: r.currentStateDuration || '',
    at: r.dateTime,
  }));
  cache.put('g_live', JSON.stringify(trucks), 30);
  return trucks;
}

// Trips (with stops between them) for each truck between `from` and `to`, plus a thinned
// GPS trail unless trail: false (used for a whole week of payroll, where only trips matter).
function geotabDay(req) {
  const ids = (req.deviceIds || []).slice(0, 30);
  if (!ids.length) return { trucks: {} };
  const withTrail = req.trail !== false;
  const per = withTrail ? 2 : 1;
  const calls = [];
  ids.forEach((id) => {
    const search = { deviceSearch: { id: id }, fromDate: req.from, toDate: req.to };
    calls.push({ method: 'Get', params: { typeName: 'Trip', search: Object.assign({ includeOverlappedTrips: true }, search) } });
    if (withTrail) calls.push({ method: 'Get', params: { typeName: 'LogRecord', search: search, resultsLimit: 20000 } });
  });
  const results = geotab('ExecuteMultiCall', { calls: calls });
  const trucks = {};
  ids.forEach((id, i) => {
    const trips = (results[i * per] || []).map((t) => ({
      start: t.start,
      stop: t.stop,
      nextStart: t.nextTripStart || null,
      driving: t.drivingDuration || '',
      idling: t.idlingDuration || '',
      stopFor: t.stopDuration || '',
      km: t.distance || 0,
      lat: t.stopPoint ? t.stopPoint.y : null,
      lng: t.stopPoint ? t.stopPoint.x : null,
    }));
    const logs = withTrail ? results[i * 2 + 1] || [] : [];
    const step = Math.max(1, Math.ceil(logs.length / 800));
    const trail = logs.filter((_, k) => k % step === 0).map((l) => [l.latitude, l.longitude]);
    trucks[id] = { trips: trips, trail: trail };
  });
  return { trucks: trucks };
}

// ---------- Storage ----------

function props() {
  return PropertiesService.getScriptProperties();
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function sheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// Cells hold at most 50,000 characters, so JSON is split across rows.
// Each piece starts with "x" so Sheets never treats it as a number or formula.
function readJson(name) {
  const sh = sheet(name);
  const rows = sh.getLastRow();
  if (!rows) return null;
  const text = sh.getRange(1, 1, rows, 1).getValues().map((r) => String(r[0]).slice(1)).join('');
  return text ? JSON.parse(text) : null;
}

function writeJson(name, value) {
  const text = JSON.stringify(value);
  const pieces = [];
  for (let i = 0; i < text.length; i += 45000) pieces.push(['x' + text.slice(i, i + 45000)]);
  const sh = sheet(name);
  sh.clearContents();
  if (pieces.length) sh.getRange(1, 1, pieces.length, 1).setValues(pieces);
}

function load() {
  return readJson('data');
}
function save(data) {
  writeJson('data', data);
}
function loadUsers() {
  return readJson('users') || [];
}
function saveUsers(users) {
  writeJson('users', users);
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
