// Talks to the Google Sheet server (apps-script/Code.gs). Every call is a POST with a
// text/plain body, which Apps Script accepts from browsers without extra permission checks.
import { SERVER_URL } from './config.js';
import { t } from './i18n.js';

const SERVER_KEY = 'dua.server';
const SESSION_KEY = 'dua.session';

export class NotLoggedIn extends Error {}

export function getServerUrl() {
  try {
    return localStorage.getItem(SERVER_KEY) || SERVER_URL;
  } catch {
    return SERVER_URL;
  }
}

export function setServerUrl(url) {
  localStorage.setItem(SERVER_KEY, url.trim());
}

export function getSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

function setSession(s) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export async function call(action, payload = {}) {
  const url = getServerUrl();
  if (!url) throw new Error(t('Enter the server address first.'));
  const token = getSession()?.token;
  let res;
  try {
    res = await fetch(url, { method: 'POST', body: JSON.stringify({ action, token, ...payload }) });
  } catch {
    throw new Error(t('Could not reach the server. Check the internet connection.'));
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(t('The server address does not look right (no answer from the route planner script).'));
  }
  if (body.error === 'Not logged in') throw new NotLoggedIn(body.error);
  if (body.error) throw new Error(t(body.error));
  return body;
}

export async function login(username, password) {
  const r = await call('login', { username, password });
  setSession({ token: r.token, user: r.user });
  return r.user;
}

export async function setupAdmin(setupCode, username, password) {
  const r = await call('setup', { setupCode, username, password });
  setSession({ token: r.token, user: r.user });
  return r.user;
}

export async function recoverAdmin(setupCode, username, password) {
  const r = await call('recoverAdmin', { setupCode, username, password });
  setSession({ token: r.token, user: r.user });
  return r.user;
}

export function updateUser(user) {
  const s = getSession();
  if (s) setSession({ ...s, user });
}

// Forgets the session and everything this browser saved, except the server address and language.
const KEEP_ON_LOGOUT = [SERVER_KEY, 'dua.lang'];

export async function logout() {
  try {
    await call('logout');
  } catch {}
  for (const k of Object.keys(localStorage)) if (k.startsWith('dua.') && !KEEP_ON_LOGOUT.includes(k)) localStorage.removeItem(k);
}
