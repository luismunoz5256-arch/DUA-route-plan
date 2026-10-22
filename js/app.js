import * as store from './store.js';
import { geocode } from './google.js';
import { missingPlan, fillMissing, assemble, nextTrafficDeparture } from './matrix.js';
import { solve, summarize, insertStop, costOf } from './solver.js';
import { overtimeStart, laborCost, minutesBefore, weekSummary, recordReturn } from './pay.js';
import { encodeRoute } from './share.js';
import { initSync, syncNow } from './sync.js';
import { canonical } from './merge.js';
import * as api from './api.js';
import { renderRoute } from './routeview.js';
import { analyzeDay, parseDuration, minuteOfDay } from './tracking.js';
import { recordStays, learnedStop, MIN_VISITS } from './stays.js';
import { mapIn, pin, depotPin, fit } from './maps.js';
import { t, locale, dayNames, translatePage, langSwitch } from './i18n.js';
import {
  esc, toMin, fmtTime, fmtTimeInput, fmtDur, fmtMoney, fmtHours, localDate, weekdayOf, weekStart, addDays, uid,
  daysCode, parseDays, parseCsv, toCsv, download, pickFile,
} from './util.js';

const $ = (sel) => document.querySelector(sel);
const COLORS = ['#1f6fb4', '#c4302b', '#2a9a3d', '#8a4fbf', '#e07b12', '#138d9c', '#8c564b', '#d0459b'];
const BALANCE = { low: 0.15, medium: 0.6, high: 2 };
const MAX_DRIVERS = 8;
const DAYS = dayNames();
const ROLE_LABEL = { admin: t('Admin'), secretary: t('Secretary'), driver: t('Driver') };

let settings = store.getSettings();
let clients = store.getClients();
let planDate = localDate();
let day = null;
let plan = null;
let routeMap = null;

const num = (v, fallback) => (v === '' || v == null || Number.isNaN(Number(v)) ? fallback : Number(v));
const hasLoc = (c) => c.lat != null && c.lng != null && c.lat !== '' && c.lng !== '';
const isScheduled = (c, weekday) => c.active !== false && !!(c.days && c.days[weekday]);
const driverName = (i) => settings.drivers[i] || t('Driver {n}', { n: i + 1 });
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
const depotName = () => settings.depotName || t('Warehouse');
const depotPoint = () => (settings.depotLat == null ? null : { lat: Number(settings.depotLat), lng: Number(settings.depotLng) });
const plural = (n, one, many) => t(n === 1 ? one : many, { n });

// Learning period: until settings.learnUntil, routes are planned freely (no usual drivers), and
// usual drivers are learned only from routes sent since settings.learnFrom, when learning began.
const isLearning = (date = planDate) => !!settings.learnUntil && date <= settings.learnUntil;

// How often each driver took each client in routes sent from learnFrom up to (not including) `date`:
// { clientId: { driverName: times } }. Routes are kept for 30 days.
function driverCounts(date = planDate) {
  const counts = {};
  const merged = new Map(clients.flatMap((c) => (c.formerIds || []).map((old) => [old, c.id]))); // see mergeClient
  for (const [d, day] of Object.entries(store.getRoutes())) {
    if (d >= date || (settings.learnFrom && d < settings.learnFrom)) continue;
    // The planner's own best plan for that day when there is one, else the routes as sent.
    const byDriver = day.best || Object.fromEntries(Object.entries(day.drivers || {}).map(([name, route]) => [name, (route.stops || []).map((s) => s.id)]));
    for (const [name, ids] of Object.entries(byDriver)) {
      for (const raw of ids) {
        const id = merged.get(raw) || raw;
        if (id) (counts[id] ||= {})[name] = (counts[id][name] || 0) + 1;
      }
    }
  }
  return counts;
}

// The driver each client usually gets, learned from routes sent before `date`: whoever took them
// most, if at least twice and at least half the time.
function usualDrivers(date = planDate) {
  const counts = driverCounts(date);
  const out = new Map();
  for (const [id, c] of Object.entries(counts)) {
    const [name, n] = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    if (n >= 2 && n * 2 >= total) out.set(id, name);
  }
  return out;
}

// A client's usual driver: set by hand on the client, else learned from past routes.
// None while learning, so every stop goes wherever it's cheapest.
const homeOf = (c, learned, date = planDate) => (isLearning(date) ? '' : c.homeDriver || learned.get(c.id) || '');

// While learning, the optimizer's routes come out in any order, so the east side could be
// "route 1" one day and "route 3" the next. Give each route to the driver who took most of
// its stops on earlier days, so each area keeps the same driver and there is something to learn.
// Kept only if it costs no more than $2 (drivers' overtime can start at different times).
function sameAreaSameDriver(orders, k) {
  const counts = driverCounts();
  const score = orders.map((o) => Array.from({ length: k }, (_, j) => o.reduce((sum, i) => sum + (counts[plan.stops[i - 1].id]?.[driverName(j)] || 0), 0)));
  let best = null;
  let bestScore = -1;
  const permute = (r, used, perm, total) => {
    if (r === k) {
      if (total > bestScore) [best, bestScore] = [perm.slice(), total];
      return;
    }
    for (let j = 0; j < k; j++) {
      if (used & (1 << j)) continue;
      perm[r] = j;
      permute(r + 1, used | (1 << j), perm, total + score[r][j]);
    }
  };
  permute(0, 0, [], 0);
  if (!bestScore) return orders;
  const relabeled = Array.from({ length: k }, () => []);
  best.forEach((j, r) => (relabeled[j] = orders[r]));
  const before = evaluate(plan, { k, orders }).total;
  return evaluate(plan, { k, orders: relabeled }).total <= before + 2 ? relabeled : orders;
}

// The planner's own best routes for k drivers with today's stops, ignoring drivers picked by hand
// and which truck stops are on now. Usual drivers are learned from these (see bestByDriver).
async function bestPlanOrders(k) {
  const learned = usualDrivers();
  const free = { ...plan, stops: plan.stops.map((s) => ({ ...s, driver: '', home: homeOf(clients.find((c) => c.id === s.id) || {}, learned) })) };
  const r = await runSolve(problemFor(free, k), { timeLimitMs: 2500, weights: { balance: BALANCE[settings.balance] ?? 0.15 } });
  const orders = r.routes.map((x) => x.order);
  return isLearning() ? sameAreaSameDriver(orders, k) : orders;
}

// { driverName: [client ids] } for a set of routes of the current plan.
function bestByDriver(orders) {
  return Object.fromEntries(orders.map((o, r) => [driverName(r), o.map((i) => plan.stops[i - 1].id)]).filter(([, ids]) => ids.length));
}

function fmtDateLong(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' });
}

function daysText(days) {
  if (!days || !days.some(Boolean)) return '—';
  if (days.every(Boolean)) return t('Every day');
  if (!days[0] && days.slice(1, 7).every(Boolean)) return `${DAYS[1]}–${DAYS[6]}`;
  if (!days[0] && !days[6] && days.slice(1, 6).every(Boolean)) return `${DAYS[1]}–${DAYS[5]}`;
  return DAYS.filter((_, i) => days[i]).join(' ');
}

function saveSettings() {
  store.saveSettings(settings);
  renderBanner();
}

function saveClients() {
  store.saveClients(clients);
  renderBanner();
}

// Runs an async action on a button: disables it, shows progress on it, puts the label back.
async function busy(btn, work) {
  const label = btn.textContent;
  btn.disabled = true;
  try {
    return await work((text) => (btn.textContent = text || label));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function errorText(err) {
  return `<span class="bad-text">${esc(err.message)}</span>`;
}

// ---------- Tabs & banner ----------

function role() {
  return api.getSession()?.user?.role || '';
}

function showTab(name) {
  if (role() === 'driver') name = 'driver';
  else if (['settings', 'users', 'trucks'].includes(name) && role() !== 'admin') name = 'plan';
  if (name !== 'trucks') clearTimeout(trucksTimer);
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== 'tab-' + name));
  const render = {
    plan: () => {
      renderStops();
      renderDriverRows();
      if (routeMap) setTimeout(() => routeMap.map.invalidateSize(), 0);
    },
    clients: renderClients,
    history: renderHistory,
    settings: renderSettings,
    users: renderUsers,
    driver: renderDriverView,
    trucks: renderTrucks,
  }[name];
  render?.();
}

function currentTab() {
  return document.querySelector('.tab.active')?.dataset.tab || 'plan';
}

function renderBanner() {
  const msgs = [];
  const admin = role() === 'admin';
  if (settings.depotLat == null) {
    msgs.push(admin ? t('Set the warehouse location in <a href="#" data-goto="settings">Settings</a> (click <b>Find</b> next to the address).') : t('The admin still needs to set the warehouse location in Settings.'));
  }
  if (!settings.apiKey) {
    msgs.push(admin ? t('No Google API key yet (Settings), so drive times will be rough estimates and addresses must be located by hand. Setup steps are in the README.') : t('No Google API key yet, so drive times are rough estimates. Ask the admin to add it in Settings.'));
  }
  if (!clients.length) msgs.push(t('Add your clients in the <a href="#" data-goto="clients">Clients</a> tab.'));
  const el = $('#setup-banner');
  el.hidden = !msgs.length;
  el.innerHTML = msgs.map((m) => `<div>${m}</div>`).join('');
}

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-goto]');
  if (go) {
    e.preventDefault();
    showTab(go.dataset.goto);
  }
  const tab = e.target.closest('.tab');
  if (tab) showTab(tab.dataset.tab);
});

// ---------- Google lookups (with monthly limits) ----------

async function locate(address) {
  if (!settings.apiKey) throw new Error(t('Add a Google API key in Settings first, or type the latitude/longitude by hand.'));
  if (store.getUsage().geocodes >= settings.monthlyGeocodeLimit) {
    throw new Error(t('Monthly address lookup limit reached ({n}). Change it in Settings if needed.', { n: settings.monthlyGeocodeLimit }));
  }
  store.addUsage('geocodes', 1);
  return geocode(settings.apiKey, address);
}

// Finds map locations for clients that have none. Stops early if the key or limit is the problem.
async function locateClients(list, progress) {
  const todo = list.filter((c) => !hasLoc(c));
  const failed = [];
  for (const [i, c] of todo.entries()) {
    progress?.(t('Finding {i} of {n}…', { i: i + 1, n: todo.length }));
    try {
      const g = await locate(c.address);
      c.lat = g.lat;
      c.lng = g.lng;
    } catch (err) {
      failed.push(`${c.name}: ${err.message}`);
      if (!settings.apiKey || store.getUsage().geocodes >= settings.monthlyGeocodeLimit) break;
    }
  }
  if (todo.length) saveClients();
  return { located: todo.length - failed.length, failed };
}

// Make sure traffic drive times exist for these points (looked up once, then saved).
async function ensureDriveTimes(points, status) {
  const cache = store.getMatrixCache();
  const need = missingPlan(points, cache);
  if (!need.elements || !settings.apiKey) return cache;
  const left = Math.max(0, settings.monthlyElementLimit - store.getUsage().elements);
  if (need.elements > left && !confirm(t('Getting traffic times for {places} new location(s) needs {need} lookups, but only {left} are left under your monthly limit of {limit}.\n\nOK = look them up anyway (may go past Google\'s free amount)\nCancel = use rough estimates for now', { places: need.newKeys.length, need: need.elements, left, limit: settings.monthlyElementLimit }))) {
    return cache;
  }
  try {
    await fillMissing(need, cache, settings.apiKey, nextTrafficDeparture(settings.trafficTime), {
      onStatus: (s) => status(t('Getting traffic times') + ' ' + s),
      onElements: (n) => store.addUsage('elements', n),
    });
  } catch (err) {
    alert(err.message + '\n\n' + t('Rough estimates will be used for the missing drive times.'));
  } finally {
    store.saveMatrixCache(cache);
  }
  return cache;
}

// ---------- App updates ----------

// A file's address with its version tag from the page's import map (see tools/stamp.mjs).
function versioned(path) {
  const map = JSON.parse(document.querySelector('script[type="importmap"]')?.textContent || '{}').imports || {};
  return new URL(map[path] || path, location.href);
}

// The office keeps the planner open all day: offer a reload when a newer version is online.
async function checkForUpdate() {
  const mine = document.querySelector('meta[name="build"]')?.content;
  if (!mine || document.hidden) return;
  try {
    const html = await (await fetch(location.pathname, { cache: 'no-store' })).text();
    const online = html.match(/<meta name="build" content="(\w+)"/)?.[1];
    $('#update-banner').hidden = !online || online === mine;
  } catch {}
}
setInterval(checkForUpdate, 10 * 60 * 1000);
document.addEventListener('visibilitychange', checkForUpdate);
$('#btn-update').addEventListener('click', () => location.reload());

// ---------- Solver (in a background worker when possible) ----------

let worker = null;
let seq = 0;
const pending = new Map();

function solveInWorker(problem, options) {
  if (!worker) {
    worker = new Worker(versioned('./js/solver-worker.js'), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, result, error } = e.data;
      const job = pending.get(id);
      pending.delete(id);
      if (error) job.reject(new Error(error));
      else job.resolve(result);
    };
    worker.onerror = (e) => {
      for (const job of pending.values()) job.reject(new Error(e.message || 'worker failed'));
      pending.clear();
      worker = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, problem, options });
  });
}

async function runSolve(problem, options) {
  try {
    return await solveInWorker(problem, options);
  } catch {
    await new Promise((r) => setTimeout(r, 0));
    return solve(problem, options);
  }
}

// ---------- Pay helpers ----------

function payRules() {
  return {
    shiftStart: toMin(day?.shiftStart || settings.shiftStart),
    regDayMin: num(settings.regularHoursPerDay, 8) * 60,
    regWeekMin: num(settings.regularHoursPerWeek, 40) * 60,
  };
}

// Paid minutes driver i already has this week (from History, unless typed in for this day).
function weekBefore(i, history) {
  const typed = day?.weekHours?.[i];
  if (typed != null && typed !== '') return Number(typed) * 60;
  return minutesBefore(history, planDate, driverName(i));
}

// Records real return times (from trucks or typed in) and saves History once.
function saveReturns(entries, source) {
  const history = store.getHistory();
  const shift = toMin(settings.shiftStart);
  let changed = 0;
  for (const [date, name, back] of entries) if (recordReturn(history, date, name, back, source, shift)) changed++;
  if (changed) store.saveHistory(history);
  return changed;
}

// Solver problem for one driver count, built from the saved plan.
// Each stop prefers its usual driver; giving it to someone else costs the "keep with usual driver" amount.
function problemFor(p, k) {
  const perMinute = p.payRate / 60;
  const index = (name) => {
    const i = settings.drivers.indexOf(name);
    return i >= 0 && i < k ? i : null;
  };
  return {
    ...p.problem,
    shiftStart: p.shiftStart,
    start: p.start,
    endBy: p.endBy,
    otAt: p.otAt.slice(0, k),
    fuelPerMile: p.payRate ? p.fuelPerMile / perMinute : 0,
    vehicles: k,
    home: [null, ...p.stops.map((s) => (s.home ? index(s.home) : null))],
    away: perMinute ? num(settings.keepWithDriver, 10) / perMinute : 0,
    // Stops given to a driver by hand never go to another truck.
    lock: [null, ...p.stops.map((s) => (s.driver ? index(s.driver) : null))],
  };
}

// Route index of every stop in a set of routes (index 0, the warehouse, has none).
function routeIndex(orders) {
  const where = [null];
  orders.forEach((o, r) => o.forEach((i) => (where[i] = r)));
  return where;
}

// Client id -> driver name in the plan's current option.
function assignedDrivers(p) {
  const out = new Map();
  if (p) viewOption(p).orders.forEach((o, r) => o.forEach((i) => out.set(p.stops[i - 1].id, driverName(r))));
  return out;
}

