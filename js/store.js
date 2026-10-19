// Everything is saved in this browser's localStorage. Nothing is sent to GitHub.
// If a shared Google Sheet is set up (Settings → Sync), sync.js copies the shared
// parts (clients, settings, route history, drive times) to and from it.
import { localDate } from './util.js';

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
    alert('Could not save to this browser: ' + err.message);
  }
}

// Tells sync.js that shared data changed on this computer.
function changed() {
  window.dispatchEvent(new Event('dua-change'));
}

export const DEFAULT_SETTINGS = {
  apiKey: '',
  depotName: 'Warehouse',
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
  trafficTime: '12:30',
  monthlyElementLimit: 4000,
  monthlyGeocodeLimit: 2000,
  driverCount: 3,
  drivers: ['Driver 1', 'Driver 2', 'Driver 3', 'Driver 4', 'Driver 5', 'Driver 6', 'Driver 7', 'Driver 8'],
  balance: 'low',
  syncUrl: '',
  syncKey: '',
};

// Settings that stay on this computer only (never synced or put in backups).
const LOCAL_ONLY = ['apiKey', 'syncUrl', 'syncKey'];

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

export function getDay(date) {
  return read('day.' + date, null);
}
export function saveDay(date, day) {
  write('day.' + date, day);
}

export function getLastPlan() {
  return read('lastPlan', null);
}
export function saveLastPlan(plan) {
  write('lastPlan', plan);
}

// Route history: { "2026-10-19": { updated, drivers: [{ name, stops, paid, ot, miles, finish, labor, fuel }], ... } }
export function getHistory() {
  return read('history', {});
}
export function saveHistoryDay(date, entry) {
  const h = getHistory();
  h[date] = { ...entry, updated: Date.now() };
  write('history', h);
  changed();
}
export function deleteHistoryDay(date) {
  const h = getHistory();
  delete h[date];
  write('history', h);
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
}
export function getSyncState() {
  return read('syncState', { last: null, error: '' });
}
export function setSyncState(s) {
  write('syncState', s);
}

// ----- Backup file (the API key and sync passcode are left out on purpose) -----

export function exportBackup() {
  return { app: 'dua-route-plan', version: 2, exported: new Date().toISOString(), ...exportSyncData() };
}
export function importBackup(data) {
  if (!data || data.app !== 'dua-route-plan') throw new Error('This is not a route planner backup file.');
  importSyncData({ ...exportSyncData(), ...data, settingsUpdated: Date.now() });
  changed();
}
