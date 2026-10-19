// Optional sharing between computers/phones through a Google Sheet the owner controls.
// The sheet runs a tiny Google Apps Script (apps-script/Code.gs) that stores one JSON copy.
// Each sync: download the sheet's copy, merge with this computer's, save both.
import * as store from './store.js';
import { mergeData, canonical } from './merge.js';

let onRemoteChange = () => {};
let onStatus = () => {};
let timer = null;
let running = false;
let again = false;

function configured() {
  const s = store.getSettings();
  return s.syncUrl && s.syncKey ? s : null;
}

async function pull(s) {
  const res = await fetch(`${s.syncUrl}?key=${encodeURIComponent(s.syncKey)}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error);
  return body.data || null;
}

async function push(s, data) {
  // text/plain keeps this a "simple" request, which Apps Script accepts from browsers.
  const res = await fetch(s.syncUrl, { method: 'POST', body: JSON.stringify({ key: s.syncKey, data }) });
  const body = await res.json();
  if (body.error) throw new Error(body.error);
}

export async function syncNow() {
  const s = configured();
  if (!s) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  onStatus('Syncing…');
  try {
    const remote = await pull(s);
    const local = store.exportSyncData();
    const merged = mergeData(local, remote);
    // A computer joining for the first time takes the shared settings, never the other way round.
    if (!store.getSyncState().last && remote?.settings) {
      merged.settings = remote.settings;
      merged.settingsUpdated = remote.settingsUpdated || 0;
    }
    const mergedText = canonical(merged);
    if (mergedText !== canonical(local)) {
      store.importSyncData(merged);
      onRemoteChange();
    }
    if (!remote || mergedText !== canonical(remote)) await push(s, merged);
    store.setSyncState({ last: Date.now(), error: '' });
    onStatus('');
  } catch (err) {
    store.setSyncState({ ...store.getSyncState(), error: err.message || String(err) });
    onStatus('Sync problem: ' + (err.message || err));
  } finally {
    running = false;
    if (again) {
      again = false;
      schedule();
    }
  }
}

function schedule() {
  if (!configured()) return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, 3000);
}

export function initSync({ remoteChanged, status }) {
  onRemoteChange = remoteChanged;
  onStatus = status;
  window.addEventListener('dua-change', schedule);
  window.addEventListener('focus', () => configured() && syncNow());
  setInterval(() => configured() && syncNow(), 5 * 60 * 1000);
  syncNow();
}