// Times, pay and fuel for one option (driver count) of the plan.
function evaluate(p, opt) {
  const s = summarize(opt.orders, problemFor(p, opt.k));
  const routes = s.routes.map((r) => ({
    ...r,
    labor: r.order.length ? laborCost(r.paid, r.ot, p.payRate) : 0,
    fuel: r.miles * p.fuelPerMile,
  }));
  const labor = routes.reduce((a, r) => a + r.labor, 0);
  const fuel = routes.reduce((a, r) => a + r.fuel, 0);
  return { ...s, routes, labor, fuel, total: labor + fuel, empty: routes.some((r) => !r.order.length) };
}

// The cheapest option where nobody is late or past the latest return (else simply the cheapest).
function bestOf(evaluated) {
  const ok = evaluated.filter(({ ev }) => !ev.lateStops.length && ev.pastEndMinutes < 0.5 && !ev.empty);
  const pool = ok.length ? ok : evaluated;
  return pool.reduce((a, b) => (b.ev.total < a.ev.total - 0.005 ? b : a)).o;
}

function evaluateAll(p) {
  return p.options.map((o) => ({ o, ev: evaluate(p, o) }));
}

// ---------- Plan tab ----------

const newSelection = () => ({ priority: false, by: settings.priorityBy, note: '' });

// Minutes at a client's stop: what the trucks really take there (see stays.js), else the unload time.
function unloadOf(c) {
  const learned = settings.learnStops !== false && learnedStop(c);
  return learned ? learned.minutes : num(c.unload, settings.defaultUnload);
}
const unloadText = (c) => {
  const learned = settings.learnStops !== false && learnedStop(c);
  return learned ? `<span title="${esc(t('Real stop time from the trucks ({n} visits)', { n: learned.visits }))}">${learned.minutes} min 🚚</span>` : `${num(c.unload, settings.defaultUnload)} min`;
};

// The driver who must take this stop: chosen for the day in the stop list, else the client's
// usual driver when the client is set to "Always this driver". '' = the planner decides.
const assignedDriver = (c, sel) => sel?.driver || (c.fixedDriver ? c.homeDriver : '') || '';

function newDay(date) {
  const weekday = weekdayOf(date);
  const selected = {};
  for (const c of clients) if (isScheduled(c, weekday)) selected[c.id] = newSelection();
  return { selected, shiftStart: settings.shiftStart, start: settings.start, latestReturn: settings.latestReturn, weekHours: {} };
}

function loadDay(date) {
  planDate = date;
  day = store.getDay(date) || newDay(date);
  day.weekHours ||= {};
  plan = store.getPlan(date);
  suggestion = null;
  // Stops checked or unchecked (e.g. by QuickBooks) while another day was open.
  if (plan) {
    const inPlan = new Set(plan.stops.map((s) => s.id));
    for (const id of Object.keys(day.selected)) if (!inPlan.has(id) && clients.some((c) => c.id === id)) addToPlan(id);
    for (const id of inPlan) if (!day.selected[id]) removeFromPlan(id);
  }
  $('#plan-shift').value = day.shiftStart || settings.shiftStart;
  $('#plan-start').value = day.start || settings.start;
  $('#plan-end').value = day.latestReturn || settings.latestReturn;
  renderStops();
  renderDriverRows();
}

function saveDay() {
  store.saveDay(planDate, day);
}

function renderPlanControls() {
  $('#plan-date').value = planDate;
  $('#plan-drivers').innerHTML = Array.from({ length: MAX_DRIVERS }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
  $('#plan-drivers').value = settings.driverCount;
  $('#plan-balance').value = settings.balance;
}

// Column name shown beside a table cell when phones stack table rows into cards (see style.css).
const label = (text) => ` data-label="${esc(t(text))}"`;

// One row per driver: name, hours already this week, when overtime starts today.
function renderDriverRows() {
  if (!day) return;
  const rules = payRules();
  const history = store.getHistory();
  const k = Math.min(MAX_DRIVERS, settings.driverCount + 1);
  $('#driver-rows').innerHTML = Array.from({ length: k }, (_, i) => {
    const before = weekBefore(i, history);
    const typed = day.weekHours[i];
    const extra = i >= settings.driverCount ? ` <span class="muted small">${t('(only if one more driver)')}</span>` : '';
    return `<tr>
      <td${label('Driver')}><input data-driver="${i}" value="${esc(driverName(i))}" />${extra}</td>
      <td${label('Hours this week')}><input class="hours" type="number" step="0.25" min="0" data-hours="${i}" value="${typed != null && typed !== '' ? esc(typed) : fmtHours(before)}" /> h</td>
      <td class="small"${label('Overtime starts')}>${fmtTime(overtimeStart({ ...rules, weekBeforeMin: before }))}</td>
    </tr>`;
  }).join('');
}

function renderStops() {
  if (!day) return;
  const weekday = weekdayOf(planDate);
  const q = $('#stop-search').value.trim().toLowerCase();
  const list = clients
    .filter((c) => c.active !== false)
    .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.address || '').toLowerCase().includes(q))
    .sort((a, b) => isScheduled(b, weekday) - isScheduled(a, weekday) || byName(a, b));
  $('#no-clients').hidden = clients.length > 0;
  const learned = usualDrivers();
  const assigned = assignedDrivers(plan);
  // On a route: that driver, in the route's colour. Otherwise: who usually takes them.
  const driverTag = (c) => {
    const on = assigned.get(c.id);
    if (on) return ` <span class="tag on-route" style="--route:${COLORS[settings.drivers.indexOf(on) % COLORS.length]}">🚚 ${esc(on)}</span>`;
    const home = homeOf(c, learned);
    return home ? ` <span class="tag">${t('usually {name}', { name: esc(home) })}</span>` : '';
  };
  $('#learn-note').hidden = !isLearning();
  if (isLearning()) $('#learn-note').textContent = '🎓 ' + t("Learning usual drivers until {date}: it learns from the planner's own best plan each day, so editing routes to match what drivers loaded doesn't change what it learns.", { date: fmtDateLong(settings.learnUntil) });
  $('#live-note').hidden = !plan;
  if (plan) $('#live-note-text').textContent = t('Routes for this day are out. Checking a stop puts it on a truck right away (its usual driver when that makes sense); unchecking takes it off. Other stops never move.');
  // Who takes each checked stop: the planner ("Auto") or a driver picked here.
  const k = plan ? viewOption().k : settings.driverCount;
  const driverPick = (c, s) => {
    const names = [...new Set([...Array.from({ length: k }, (_, i) => driverName(i)), s?.driver].filter(Boolean))];
    const auto = c.fixedDriver && c.homeDriver ? t('{name} (always)', { name: c.homeDriver }) : t('Auto');
    return `<select data-f="driver" ${s ? '' : 'disabled'} aria-label="${t('Driver')}"><option value="">${esc(auto)}</option>${names.map((n) => `<option value="${esc(n)}" ${s?.driver === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  };
  $('#stop-rows').innerHTML = list
    .map((c) => {
      const s = day.selected[c.id];
      return `<tr data-id="${esc(c.id)}" class="${s ? 'selected' : ''}">
        <td class="pick"><input type="checkbox" data-f="on" ${s ? 'checked' : ''} aria-label="${esc(c.name)}" /></td>
        <td class="name">${esc(c.name)}${isScheduled(c, weekday) ? ` <span class="tag good">${t('regular today')}</span>` : ''}${c.dayHours?.[weekday] ? ` <span class="tag prio">⏰ ${esc(hoursText(hoursOn(c, weekday)))}</span>` : ''}${s?.qb?.length ? ` <span class="tag invoice">🧾 ${s.qb.map((r) => '#' + esc(r)).join(' ')}</span>` : ''}${driverTag(c)}<div class="addr">${esc(c.address)}${hasLoc(c) ? '' : ` <span class="warn-text">⚠ ${t('not located')}</span>`}</div></td>
        <td class="drv"${label('Driver')}>${driverPick(c, s)}</td>
        <td class="small"${label('Usual days')}>${esc(daysText(c.days))}</td>
        <td class="small"${label('Unload')}>${unloadText(c)}</td>
        <td class="prio"${label('Priority')}><input type="checkbox" data-f="priority" ${s?.priority ? 'checked' : ''} ${s ? '' : 'disabled'} aria-label="${t('Priority')}" /></td>
        <td class="by"${label('Deliver by')}><input type="time" data-f="by" value="${esc(s?.by || settings.priorityBy)}" ${s?.priority ? '' : 'disabled'} /></td>
        <td class="note-cell"${label('Note for today')}><input class="note" data-f="note" value="${esc(s?.note || '')}" ${s ? '' : 'disabled'} placeholder="${esc(c.notes || '')}" /></td>
      </tr>`;
    })
    .join('');
  const ids = new Set(clients.map((c) => c.id));
  const n = Object.keys(day.selected).filter((id) => ids.has(id)).length;
  $('#stop-count').textContent = t('({n} selected for {day})', { n, day: DAYS[weekday] });
  renderQbNote();
}

$('#stop-rows').addEventListener('change', onStopEdit);
$('#stop-rows').addEventListener('input', (e) => {
  if (e.target.dataset.f === 'note') onStopEdit(e);
});

function onStopEdit(e) {
  const tr = e.target.closest('tr');
  const id = tr?.dataset.id;
  const f = e.target.dataset.f;
  if (!id || !f) return;
  if (f === 'on') {
    // An invoiced stop unchecked by hand stays unchecked when QuickBooks sends it again.
    day.qbSkip = (day.qbSkip || []).filter((x) => x !== id);
    if (e.target.checked) day.selected[id] = newSelection();
    else {
      if (day.selected[id]?.qb) day.qbSkip.push(id);
      delete day.selected[id];
    }
    saveDay();
    renderStops();
    if (plan) (e.target.checked ? addToPlan : removeFromPlan)(id);
    return;
  }
  const s = day.selected[id];
  if (!s) return;
  if (f === 'priority') {
    s.priority = e.target.checked;
    tr.querySelector('[data-f="by"]').disabled = !s.priority;
  } else if (f === 'by') s.by = e.target.value;
  else if (f === 'note') s.note = e.target.value;
  else if (f === 'driver') {
    if (e.target.value) s.driver = e.target.value;
    else delete s.driver;
    saveDay();
    return updatePlannedDriver(id);
  }
  saveDay();
  if (e.type === 'change') updatePlannedStop(id);
}

// Gives every checked stop without a driver its client's usual driver (set by hand or learned).
$('#btn-fill-drivers').addEventListener('click', () => {
  const learned = usualDrivers();
  const k = plan ? viewOption().k : settings.driverCount;
  const names = Array.from({ length: k }, (_, i) => driverName(i));
  let n = 0;
  for (const [id, s] of Object.entries(day.selected)) {
    const c = clients.find((x) => x.id === id);
    const usual = c && (c.homeDriver || learned.get(id));
    if (!c || s.driver || !names.includes(usual)) continue;
    s.driver = usual;
    n++;
    if (plan) updatePlannedDriver(id);
  }
  saveDay();
  renderStops();
  alert(n ? t('Gave {n} stop(s) to their usual driver. Change any of them in the Driver column.', { n }) : t('No checked stop has a usual driver yet.'));
});

$('#plan-date').addEventListener('change', (e) => {
  if (!e.target.value) return;
  loadDay(e.target.value);
  renderResults();
});
for (const [id, field] of [['#plan-shift', 'shiftStart'], ['#plan-start', 'start'], ['#plan-end', 'latestReturn']]) {
  $(id).addEventListener('change', (e) => {
    day[field] = e.target.value;
    saveDay();
    if (field === 'shiftStart') renderDriverRows();
  });
}
$('#plan-drivers').addEventListener('change', (e) => {
  settings.driverCount = Number(e.target.value);
  saveSettings();
  renderDriverRows();
});
$('#plan-balance').addEventListener('change', (e) => {
  settings.balance = e.target.value;
  saveSettings();
});
$('#driver-rows').addEventListener('change', (e) => {
  const d = e.target.dataset.driver;
  const h = e.target.dataset.hours;
  if (d != null) renameDriver(Number(d), e.target.value.trim() || t('Driver {n}', { n: Number(d) + 1 }));
  if (h != null) {
    day.weekHours[h] = e.target.value;
    saveDay();
  }
  renderDriverRows();
});

// A truck assignment follows the driver when they're renamed.
function renameDriver(i, name) {
  const old = settings.drivers[i];
  if (old === name) return;
  settings.drivers[i] = name;
  if (settings.trucks?.[old]) {
    settings.trucks = { ...settings.trucks, [name]: settings.trucks[old] };
    delete settings.trucks[old];
  }
  saveSettings();
  // So does being someone's usual driver.
  const theirs = clients.filter((c) => old && c.homeDriver === old);
  for (const c of theirs) c.homeDriver = name;
  if (theirs.length) saveClients();
  if (plan) renderResults();
}

$('#stop-search').addEventListener('input', renderStops);
$('#btn-select-scheduled').addEventListener('click', () => {
  const weekday = weekdayOf(planDate);
  const added = clients.filter((c) => isScheduled(c, weekday) && !day.selected[c.id]);
  for (const c of added) day.selected[c.id] = newSelection();
  saveDay();
  renderStops();
  if (plan) for (const c of added) addToPlan(c.id);
});
$('#btn-select-none').addEventListener('click', () => {
  if (!confirm(plan ? t('Uncheck all stops for this day? They also come off the routes already sent to drivers.') : t('Uncheck all stops for this day?'))) return;
  const ids = Object.keys(day.selected);
  day.selected = {};
  saveDay();
  renderStops();
  if (plan) for (const id of ids) removeFromPlan(id);
});
$('#btn-optimize').addEventListener('click', buildRoutes);

// A client's delivery window on a weekday (0 = Sunday): that day's own times where set,
// else the usual ones. { open, close } as "HH:MM" or ''.
function hoursOn(c, weekday) {
  const d = c.dayHours?.[weekday] || {};
  return { open: d.open || c.open || '', close: d.close || c.close || '' };
}

const hoursText = ({ open, close }) => (open || close ? `${open ? fmtTime(toMin(open)) : '…'} – ${close ? fmtTime(toMin(close)) : '…'}` : '');

function stopFromClient(c, sel, home = '') {
  const hours = hoursOn(c, weekdayOf(planDate));
  const prio = sel.priority ? toMin(sel.by || settings.priorityBy) : null;
  const close = toMin(hours.close);
  return {
    id: c.id, name: c.name, address: c.address, lat: Number(c.lat), lng: Number(c.lng), home, driver: assignedDriver(c, sel),
    unload: unloadOf(c), notes: c.notes || '', today: sel.note || '',
    priority: !!sel.priority, by: sel.priority ? sel.by || settings.priorityBy : '',
    open: toMin(hours.open), due: prio == null ? close : close == null ? prio : Math.min(prio, close),
  };
}

// Drive-time tables (minutes and miles) for the warehouse + stops.
async function tablesFor(depot, stops, status) {
  const points = [depot, ...stops.map((s) => ({ lat: s.lat, lng: s.lng }))];
  const cache = await ensureDriveTimes(points, status);
  const m = assemble(points, cache);
  return { time: m.time, dist: m.meters.map((row) => row.map((x) => x / 1609.34)), source: { google: m.fromGoogle, estimated: m.estimated } };
}

