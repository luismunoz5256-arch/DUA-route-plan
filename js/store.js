// Everything is saved in this browser's localStorage and, through sync.js, in the
// Google Sheet server (clients, settings, history, drive times, picked stops, plans, published routes).
// Nothing is sent to GitHub.
import { localDate } from './util.js';
import { t } from './i18n.js';

const PREFIX = 'dua.';

function read(key, fallback) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (err) {
    alert(t('Could not save to this browser:') + ' ' + err.message);
  }
}

// Tells sync.js that shared data changed on this computer.
function changed() {
  window.dispatchEvent(new Event('dua-change'));
}

export const DEFAULT_SETTINGS = {
  apiKey: '',
  depotName: '', // empty = "Warehouse" in the chosen language
  depotAddress: '840 N Hawkins Blvd, El Paso, TX 79915',
  depotLat: null,
  depotLng: null,
  shiftStart: '08:00',
  start: '11:30',
  latestReturn: '17:00',
  regularHoursPerDay: 8,
  regularHoursPerWeek: 40,
  payRate: 14,
  fuelPerMile: 0.3,
  defaultUnload: 10,
  priorityBy: '13:00',
  orderCutoff: '10:00', // orders after this time are late; then the driving order is set
  keepWithDriver: 10, // $: a client stays with their usual driver unless moving them saves more
  // Learning period (dates as YYYY-MM-DD): until learnUntil, routes ignore usual drivers, and usual
  // drivers are learned only from routes since learnFrom. Starts with two weeks from Oct 21, 2026.
  learnFrom: '2026-10-21',
  learnUntil: '2026-10-31',
  trafficTime: '12:30',
  monthlyElementLimit: 4000,
  monthlyGeocodeLimit: 2000,
  driverCount: 3,
  drivers: ['Driver 1', 'Driver 2', 'Driver 3', 'Driver 4', 'Driver 5', 'Driver 6', 'Driver 7', 'Driver 8'],
  balance: 'low',
  trucks: {}, // driver name -> Geotab device id
  geotabRadius: 200,
};

// Settings that stay on this computer only (never synced or put in backups).
const LOCAL_ONLY = [];

function sharedPart(s) {
  const out = { ...s };
  for (const k of LOCAL_ONLY) delete out[k];
  return out;
}

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read('settings', {}) };
}
export function saveSettings(s) {
  const before = JSON.stringify(sharedPart(getSettings()));
  write('settings', s);
  if (JSON.stringify(sharedPart(s)) !== before) {
    write('settingsUpdated', Date.now());
    changed();
  }
}

export function getClients() {
  return read('clients', []);
}
// Stamps `updated` on clients that changed and remembers deletions.
export function saveClients(list) {
  const strip = ({ updated, ...rest }) => JSON.stringify(rest);
  const prev = new Map(getClients().map((c) => [c.id, strip(c)]));
  const now = Date.now();
  let any = prev.size !== list.length;
  for (const c of list) {
    if (prev.get(c.id) !== strip(c)) {
      c.updated = now;
      any = true;
    }
  }
  const ids = new Set(list.map((c) => c.id));
  const deleted = read('deletedClients', {});
  for (const id of prev.keys()) if (!ids.has(id)) deleted[id] = now;
  write('deletedClients', deleted);
  write('clients', list);
  if (any) changed();
}

// Drive-time cache: { "lat,lng|lat,lng": [minutes, meters] }
export function getMatrixCache() {
  return read('matrix', {});
}
export function saveMatrixCache(m) {
  write('matrix', m);
  changed();
}

// Keeps only the newest `n` dates of a { date: ... } object.
function keepLast(all, n) {
  for (const d of Object.keys(all).sort().slice(0, -n)) delete all[d];
  return all;
}

// Stops picked for each day (shared, so every office computer sees the same orders):
// { "2026-10-21": { updated, selected: { clientId: { priority, by, note } }, shiftStart, start, latestReturn, weekHours } }
export function getDays() {
  return read('days', {});
}
export function getDay(date) {
  return getDays()[date] || read('day.' + date, null); // day.<date> = saved by an older version
}
export function saveDay(date, day) {
  write('days', keepLast({ ...getDays(), [date]: { ...day, updated: Date.now() } }, 14));
  changed();
}

