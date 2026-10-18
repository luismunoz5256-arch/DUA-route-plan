// Everything is saved in this browser's localStorage. Nothing is sent to GitHub.
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

export const DEFAULT_SETTINGS = {
  apiKey: '',
  depotName: 'Warehouse',
  depotAddress: '840 N Hawkins Blvd, El Paso, TX 79915',
  depotLat: null,
  depotLng: null,
  start: '11:30',
  endBy: '16:00',
  payRate: 14,
  defaultUnload: 10,
  priorityBy: '13:00',
  trafficTime: '12:30',
  monthlyElementLimit: 4000,
  monthlyGeocodeLimit: 2000,
  driverCount: 3,
  drivers: ['Driver 1', 'Driver 2', 'Driver 3', 'Driver 4', 'Driver 5', 'Driver 6', 'Driver 7', 'Driver 8'],
  balance: 'low',
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read('settings', {}) };
}
export function saveSettings(s) {
  write('settings', s);
}

export function getClients() {
  return read('clients', []);
}
export function saveClients(list) {
  write('clients', list);
}

// Drive-time cache: { "lat,lng|lat,lng": [minutes, meters] }
export function getMatrixCache() {
  return read('matrix', {});
}
export function saveMatrixCache(m) {
  write('matrix', m);
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

// Backup file (the API key is left out on purpose).
export function exportBackup() {
  const { apiKey, ...settings } = getSettings();
  return { app: 'dua-route-plan', version: 1, exported: new Date().toISOString(), settings, clients: getClients(), matrix: getMatrixCache() };
}
export function importBackup(data) {
  if (!data || data.app !== 'dua-route-plan') throw new Error('This is not a route planner backup file.');
  const apiKey = getSettings().apiKey;
  if (data.settings) saveSettings({ ...DEFAULT_SETTINGS, ...data.settings, apiKey });
  if (Array.isArray(data.clients)) saveClients(data.clients);
  if (data.matrix) saveMatrixCache({ ...getMatrixCache(), ...data.matrix });
}