async function buildRoutes() {
  const status = (s) => ($('#plan-status').textContent = s);
  const depot = depotPoint();
  if (!depot) return alert(t('Set the warehouse location in Settings first.'));
  const chosen = clients.filter((c) => day.selected[c.id]);
  saveDay(); // so every office computer has the same stops as the plan
  if (!chosen.length) return alert(t('Check at least one stop.'));
  const shiftStart = toMin($('#plan-shift').value);
  const start = toMin($('#plan-start').value);
  const endBy = toMin($('#plan-end').value);
  if (shiftStart == null || start == null || endBy == null || endBy <= start || start < shiftStart) {
    return alert(t('Check the clock-in, leave and latest-return times.'));
  }

  const t0 = performance.now();
  await busy($('#btn-optimize'), async () => {
    try {
      if (settings.apiKey) await locateClients(chosen, status);
      const stillMissing = chosen.filter((c) => !hasLoc(c));
      if (stillMissing.length) {
        status('');
        alert(t('These clients have no map location yet. Open them in the Clients tab and click Find (or type the latitude/longitude):') + '\n\n' + stillMissing.map((c) => '• ' + c.name).join('\n'));
        return;
      }
      // Rebuilding a plan that already went out keeps each stop with the driver it has now
      // (unless moving saves more than the set amount); new stops go to their usual driver.
      const old = plan?.date === planDate ? plan : null;
      const current = assignedDrivers(old);
      const learned = usualDrivers();
      const stops = chosen.map((c) => stopFromClient(c, day.selected[c.id], current.get(c.id) || homeOf(c, learned)));
      const tables = await tablesFor(depot, stops, status);
      const rules = payRules();
      const history = store.getHistory();
      const weekMin = Array.from({ length: MAX_DRIVERS }, (_, i) => weekBefore(i, history));

      plan = {
        date: planDate,
        created: Date.now(),
        shiftStart,
        start,
        endBy,
        payRate: num(settings.payRate, 14),
        fuelPerMile: num(settings.fuelPerMile, 0),
        otAt: weekMin.map((w) => overtimeStart({ ...rules, weekBeforeMin: w })),
        requested: settings.driverCount,
        view: settings.driverCount,
        depot: { name: depotName(), address: settings.depotAddress, lat: depot.lat, lng: depot.lng },
        stops,
        problem: {
          time: tables.time,
          dist: tables.dist,
          service: [0, ...stops.map((s) => s.unload)],
          open: [null, ...stops.map((s) => s.open)],
          due: [null, ...stops.map((s) => s.due)],
        },
        options: [],
        source: { ...tables.source, trafficTime: settings.trafficTime },
      };

      const k = settings.driverCount;
      const counts = [...new Set([k - 1, k, k + 1])].filter((x) => x >= 1 && x <= MAX_DRIVERS && (x <= stops.length || x === k));
      for (const vehicles of counts) {
        status(plural(vehicles, 'Optimizing routes for 1 driver…', 'Optimizing routes for {n} drivers…'));
        const r = await runSolve(problemFor(plan, vehicles), {
          timeLimitMs: vehicles === k ? 2500 : 1500,
          weights: { balance: BALANCE[settings.balance] ?? 0.15 },
        });
        let orders = r.routes.map((x) => x.order);
        if (isLearning() && !old && !plan.stops.some((s) => s.driver)) orders = sameAreaSameDriver(orders, vehicles);
        plan.options.push({ k: vehicles, orders, original: orders.map((o) => o.slice()) });
      }
      const kept = plan.options.find((o) => o.k === k);
      const locked = plan.stops.some((s) => s.driver);
      const cost = (orders) => evaluate(plan, { k, orders }).total;
      // The planner's own best plan for the day: no drivers picked by hand, nothing kept on the truck
      // it was on. Usual drivers are learned from it, whatever routes are actually sent (see driverCounts).
      let best = kept.orders;
      if (current.size || locked) {
        status(t("Working out the planner's own best plan…"));
        best = await bestPlanOrders(k);
      }
      plan.best = bestByDriver(best);
      // Drivers picked by hand: what letting the planner pick every driver would cost, for comparison.
      if (locked && cost(kept.orders) - cost(best) >= 1) plan.free = { k, extra: cost(kept.orders) - cost(best) };
      // Stops kept the trucks they were on. Also plan from scratch (still with the drivers picked by
      // hand), and offer that if it's cheaper.
      if (current.size) {
        let orders = best;
        if (locked) {
          status(t('Comparing with planning from scratch…'));
          const scratch = { ...plan, stops: plan.stops.map((s) => ({ ...s, home: homeOf(clients.find((c) => c.id === s.id) || {}, learned) })) };
          orders = (await runSolve(problemFor(scratch, k), { timeLimitMs: 2500, weights: { balance: BALANCE[settings.balance] ?? 0.15 } })).routes.map((x) => x.order);
        }
        const saves = cost(kept.orders) - cost(orders);
        const before = routeIndex(kept.orders);
        const after = routeIndex(orders);
        const moves = before.filter((r0, i) => i && r0 !== after[i]).length;
        if (saves >= 1 && moves) plan.fresh = { k, orders, saves, moves };
      }
      // Show the number of drivers that was asked for; a cheaper count is offered, not forced.
      plan.view = k;
      // What the drivers were first told stays the yardstick for "new" and "taken off" on their phones.
      plan.sent = old?.sent || sentNow();
      suggestion = null;
      savePlan();
      renderResults();
      status(t('Done in {s} s.', { s: ((performance.now() - t0) / 1000).toFixed(1) }));
      $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      console.error(err);
      status('');
      alert(t('Something went wrong:') + ' ' + err.message);
    }
  });
}

// Saves the plan, publishes each driver's route, and records the viewed plan in History.
function savePlan() {
  store.savePlan(plan);
  const ev = evaluate(plan, viewOption());
  const routes = {};
  ev.routes.forEach((r, i) => {
    if (r.order.length) routes[driverName(i)] = routePayload(r, i);
  });
  store.saveRoutesDay(plan.date, routes, plan.best);
  // Real return times (from the truck or typed in History) are kept when the plan changes.
  const before = store.getHistory()[plan.date]?.drivers || [];
  const drivers = ev.routes
    .map((r, i) => {
      const planned = { name: driverName(i), stops: r.order.length, paid: Math.round(r.paid), back: Math.round(r.finish), miles: Math.round(r.miles * 10) / 10 };
      const real = before.find((d) => d.name === planned.name && d.source);
      return real ? { ...planned, back: real.back, paid: real.paid, source: real.source } : planned;
    })
    .filter((d) => d.stops);
  // Keep real times for anyone (e.g. a truck nobody planned) who isn't on this plan.
  for (const d of before) if (d.source && !drivers.some((x) => x.name === d.name)) drivers.push(d);
  store.saveHistoryDay(plan.date, { drivers, shiftStart: plan.shiftStart, stops: plan.stops.length, miles: ev.miles });
}

// ---------- Results ----------

function viewOption(p = plan) {
  return p.options.find((o) => o.k === p.view) || p.options[0];
}

// Each driver's stops as sent right now: { driverName: [{ id, n }] }.
function sentNow() {
  const out = {};
  viewOption().orders.forEach((o, r) => {
    out[driverName(r)] = o.map((i) => ({ id: plan.stops[i - 1].id, n: plan.stops[i - 1].name }));
  });
  return out;
}

function renderResults() {
  renderStops(); // each stop shows the driver it's on
  if (!plan) {
    $('#results').hidden = true;
    return;
  }
  $('#results').hidden = false;
  const views = evaluateAll(plan);
  const best = bestOf(views);
  const view = viewOption();

  $('#cost-note').textContent = t('Paid from clock-in ({clock}) until back at the warehouse at {rate}/h; overtime at 1.5× ({ot}/h); fuel at {fuel}/mile. Click a row to view that plan.', {
    clock: fmtTime(plan.shiftStart),
    rate: fmtMoney(plan.payRate),
    ot: fmtMoney(plan.payRate * 1.5),
    fuel: fmtMoney(plan.fuelPerMile),
  });

  const head = ['Drivers', 'Back at warehouse', 'Paid hours', 'Overtime', 'Labor', 'Fuel', 'Total', ''].map((h) => `<th>${h && t(h)}</th>`).join('');
  $('#compare-rows').innerHTML =
    `<tr class="head">${head}</tr>` +
    views
      .map(({ o, ev }) => {
        const flags = [];
        if (o === best) flags.push(`<span class="tag good">${t('Best')}</span>`);
        if (ev.pastEndMinutes >= 0.5) flags.push(`<span class="tag bad">${t('Past {time}', { time: fmtTime(plan.endBy) })}</span>`);
        if (ev.lateStops.length) flags.push(`<span class="tag bad">${t('{n} late', { n: ev.lateStops.length })}</span>`);
        if (ev.empty) flags.push(`<span class="tag">${t('Not enough stops')}</span>`);
        if (o.edited) flags.push(`<span class="tag">${t('Changed by hand')}</span>`);
        const finishes = ev.routes.filter((r) => r.order.length).map((r) => fmtTime(r.finish)).join(', ');
        return `<tr data-k="${o.k}" class="${o.k === view.k ? 'current' : ''}">
          <td class="k"><b>${plural(o.k, '1 driver', '{n} drivers')}</b>${o.k === plan.requested ? ` <span class="muted small">${t('(requested)')}</span>` : ''}</td>
          <td class="small"${label('Back at warehouse')}>${finishes}</td>
          <td${label('Paid hours')}>${fmtHours(ev.paidMinutes)} h</td>
          <td${label('Overtime')}>${ev.otMinutes >= 0.5 ? `${fmtHours(ev.otMinutes)} h` : '—'}</td>
          <td${label('Labor')}>${fmtMoney(ev.labor)}</td>
          <td${label('Fuel')}>${fmtMoney(ev.fuel)}</td>
          <td class="total"${label('Total')}><b>${fmtMoney(ev.total)}</b></td>
          <td class="flags">${flags.join(' ')}</td>
        </tr>`;
      })
      .join('');

  const viewEv = views.find((x) => x.o === view).ev;
  const bestEv = views.find((x) => x.o === best).ev;
  const hint = $('#best-hint');
  hint.hidden = best === view;
  if (best !== view) {
    const saves = viewEv.total - bestEv.total;
    hint.innerHTML =
      (saves > 0.005
        ? t('{drivers} would cost {amount} less.', { drivers: plural(best.k, '1 driver', '{n} drivers'), amount: fmtMoney(saves) })
        : t('{drivers} gets everyone back on time.', { drivers: plural(best.k, '1 driver', '{n} drivers') })) +
      ` <button class="link" data-k="${best.k}">${t('Show that plan')}</button>`;
  }

  const free = plan.free?.k === view.k ? plan.free : null;
  $('#free-hint').hidden = !free;
  if (free) $('#free-hint').textContent = t('Your driver choices cost about {amount} more than letting the planner choose every driver.', { amount: fmtMoney(free.extra) });
  const fresh = plan.fresh?.k === view.k ? plan.fresh : null;
  $('#fresh-hint').hidden = !fresh;
  if (fresh) {
    $('#fresh-hint').innerHTML =
      t('Stops stayed on the trucks they were already on. Planning from scratch would cost {amount} less, but {n} stop(s) would change trucks.', { amount: fmtMoney(fresh.saves), n: fresh.moves }) +
      ` <button class="link" id="btn-use-fresh">${t('Use the plan from scratch')}</button>`;
  }

  const src = plan.source;
  $('#data-note').innerHTML = src.estimated
    ? `<span class="warn-text">⚠ ${t('{n} of {total} drive times are rough straight-line estimates. Times may be off.', { n: src.estimated, total: src.google + src.estimated })}</span>`
    : t('Drive times from Google with typical traffic around {time}.', { time: fmtTime(toMin(src.trafficTime)) });

  const ev = viewEv;
  $('#plan-title').textContent = `${fmtDateLong(plan.date)} · ${plural(view.k, '1 driver', '{n} drivers')} · ${fmtMoney(ev.total)}`;
  $('#btn-reset-edits').hidden = !view.edited;
  renderRouteMap(ev);
  const done = store.getDone()[plan.date] || {};
  $('#driver-cards').innerHTML = ev.routes.map((r, i) => driverCard(r, i, view.k, done[driverName(i)] || {})).join('');
  renderFinal();
}

// Click a row of the comparison (or "Show that plan") to switch to that number of drivers.
function viewDrivers(e) {
  const el = e.target.closest('[data-k]');
  if (!el) return;
  plan.view = Number(el.dataset.k);
  plan.sent = sentNow(); // a different number of drivers starts a new list for everyone
  suggestion = null;
  savePlan();
  renderResults();
}
$('#compare-rows').addEventListener('click', viewDrivers);
$('#best-hint').addEventListener('click', viewDrivers);
$('#fresh-hint').addEventListener('click', (e) => {
  if (!e.target.closest('#btn-use-fresh') || !plan.fresh) return;
  const opt = plan.options.find((o) => o.k === plan.fresh.k);
  opt.orders = plan.fresh.orders.map((o) => o.slice());
  opt.original = plan.fresh.orders.map((o) => o.slice());
  opt.edited = false;
  plan.view = opt.k;
  plan.fresh = plan.free = null;
  suggestion = null;
  savePlan();
  renderResults();
});

$('#btn-reset-edits').addEventListener('click', () => {
  const opt = viewOption();
  if (!confirm(t('Put this plan back the way the planner made it?'))) return;
  // Stops added later are not in the original; keep them where they are now.
  const inOriginal = new Set(opt.original.flat());
  const added = opt.orders.flat().filter((x) => !inOriginal.has(x));
  opt.orders = opt.original.map((o) => o.slice());
  for (const s of added) opt.orders = insertStop(opt.orders, problemFor(plan, opt.k), s);
  opt.edited = false;
  savePlan();
  renderResults();
});

function stopPlace(s) {
  return s.address || `${s.lat},${s.lng}`;
}

// Google Maps links allow 9 waypoints, so long routes are split into parts.
function mapsLinks(places) {
  const links = [];
  let i = 0;
  while (i < places.length - 1) {
    const seg = places.slice(i, i + 11);
    const params = new URLSearchParams({ api: '1', travelmode: 'driving', origin: seg[0], destination: seg[seg.length - 1] });
    if (seg.length > 2) params.set('waypoints', seg.slice(1, -1).join('|'));
    links.push('https://www.google.com/maps/dir/?' + params.toString());
    i += seg.length - 1;
  }
  return links;
}

function routeLinks(r) {
  return mapsLinks([plan.depot.address, ...r.order.map((i) => stopPlace(plan.stops[i - 1])), plan.depot.address]);
}

// One driver's route, packed for the driver phone page and the driver login.
// The date stays as YYYY-MM-DD so each phone shows it in its own language.
// x = added since the driver first got the list; g = stops taken off their list;
// f = driving order is final; c = when orders close.
function routePayload(r, i) {
  const sent = plan.sent?.[driverName(i)];
  const ids = new Set(r.order.map((idx) => plan.stops[idx - 1].id));
  const gone = (sent || []).filter((s) => !ids.has(s.id)).map((s) => s.n);
  return {
    driver: driverName(i),
    date: plan.date,
    leave: Math.round(plan.start),
    back: Math.round(r.finish),
    depot: { n: plan.depot.name, a: plan.depot.address },
    f: plan.final ? 1 : 0,
    c: toMin(settings.orderCutoff) ?? 0,
    ...(gone.length ? { g: gone } : {}),
    stops: r.order.map((idx, n) => {
      const s = plan.stops[idx - 1];
      return {
        id: s.id,
        n: s.name,
        a: stopPlace(s),
        t: Math.round(r.stops[n].arrive),
        p: s.priority ? toMin(s.by) : 0,
        o: [s.notes, s.today].filter(Boolean).join(' · '),
        ...(sent && !sent.some((x) => x.id === s.id) ? { x: 1 } : {}),
      };
    }),
  };
}

// Link to the phone page for one driver (the route rides inside the link).
function phoneLink(r, i) {
  return new URL('driver.html', location.href).href.split('#')[0] + '#' + encodeRoute(routePayload(r, i));
}

