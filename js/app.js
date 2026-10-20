import * as store from './store.js';
import { geocode } from './google.js';
import { missingPlan, fillMissing, assemble, nextTrafficDeparture } from './matrix.js';
import { solve, summarize, insertStop } from './solver.js';
import { overtimeStart, laborCost, minutesBefore, weekSummary, recordReturn } from './pay.js';
import { encodeRoute } from './share.js';
import { initSync, syncNow } from './sync.js';
import * as api from './api.js';
import { renderRoute } from './routeview.js';
import { analyzeDay, parseDuration, minuteOfDay } from './tracking.js';
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

// ---------- Solver (in a background worker when possible) ----------

let worker = null;
let seq = 0;
const pending = new Map();

function solveInWorker(problem, options) {
  if (!worker) {
    worker = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
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
function problemFor(p, k) {
  return {
    ...p.problem,
    shiftStart: p.shiftStart,
    start: p.start,
    endBy: p.endBy,
    otAt: p.otAt.slice(0, k),
    fuelPerMile: p.payRate ? p.fuelPerMile / (p.payRate / 60) : 0,
    vehicles: k,
  };
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
      <td><input data-driver="${i}" value="${esc(driverName(i))}" />${extra}</td>
      <td><input class="hours" type="number" step="0.25" min="0" data-hours="${i}" value="${typed != null && typed !== '' ? esc(typed) : fmtHours(before)}" /> h</td>
      <td class="small">${fmtTime(overtimeStart({ ...rules, weekBeforeMin: before }))}</td>
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
  $('#stop-rows').innerHTML = list
    .map((c) => {
      const s = day.selected[c.id];
      return `<tr data-id="${esc(c.id)}" class="${s ? 'selected' : ''}">
        <td><input type="checkbox" data-f="on" ${s ? 'checked' : ''} aria-label="${esc(c.name)}" /></td>
        <td class="name">${esc(c.name)}${isScheduled(c, weekday) ? ` <span class="tag good">${t('regular today')}</span>` : ''}<div class="addr">${esc(c.address)}${hasLoc(c) ? '' : ` <span class="warn-text">⚠ ${t('not located')}</span>`}</div></td>
        <td class="small">${esc(daysText(c.days))}</td>
        <td class="small">${num(c.unload, settings.defaultUnload)} min</td>
        <td><input type="checkbox" data-f="priority" ${s?.priority ? 'checked' : ''} ${s ? '' : 'disabled'} aria-label="${t('Priority')}" /></td>
        <td><input type="time" data-f="by" value="${esc(s?.by || settings.priorityBy)}" ${s?.priority ? '' : 'disabled'} /></td>
        <td><input class="note" data-f="note" value="${esc(s?.note || '')}" ${s ? '' : 'disabled'} placeholder="${esc(c.notes || '')}" /></td>
      </tr>`;
    })
    .join('');
  const ids = new Set(clients.map((c) => c.id));
  const n = Object.keys(day.selected).filter((id) => ids.has(id)).length;
  $('#stop-count').textContent = t('({n} selected for {day})', { n, day: DAYS[weekday] });
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
    if (e.target.checked) day.selected[id] = newSelection();
    else delete day.selected[id];
    saveDay();
    renderStops();
    return;
  }
  const s = day.selected[id];
  if (!s) return;
  if (f === 'priority') {
    s.priority = e.target.checked;
    tr.querySelector('[data-f="by"]').disabled = !s.priority;
  } else if (f === 'by') s.by = e.target.value;
  else if (f === 'note') s.note = e.target.value;
  saveDay();
}

$('#plan-date').addEventListener('change', (e) => e.target.value && loadDay(e.target.value));
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
  if (plan) renderResults();
}