// Built plans (shared, so an order typed on any office computer goes onto the routes):
// { "2026-10-21": plan } — see buildRoutes in app.js for the shape.
export function getPlans() {
  const plans = read('plans', {});
  const old = read('lastPlan', null); // saved by an older version
  if (old?.problem && !plans[old.date]) plans[old.date] = old;
  return plans;
}
// A day whose stops were all taken off keeps { date, deleted: true }, so the deletion syncs too.
export function getPlan(date) {
  const plan = getPlans()[date];
  return plan && !plan.deleted ? plan : null;
}
export function savePlan(plan) {
  plan.updated = Date.now();
  write('plans', keepLast({ ...getPlans(), [plan.date]: plan }, 5));
  localStorage.removeItem(PREFIX + 'lastPlan');
  changed();
}

// Route history: { "2026-10-19": { updated, shiftStart, stops, miles, drivers: [{ name, stops, paid, back, miles, source }] } }
// source: 'truck' (Geotab) or 'manual' (typed in) when `back` is a real return time; missing = planned.
export function getHistory() {
  return read('history', {});
}
export function saveHistoryDay(date, entry) {
  const h = getHistory();
  h[date] = { ...entry, updated: Date.now() };
  saveHistory(h);
}
// Saves a History object changed in place (each changed day carries its own `updated`).
export function saveHistory(h) {
  write('history', h);
  changed();
}
export function deleteHistoryDay(date) {
  const h = getHistory();
  delete h[date];
  saveHistory(h);
}

// Routes sent to drivers: { "2026-10-21": { updated, drivers: { "Ana": route } } }
// (route = the same packed shape as the driver phone page, see share.js)
export function getRoutes() {
  return read('routes', {});
}
export function saveRoutesDay(date, drivers) {
  const all = getRoutes();
  all[date] = { updated: Date.now(), drivers };
  // keep the last 30 days
  for (const d of Object.keys(all).sort().slice(0, -30)) delete all[d];
  write('routes', all);
  changed();
}

// QuickBooks invoices sent by the office PC helper (the server's copy; read-only here):
// { lastSeen, days: { "2026-10-21": [{ id, ref, cid, cname, address, voided }] } }
export function getQb() {
  return read('qb', null);
}
export function saveQb(qb) {
  write('qb', qb);
}

// Stops ticked done by drivers: { date: { driverName: { stopId: time } } } (set by the server)
export function getDone() {
  return read('done', {});
}
export function saveDone(done) {
  write('done', done);
}

function monthKey() {
  return localDate().slice(0, 7);
}
export function getUsage() {
  return { elements: 0, geocodes: 0, ...(read('usage', {})[monthKey()] || {}) };
}
export function addUsage(kind, n) {
  const all = read('usage', {});
  const m = { elements: 0, geocodes: 0, ...(all[monthKey()] || {}) };
  m[kind] += n;
  all[monthKey()] = m;
  write('usage', all);
}

// ----- Sync -----

export function exportSyncData() {
  return {
    clients: getClients(),
    deletedClients: read('deletedClients', {}),
    history: getHistory(),
    matrix: getMatrixCache(),
    settings: sharedPart(getSettings()),
    settingsUpdated: read('settingsUpdated', 0),
    routes: getRoutes(),
    done: getDone(),
    days: getDays(),
    plans: getPlans(),
  };
}
// Writes merged data without announcing a change (that would start another sync).
export function importSyncData(data) {
  const local = {};
  for (const k of LOCAL_ONLY) local[k] = getSettings()[k];
  write('settings', { ...DEFAULT_SETTINGS, ...(data.settings || {}), ...local });
  write('settingsUpdated', data.settingsUpdated || 0);
  write('clients', data.clients || []);
  write('deletedClients', data.deletedClients || {});
  write('history', data.history || {});
  write('matrix', data.matrix || {});
  write('routes', data.routes || {});
  write('done', data.done || {});
  write('days', data.days || {});
  write('plans', data.plans || {});
}

// Drivers only receive their own routes.
export function importDriverData(data) {
  write('routes', data.routes || {});
  write('done', data.done || {});
}
export function getSyncState() {
  return read('syncState', { last: null, error: '' });
}
export function setSyncState(s) {
  write('syncState', s);
}

// ----- Backup file (the Google API key is left out on purpose) -----

export function exportBackup() {
  const data = exportSyncData();
  const { apiKey, ...settings } = data.settings;
  return { app: 'dua-route-plan', version: 3, exported: new Date().toISOString(), ...data, settings };
}
export function importBackup(data) {
  if (!data || data.app !== 'dua-route-plan') throw new Error(t('This is not a route planner backup file.'));
  const cur = exportSyncData();
  importSyncData({ ...cur, ...data, settings: { ...data.settings, apiKey: cur.settings.apiKey }, settingsUpdated: Date.now() });
  changed();
}