function driverCard(r, i, k, done) {
  const color = COLORS[i % COLORS.length];
  if (!r.order.length) {
    return `<div class="card driver" style="--route:${color}"><h3>${esc(driverName(i))}</h3><p class="muted">${t('No stops for this driver.')}</p></div>`;
  }
  const moveOptions = Array.from({ length: k }, (_, j) => (j === i ? '' : `<option value="${j}">${esc(driverName(j))}</option>`)).join('');
  const rows = r.order
    .map((idx, n) => {
      const s = plan.stops[idx - 1];
      const a = r.stops[n];
      const tags = [];
      if (s.priority) tags.push(`<span class="tag prio">${t('Priority · by {time}', { time: fmtTime(toMin(s.by)) })}</span>`);
      if (a.late > 0.5) tags.push(`<span class="tag bad">${t('{n} min late', { n: Math.round(a.late) })}</span>`);
      if (s.added) tags.push(`<span class="tag new">${t('Added')}</span>`);
      if (s.driver) tags.push(`<span class="tag" title="${esc(t('Given to this driver by hand'))}">📌</span>`);
      if (done[s.id]) tags.push(`<span class="tag done">✓ ${t('Done {time}', { time: fmtTime(minuteOfDay(done[s.id])) })}</span>`);
      const notes = [t('Unload {n} min', { n: s.unload }), s.notes, s.today].filter(Boolean).map(esc).join(' · ');
      return `<li><span class="num">${n + 1}</span><span class="time">${fmtTime(a.arrive)}</span>
        <div><div class="who">${esc(s.name)} ${tags.join(' ')}</div><div class="addr">${esc(s.address)}</div><div class="note">${notes}</div></div>
        <div class="edit noprint" data-r="${i}" data-n="${n}">
          <button class="secondary" data-move="up" ${n === 0 ? 'disabled' : ''} title="${t('Earlier')}">▲</button>
          <button class="secondary" data-move="down" ${n === r.order.length - 1 ? 'disabled' : ''} title="${t('Later')}">▼</button>
          ${k > 1 ? `<select data-move="to" aria-label="${t('Move to…')}"><option value="">${t('Move to…')}</option>${moveOptions}</select>` : ''}
        </div></li>`;
    })
    .join('');
  const links = routeLinks(r);
  const badge =
    r.pastEnd >= 0.5
      ? `<span class="tag bad">${t('{n} min past {time}', { n: Math.round(r.pastEnd), time: fmtTime(plan.endBy) })}</span>`
      : r.ot >= 0.5
        ? `<span class="tag prio">${t('Back {time} · {n} min OT', { time: fmtTime(r.finish), n: Math.round(r.ot) })}</span>`
        : `<span class="tag good">${t('Back {time}', { time: fmtTime(r.finish) })}</span>`;
  return `<div class="card driver" style="--route:${color}">
    <div class="row between"><h3>${esc(driverName(i))}</h3>${badge}</div>
    <div class="stats">
      <span>${esc(fmtDateLong(plan.date))}</span>
      <span>${t('Stops')} <b>${r.order.length}</b></span>
      <span>${t('Paid')} <b>${fmtDur(r.paid)}${r.ot >= 0.5 ? ` (${fmtDur(r.ot)} ${t('OT')})` : ''} · ${fmtMoney(r.labor)}</b></span>
      <span>${t('Driving')} <b>${fmtDur(r.drive)} · ${r.miles.toFixed(0)} mi · ${fmtMoney(r.fuel)} ${t('fuel')}</b></span>
    </div>
    <ol>
      <li class="depot"><span class="num">W</span><span class="time">${fmtTime(plan.start)}</span><div><div class="who">${t('Leave {place}', { place: esc(plan.depot.name) })}</div></div></li>
      ${rows}
      <li class="depot"><span class="num">W</span><span class="time">${fmtTime(r.finish)}</span><div><div class="who">${t('Back at {place}', { place: esc(plan.depot.name) })}</div></div></li>
    </ol>
    <div class="actions">
      <a class="btn secondary" href="${esc(phoneLink(r, i))}" target="_blank" rel="noopener">${t('Driver phone page')}</a>
      <button class="secondary" data-copylink="${i}">${t('Copy phone link')}</button>
      <button class="secondary" data-copy="${i}">${t('Copy for text')}</button>
      ${links.map((l, n) => `<a class="btn secondary" href="${esc(l)}" target="_blank" rel="noopener">Google Maps${links.length > 1 ? ` ${n + 1}` : ''}</a>`).join('')}
    </div>
  </div>`;
}

async function copyText(text, btn) {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = t('Copied!');
    setTimeout(() => (btn.textContent = label), 1500);
  } catch {
    prompt(t('Copy this:'), text);
  }
}

function textMessage(r, i) {
  const lines = [`${driverName(i)} – ${fmtDateLong(plan.date)}`, t('Leave {place} {time}', { place: plan.depot.name, time: fmtTime(plan.start) })];
  r.order.forEach((idx, n) => {
    const s = plan.stops[idx - 1];
    const extra = [s.priority ? t('PRIORITY by {time}', { time: fmtTime(toMin(s.by)) }) : '', s.notes, s.today].filter(Boolean).join(' – ');
    lines.push(`${n + 1}. ${fmtTime(r.stops[n].arrive)} ${s.name}, ${s.address}${extra ? ` (${extra})` : ''}`);
  });
  lines.push(t('Back at {place} about {time}', { place: plan.depot.name, time: fmtTime(r.finish) }));
  lines.push(t('Route on your phone:') + ' ' + phoneLink(r, i));
  return lines.join('\n');
}

$('#driver-cards').addEventListener('click', (e) => {
  const linkBtn = e.target.closest('[data-copylink]');
  const textBtn = e.target.closest('[data-copy]');
  if (linkBtn || textBtn) {
    const ev = evaluate(plan, viewOption());
    const i = Number((linkBtn || textBtn).dataset.copylink ?? textBtn.dataset.copy);
    copyText(linkBtn ? phoneLink(ev.routes[i], i) : textMessage(ev.routes[i], i), linkBtn || textBtn);
    return;
  }
  const mv = e.target.closest('button[data-move]');
  if (mv) {
    const box = mv.closest('.edit');
    moveStop(Number(box.dataset.r), Number(box.dataset.n), mv.dataset.move === 'up' ? -1 : 1);
  }
});

$('#driver-cards').addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-move="to"]');
  if (!sel || sel.value === '') return;
  const box = sel.closest('.edit');
  giveStop(Number(box.dataset.r), Number(box.dataset.n), Number(sel.value));
});

function afterEdit(opt) {
  opt.edited = true;
  plan.fresh = plan.free = null;
  savePlan();
  renderResults();
}

function moveStop(r, n, dir) {
  const opt = viewOption();
  const route = opt.orders[r];
  const m = n + dir;
  if (m < 0 || m >= route.length) return;
  [route[n], route[m]] = [route[m], route[n]];
  afterEdit(opt);
}

// Hand a stop to another driver, at the cheapest spot in their route.
// Hand a stop to another driver, at the cheapest spot in their route. It stays with that driver
// when routes are built again (shown as chosen in the stop list's Driver column).
function giveStop(r, n, to) {
  const opt = viewOption();
  const [stop] = opt.orders[r].splice(n, 1);
  const s = plan.stops[stop - 1];
  s.driver = driverName(to);
  if (day.selected[s.id]) {
    day.selected[s.id].driver = s.driver;
    saveDay();
  }
  const only = opt.orders.map((_, j) => (j === to ? 0 : Infinity));
  opt.orders = insertStop(opt.orders, problemFor(plan, opt.k), stop, only);
  afterEdit(opt);
}

// A driver picked for a stop that's already on the routes: move it onto their truck now
// (cheapest spot); "Auto" just lets the planner move it next time.
function updatePlannedDriver(id) {
  const idx = plan ? plan.stops.findIndex((s) => s.id === id) + 1 : 0;
  const c = clients.find((x) => x.id === id);
  if (!idx || !c) return renderStops();
  const name = assignedDriver(c, day.selected[id]);
  plan.stops[idx - 1].driver = name;
  for (const opt of plan.options) {
    const to = settings.drivers.indexOf(name);
    if (!name || to < 0 || to >= opt.k || opt.orders[to].includes(idx)) continue;
    const orders = opt.orders.map((o) => o.filter((x) => x !== idx));
    opt.orders = insertStop(orders, problemFor(plan, opt.k), idx, orders.map((_, j) => (j === to ? 0 : Infinity)));
  }
  plan.fresh = plan.free = null;
  suggestion = null;
  savePlan();
  renderResults();
  if (name) liveMsg(`✓ ${t('{name} → {driver}. It shows on their phone as new.', { name: esc(c.name), driver: `<b>${esc(name)}</b>` })}`);
}

// ---------- Orders after the routes went out ----------
// Once a day's routes are built, checking a stop puts it on a truck right away (the cheapest
// spot, preferring the client's usual driver) and unchecking takes it off. Nobody else moves,
// so drivers can load as orders come in. When orders close, "Set final driving order" works out
// each driver's best order without moving any stop to another truck.

let planQueue = Promise.resolve();
let suggestion = null; // moves "Set final driving order" found worth making: { k, orders, saves, moves }

// Plan changes run one at a time, in the order they were asked for.
function queuePlan(work) {
  planQueue = planQueue.then(work).catch((err) => {
    console.error(err);
    liveMsg(errorText(err));
  });
  return planQueue;
}

function liveMsg(html) {
  $('#live-msg').innerHTML = html;
}

// Removes stop `idx` (1-based) from a plan, renumbering the rest.
function dropStop(p, idx) {
  const keep = (row) => row.filter((_, j) => j !== idx);
  p.stops.splice(idx - 1, 1);
  for (const [key, v] of Object.entries(p.problem)) p.problem[key] = Array.isArray(v[0]) ? keep(v).map(keep) : keep(v);
  const fix = (orders) => orders.map((o) => o.filter((x) => x !== idx).map((x) => (x > idx ? x - 1 : x)));
  p.fresh = p.free = null;
  for (const opt of p.options) {
    opt.orders = fix(opt.orders);
    opt.original = fix(opt.original);
  }
}

function addToPlan(id) {
  return queuePlan(async () => {
    const c = clients.find((x) => x.id === id);
    if (!plan || !c || !day.selected[id] || plan.stops.some((s) => s.id === id)) return;
    await locateClients([c], liveMsg);
    if (!hasLoc(c)) return liveMsg(errorText(new Error(t('{name} has no map location yet. Open it in the Clients tab and click Find.', { name: c.name }))));
    const stop = { ...stopFromClient(c, day.selected[id], homeOf(c, usualDrivers())), added: true };
    const stops = [...plan.stops, stop];
    const tables = await tablesFor(plan.depot, stops, liveMsg);
    if (!plan || !day.selected[id] || plan.stops.some((s) => s.id === id)) return; // changed while looking up
    plan.stops = stops;
    plan.problem = {
      time: tables.time,
      dist: tables.dist,
      service: [...plan.problem.service, stop.unload],
      open: [...plan.problem.open, stop.open],
      due: [...plan.problem.due, stop.due],
    };
    plan.source = { ...plan.source, ...tables.source };
    const idx = stops.length;
    const nowMin = plan.date === localDate() ? minuteOfDay(Date.now()) : -1;
    for (const opt of plan.options) {
      const p = problemFor(plan, opt.k);
      // Stops whose planned arrival has passed are treated as done.
      const ev = summarize(opt.orders, p);
      const minPos = ev.routes.map((r) => r.stops.filter((s) => s.arrive <= nowMin).length);
      opt.orders = insertStop(opt.orders, p, idx, minPos);
    }
    plan.fresh = plan.free = null;
    suggestion = null;
    savePlan();
    renderResults();
    const r = viewOption().orders.findIndex((o) => o.includes(idx));
    liveMsg(`✓ ${t('{name} → {driver}. It shows on their phone as new.', { name: esc(c.name), driver: `<b>${esc(driverName(r))}</b>` })}`);
  });
}

function removeFromPlan(id) {
  return queuePlan(async () => {
    const idx = plan ? plan.stops.findIndex((s) => s.id === id) + 1 : 0;
    if (!idx || day.selected[id]) return;
    const name = plan.stops[idx - 1].name;
    const r = viewOption().orders.findIndex((o) => o.includes(idx));
    dropStop(plan, idx);
    suggestion = null;
    if (!plan.stops.length) return clearPlan();
    savePlan();
    renderResults();
    liveMsg(t('{name} taken off {driver}\'s route. Their phone says not to deliver it.', { name: esc(name), driver: `<b>${esc(driverName(r))}</b>` }));
  });
}

// Every stop came off: the day has no routes any more, so checking stops again just picks them,
// and the next Build routes plans the whole day from scratch.
function clearPlan() {
  store.savePlan({ date: plan.date, deleted: true });
  store.saveRoutesDay(plan.date, {});
  plan = null;
  suggestion = null;
  renderResults();
  liveMsg('');
}

// Priority, deliver-by time and today's note follow the stop onto its route.
function updatePlannedStop(id) {
  const idx = plan ? plan.stops.findIndex((s) => s.id === id) + 1 : 0;
  const c = clients.find((x) => x.id === id);
  if (!idx || !c || !day.selected[id]) return;
  const s = plan.stops[idx - 1];
  const fresh = stopFromClient(c, day.selected[id], s.home);
  Object.assign(s, { priority: fresh.priority, by: fresh.by, today: fresh.today, due: fresh.due });
  plan.problem.due[idx] = fresh.due;
  savePlan();
  renderResults();
}

// ---------- QuickBooks Desktop invoices ----------
// The helper on the office PC (quickbooks/qb-sync.ps1) sends every invoice dated over the next
// few days. Each invoice checks its client's stop for that date (adding the client if it's new),
// and goes onto a truck right away if the routes are already out. A stop that was checked only
// because of an invoice is unchecked again when the invoice is voided or deleted.

const QB_STALE_MIN = 10; // the helper sends every minute; warn after this many minutes of silence
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const qbDisplayName = (fullName) => String(fullName).split(':').join(' – ');

// The client for a QuickBooks customer: linked before, same QuickBooks name, or same name.
// Adds a new client (from the invoice's ship-to address) if there is none.
function qbClient(inv) {
  let c =
    clients.find((x) => x.qbId && x.qbId === inv.cid) ||
    clients.find((x) => !x.qbId && x.qbName && norm(x.qbName) === norm(inv.cname)) ||
    clients.find((x) => !x.qbId && norm(x.name) === norm(qbDisplayName(inv.cname)));
  if (c) {
    if (c.qbId !== inv.cid || c.active === false) Object.assign(c, { qbId: inv.cid, active: true });
    return { c, isNew: false };
  }
  c = {
    id: 'qb-' + inv.cid.replace(/[^A-Za-z0-9-]/g, ''),
    active: true,
    name: qbDisplayName(inv.cname),
    qbId: inv.cid,
    qbName: inv.cname,
    address: inv.address,
    lat: null,
    lng: null,
    unload: settings.defaultUnload,
    open: '',
    close: '',
    notes: '',
    days: [false, false, false, false, false, false, false],
  };
  clients.push(c);
  return { c, isNew: true };
}

// Brings the checked stops of every coming day in line with the invoices.
function applyQuickBooks() {
  const qb = store.getQb();
  if (!qb?.days || !day || !['admin', 'secretary'].includes(role())) return;
  const before = canonical(clients);
  const fresh = [];
  for (const [date, invoices] of Object.entries(qb.days)) {
    if (date < localDate()) continue;
    const refs = new Map(); // client id -> invoice numbers
    for (const inv of invoices) {
      if (inv.voided || !inv.cid) continue;
      const { c, isNew } = qbClient(inv);
      if (isNew) fresh.push(c);
      refs.set(c.id, [...(refs.get(c.id) || []), inv.ref || inv.id]);
    }
    const d = date === planDate ? day : store.getDay(date) || newDay(date);
    const was = canonical(d.selected);
    const added = [];
    const removed = [];
    for (const id of d.qbSkip || []) refs.delete(id);
    for (const [id, list] of refs) {
      if (d.selected[id]) d.selected[id].qb = list;
      else {
        d.selected[id] = { ...newSelection(), qb: list, fromQb: true };
        added.push(id);
      }
    }
    for (const [id, sel] of Object.entries(d.selected)) {
      if (!sel.qb || refs.has(id)) continue;
      if (sel.fromQb) {
        delete d.selected[id];
        removed.push(id);
      } else delete sel.qb; // checked by hand or a regular: stays checked
    }
    if (canonical(d.selected) === was) continue;
    if (date !== planDate) {
      store.saveDay(date, d);
      continue;
    }
    saveDay();
    if (plan) {
      for (const id of added) addToPlan(id);
      for (const id of removed) removeFromPlan(id);
    }
  }
  if (canonical(clients) !== before) saveClients();
  if (fresh.length && settings.apiKey) locateClients(fresh).then(() => currentTab() === 'clients' && renderClients());
  renderStops();
  if (currentTab() === 'clients') renderClients();
}