$('#stop-search').addEventListener('input', renderStops);
$('#btn-select-scheduled').addEventListener('click', () => {
  const weekday = weekdayOf(planDate);
  for (const c of clients) if (isScheduled(c, weekday) && !day.selected[c.id]) day.selected[c.id] = newSelection();
  saveDay();
  renderStops();
});
$('#btn-select-none').addEventListener('click', () => {
  if (!confirm(t('Uncheck all stops for this day?'))) return;
  day.selected = {};
  saveDay();
  renderStops();
});
$('#btn-optimize').addEventListener('click', buildRoutes);

function stopFromClient(c, sel) {
  const prio = sel.priority ? toMin(sel.by || settings.priorityBy) : null;
  const close = toMin(c.close);
  return {
    id: c.id, name: c.name, address: c.address, lat: Number(c.lat), lng: Number(c.lng),
    unload: num(c.unload, settings.defaultUnload), notes: c.notes || '', today: sel.note || '',
    priority: !!sel.priority, by: sel.priority ? sel.by || settings.priorityBy : '',
    open: toMin(c.open), due: prio == null ? close : close == null ? prio : Math.min(prio, close),
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
      const stops = chosen.map((c) => stopFromClient(c, day.selected[c.id]));
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
        const orders = r.routes.map((x) => x.order);
        plan.options.push({ k: vehicles, orders, original: orders.map((o) => o.slice()) });
      }
      // Show the number of drivers that was asked for; a cheaper count is offered, not forced.
      plan.view = k;
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
  store.saveLastPlan(plan);
  const ev = evaluate(plan, viewOption());
  const routes = {};
  ev.routes.forEach((r, i) => {
    if (r.order.length) routes[driverName(i)] = routePayload(r, i);
  });
  store.saveRoutesDay(plan.date, routes);
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

function viewOption() {
  return plan.options.find((o) => o.k === plan.view) || plan.options[0];
}

function renderResults() {
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
    `<tr>${head}</tr>` +
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
          <td><b>${o.k}</b>${o.k === plan.requested ? ` <span class="muted small">${t('(requested)')}</span>` : ''}</td>
          <td class="small">${finishes}</td>
          <td>${fmtHours(ev.paidMinutes)} h</td>
          <td>${ev.otMinutes >= 0.5 ? `${fmtHours(ev.otMinutes)} h` : '—'}</td>
          <td>${fmtMoney(ev.labor)}</td>
          <td>${fmtMoney(ev.fuel)}</td>
          <td><b>${fmtMoney(ev.total)}</b></td>
          <td>${flags.join(' ')}</td>
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
  renderAddStop();
}

// Click a row of the comparison (or "Show that plan") to switch to that number of drivers.
function viewDrivers(e) {
  const el = e.target.closest('[data-k]');
  if (!el) return;
  plan.view = Number(el.dataset.k);
  savePlan();
  renderResults();
}
$('#compare-rows').addEventListener('click', viewDrivers);
$('#best-hint').addEventListener('click', viewDrivers);

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
function routePayload(r, i) {
  return {
    driver: driverName(i),
    date: plan.date,
    leave: Math.round(plan.start),
    back: Math.round(r.finish),
    depot: { n: plan.depot.name, a: plan.depot.address },
    stops: r.order.map((idx, n) => {
      const s = plan.stops[idx - 1];
      return {
        id: s.id,
        n: s.name,
        a: stopPlace(s),
        t: Math.round(r.stops[n].arrive),
        p: s.priority ? toMin(s.by) : 0,
        o: [s.notes, s.today].filter(Boolean).join(' · '),
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
      <a class="secondary" href="${esc(phoneLink(r, i))}" target="_blank" rel="noopener">${t('Driver phone page')}</a> ·
      <button class="secondary" data-copylink="${i}">${t('Copy phone link')}</button>
      <button class="secondary" data-copy="${i}">${t('Copy for text')}</button>
      <span class="small">${links.map((l, n) => `<a href="${esc(l)}" target="_blank" rel="noopener">Google Maps${links.length > 1 ? ` ${n + 1}` : ''}</a>`).join(' · ')}</span>
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
function giveStop(r, n, to) {
  const opt = viewOption();
  const [stop] = opt.orders[r].splice(n, 1);
  const only = opt.orders.map((_, j) => (j === to ? 0 : Infinity));
  opt.orders = insertStop(opt.orders, problemFor(plan, opt.k), stop, only);
  afterEdit(opt);
}

// ---------- Add a late order ----------

function renderAddStop() {
  const inPlan = new Set(plan.stops.map((s) => s.id));
  const list = clients.filter((c) => c.active !== false && !inPlan.has(c.id)).sort(byName);
  const sel = $('#add-client');
  const keep = sel.value;
  sel.innerHTML = `<option value="">${t('Choose a client…')}</option>` + list.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  sel.value = list.some((c) => c.id === keep) ? keep : '';
  if (!$('#add-by').value) $('#add-by').value = settings.priorityBy;
}

$('#btn-add-stop').addEventListener('click', (e) => {
  const c = clients.find((x) => x.id === $('#add-client').value);
  if (!c) return alert(t('Choose a client to add.'));
  busy(e.target, async (status) => {
    try {
      await locateClients([c], status);
      if (!hasLoc(c)) return alert(t('{name} has no map location yet. Open it in the Clients tab and click Find.', { name: c.name }));
      const sel = { priority: $('#add-priority').checked, by: $('#add-by').value, note: '' };
      const stop = { ...stopFromClient(c, sel), added: true };
      const stops = [...plan.stops, stop];
      const tables = await tablesFor(plan.depot, stops, status);
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
      day.selected[c.id] = sel;
      saveDay();
      savePlan();
      renderResults();
      renderStops();
      $('#add-priority').checked = false;
    } catch (err) {
      alert(t('Could not add the stop:') + ' ' + err.message);
    }
  });
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
        for (const p of pairs) {
          const trips = (week.trucks[p.id]?.trips || []).filter((tr) => localDate(new Date(tr.start)) === date);
          const r = trips.length ? analyzeDay({ trips, depot, radius: num(settings.geotabRadius, 200) }) : null;
          if (r?.back != null) returns.push([date, p.name, Math.round(minuteOfDay(r.back))]);
        }
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
  const list = clients.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.address || '').toLowerCase().includes(q)).sort(byName);
  $('#client-count').textContent = `(${clients.length})`;
  $('#client-rows').innerHTML = list
    .map(
      (c) => `<tr data-id="${esc(c.id)}">
      <td class="name">${esc(c.name)}</td>
      <td class="addr">${esc(c.address)}${hasLoc(c) ? '' : ` <span class="warn-text">⚠ ${t('not located')}</span>`}</td>
      <td class="small">${esc(daysText(c.days))}</td>
      <td class="small">${num(c.unload, settings.defaultUnload)} min</td>
      <td class="small">${c.open || c.close ? `${c.open ? fmtTime(toMin(c.open)) : '…'} – ${c.close ? fmtTime(toMin(c.close)) : '…'}` : ''}</td>
      <td class="small">${esc(c.notes || '')}</td>
      <td class="row small-gap"><button class="link" data-act="edit">${t('Edit')}</button><button class="link danger" data-act="delete">${t('Delete')}</button></td>
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

const dialog = $('#client-dialog');
const cform = $('#client-form');
let editing = null;

$('#client-days').innerHTML = DAYS.map((d, i) => `<label><input type="checkbox" data-day="${i}" /> ${d}</label>`).join('');

function openClient(c) {
  editing = c || null;
  $('#client-dialog-title').textContent = c ? t('Edit client') : t('Add client');
  cform.reset();
  const v = c || { unload: settings.defaultUnload, days: [false, true, true, true, true, true, false] };
  for (const f of ['name', 'address', 'lat', 'lng', 'unload', 'open', 'close', 'notes']) cform.elements[f].value = v[f] ?? '';
  cform.querySelectorAll('[data-day]').forEach((cb) => (cb.checked = !!v.days?.[cb.dataset.day]));
  $('#client-locate-msg').textContent = '';
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
    days: [...cform.querySelectorAll('[data-day]')].map((cb) => cb.checked),
  };
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

// ---------- Settings tab ----------

const sform = $('#settings-form');
const SETTING_FIELDS = [
  'depotName', 'depotAddress', 'depotLat', 'depotLng', 'shiftStart', 'start', 'latestReturn', 'payRate',
  'regularHoursPerDay', 'regularHoursPerWeek', 'fuelPerMile', 'defaultUnload', 'priorityBy', 'apiKey',
  'trafficTime', 'monthlyElementLimit', 'monthlyGeocodeLimit',
];
const NUMERIC = new Set(['depotLat', 'depotLng', 'payRate', 'regularHoursPerDay', 'regularHoursPerWeek', 'fuelPerMile', 'defaultUnload', 'monthlyElementLimit', 'monthlyGeocodeLimit']);
const DEPOT_LOC = ['depotAddress', 'depotLat', 'depotLng'];

function renderSettings() {
  renderGeotabSettings();
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
  const tab = currentTab();
  if (tab === 'settings') renderSettings();
  else if (tab === 'clients') renderClients();
  else if (tab === 'history') renderHistory();
  renderStops();
  renderDriverRows();
  if (plan && tab === 'plan') renderResults();
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
    el.innerHTML = `<p class="card">${t("No route for you yet, {name}. The office will send it after building today's routes — this page checks every couple of minutes.", { name: esc(me.driverName) })}</p>`;
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
    const byId = new Map(clients.map((c) => [c.id, c]));
    const depot = depotPoint();
    const returns = [];
    const rows = pairs.map((p, i) => {
      const route = routes[p.name];
      const planned = (route?.stops || [])
        .map((s) => {
          const c = byId.get(s.id);
          return c && hasLoc(c) ? { id: s.id, name: s.n, lat: Number(c.lat), lng: Number(c.lng), plannedArrive: s.t } : null;
        })
        .filter(Boolean);
      const truck = dayData.trucks[p.id] || { trips: [], trail: [] };
      const report = analyzeDay({ trips: truck.trips, depot, planned, radius: num(settings.geotabRadius, 200) });
      if (report.back != null) returns.push([date, p.name, Math.round(minuteOfDay(report.back))]);
      return { ...p, color: COLORS[i % COLORS.length], route, report, trail: truck.trail, live: live.trucks.find((x) => x.id === p.id) };
    });
    const changed = saveReturns(returns, 'truck');
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
      <td>${ROLE_LABEL[u.role]}</td><td>${esc(u.driverName || '')}</td>
      <td class="row small-gap"><button class="link" data-uact="edit">${t('Edit / reset password')}</button>${u.username === me ? '' : `<button class="link danger" data-uact="delete">${t('Remove')}</button>`}</td></tr>`)
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
let setupMode = false;

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
  setupMode = false;
  $('#setup-box').hidden = true;
  $('#login-btn').textContent = t('Log in');
  if (!url) return;
  try {
    setupMode = (await api.call('status')).needsSetup;
  } catch (err) {
    $('#server-box').hidden = false;
    loginMessage(err.message);
  }
  $('#setup-box').hidden = !setupMode;
  if (setupMode) $('#login-btn').textContent = t('Create admin account');
}

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
    if (setupMode) return;
  }
  if (!api.getServerUrl()) return showLogin(t('Enter the server address first.'));
  $('#login-btn').disabled = true;
  try {
    const user = setupMode ? await api.setupAdmin(el.setupCode.value, el.username.value, el.password.value) : await api.login(el.username.value, el.password.value);
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
    status: (s) => ($('#sync-status').textContent = s),
    loggedOut: () => showLogin(t('Please log in again.')),
  });
  if (document.body.classList.contains('logged-out')) return;
  settings = store.getSettings();
  clients = store.getClients();
  if (user.role === 'driver') return showTab('driver');
  plan = store.getLastPlan();
  if (plan && !plan.problem) plan = null; // saved by an older version
  renderPlanControls();
  loadDay(planDate);
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
