// Keeps this browser and the Google Sheet server in step.
// Office (admin/secretary): download the server copy, merge with this browser's, upload the result.
// Driver: download only their own routes.
import * as store from './store.js';
import * as api from './api.js';
import { mergeData, canonical } from './merge.js';

// Same list as SECRETARY_SETTINGS in apps-script/Code.gs.
const SECRETARY_SETTINGS = ['driverCount', 'drivers', 'balance'];

let hooks = { remoteChanged() {}, status() {}, loggedOut() {} };
let timer = null;
let running = false;
let again = false;
let started = false;

function role() {
  return api.getSession()?.user?.role;
}

export async function syncNow() {
  if (!role()) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  hooks.status('Syncing…');
  try {
    const { data: remote, user } = await api.call('pull');
    api.updateUser(user);
    if (user.role === 'driver') {
      const before = canonical({ r: store.getRoutes(), d: store.getDone() });
      store.importDriverData(remote);
      if (canonical({ r: store.getRoutes(), d: store.getDone() }) !== before) hooks.remoteChanged();
    } else {
      const local = store.exportSyncData();
      const merged = mergeData(local, remote);
      // A computer joining for the first time takes the shared settings, never the other way round.
      // A secretary always takes the shared settings, apart from the few on the Plan screen.
      if (remote?.settings && (!store.getSyncState().last || user.role !== 'admin')) {
        const own = user.role === 'admin' ? {} : Object.fromEntries(SECRETARY_SETTINGS.filter((k) => k in merged.settings).map((k) => [k, merged.settings[k]]));
        merged.settings = { ...remote.settings, ...(store.getSyncState().last ? own : {}) };
        merged.settingsUpdated = remote.settingsUpdated || 0;
      }
      const mergedText = canonical(merged);
      if (mergedText !== canonical(local)) {
        store.importSyncData(merged);
        hooks.remoteChanged();
      }
      if (!remote || mergedText !== canonical(remote)) await api.call('push', { data: merged });
    }
    store.setSyncState({ last: Date.now(), error: '' });
    hooks.status('');
  } catch (err) {
    if (err instanceof api.NotLoggedIn) {
      hooks.status('');
      hooks.loggedOut();
    } else {
      store.setSyncState({ ...store.getSyncState(), error: err.message || String(err) });
      hooks.status('Sync problem: ' + (err.message || err));
    }
  } finally {
    running = false;
    if (again) {
      again = false;
      schedule();
    }
  }
}

function schedule() {
  if (!role() || role() === 'driver') return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, 2000);
}

export function initSync(h) {
  hooks = { ...hooks, ...h };
  if (!started) {
    started = true;
    window.addEventListener('dua-change', schedule);
    window.addEventListener('focus', () => syncNow());
    setInterval(() => syncNow(), 2 * 60 * 1000);
  }
  return syncNow();
}