// Line under the Stops title: what QuickBooks sent for this day, and checked stops with no invoice.
function renderQbNote() {
  const qb = store.getQb();
  const el = $('#qb-note');
  el.hidden = !qb?.lastSeen;
  if (el.hidden) return;
  const ids = new Set(clients.map((c) => c.id));
  const sel = Object.entries(day.selected).filter(([id]) => ids.has(id));
  const invoiced = sel.filter(([, s]) => s.qb?.length).length;
  const missing = sel.filter(([, s]) => !s.qb?.length).map(([id]) => clients.find((c) => c.id === id).name);
  const ago = Math.round((Date.now() - qb.lastSeen) / 60000);
  const parts = [`🧾 ${t('QuickBooks: {n} stop(s) with an invoice for this day.', { n: invoiced })}`];
  parts.push(ago > QB_STALE_MIN && planDate >= localDate()
    ? `<span class="warn-text">⚠ ${t('The QuickBooks helper last checked in {time}. Is QuickBooks open on the office PC?', { time: new Date(qb.lastSeen).toLocaleString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) })}</span>`
    : `<span class="muted">${t('Checked {n} min ago.', { n: ago })}</span>`);
  const dups = duplicateSuggestions().length;
  if (dups) parts.push(`<br><span class="warn-text">⚠ ${t('{n} client(s) added from QuickBooks may be duplicates.', { n: dups })}</span> <a href="#" data-goto="clients">${t('Check them in Clients')}</a>`);
  if (missing.length) {
    parts.push(`<br>${t('Checked but no invoice yet: {names}.', { names: missing.map(esc).join(', ') })} <button class="link" id="btn-uncheck-uninvoiced">${t('Uncheck them')}</button>`);
  }
  el.innerHTML = parts.join(' ');
}

$('#qb-note').addEventListener('click', (e) => {
  if (!e.target.closest('#btn-uncheck-uninvoiced')) return;
  const ids = Object.entries(day.selected).filter(([, s]) => !s.qb?.length).map(([id]) => id);
  if (!confirm(t('Uncheck {n} stop(s) that have no QuickBooks invoice?', { n: ids.length }))) return;
  for (const id of ids) delete day.selected[id];
  saveDay();
  renderStops();
  if (plan) for (const id of ids) removeFromPlan(id);
});

// ---------- Final driving order ----------

function renderFinal() {
  const cutoff = toMin(settings.orderCutoff);
  const closed = plan.date < localDate() || (plan.date === localDate() && cutoff != null && minuteOfDay(Date.now()) >= cutoff);
  const btn = $('#btn-final');
  btn.className = plan.final ? 'secondary' : closed ? 'primary' : 'secondary';
  $('#final-note').innerHTML = plan.final
    ? `✓ ${t('Final driving order set at {time}. Every stop stayed on its truck.', { time: fmtTime(minuteOfDay(plan.final)) })} ${t('Click again after more changes.')}`
    : cutoff != null && closed
      ? `<b>${t('Orders closed at {time}.', { time: fmtTime(cutoff) })}</b> ${t('Click to give every driver their best driving order and times. No stop moves to another truck.')}`
      : cutoff != null
        ? t('Until orders close at {time}, drivers see the stops to load. Then click this: no stop moves to another truck, and each driver gets the best driving order and times.', { time: fmtTime(cutoff) })
        : t('When orders close, click this: no stop moves to another truck, and each driver gets the best driving order and times.');
  const box = $('#final-suggest');
  box.hidden = !suggestion || suggestion.k !== viewOption().k;
  if (!box.hidden) {
    box.innerHTML = `<p><b>${t('Moving {n} stop(s) to another truck would save {amount} more:', { n: suggestion.moves.length, amount: fmtMoney(suggestion.saves) })}</b></p>
      <ul>${suggestion.moves.map((m) => `<li>${esc(m.name)}: ${esc(m.from)} → ${esc(m.to)}</li>`).join('')}</ul>
      <p class="muted small">${t('Only do this if those orders are not loaded yet. The drivers\' phones will show the change.')}</p>
      <div class="row wrap small-gap"><button class="primary" data-suggest="apply">${t('Move them')}</button><button class="secondary" data-suggest="skip">${t('Keep as is')}</button></div>`;
  }
}

async function setFinalOrder(btn) {
  await planQueue;
  await busy(btn, async (status) => {
    const weights = { balance: BALANCE[settings.balance] ?? 0.15 };
    status(t('Working…'));
    for (const opt of plan.options) {
      if (!opt.orders.flat().length) continue;
      const p = { ...problemFor(plan, opt.k), lock: routeIndex(opt.orders) };
      const r = await runSolve(p, { timeLimitMs: 1500, weights });
      const orders = r.routes.map((x) => x.order);
      if (costOf(orders, p, weights) < costOf(opt.orders, p, weights) - 1e-6) opt.orders = orders;
    }
    // Would moving a few stops between trucks be worth it? Only suggested (when all the moves
    // together save more than the "keep with usual driver" amount), never done on its own.
    // Each move is charged $2 in the search so it only moves stops that clearly help.
    const view = viewOption();
    suggestion = null;
    if (view.k > 1 && view.orders.flat().length) {
      const p = problemFor(plan, view.k);
      const r = await runSolve({ ...p, home: routeIndex(view.orders), away: 120 / plan.payRate }, { timeLimitMs: 2000, weights });
      const orders = r.routes.map((x) => x.order);
      const saves = evaluate(plan, view).total - evaluate(plan, { k: view.k, orders }).total;
      const before = routeIndex(view.orders);
      const after = routeIndex(orders);
      const moves = [];
      for (let i = 1; i < before.length; i++) {
        if (before[i] !== after[i]) moves.push({ name: plan.stops[i - 1].name, from: driverName(before[i]), to: driverName(after[i]) });
      }
      if (moves.length && saves >= Math.max(0.5, num(settings.keepWithDriver, 10))) suggestion = { k: view.k, orders, saves, moves };
    }
    // Orders are in now: the planner's own best plan for the whole day, to learn usual drivers from.
    plan.best = bestByDriver(await bestPlanOrders(view.k));
    plan.final = Date.now();
    plan.fresh = plan.free = null;
    savePlan();
    renderResults();
  });
}

$('#btn-final').addEventListener('click', (e) => setFinalOrder(e.currentTarget));
$('#final-suggest').addEventListener('click', (e) => {
  const b = e.target.closest('[data-suggest]');
  if (!b) return;
  const view = viewOption();
  if (b.dataset.suggest === 'apply' && suggestion?.k === view.k) {
    view.orders = suggestion.orders.map((o) => o.slice());
    savePlan();
  }
  suggestion = null;
  renderResults();
});

$('#btn-print').addEventListener('click', () => window.print());

function renderRouteMap(ev) {
  routeMap = mapIn($('#map'), routeMap);
  if (!routeMap) return;
  const layer = routeMap.layer;
  const d = [plan.depot.lat, plan.depot.lng];
  const pts = [d];
  depotPin(layer, plan.depot, plan.depot.name);
  ev.routes.forEach((r, i) => {
    const color = COLORS[i % COLORS.length];
    const line = [d];
    r.order.forEach((idx, n) => {
      const s = plan.stops[idx - 1];
      const ll = [s.lat, s.lng];
      line.push(ll);
      pts.push(ll);
      pin(layer, ll, `<div class="pin" style="background:${color}">${n + 1}</div>`, 26, `<b>${esc(s.name)}</b><br>${esc(driverName(i))} · ${t('stop {n}', { n: n + 1 })}<br>${fmtTime(r.stops[n].arrive)}`);
    });
    line.push(d);
    if (r.order.length) L.polyline(line, { color, weight: 4, opacity: 0.75 }).addTo(layer);
  });
  fit(routeMap, pts);
}

// ---------- History tab ----------

let historyWeek = weekStart(localDate());
let weekRows = [];

function renderHistory() {
  const history = store.getHistory();
  const regWeekMin = payRules().regWeekMin;
  $('#week-of').value = historyWeek;
  weekRows = weekSummary(history, historyWeek, { regWeekMin, rate: num(settings.payRate, 14) });
  const dayHead = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(historyWeek, i);
    return `<th class="num">${DAYS[weekdayOf(d)]} ${Number(d.slice(8))}</th>`;
  }).join('');
  $('#week-rows').innerHTML =
    `<tr><th>${t('Driver')}</th>${dayHead}<th class="num">${t('Total')}</th><th class="num">${t('Overtime')}</th><th class="num">${t('Est. pay')}</th></tr>` +
    (weekRows.length
      ? weekRows
          .map(
            (r) => `<tr><td><b>${esc(r.name)}</b></td>${r.days.map((m, i) => `<td class="num">${m == null ? '' : fmtHours(m)}${r.fromTruck[i] ? ' 🚚' : ''}</td>`).join('')}
            <td class="num ${r.total > regWeekMin ? 'bad-text' : ''}"><b>${fmtHours(r.total)}</b></td>
            <td class="num">${r.ot >= 0.5 ? fmtHours(r.ot) : '—'}</td><td class="num">${fmtMoney(r.pay)}</td></tr>`,
          )
          .join('')
      : `<tr><td colspan="11" class="muted">${t('Nothing saved for this week yet.')}</td></tr>`);

  const sourceLabel = { truck: '🚚 ' + t('from truck'), manual: '✎ ' + t('typed in') };
  const dates = Object.keys(history).sort().reverse();
  $('#history-days').innerHTML = dates.length
    ? dates
        .slice(0, 60)
        .map((date) => {
          const h = history[date];
          return `<div class="history-day" data-date="${date}">
            <div class="row wrap between"><b>${esc(fmtDateLong(date))}</b>
              <span class="small">${h.stops ? t('{n} stops · {mi} mi', { n: h.stops, mi: Math.round(h.miles || 0) }) : t('no plan in the app')}
              <button class="link danger" data-del="${date}">${t('Delete')}</button></span></div>
            <table><tbody>${(h.drivers || [])
              .map((d, i) => `<tr><td>${esc(d.name)}</td><td class="small">${d.stops ? t('{n} stops', { n: d.stops }) : ''}</td>
                <td><label class="inline small">${t('Back')} <input type="time" data-back="${i}" value="${fmtTimeInput(d.back)}" /></label>
                  <span class="muted small">${sourceLabel[d.source] || t('planned')}</span></td>
                <td class="small">${fmtHours(d.paid)} h</td></tr>`)
              .join('')}</tbody></table>
          </div>`;
        })
        .join('')
    : `<p class="muted">${t('Nothing yet. Every plan you build is saved here under its date.')}</p>`;
}

function changeWeek(monday) {
  historyWeek = monday;
  $('#week-msg').textContent = '';
  renderHistory();
}

$('#week-of').addEventListener('change', (e) => e.target.value && changeWeek(weekStart(e.target.value)));
$('#btn-week-prev').addEventListener('click', () => changeWeek(addDays(historyWeek, -7)));
$('#btn-week-next').addEventListener('click', () => changeWeek(addDays(historyWeek, 7)));

// Payroll: fetch every truck's trips for the week and record each day's real return time.
$('#btn-week-trucks').addEventListener('click', (e) =>
  busy(e.target, async (status) => {
    status(t('Getting truck data…'));
    try {
      const depot = depotPoint();
      if (!depot) throw new Error(t('Set the warehouse location in Settings first — return times are found by the truck arriving there.'));
      if (!(await api.call('geotabStatus')).connected) throw new Error(t('Connect Geotab first (Settings → Truck tracking).'));
      const pairs = truckPairs(await loadDevices());
      const { from } = localDayRange(historyWeek);
      const { to } = localDayRange(addDays(historyWeek, 6));
      const week = await api.call('geotabDay', { deviceIds: pairs.map((p) => p.id), from, to, trail: false });
      const returns = [];
      for (let i = 0; i < 7; i++) {
        const date = addDays(historyWeek, i);
        if (date > localDate()) break;
        const reports = [];
        for (const p of pairs) {
          const trips = (week.trucks[p.id]?.trips || []).filter((tr) => localDate(new Date(tr.start)) === date);
          const r = trips.length ? analyzeDay({ trips, depot, planned: plannedStops(date, p.name), radius: num(settings.geotabRadius, 200) }) : null;
          if (r) reports.push(r);
          if (r?.back != null) returns.push([date, p.name, Math.round(minuteOfDay(r.back))]);
        }
        learnStops(date, reports);
      }
      saveReturns(returns, 'truck');
      renderHistory();
      $('#week-msg').textContent = returns.length ? t('Got {n} return time(s) from the trucks. Times typed in by hand were kept.', { n: returns.length }) : t('No truck returns to the warehouse found for this week.');
    } catch (err) {
      if (err instanceof api.NotLoggedIn) return showLogin(t('Please log in again.'));
      $('#week-msg').innerHTML = errorText(err);
    }
  }),
);

$('#btn-week-csv').addEventListener('click', () => {
  if (!weekRows.length) return alert(t('Nothing to download for this week.'));
  const rate = num(settings.payRate, 14);
  const days = Array.from({ length: 7 }, (_, i) => addDays(historyWeek, i));
  const rows = [
    [t('Driver'), ...days.map((d) => `${DAYS[weekdayOf(d)]} ${d}`), t('Total hours'), t('Regular hours'), t('Overtime hours'), t('Rate'), t('Pay')],
    ...weekRows.map((r) => [r.name, ...r.days.map((m) => (m == null ? '' : fmtHours(m))), fmtHours(r.total), fmtHours(r.total - r.ot), fmtHours(r.ot), rate.toFixed(2), r.pay.toFixed(2)]),
  ];
  download(`payroll-${historyWeek}.csv`, toCsv(rows), 'text/csv');
});

$('#history-days').addEventListener('change', (e) => {
  const input = e.target.closest('[data-back]');
  if (!input) return;
  const date = input.closest('[data-date]').dataset.date;
  const d = store.getHistory()[date].drivers[Number(input.dataset.back)];
  saveReturns([[date, d.name, toMin(input.value)]], 'manual');
  renderHistory();
});
$('#history-days').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del]');
  if (!b || !confirm(t('Delete the saved routes for {date}?', { date: fmtDateLong(b.dataset.del) }))) return;
  store.deleteHistoryDay(b.dataset.del);
  renderHistory();
});

// ---------- Clients tab ----------

function renderClients() {
  const q = $('#client-search').value.trim().toLowerCase();
  const learned = usualDrivers(localDate());
  const learning = isLearning(localDate());
  renderDuplicates();
  const list = clients.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.address || '').toLowerCase().includes(q)).sort(byName);
  $('#client-count').textContent = `(${clients.length})`;
  $('#client-rows').innerHTML = list
    .map(
      (c) => `<tr data-id="${esc(c.id)}">
      <td class="name">${esc(c.name)}</td>
      <td class="addr">${esc(c.address)}${hasLoc(c) ? '' : ` <span class="warn-text">⚠ ${t('not located')}</span>`}</td>
      <td class="small"${label('Days')}>${esc(daysText(c.days))}</td>
      <td class="small"${label('Usual driver')}>${c.homeDriver ? (c.fixedDriver ? '📌 ' : '') + esc(c.homeDriver) : learned.has(c.id) ? `${esc(learned.get(c.id))} <span class="muted">${learning ? t('(learning)') : t('(auto)')}</span>` : '—'}</td>
      <td class="small"${label('Unload')}>${unloadText(c)}</td>
      <td class="small"${label('Hours')}>${hoursText(c)}${Object.keys(c.dayHours || {}).sort().map((w) => `<div class="muted">${DAYS[w]} ${hoursText(hoursOn(c, w))}</div>`).join('')}</td>
      <td class="small"${label('Notes')}>${esc(c.notes || '')}</td>
      <td class="row small-gap actions"><button class="link" data-act="edit">${t('Edit')}</button><button class="link danger" data-act="delete">${t('Delete')}</button></td>
    </tr>`,
    )
    .join('');
}

$('#client-search').addEventListener('input', renderClients);
$('#client-rows').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.closest('tr').dataset.id;
  const c = clients.find((x) => x.id === id);
  if (b.dataset.act === 'edit') openClient(c);
  if (b.dataset.act === 'delete' && confirm(t('Delete {name}?', { name: c.name }))) {
    clients = clients.filter((x) => x.id !== id);
    saveClients();
    renderClients();
  }
});

// ---------- Duplicate clients (QuickBooks names that didn't match) ----------

const STREET_WORDS = { street: 'st', avenue: 'ave', av: 'ave', boulevard: 'blvd', drive: 'dr', road: 'rd', lane: 'ln', north: 'n', south: 's', east: 'e', west: 'w', suite: 'ste' };
const NAME_FILLER = new Set(['the', 'inc', 'llc', 'co', 'corp', 'company', 'and', 'restaurant', 'cafe', 'bar', 'grill', 'de', 'el', 'la', 'los', 'las']);

// The street part of an address, spelled one way ("1037 N Mesa St").
const streetKey = (address) => norm(String(address || '').split(',')[0]).split(' ').map((w) => STREET_WORDS[w] || w).join(' ');
const nameWords = (name) => new Set(norm(name).split(' ').filter((w) => w && !NAME_FILLER.has(w)));

function kmApart(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  return 6371 * Math.hypot(dLat, dLng);
}

// Why two clients look like the same restaurant ({ score, text }), or null.
function sameClientReason(a, b) {
  const why = [];
  let score = 0;
  if (streetKey(a.address) && streetKey(a.address) === streetKey(b.address)) (score += 3), why.push(t('same address'));
  else if (hasLoc(a) && hasLoc(b) && kmApart({ lat: +a.lat, lng: +a.lng }, { lat: +b.lat, lng: +b.lng }) < 0.12) (score += 2), why.push(t('same spot on the map'));
  const wa = nameWords(a.name);
  const wb = nameWords(b.name);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  if (shared && shared / Math.min(wa.size, wb.size) >= 0.5) (score += 1), why.push(t('similar name'));
  return score ? { score, text: why.join(', ') } : null;
}

// Each client QuickBooks added, paired with the existing client it most looks like.
function duplicateSuggestions() {
  const mine = clients.filter((c) => !c.qbId);
  const out = [];
  for (const q of clients.filter((c) => c.id.startsWith('qb-'))) {
    let best = null;
    for (const m of mine) {
      if ((q.notDup || []).includes(m.id)) continue;
      const why = sameClientReason(q, m);
      if (why && (!best || why.score > best.why.score)) best = { m, why };
    }
    if (best) out.push({ q, m: best.m, reason: best.why.text });
  }
  return out;
}

function renderDuplicates() {
  const list = duplicateSuggestions();
  $('#dup-card').hidden = !list.length;
  $('#dup-rows').innerHTML = list
    .map(({ q, m, reason }) => `<div class="dup-row" data-q="${esc(q.id)}" data-m="${esc(m.id)}">
      <div><b>${esc(q.name)}</b> <span class="tag invoice">QuickBooks</span> → <b>${esc(m.name)}</b>
        <div class="muted small">${esc(reason)} · ${esc(q.address || '')}</div></div>
      <div class="row small-gap"><button class="primary" data-dup="merge">${t('Merge')}</button><button class="secondary" data-dup="no">${t('Not the same')}</button></div>
    </div>`)
    .join('');
}

$('#dup-rows').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dup]');
  if (!b) return;
  const row = b.closest('.dup-row');
  const q = clients.find((c) => c.id === row.dataset.q);
  if (b.dataset.dup === 'merge') mergeClient(row.dataset.q, row.dataset.m);
  else if (q) {
    q.notDup = [...(q.notDup || []), row.dataset.m];
    saveClients();
    renderClients();
  }
});

// Moves the stop picked for `dupId` on one day over to `keepId`. True if anything changed.
function mergeSelection(d, dupId, keepId) {
  d.qbSkip = (d.qbSkip || []).map((x) => (x === dupId ? keepId : x));
  const a = d.selected[dupId];
  if (!a) return false;
  const b = d.selected[keepId];
  const qb = [...new Set([...(b?.qb || []), ...(a.qb || [])])];
  d.selected[keepId] = { ...(b || a), ...(qb.length ? { qb } : {}) };
  if (b) delete d.selected[keepId].fromQb; // was already checked: an invoice going away won't uncheck it
  delete d.selected[dupId];
  return true;
}

// Puts `keep` in place of stop `dupId` in a plan (or drops it if `keep` is already there).
// Drivers' "first told" lists are renamed too, so their phones don't show it as new or taken off.
function mergeInPlan(p, dupId, keep) {
  const idx = p.stops.findIndex((s) => s.id === dupId) + 1;
  if (!idx) return false;
  if (p.stops.some((s) => s.id === keep.id)) dropStop(p, idx);
  else Object.assign(p.stops[idx - 1], { id: keep.id, name: keep.name, address: keep.address || p.stops[idx - 1].address, notes: keep.notes || '' });
  for (const [name, list] of Object.entries(p.sent || {})) {
    const seen = new Set();
    p.sent[name] = list
      .map((s) => (s.id === dupId ? { id: keep.id, n: keep.name } : s))
      .filter((s) => !seen.has(s.id) && seen.add(s.id));
  }
  return true;
}

// The same restaurant is in the list twice: keep one, remove the other, and move the QuickBooks
// link, picked stops and route stops of the removed one over. Future invoices go to the kept one.
function mergeClient(dupId, keepId) {
  const dup = clients.find((c) => c.id === dupId);
  const keep = clients.find((c) => c.id === keepId);
  if (!dup || !keep || dup === keep) return;
  if (!confirm(t('Merge "{dup}" into "{keep}"? "{dup}" is removed; its QuickBooks link, orders and route stops move to "{keep}".', { dup: dup.name, keep: keep.name }))) return;
  if (dup.qbId) Object.assign(keep, { qbId: dup.qbId, qbName: dup.qbName || keep.qbName || '' });
  if (!hasLoc(keep) && hasLoc(dup)) Object.assign(keep, { lat: dup.lat, lng: dup.lng, address: keep.address || dup.address });
  keep.formerIds = [...new Set([...(keep.formerIds || []), dupId, ...(dup.formerIds || [])])];
  keep.active = true;
  clients = clients.filter((c) => c !== dup);
  saveClients();
  for (const [date, saved] of Object.entries(store.getDays())) {
    if (date === planDate) continue;
    if (mergeSelection(saved, dupId, keepId)) store.saveDay(date, saved);
  }
  if (day && mergeSelection(day, dupId, keepId)) saveDay();
  for (const saved of Object.values(store.getPlans())) {
    if (saved.deleted) continue;
    const p = saved.date === plan?.date ? plan : saved;
    if (!mergeInPlan(p, dupId, keep)) continue;
    if (p === plan) savePlan();
    else store.savePlan(p);
  }
  renderClients();
  renderResults();
}

const dialog = $('#client-dialog');
const cform = $('#client-form');
let editing = null;

$('#client-days').innerHTML = DAYS.map((d, i) => `<label><input type="checkbox" data-day="${i}" /> ${d}</label>`).join('');
// Monday first, Sunday last
$('#day-hours-rows').innerHTML = `<span></span><span class="muted small">${t('Earliest')}</span><span class="muted small">${t('Latest')}</span>` + [1, 2, 3, 4, 5, 6, 0]
  .map((i) => `<span class="day">${DAYS[i]}</span>
    <input type="time" data-hours-day="${i}" data-side="open" aria-label="${esc(t('Earliest delivery'))} ${DAYS[i]}" />
    <input type="time" data-hours-day="${i}" data-side="close" aria-label="${esc(t('Latest delivery'))} ${DAYS[i]}" />`)
  .join('');

function openClient(c) {
  editing = c || null;
  $('#client-dialog-title').textContent = c ? t('Edit client') : t('Add client');
  cform.reset();
  const v = c || { unload: settings.defaultUnload, days: [false, true, true, true, true, true, false] };
  const learned = c ? usualDrivers(localDate()).get(c.id) : '';
  cform.elements.homeDriver.innerHTML =
    `<option value="">${isLearning(localDate()) ? t('Automatic (learning until {date})', { date: esc(fmtDateLong(settings.learnUntil)) }) : learned ? t('Automatic (now {name})', { name: esc(learned) }) : t('Automatic (from past routes)')}</option>` +
    [...new Set([...settings.drivers.slice(0, MAX_DRIVERS), v.homeDriver].filter(Boolean))].map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  for (const f of ['name', 'address', 'lat', 'lng', 'unload', 'open', 'close', 'notes', 'homeDriver', 'qbName']) cform.elements[f].value = v[f] ?? '';
  cform.querySelectorAll('[data-day]').forEach((cb) => (cb.checked = !!v.days?.[cb.dataset.day]));
  cform.elements.fixedDriver.checked = !!v.fixedDriver;
  const learnedStopTime = c && learnedStop(c);
  const visits = Object.keys(c?.stays || {}).length;
  $('#stop-learned').hidden = !visits;
  $('#stop-learned').textContent = learnedStopTime
    ? settings.learnStops !== false
      ? t('The trucks typically stay {n} min here ({v} visits). Planning uses that instead of the unload time.', { n: learnedStopTime.minutes, v: learnedStopTime.visits })
      : t('The trucks typically stay {n} min here ({v} visits). Turn on real stop times in Settings to plan with it.', { n: learnedStopTime.minutes, v: learnedStopTime.visits })
    : t('{v} visit(s) recorded from the trucks. Planning starts using them after {min}.', { v: visits, min: MIN_VISITS });
  cform.querySelectorAll('[data-hours-day]').forEach((input) => (input.value = v.dayHours?.[input.dataset.hoursDay]?.[input.dataset.side] || ''));
  $('#day-hours').open = Object.keys(v.dayHours || {}).length > 0;
  $('#client-locate-msg').textContent = '';
  $('#merge-row').hidden = !c;
  if (c) $('#merge-into').innerHTML = `<option value="">${t('Choose the client to keep…')}</option>` + clients.filter((x) => x !== c).sort(byName).map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  dialog.showModal();
}

// Looks up the address in a form and fills its latitude/longitude fields.
async function locateInto(form, [addressField, latField, lngField], msgEl) {
  const address = form.elements[addressField].value.trim();
  if (!address) return false;
  msgEl.textContent = t('Looking up…');
  try {
    const g = await locate(address);
    form.elements[latField].value = g.lat;
    form.elements[lngField].value = g.lng;
    msgEl.innerHTML = `${t('Found:')} ${esc(g.formatted)}${g.partial ? ` <span class="warn-text">${t('(partial match, check it)')}</span>` : ''}`;
    return true;
  } catch (err) {
    msgEl.innerHTML = errorText(err);
    return false;
  }
}

// Changing an address clears the old latitude/longitude so it gets looked up again.
function clearLocationOnChange(form, [addressField, latField, lngField]) {
  form.elements[addressField].addEventListener('change', () => {
    form.elements[latField].value = '';
    form.elements[lngField].value = '';
  });
}

const CLIENT_LOC = ['address', 'lat', 'lng'];
$('#btn-add-client').addEventListener('click', () => openClient(null));
$('#btn-cancel-client').addEventListener('click', () => dialog.close());
$('#btn-merge').addEventListener('click', () => {
  const keepId = $('#merge-into').value;
  if (!editing || !keepId) return alert(t('Choose the client to keep.'));
  const id = editing.id;
  mergeClient(id, keepId);
  if (!clients.some((c) => c.id === id)) dialog.close();
});
$('#btn-locate-client').addEventListener('click', () => locateInto(cform, CLIENT_LOC, $('#client-locate-msg')));
clearLocationOnChange(cform, CLIENT_LOC);

cform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = cform.elements;
  if (el.lat.value === '' && settings.apiKey) await locateInto(cform, CLIENT_LOC, $('#client-locate-msg'));
  const data = {
    name: el.name.value.trim(),
    address: el.address.value.trim(),
    lat: el.lat.value === '' ? null : Number(el.lat.value),
    lng: el.lng.value === '' ? null : Number(el.lng.value),
    unload: num(el.unload.value, settings.defaultUnload),
    open: el.open.value,
    close: el.close.value,
    notes: el.notes.value.trim(),
    homeDriver: el.homeDriver.value,
    fixedDriver: el.fixedDriver.checked && !!el.homeDriver.value,
    qbName: el.qbName.value.trim(),
    days: [...cform.querySelectorAll('[data-day]')].map((cb) => cb.checked),
    dayHours: {},
  };
  for (const input of cform.querySelectorAll('[data-hours-day]')) {
    if (input.value) (data.dayHours[input.dataset.hoursDay] ||= {})[input.dataset.side] = input.value;
  }
  // A changed QuickBooks name is linked again by name the next time invoices come in.
  if (editing && (editing.qbName || '') !== data.qbName) data.qbId = '';
  if (editing) Object.assign(editing, data);
  else clients.push({ id: uid(), active: true, ...data });
  saveClients();
  dialog.close();
  renderClients();
  if (day) renderStops();
});

$('#btn-locate-all').addEventListener('click', (e) => {
  if (clients.every(hasLoc)) return alert(t('Every client already has a location.'));
  busy(e.target, async (status) => {
    const { located, failed } = await locateClients(clients, status);
    renderClients();
    alert(t('Located {n} client(s).', { n: located }) + (failed.length ? '\n\n' + t('Problems:') + '\n' + failed.join('\n') : ''));
  });
});

// Column names stay in English so files open the same way in either language.
const CSV_HEADER = ['name', 'address', 'days', 'unload', 'earliest', 'latest', 'notes', 'lat', 'lng'];

$('#btn-export-csv').addEventListener('click', () => {
  const rows = [CSV_HEADER, ...clients.map((c) => [c.name, c.address, daysCode(c.days), c.unload, c.open, c.close, c.notes, c.lat ?? '', c.lng ?? ''])];
  download(`clients-${localDate()}.csv`, toCsv(rows), 'text/csv');
});

$('#csv-template').addEventListener('click', (e) => {
  e.preventDefault();
  download('clients-template.csv', toCsv([CSV_HEADER, ['Example Cafe', '123 Main St, El Paso, TX', 'Mon Wed Fri', '10', '', '13:00', 'Back door', '', '']]), 'text/csv');
});

// "1pm", "13:00", "9:30 am" -> "13:00"
function csvTime(text) {
  const m = String(text).trim().match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
  if (!m) return '';
  let h = Number(m[1]);
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2] || '00'}`;
}

$('#btn-import-csv').addEventListener('click', async () => {
  const text = await pickFile('.csv,text/csv');
  if (!text) return;
  const rows = parseCsv(text);
  if (rows.length < 2) return alert(t('That file has no client rows.'));
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const ix = {
    name: col('name', 'client', 'restaurant', 'nombre', 'cliente'),
    address: col('address', 'addr', 'dirección', 'direccion'),
    days: col('days', 'day', 'schedule', 'días', 'dias'),
    unload: col('unload', 'unload minutes', 'service', 'minutes', 'descarga'),
    open: col('earliest', 'open', 'opens'),
    close: col('latest', 'close', 'closes'),
    notes: col('notes', 'note', 'notas'),
    lat: col('lat', 'latitude'),
    lng: col('lng', 'lon', 'long', 'longitude'),
  };
  if (ix.name < 0 || ix.address < 0) return alert(t('The first row must include "name" and "address" columns.'));
  const get = (r, k) => (ix[k] >= 0 ? (r[ix[k]] || '').trim() : '');
  let added = 0;
  let updated = 0;
  for (const r of rows.slice(1)) {
    const name = get(r, 'name');
    if (!name) continue;
    const data = {
      name,
      address: get(r, 'address'),
      days: parseDays(get(r, 'days')),
      unload: num(get(r, 'unload'), settings.defaultUnload),
      open: csvTime(get(r, 'open')),
      close: csvTime(get(r, 'close')),
      notes: get(r, 'notes'),
      lat: get(r, 'lat') === '' ? null : Number(get(r, 'lat')),
      lng: get(r, 'lng') === '' ? null : Number(get(r, 'lng')),
    };
    const existing = clients.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (existing.address !== data.address && data.lat == null) {
        existing.lat = null;
        existing.lng = null;
      }
      for (const [k, v] of Object.entries(data)) if (v != null) existing[k] = v;
      updated++;
    } else {
      clients.push({ id: uid(), active: true, ...data });
      added++;
    }
  }
  saveClients();
  renderClients();
  const missing = clients.filter((c) => !hasLoc(c)).length;
  alert(t('Imported: {added} new, {updated} updated.', { added, updated }) + (missing ? '\n\n' + t('{n} client(s) still need a map location — click "Find missing locations".', { n: missing }) : ''));
});

// ---------- QuickBooks settings (admin) ----------

function renderQbSettings() {
  const qb = store.getQb();
  $('#qb-status').innerHTML = qb?.lastSeen
    ? `${Date.now() - qb.lastSeen > QB_STALE_MIN * 60000 ? '⚠' : '✓'} ${t('The helper last sent invoices {time}.', { time: new Date(qb.lastSeen).toLocaleString(locale) })}`
    : `<span class="muted">${t('Not connected yet.')}</span>`;
}

// A new key (the old one stops working) in a small file the helper reads, next to qb-sync.ps1.
$('#btn-qb-key').addEventListener('click', (e) => {
  if (store.getQb()?.lastSeen && !confirm(t('Make a new key? The helper on the office PC stops working until it gets the new settings file.'))) return;
  busy(e.currentTarget, async () => {
    try {
      const { key } = await api.call('qbKey');
      download('qb-settings.json', JSON.stringify({ server: api.getServerUrl(), key }, null, 2), 'application/json');
      $('#qb-key-msg').textContent = t('Saved qb-settings.json. Put it in the same folder as qb-sync.ps1 on the office PC.');
    } catch (err) {
      $('#qb-key-msg').innerHTML = errorText(err);
    }
  });
});

// ---------- Settings tab ----------

const sform = $('#settings-form');
const SETTING_FIELDS = [
  'depotName', 'depotAddress', 'depotLat', 'depotLng', 'shiftStart', 'start', 'latestReturn', 'payRate',
  'regularHoursPerDay', 'regularHoursPerWeek', 'fuelPerMile', 'defaultUnload', 'priorityBy', 'apiKey',
  'trafficTime', 'monthlyElementLimit', 'monthlyGeocodeLimit', 'orderCutoff', 'keepWithDriver', 'learnUntil',
];
const NUMERIC = new Set(['depotLat', 'depotLng', 'payRate', 'regularHoursPerDay', 'regularHoursPerWeek', 'fuelPerMile', 'defaultUnload', 'monthlyElementLimit', 'monthlyGeocodeLimit', 'keepWithDriver']);
const DEPOT_LOC = ['depotAddress', 'depotLat', 'depotLng'];

function renderSettings() {
  $('#learn-line').textContent = isLearning(localDate())
    ? t('Learning now (since {from}): routes are planned the cheapest way each day, and each area keeps the same driver from day to day. After {until}, each client stays with the driver they had most often.', { from: fmtDateLong(settings.learnFrom || localDate()), until: fmtDateLong(settings.learnUntil) })
    : t('Usual drivers are learned from routes since {from}. Pick a date above to plan freely and learn again until then.', { from: settings.learnFrom ? fmtDateLong(settings.learnFrom) : '—' });
  renderGeotabSettings();
  renderQbSettings();
  for (const f of SETTING_FIELDS) sform.elements[f].value = settings[f] ?? '';
  const u = store.getUsage();
  $('#usage-line').textContent = t('This month: {e} of {el} drive-time lookups and {g} of {gl} address lookups used (counted by this browser).', {
    e: u.elements,
    el: settings.monthlyElementLimit,
    g: u.geocodes,
    gl: settings.monthlyGeocodeLimit,
  });
  $('#matrix-line').textContent = t('{n} drive times saved. Daily planning reuses them, so it normally makes no Google requests.', { n: Object.keys(store.getMatrixCache()).length });
  const sync = store.getSyncState();
  $('#sync-line').innerHTML = sync.error
    ? `<span class="bad-text">${t('Last save to the Google Sheet failed:')} ${esc(sync.error)}</span>`
    : sync.last
      ? t('Saved to the Google Sheet. Last synced {when}.', { when: new Date(sync.last).toLocaleString(locale) })
      : t('Not synced yet.');
}

sform.addEventListener('click', (e) => {
  const b = e.target.closest('[data-reveal]');
  if (!b) return;
  const input = sform.elements[b.dataset.reveal];
  input.type = input.type === 'password' ? 'text' : 'password';
  b.textContent = input.type === 'password' ? t('Show') : t('Hide');
});

$('#btn-locate-depot').addEventListener('click', () => locateInto(sform, DEPOT_LOC, $('#settings-saved')));
clearLocationOnChange(sform, DEPOT_LOC);

sform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = sform.elements;
  el.apiKey.value = el.apiKey.value.trim();
  if (el.depotLat.value === '' && el.apiKey.value) {
    settings.apiKey = el.apiKey.value;
    await locateInto(sform, DEPOT_LOC, $('#settings-saved'));
  }
  // A learning period set after the last one ended starts learning afresh from today.
  if (el.learnUntil.value && el.learnUntil.value !== settings.learnUntil && !isLearning(localDate())) settings.learnFrom = localDate();
  for (const f of SETTING_FIELDS) {
    const v = el[f].value;
    settings[f] = NUMERIC.has(f) ? (v === '' ? (f.startsWith('depot') ? null : store.DEFAULT_SETTINGS[f]) : Number(v)) : v;
  }
  saveSettings();
  renderSettings();
  renderDriverRows();
  $('#settings-saved').textContent = settings.depotLat == null ? t('Saved — but the warehouse still has no location.') : t('Saved.');
});

$('#btn-sync-now').addEventListener('click', async () => {
  await syncNow();
  renderSettings();
});

$('#btn-preload').addEventListener('click', (e) => {
  if (!settings.apiKey) return alert(t('Add a Google API key first.'));
  const depot = depotPoint();
  if (!depot) return alert(t('Set the warehouse location first.'));
  const points = [depot, ...clients.filter((c) => c.active !== false && hasLoc(c)).map((c) => ({ lat: Number(c.lat), lng: Number(c.lng) }))];
  const need = missingPlan(points, store.getMatrixCache());
  if (!need.elements) return alert(t('All drive times are already saved.'));
  if (!confirm(t('This looks up {n} drive times (this month so far: {used} of your {limit} limit). Continue?', { n: need.elements, used: store.getUsage().elements, limit: settings.monthlyElementLimit }))) return;
  busy(e.target, async (status) => {
    await ensureDriveTimes(points, status);
    renderSettings();
  });
});

$('#btn-clear-matrix').addEventListener('click', () => {
  if (!confirm(t('Forget all saved drive times? They will be looked up again from Google (using your free monthly amount) the next time you plan.'))) return;
  store.saveMatrixCache({});
  renderSettings();
});

$('#btn-backup').addEventListener('click', () => {
  download(`route-planner-backup-${localDate()}.json`, JSON.stringify(store.exportBackup()), 'application/json');
});

$('#btn-restore').addEventListener('click', async () => {
  const text = await pickFile('.json,application/json');
  if (!text) return;
  try {
    const data = JSON.parse(text);
    if (!confirm(t('Replace your clients and settings with the backup from {date}?', { date: data.exported?.slice(0, 10) || '?' }))) return;
    store.importBackup(data);
    reloadFromStore();
    alert(t('Backup restored.'));
  } catch (err) {
    alert(t('Could not restore:') + ' ' + err.message);
  }
});

// Re-read everything after a restore or a sync brought in changes.
function reloadFromStore() {
  settings = store.getSettings();
  clients = store.getClients();
  if (role() === 'driver') return renderDriverView();
  renderPlanControls();
  renderBanner();
  // Another computer may have picked stops or changed the routes for this day.
  day = store.getDay(planDate) || day;
  if (day) day.weekHours ||= {};
  const shared = store.getPlan(planDate);
  if (shared?.updated !== plan?.updated) suggestion = null;
  plan = shared;
  const tab = currentTab();
  if (tab === 'settings') renderSettings();
  else if (tab === 'clients') renderClients();
  else if (tab === 'history') renderHistory();
  renderStops();
  renderDriverRows();
  if (tab === 'plan') renderResults();
}

// ---------- Driver login view ----------

let driverDate = null;

function renderDriverView() {
  const me = api.getSession()?.user;
  const routes = store.getRoutes();
  const dates = Object.keys(routes).filter((d) => routes[d].drivers?.[me.driverName]).sort();
  const today = localDate();
  if (!dates.includes(driverDate)) driverDate = dates.includes(today) ? today : dates[dates.length - 1] || null;
  $('#driver-days').innerHTML = dates
    .map((d) => `<button class="${d === driverDate ? 'primary' : 'secondary'}" data-day="${d}">${d === today ? t('Today') : esc(fmtDateLong(d))}</button>`)
    .join('');
  const el = $('#driver-route');
  if (!me.driverName) {
    el.innerHTML = `<p class="card">${t('Your account is not linked to a driver name yet. Ask the admin.')}</p>`;
    return;
  }
  if (!driverDate) {
    el.innerHTML = `<p class="card">${t("No route for you yet, {name}. The office will send it after building today's routes — this page checks every minute.", { name: esc(me.driverName) })}</p>`;
    return;
  }
  const done = store.getDone()[driverDate]?.[me.driverName] || {};
  renderRoute(el, routes[driverDate].drivers[me.driverName], done, async (stopId, isDone) => {
    // Show it right away, then save it on the server.
    const all = store.getDone();
    const mine = ((all[driverDate] ||= {})[me.driverName] ||= {});
    if (isDone) mine[stopId] = Date.now();
    else delete mine[stopId];
    store.saveDone(all);
    renderDriverView();
    try {
      const r = await api.call('done', { date: driverDate, stopId, done: isDone });
      all[driverDate][me.driverName] = r.done;
      store.saveDone(all);
    } catch (err) {
      if (err instanceof api.NotLoggedIn) return showLogin();
      alert(t('Could not save that — check the connection and try again.') + '\n' + err.message);
    }
  });
}

$('#driver-days').addEventListener('click', (e) => {
  const b = e.target.closest('[data-day]');
  if (!b) return;
  driverDate = b.dataset.day;
  renderDriverView();
});

// ---------- Trucks tab (admin, MyGeotab) ----------

let trucksMap = null;
let trucksTimer = null;
let geotabDeviceList = null;

async function loadDevices() {
  if (!geotabDeviceList) geotabDeviceList = (await api.call('geotabDevices')).devices;
  return geotabDeviceList;
}

// Every truck: drivers' trucks first (named after the driver, in driver order), then the rest.
function truckPairs(devices) {
  const byDevice = new Map();
  for (const name of settings.drivers) {
    const id = settings.trucks?.[name];
    if (id && !byDevice.has(id)) byDevice.set(id, name);
  }
  return devices
    .map((d) => ({ id: d.id, device: d, name: byDevice.get(d.id) || d.name, driver: byDevice.has(d.id) }))
    .sort((a, b) => (b.driver - a.driver) || (a.driver ? settings.drivers.indexOf(a.name) - settings.drivers.indexOf(b.name) : 0));
}

// The stops a driver's truck was supposed to make on `date`, to match against its trips.
function plannedStops(date, name) {
  const byId = new Map(clients.map((c) => [c.id, c]));
  return (store.getRoutes()[date]?.drivers?.[name]?.stops || [])
    .map((s) => {
      const c = byId.get(s.id);
      return c && hasLoc(c) ? { id: s.id, name: s.n, lat: Number(c.lat), lng: Number(c.lng), plannedArrive: s.t } : null;
    })
    .filter(Boolean);
}

// How long each truck stayed at each client it delivered to on `date` (see stays.js).
// Visits still going on (no departure yet) don't count.
function learnStops(date, reports) {
  const visits = reports.flatMap((r) => r.visits.filter((v) => v.visited && v.leave != null).map((v) => ({ id: v.id, minutes: v.minutes })));
  if (recordStays(clients, date, visits)) saveClients();
}

// When an admin opens the planner, it reads the past week's truck days it hasn't read yet:
// real return times for payroll, and real stop times for planning.
async function readPastTruckDays() {
  const depot = depotPoint();
  if (role() !== 'admin' || !depot) return;
  const routes = store.getRoutes();
  const dates = Array.from({ length: 7 }, (_, i) => addDays(localDate(), -1 - i)).filter((d) => routes[d] && !store.getHistory()[d]?.trucksRead);
  if (!dates.length) return;
  try {
    if (!(await api.call('geotabStatus')).connected) return;
    const pairs = truckPairs(await loadDevices());
    for (const date of dates) {
      const data = await api.call('geotabDay', { deviceIds: pairs.map((p) => p.id), ...localDayRange(date), trail: false });
      const returns = [];
      const reports = [];
      for (const p of pairs) {
        const trips = data.trucks[p.id]?.trips || [];
        if (!trips.length) continue;
        const r = analyzeDay({ trips, depot, planned: plannedStops(date, p.name), radius: num(settings.geotabRadius, 200) });
        reports.push(r);
        if (r.back != null) returns.push([date, p.name, Math.round(minuteOfDay(r.back))]);
      }
      saveReturns(returns, 'truck');
      learnStops(date, reports);
      const history = store.getHistory();
      history[date] = { drivers: [], ...history[date], trucksRead: true, updated: Date.now() };
      store.saveHistory(history);
    }
  } catch (err) {
    console.error(err); // tried again next time the planner opens
  }
}

function localDayRange(date) {
  const [y, m, d] = date.split('-').map(Number);
  return { from: new Date(y, m - 1, d).toISOString(), to: new Date(y, m - 1, d + 1).toISOString() };
}

function stateText(live) {
  if (!live) return `<span class="muted">${t('No live position')}</span>`;
  const mins = Math.round(parseDuration(live.stateFor));
  const age = (Date.now() - Date.parse(live.at)) / 60000;
  if (!live.communicating || age > 30) return `<span class="tag warn">${t('No signal')}</span> ${t('last seen {time}', { time: timeOf(Date.parse(live.at)) })}`;
  return live.driving
    ? `<span class="tag good">${t('Driving')}</span> ${t('{mph} mph · for {dur}', { mph: Math.round(live.speed * 0.621371), dur: fmtDur(mins) })}`
    : `<span class="tag warn">${t('Stopped')}</span> ${t('for {dur}', { dur: fmtDur(mins) })}`;
}

function timeOf(ms) {
  return ms == null ? '—' : fmtTime(minuteOfDay(ms));
}

async function renderTrucks() {
  clearTimeout(trucksTimer);
  const status = (s) => ($('#trucks-status').textContent = s);
  const note = $('#trucks-note');
  const cards = $('#truck-cards');
  if (!$('#trucks-date').value) $('#trucks-date').value = localDate();
  const date = $('#trucks-date').value;
  const today = date === localDate();
  status(t('Loading…'));
  try {
    if (!(await api.call('geotabStatus')).connected) {
      note.innerHTML = t('Geotab is not connected yet. Go to <a href="#" data-goto="settings">Settings → Truck tracking</a>.');
      cards.innerHTML = '';
      return status('');
    }
    const pairs = truckPairs(await loadDevices());
    if (!pairs.length) {
      note.textContent = t('No trucks found in Geotab.');
      cards.innerHTML = '';
      return status('');
    }
    const [dayData, live] = await Promise.all([
      api.call('geotabDay', { deviceIds: pairs.map((p) => p.id), ...localDayRange(date) }),
      today ? api.call('geotabLive') : Promise.resolve({ trucks: [] }),
    ]);
    const routes = store.getRoutes()[date]?.drivers || {};
    const depot = depotPoint();
    const returns = [];
    const rows = pairs.map((p, i) => {
      const route = routes[p.name];
      const planned = plannedStops(date, p.name);
      const truck = dayData.trucks[p.id] || { trips: [], trail: [] };
      const report = analyzeDay({ trips: truck.trips, depot, planned, radius: num(settings.geotabRadius, 200) });
      if (report.back != null) returns.push([date, p.name, Math.round(minuteOfDay(report.back))]);
      return { ...p, color: COLORS[i % COLORS.length], route, report, trail: truck.trail, live: live.trucks.find((x) => x.id === p.id) };
    });
    const changed = saveReturns(returns, 'truck');
    learnStops(date, rows.map((r) => r.report));
    note.textContent =
      (today ? t('Live positions update every minute while this page is open. Return times feed into History automatically.') : t('Return times from the trucks are used in History (unless someone typed a time there).')) +
      (changed ? ' ' + t('History was updated with real return times.') : '');
    renderTrucksMap(rows, depot);
    cards.innerHTML = rows.map((r) => truckCard(r, today)).join('');
    status(t('Updated {time}', { time: timeOf(Date.now()) }));
  } catch (err) {
    if (err instanceof api.NotLoggedIn) return showLogin(t('Please log in again.'));
    status('');
    note.innerHTML = errorText(err);
  } finally {
    if (today && currentTab() === 'trucks') trucksTimer = setTimeout(renderTrucks, 60000);
  }
}

function truckCard(tr, today) {
  const r = tr.report;
  const visited = r.visits.filter((v) => v.visited).length;
  const visitRows = r.visits
    .map((v, n) => {
      let tag = `<span class="tag">${t('Not reached')}</span>`;
      if (v.visited) {
        tag =
          v.lateBy > 10
            ? `<span class="tag bad">${t('{n} min late', { n: Math.round(v.lateBy) })}</span>`
            : v.lateBy < -10
              ? `<span class="tag">${t('{n} min early', { n: Math.round(-v.lateBy) })}</span>`
              : `<span class="tag good">${t('On time')}</span>`;
      }
      return `<tr><td>${n + 1}</td><td>${esc(v.name)}</td><td>${fmtTime(v.plannedArrive)}</td>
        <td>${v.visited ? timeOf(v.arrive) : '—'}</td><td>${v.visited ? fmtDur(v.minutes) : ''}</td><td>${tag}</td></tr>`;
    })
    .join('');
  const unplanned = r.unplanned
    .map((u) => `<li>${timeOf(u.arrive)} · ${t('stopped {dur}', { dur: fmtDur(u.minutes) })} · <a href="https://www.google.com/maps?q=${u.lat},${u.lng}" target="_blank" rel="noopener">${t('see place')}</a></li>`)
    .join('');
  const head = ['#', 'Client', 'Planned', 'Arrived', 'Stayed', ''].map((h) => `<th>${h && h !== '#' ? t(h) : h}</th>`).join('');
  return `<div class="card driver truck-card" style="--route:${tr.color}">
    <div class="row between"><h3>${tr.driver ? esc(tr.name) : `🚚 ${esc(tr.name)}`}</h3><span class="muted small">${tr.driver ? `🚚 ${esc(tr.device.name)}` : t('no driver assigned')}</span></div>
    ${today ? `<div class="live">${stateText(tr.live)}</div>` : ''}
    <div class="stats">
      <span>${t('Left')} <b>${timeOf(r.left)}</b></span>
      <span>${t('Back')} <b>${r.back != null ? timeOf(r.back) : r.stillOut ? t('still out') : '—'}</b></span>
      <span>${t('Driving')} <b>${fmtDur(r.driveMin)}</b></span>
      <span>${t('Idling')} <b>${fmtDur(r.idleMin)}</b></span>
      <span><b>${r.miles.toFixed(0)}</b> mi</span>
      ${tr.route ? `<span>${t('Stops')} <b>${t('{n} of {total}', { n: visited, total: r.visits.length })}</b></span>` : ''}
    </div>
    ${tr.route ? `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${visitRows}</tbody></table></div>` : `<p class="muted small">${t('No planned route for this driver on this day.')}</p>`}
    ${r.unplanned.length ? `<h4>${t("Stops that weren't on the route ({n})", { n: r.unplanned.length })}</h4><ul class="small">${unplanned}</ul>` : ''}
  </div>`;
}

function renderTrucksMap(rows, depot) {
  trucksMap = mapIn($('#trucks-map'), trucksMap);
  if (!trucksMap) return;
  const layer = trucksMap.layer;
  const pts = [];
  if (depot) {
    pts.push([depot.lat, depot.lng]);
    depotPin(layer, depot, depotName());
  }
  for (const tr of rows) {
    if (tr.trail.length > 1) L.polyline(tr.trail, { color: tr.color, weight: 3, opacity: 0.7 }).addTo(layer);
    pts.push(...tr.trail);
    for (const v of tr.report.visits) {
      pts.push([v.lat, v.lng]);
      const info = v.visited ? t('arrived {time}, stayed {dur}', { time: timeOf(v.arrive), dur: fmtDur(v.minutes) }) : t('not reached');
      pin(layer, [v.lat, v.lng], `<div class="plan-pin ${v.visited ? 'hit' : ''}" style="--route:${tr.color}"></div>`, 16, `<b>${esc(v.name)}</b><br>${esc(tr.name)} · ${t('planned {time}', { time: fmtTime(v.plannedArrive) })}<br>${info}`);
    }
    if (tr.live?.lat != null) {
      pts.push([tr.live.lat, tr.live.lng]);
      pin(layer, [tr.live.lat, tr.live.lng], `<div class="truck-pin"><div class="dot" style="background:${tr.color}">🚚</div><span class="label">${esc(tr.name)}</span></div>`, 28, `<b>${esc(tr.name)}</b> · ${esc(tr.device.name)}<br>${stateText(tr.live)}`, 2000);
    }
  }
  fit(trucksMap, pts);
}

$('#trucks-date').addEventListener('change', renderTrucks);
$('#btn-trucks-refresh').addEventListener('click', renderTrucks);

// Settings → Truck tracking
async function renderGeotabSettings() {
  $('#g-radius').value = num(settings.geotabRadius, 200);
  $('#g-learn-stops').checked = settings.learnStops !== false;
  let st;
  try {
    st = await api.call('geotabStatus');
  } catch (err) {
    $('#geotab-status').innerHTML = errorText(err);
    return;
  }
  $('#btn-geotab-clear').hidden = !st.connected;
  $('#btn-geotab-save').textContent = st.connected ? t('Change login') : t('Connect');
  $('#truck-assign').hidden = !st.connected;
  $('#geotab-status').innerHTML = st.connected ? `<span class="tag good">${t('Connected')}</span> ${esc(st.userName)} · ${esc(st.database)}` : t('Not connected.');
  if (!st.connected) return;
  $('#g-server').value = st.server;
  $('#g-database').value = st.database;
  $('#g-user').value = st.userName;
  try {
    const devices = await loadDevices();
    const lastAssigned = Math.max(0, ...settings.drivers.map((n, i) => (settings.trucks?.[n] ? i + 1 : 0)));
    const names = settings.drivers.slice(0, Math.max(settings.driverCount + 1, lastAssigned));
    $('#truck-rows').innerHTML = names
      .map((n) => `<tr><td>${esc(n)}</td><td><select data-truck="${esc(n)}"><option value="">${t('— no truck —')}</option>${devices
        .map((d) => `<option value="${esc(d.id)}" ${settings.trucks?.[n] === d.id ? 'selected' : ''}>${esc(d.name)}${d.plate ? ` (${esc(d.plate)})` : ''}</option>`)
        .join('')}</select></td></tr>`)
      .join('');
  } catch (err) {
    $('#truck-rows').innerHTML = `<tr><td>${errorText(err)}</td></tr>`;
  }
}

$('#btn-geotab-save').addEventListener('click', (e) =>
  busy(e.target, async () => {
    $('#geotab-status').textContent = t('Checking with Geotab…');
    try {
      await api.call('geotabSave', { server: $('#g-server').value, database: $('#g-database').value, userName: $('#g-user').value, password: $('#g-pass').value });
      $('#g-pass').value = '';
      geotabDeviceList = null;
    } catch (err) {
      $('#geotab-status').innerHTML = errorText(err);
      return;
    }
    await renderGeotabSettings();
  }),
);

$('#btn-geotab-clear').addEventListener('click', async () => {
  if (!confirm(t('Disconnect Geotab? Truck tracking stops until you connect again.'))) return;
  await api.call('geotabSave', { clear: true });
  geotabDeviceList = null;
  renderGeotabSettings();
});

$('#truck-rows').addEventListener('change', (e) => {
  const sel = e.target.closest('[data-truck]');
  if (!sel) return;
  settings.trucks = { ...(settings.trucks || {}), [sel.dataset.truck]: sel.value };
  saveSettings();
});

$('#g-radius').addEventListener('change', (e) => {
  settings.geotabRadius = num(e.target.value, 200);
  saveSettings();
});
$('#g-learn-stops').addEventListener('change', (e) => {
  settings.learnStops = e.target.checked;
  saveSettings();
});

// ---------- Users tab (admin) ----------

let users = [];
let editingUser = null;
const uform = $('#user-form');

function showDriverNameField() {
  $('#user-driver-name').hidden = uform.elements.role.value !== 'driver';
}

async function renderUsers() {
  uform.elements.driverName.innerHTML = settings.drivers.map((n) => `<option>${esc(n)}</option>`).join('');
  showDriverNameField();
  try {
    users = (await api.call('listUsers')).users;
  } catch (err) {
    $('#user-rows').innerHTML = `<tr><td colspan="4">${errorText(err)}</td></tr>`;
    return;
  }
  const me = api.getSession()?.user?.username;
  $('#user-rows').innerHTML = users
    .map((u) => `<tr data-user="${esc(u.username)}"><td><b>${esc(u.username)}</b>${u.username === me ? ` <span class="muted small">${t('(you)')}</span>` : ''}</td>
      <td${label('Role')}>${ROLE_LABEL[u.role]}</td><td${label('Driver name')}>${esc(u.driverName || '')}</td>
      <td class="row small-gap actions"><button class="link" data-uact="edit">${t('Edit / reset password')}</button>${u.username === me ? '' : `<button class="link danger" data-uact="delete">${t('Remove')}</button>`}</td></tr>`)
    .join('');
}

function resetUserForm() {
  editingUser = null;
  uform.reset();
  uform.elements.username.disabled = false;
  $('#user-form-title').textContent = t('Add a person');
  $('#btn-user-cancel').hidden = true;
  showDriverNameField();
}

uform.elements.role.addEventListener('change', showDriverNameField);
$('#btn-user-cancel').addEventListener('click', resetUserForm);

$('#user-rows').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-uact]');
  if (!b) return;
  const u = users.find((x) => x.username === b.closest('tr').dataset.user);
  if (b.dataset.uact === 'edit') {
    editingUser = u;
    const el = uform.elements;
    el.username.value = u.username;
    el.username.disabled = true;
    el.role.value = u.role;
    if (u.driverName && !settings.drivers.includes(u.driverName)) el.driverName.insertAdjacentHTML('beforeend', `<option>${esc(u.driverName)}</option>`);
    el.driverName.value = u.driverName || settings.drivers[0];
    el.password.value = '';
    $('#user-form-title').textContent = t('Edit {name}', { name: u.username });
    $('#btn-user-cancel').hidden = false;
    showDriverNameField();
    uform.scrollIntoView({ behavior: 'smooth' });
  }
  if (b.dataset.uact === 'delete' && confirm(t('Remove {name}? They will be logged out everywhere.', { name: u.username }))) {
    try {
      await api.call('deleteUser', { username: u.username });
    } catch (err) {
      alert(err.message);
    }
    renderUsers();
  }
});

uform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = uform.elements;
  const user = { username: editingUser ? editingUser.username : el.username.value, role: el.role.value, driverName: el.driverName.value, password: el.password.value };
  if (!editingUser && !user.password) return ($('#user-msg').textContent = t('Give them a password.'));
  try {
    await api.call('saveUser', { user });
    $('#user-msg').textContent = t('Saved {name}.', { name: user.username });
    resetUserForm();
    renderUsers();
  } catch (err) {
    $('#user-msg').textContent = err.message;
  }
});

// ---------- Login ----------

const lform = $('#login-form');
let loginMode = 'login'; // 'login' | 'setup' (first admin) | 'recover' (admin recovery)

function setLoginMode(mode) {
  loginMode = mode;
  $('#setup-box').hidden = mode === 'login';
  $('#setup-first').hidden = mode !== 'setup';
  $('#setup-recover').hidden = mode !== 'recover';
  $('#login-btn').textContent = { login: t('Log in'), setup: t('Create admin account'), recover: t('Make admin and log in') }[mode];
}

function loginMessage(msg, bad = true) {
  $('#login-msg').textContent = msg;
  $('#login-msg').className = 'small' + (msg && bad ? ' bad' : '');
}

async function showLogin(msg = '') {
  document.body.classList.add('logged-out');
  delete document.body.dataset.role;
  loginMessage(msg);
  const url = api.getServerUrl();
  lform.elements.server.value = url;
  $('#server-box').hidden = !!url;
  setLoginMode('login');
  if (!url) return;
  try {
    if ((await api.call('status')).needsSetup) setLoginMode('setup');
  } catch (err) {
    $('#server-box').hidden = false;
    loginMessage(err.message);
  }
}

$('#recover-admin').addEventListener('click', (e) => {
  e.preventDefault();
  setLoginMode(loginMode === 'recover' ? 'login' : 'recover');
  loginMessage('');
});

$('#change-server').addEventListener('click', (e) => {
  e.preventDefault();
  $('#server-box').hidden = false;
  lform.elements.server.focus();
});

lform.elements.server.addEventListener('change', () => {
  api.setServerUrl(lform.elements.server.value);
  showLogin();
});

lform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = lform.elements;
  if (el.server.value.trim() && el.server.value.trim() !== api.getServerUrl()) {
    api.setServerUrl(el.server.value);
    await showLogin();
    if (loginMode === 'setup') return;
  }
  if (!api.getServerUrl()) return showLogin(t('Enter the server address first.'));
  $('#login-btn').disabled = true;
  try {
    const login = { login: api.login, setup: api.setupAdmin, recover: api.recoverAdmin }[loginMode];
    const user = loginMode === 'login' ? await login(el.username.value, el.password.value) : await login(el.setupCode.value, el.username.value, el.password.value);
    lform.reset();
    store.setSyncState({ last: null, error: '' });
    await enterApp(user);
  } catch (err) {
    loginMessage(err.message);
  } finally {
    $('#login-btn').disabled = false;
  }
});

$('#btn-logout').addEventListener('click', async () => {
  if (!confirm(t('Log out? This computer will forget the saved data until someone logs in again (it stays safe in the Google Sheet).'))) return;
  await api.logout();
  location.reload();
});

$('#btn-password').addEventListener('click', async () => {
  const oldPassword = prompt(t('Current password:'));
  if (!oldPassword) return;
  const newPassword = prompt(t('New password (at least 6 characters):'));
  if (!newPassword) return;
  try {
    await api.call('changePassword', { oldPassword, newPassword });
    alert(t('Password changed.'));
  } catch (err) {
    alert(err.message);
  }
});

async function enterApp(user) {
  document.body.classList.remove('logged-out');
  document.body.dataset.role = user.role;
  $('#who').textContent = `${user.username} · ${ROLE_LABEL[user.role]}`;
  await initSync({
    remoteChanged: reloadFromStore,
    qbChanged: (changed) => (changed ? applyQuickBooks() : day && renderQbNote()),
    status: (s) => ($('#sync-status').textContent = s),
    loggedOut: () => showLogin(t('Please log in again.')),
  });
  if (document.body.classList.contains('logged-out')) return;
  settings = store.getSettings();
  clients = store.getClients();
  if (user.role === 'driver') return showTab('driver');
  renderPlanControls();
  loadDay(planDate);
  applyQuickBooks();
  readPastTruckDays().then(() => currentTab() === 'clients' && renderClients());
  renderBanner();
  renderResults();
  showTab('plan');
}

// ---------- Start ----------

translatePage();
document.querySelectorAll('.lang-slot').forEach((slot) => slot.append(langSwitch()));
const session = api.getSession();
if (api.getServerUrl() && session) enterApp(session.user);
else showLogin();
