import * as store from './store.js';
import { geocode } from './google.js';
import { missingPlan, fillMissing, assemble, nextTrafficDeparture } from './matrix.js';
import { solve, summarize, insertStop } from './solver.js';
import { overtimeStart, laborCost, minutesBefore, weekSummary } from './pay.js';
import { encodeRoute } from './share.js';
import { initSync, syncNow } from './sync.js';
import * as api from './api.js';
import { renderRoute } from './routeview.js';
import { analyzeDay, parseDuration, minuteOfDay } from './tracking.js';
import {
  esc, toMin, fmtTime, fmtDur, fmtMoney, fmtHours, localDate, weekdayOf, weekStart, addDays, uid,
  daysLabel, parseDays, parseCsv, toCsv, download, pickFile, DAY_NAMES,
} from './util.js';

const $ = (sel) => document.querySelector(sel);
const COLORS = ['#1f6fb4', '#c4302b', '#2a9a3d', '#8a4fbf', '#e07b12', '#138d9c', '#8c564b', '#d0459b'];
const BALANCE = { low: 0.15, medium: 0.6, high: 2 };
const MAX_DRIVERS = 8;

let settings = store.getSettings();
let clients = store.getClients();
let planDate = localDate();
let day = null;
let plan = store.getLastPlan();
if (plan && !plan.problem) plan = null; // plan saved by an older version
let map = null;
let mapLayer = null;

const num = (v, fallback) => (v === '' || v == null || Number.isNaN(Number(v)) ? fallback : Number(v));
const hasLoc = (c) => c.lat != null && c.lng != null && c.lat !== '' && c.lng !== '';
const isScheduled = (c, weekday) => c.active !== false && !!(c.days && c.days[weekday]);
const driverName = (i) => settings.drivers[i] || `Driver ${i + 1}`;

function saveSettings() {
  store.saveSettings(settings);
  renderBanner();
}

function saveClients() {
  store.saveClients(clients);
  renderBanner();
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
  if (name === 'plan') {
    renderStops();
    renderDriverRows();
    if (map) setTimeout(() => map.invalidateSize(), 0);
  }
  if (name === 'clients') renderClients();
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettings();
  if (name === 'users') renderUsers();
  if (name === 'driver') renderDriverView();
  if (name === 'trucks') renderTrucks();
}

function currentTab() {
  return document.querySelector('.tab.active')?.dataset.tab || 'plan';
}

function renderBanner() {
  const msgs = [];
  const admin = role() === 'admin';
  if (settings.depotLat == null) {
    msgs.push(admin ? 'Set the warehouse location in <a href="#" data-goto="settings">Settings</a> (click <b>Find</b> next to the address).' : 'The admin still needs to set the warehouse location in Settings.');
  }
  if (!settings.apiKey) {
    msgs.push(admin ? 'No Google API key yet (Settings), so drive times will be rough estimates and addresses must be located by hand. Setup steps are in the README.' : 'No Google API key yet, so drive times are rough estimates. Ask the admin to add it in Settings.');
  }
  if (!clients.length) msgs.push('Add your clients in the <a href="#" data-goto="clients">Clients</a> tab.');
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
  if (!settings.apiKey) throw new Error('Add a Google API key in Settings first, or type the latitude/longitude by hand.');
  const used = store.getUsage().geocodes;
  if (used >= settings.monthlyGeocodeLimit) throw new Error(`Monthly address lookup limit reached (${settings.monthlyGeocodeLimit}). Change it in Settings if needed.`);
  store.addUsage('geocodes', 1);
  return geocode(settings.apiKey, address);
}

// Make sure traffic drive times exist for these points (looked up once, then saved).
async function ensureDriveTimes(points, status, { askIfOverLimit = true } = {}) {
  const cache = store.getMatrixCache();
  const need = missingPlan(points, cache);
  if (!need.elements || !settings.apiKey) return cache;
  const used = store.getUsage().elements;
  const left = Math.max(0, settings.monthlyElementLimit - used);
  if (need.elements > left) {
    const ok =
      askIfOverLimit &&
      confirm(
        `Getting traffic times for ${need.newKeys.length} new location(s) needs ${need.elements} lookups, ` +
          `but only ${left} are left under your monthly limit of ${settings.monthlyElementLimit}.\n\n` +
          `OK = look them up anyway (may go past Google's free amount)\nCancel = use rough estimates for now`,
      );
    if (!ok) return cache;
  }
  try {
    await fillMissing(need, cache, settings.apiKey, nextTrafficDeparture(settings.trafficTime), {
      onStatus: status,
      onElements: (n) => store.addUsage('elements', n),
    });
  } catch (err) {
    alert(err.message + '\n\nRough estimates will be used for the missing drive times.');
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

// Paid minutes each driver already has this week (History, unless typed in for this day).
function weekBefore(i) {
  const typed = day?.weekHours?.[i];
  if (typed != null && typed !== '') return Number(typed) * 60;
  return minutesBefore(store.getHistory(), planDate, driverName(i));
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

// ---------- Plan tab ----------

function newDay(date) {
  const weekday = weekdayOf(date);
  const selected = {};
  for (const c of clients) if (isScheduled(c, weekday)) selected[c.id] = { priority: false, by: settings.priorityBy, note: '' };
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
  const k = Math.min(MAX_DRIVERS, settings.driverCount + 1);
  $('#driver-rows').innerHTML = Array.from({ length: k }, (_, i) => {
    const before = weekBefore(i);
    const typed = day.weekHours[i];
    const otAt = overtimeStart({ ...rules, weekBeforeMin: before });
    const extra = i >= settings.driverCount ? ' <span class="muted small">(only if one more driver)</span>' : '';
    return `<tr>
      <td><input data-driver="${i}" value="${esc(driverName(i))}" />${extra}</td>
      <td><input class="hours" type="number" step="0.25" min="0" data-hours="${i}" value="${typed != null && typed !== '' ? esc(typed) : fmtHours(before)}" /> h</td>
      <td class="small">${fmtTime(otAt)}</td>
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
    .sort((a, b) => isScheduled(b, weekday) - isScheduled(a, weekday) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  $('#no-clients').hidden = clients.length > 0;
  $('#stop-rows').innerHTML = list
    .map((c) => {
      const s = day.selected[c.id];
      const unload = num(c.unload, settings.defaultUnload);
      return `<tr data-id="${c.id}" class="${s ? 'selected' : ''}">
        <td><input type="checkbox" data-f="on" ${s ? 'checked' : ''} aria-label="Deliver to ${esc(c.name)}" /></td>
        <td class="name">${esc(c.name)}${isScheduled(c, weekday) ? ' <span class="tag good">regular today</span>' : ''}<div class="addr">${esc(c.address)}${hasLoc(c) ? '' : ' <span class="warn-text">⚠ not located</span>'}</div></td>
        <td class="small">${esc(daysLabel(c.days))}</td>
        <td class="small">${unload} min</td>
        <td><input type="checkbox" data-f="priority" ${s?.priority ? 'checked' : ''} ${s ? '' : 'disabled'} aria-label="Priority" /></td>
        <td><input type="time" data-f="by" value="${esc(s?.by || settings.priorityBy)}" ${s?.priority ? '' : 'disabled'} /></td>
        <td><input class="note" data-f="note" value="${esc(s?.note || '')}" ${s ? '' : 'disabled'} placeholder="${esc(c.notes || '')}" /></td>
      </tr>`;
    })
    .join('');
  const n = Object.keys(day.selected).filter((id) => clients.some((c) => c.id === id)).length;
  $('#stop-count').textContent = `(${n} selected for ${DAY_NAMES[weekday]})`;
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
    if (e.target.checked) day.selected[id] = { priority: false, by: settings.priorityBy, note: '' };
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
$('#plan-shift').addEventListener('change', (e) => { day.shiftStart = e.target.value; saveDay(); renderDriverRows(); });
$('#plan-start').addEventListener('change', (e) => { day.start = e.target.value; saveDay(); });
$('#plan-end').addEventListener('change', (e) => { day.latestReturn = e.target.value; saveDay(); });
$('#plan-drivers').addEventListener('change', (e) => {
  settings.driverCount = Number(e.target.value);
  saveSettings();
  renderDriverRows();
});
$('#plan-balance').addEventListener('change', (e) => { settings.balance = e.target.value; saveSettings(); });
$('#driver-rows').addEventListener('change', (e) => {
  const d = e.target.dataset.driver;
  const h = e.target.dataset.hours;
  if (d != null) {
    settings.drivers[d] = e.target.value.trim() || `Driver ${Number(d) + 1}`;
    saveSettings();
    if (plan) renderResults();
  }
  if (h != null) {
    day.weekHours[h] = e.target.value;
    saveDay();
  }
  renderDriverRows();
});
$('#stop-search').addEventListener('input', renderStops);
$('#btn-select-scheduled').addEventListener('click', () => {
  const weekday = weekdayOf(planDate);
  for (const c of clients) if (isScheduled(c, weekday) && !day.selected[c.id]) day.selected[c.id] = { priority: false, by: settings.priorityBy, note: '' };
  saveDay();
  renderStops();
});
$('#btn-select-none').addEventListener('click', () => {
  if (!confirm('Uncheck all stops for this day?')) return;
  day.selected = {};
  saveDay();
  renderStops();
});
$('#btn-optimize').addEventListener('click', buildRoutes);

// Locate any clients that have no coordinates yet; returns those still missing.
async function locateMissing(list, status) {
  const missing = list.filter((c) => !hasLoc(c));
  if (missing.length && settings.apiKey) {
    for (const c of missing) {
      status(`Finding address for ${c.name}…`);
      try {
        const g = await locate(c.address);
        c.lat = g.lat;
        c.lng = g.lng;
      } catch {}
    }
    saveClients();
  }
  return list.filter((c) => !hasLoc(c));
}

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
  const status = (t) => ($('#plan-status').textContent = t);
  if (settings.depotLat == null) return alert('Set the warehouse location in Settings first.');
  const chosen = clients.filter((c) => day.selected[c.id]);
  if (!chosen.length) return alert('Check at least one stop.');
  const shiftStart = toMin($('#plan-shift').value);
  const start = toMin($('#plan-start').value);
  const endBy = toMin($('#plan-end').value);
  if (shiftStart == null || start == null || endBy == null || endBy <= start || start < shiftStart) {
    return alert('Check the clock-in, leave and latest-return times.');
  }

  const btn = $('#btn-optimize');
  btn.disabled = true;
  const t0 = performance.now();
  try {
    const stillMissing = await locateMissing(chosen, status);
    if (stillMissing.length) {
      alert(`These clients have no map location yet. Open them in the Clients tab and click Find (or type the latitude/longitude):\n\n${stillMissing.map((c) => '• ' + c.name).join('\n')}`);
      return;
    }

    const depot = { lat: Number(settings.depotLat), lng: Number(settings.depotLng) };
    const stops = chosen.map((c) => stopFromClient(c, day.selected[c.id]));
    const tables = await tablesFor(depot, stops, status);
    const rules = payRules();
    const weekMin = Array.from({ length: MAX_DRIVERS }, (_, i) => weekBefore(i));

    plan = {
      date: planDate,
      created: Date.now(),
      shiftStart,
      start,
      endBy,
      payRate: num(settings.payRate, 14),
      fuelPerMile: num(settings.fuelPerMile, 0),
      otAt: weekMin.map((w) => overtimeStart({ ...rules, weekBeforeMin: w })),
      weekMin,
      requested: settings.driverCount,
      view: settings.driverCount,
      depot: { name: settings.depotName, address: settings.depotAddress, lat: depot.lat, lng: depot.lng },
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
      status(`Optimizing routes for ${vehicles} driver${vehicles > 1 ? 's' : ''}…`);
      const r = await runSolve(problemFor(plan, vehicles), {
        timeLimitMs: vehicles === k ? 2500 : 1500,
        weights: { balance: BALANCE[settings.balance] ?? 0.15 },
      });
      const orders = r.routes.map((x) => x.order);
      plan.options.push({ k: vehicles, orders, original: orders.map((o) => o.slice()) });
    }
    plan.view = bestOption(plan).k;
    savePlan();
    renderResults();
    status(`Done in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    status('');
    alert('Something went wrong: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

// Saves the plan and records the plan being viewed in History (for weekly hours).
function savePlan() {
  store.saveLastPlan(plan);
  const opt = viewOption();
  const ev = evaluate(plan, opt);
  // What drivers see when they log in.
  const routes = {};
  ev.routes.forEach((r, i) => {
    if (r.order.length) routes[driverName(i)] = routePayload(r, i);
  });
  store.saveRoutesDay(plan.date, routes);
  // Real return times (from the truck or typed in History) are kept when the plan changes.
  const before = store.getHistory()[plan.date]?.drivers || [];
  store.saveHistoryDay(plan.date, {
    drivers: ev.routes
      .map((r, i) => {
        const real = before.find((d) => d.name === driverName(i) && d.source);
        const planned = { name: driverName(i), stops: r.order.length, paid: Math.round(r.paid), ot: Math.round(r.ot), miles: Math.round(r.miles * 10) / 10, back: Math.round(r.finish), labor: r.labor, fuel: r.fuel };
        return real ? { ...planned, back: real.back, paid: real.paid, ot: real.ot, labor: real.labor, source: real.source } : planned;
      })
      .filter((d) => d.stops),
    shiftStart: plan.shiftStart,
    stops: plan.stops.length,
    labor: ev.labor,
    fuel: ev.fuel,
    total: ev.total,
    miles: ev.miles,
  });
}

// ---------- Results ----------

function isOk(ev) {
  return !ev.lateStops.length && ev.pastEndMinutes < 0.5 && !ev.empty;
}

function bestOption(p) {
  const evs = p.options.map((o) => ({ o, ev: evaluate(p, o) }));
  const ok = evs.filter((x) => isOk(x.ev));
  const pool = ok.length ? ok : evs;
  return pool.reduce((a, b) => (b.ev.total < a.ev.total - 0.005 ? b : a)).o;
}

function viewOption() {
  return plan.options.find((o) => o.k === plan.view) || plan.options[0];
}

function fmtDateLong(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function renderResults() {
  if (!plan) {
    $('#results').hidden = true;
    return;
  }
  $('#results').hidden = false;
  const best = bestOption(plan);
  const view = viewOption();
  const views = plan.options.map((o) => ({ o, ev: evaluate(plan, o) }));

  $('#cost-note').textContent =
    `Paid from clock-in (${fmtTime(plan.shiftStart)}) until back at the warehouse at ${fmtMoney(plan.payRate)}/h; overtime at 1.5× (${fmtMoney(plan.payRate * 1.5)}/h); ` +
    `fuel at ${fmtMoney(plan.fuelPerMile)}/mile. Click a row to view that plan.`;

  $('#compare-rows').innerHTML =
    `<tr><th>Drivers</th><th>Back at warehouse</th><th>Paid hours</th><th>Overtime</th><th>Labor</th><th>Fuel</th><th>Total</th><th></th></tr>` +
    views
      .map(({ o, ev }) => {
        const flags = [];
        if (o === best) flags.push('<span class="tag good">Best</span>');
        if (ev.pastEndMinutes >= 0.5) flags.push(`<span class="tag bad">Past ${fmtTime(plan.endBy)}</span>`);
        if (ev.lateStops.length) flags.push(`<span class="tag bad">${ev.lateStops.length} late</span>`);
        if (ev.empty) flags.push('<span class="tag">Not enough stops</span>');
        if (o.edited) flags.push('<span class="tag">Changed by hand</span>');
        const finishes = ev.routes.filter((r) => r.order.length).map((r) => fmtTime(r.finish)).join(', ');
        return `<tr data-k="${o.k}" class="${o.k === view.k ? 'current' : ''}">
          <td><b>${o.k}</b>${o.k === plan.requested ? ' <span class="muted small">(requested)</span>' : ''}</td>
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

  const src = plan.source;
  $('#data-note').innerHTML = src.estimated
    ? `<span class="warn-text">⚠ ${src.estimated} of ${src.google + src.estimated} drive times are rough straight-line estimates${settings.apiKey ? '' : ' (no Google API key)'}. Times may be off.</span>`
    : `Drive times from Google with typical traffic around ${fmtTime(toMin(src.trafficTime))}.`;

  const ev = views.find((x) => x.o === view).ev;
  $('#plan-title').textContent = `${fmtDateLong(plan.date)} · ${view.k} driver${view.k > 1 ? 's' : ''} · ${fmtMoney(ev.total)}`;
  $('#btn-reset-edits').hidden = !view.edited;
  renderMap(view, ev);
  $('#driver-cards').innerHTML = ev.routes.map((r, i) => driverCard(r, i, view.k)).join('');
  renderAddStop();
}

$('#compare-rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-k]');
  if (!tr) return;
  plan.view = Number(tr.dataset.k);
  savePlan();
  renderResults();
});

$('#btn-reset-edits').addEventListener('click', () => {
  const opt = viewOption();
  if (!confirm('Put this plan back the way the planner made it?')) return;
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
  const places = [plan.depot.address, ...r.order.map((i) => stopPlace(plan.stops[i - 1])), plan.depot.address];
  return mapsLinks(places);
}

// One driver's route, packed for the driver phone page and the driver login.
function routePayload(r, i) {
  return {
    driver: driverName(i),
    date: fmtDateLong(plan.date),
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

function driverCard(r, i, k) {
  const color = COLORS[i % COLORS.length];
  if (!r.order.length) {
    return `<div class="card driver" style="--route:${color}"><h3>${esc(driverName(i))}</h3><p class="muted">No stops for this driver.</p></div>`;
  }
  const done = store.getDone()[plan.date]?.[driverName(i)] || {};
  const moveOptions = Array.from({ length: k }, (_, j) => (j === i ? '' : `<option value="${j}">${esc(driverName(j))}</option>`)).join('');
  const rows = r.order
    .map((idx, n) => {
      const s = plan.stops[idx - 1];
      const a = r.stops[n];
      const tags = [];
      if (s.priority) tags.push(`<span class="tag prio">Priority · by ${fmtTime(toMin(s.by))}</span>`);
      if (a.late > 0.5) tags.push(`<span class="tag bad">${Math.round(a.late)} min late</span>`);
      if (s.added) tags.push('<span class="tag new">Added</span>');
      if (done[s.id]) tags.push(`<span class="tag done">✓ Done ${fmtTime(new Date(done[s.id]).getHours() * 60 + new Date(done[s.id]).getMinutes())}</span>`);
      const notes = [`Unload ${s.unload} min`, s.notes, s.today].filter(Boolean).map(esc).join(' · ');
      return `<li><span class="num">${n + 1}</span><span class="time">${fmtTime(a.arrive)}</span>
        <div><div class="who">${esc(s.name)} ${tags.join(' ')}</div><div class="addr">${esc(s.address)}</div><div class="note">${notes}</div></div>
        <div class="edit noprint" data-r="${i}" data-n="${n}">
          <button class="secondary" data-move="up" ${n === 0 ? 'disabled' : ''} title="Earlier">▲</button>
          <button class="secondary" data-move="down" ${n === r.order.length - 1 ? 'disabled' : ''} title="Later">▼</button>
          ${k > 1 ? `<select data-move="to" aria-label="Move to another driver"><option value="">Move to…</option>${moveOptions}</select>` : ''}
        </div></li>`;
    })
    .join('');
  const links = routeLinks(r);
  return `<div class="card driver" style="--route:${color}">
    <div class="row between"><h3>${esc(driverName(i))}</h3>
      ${r.pastEnd >= 0.5 ? `<span class="tag bad">${Math.round(r.pastEnd)} min past ${fmtTime(plan.endBy)}</span>` : r.ot >= 0.5 ? `<span class="tag prio">Back ${fmtTime(r.finish)} · ${Math.round(r.ot)} min OT</span>` : `<span class="tag good">Back ${fmtTime(r.finish)}</span>`}</div>
    <div class="stats">
      <span>${esc(fmtDateLong(plan.date))}</span>
      <span>Stops <b>${r.order.length}</b></span>
      <span>Paid <b>${fmtDur(r.paid)}${r.ot >= 0.5 ? ` (${fmtDur(r.ot)} OT)` : ''} · ${fmtMoney(r.labor)}</b></span>
      <span>Driving <b>${fmtDur(r.drive)} · ${r.miles.toFixed(0)} mi · ${fmtMoney(r.fuel)} fuel</b></span>
    </div>
    <ol>
      <li class="depot"><span class="num">W</span><span class="time">${fmtTime(plan.start)}</span><div><div class="who">Leave ${esc(plan.depot.name)}</div></div></li>
      ${rows}
      <li class="depot"><span class="num">W</span><span class="time">${fmtTime(r.finish)}</span><div><div class="who">Back at ${esc(plan.depot.name)}</div></div></li>
    </ol>
    <div class="actions">
      <a class="secondary" href="${esc(phoneLink(r, i))}" target="_blank" rel="noopener">Driver phone page</a> ·
      <button class="secondary" data-copylink="${i}">Copy phone link</button>
      <button class="secondary" data-copy="${i}">Copy for text</button>
      <span class="small">${links.map((l, n) => `<a href="${esc(l)}" target="_blank" rel="noopener">Google Maps${links.length > 1 ? ` ${n + 1}` : ''}</a>`).join(' · ')}</span>
    </div>
  </div>`;
}

async function copyText(text, btn, label) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = label), 1500);
  } catch {
    prompt('Copy this:', text);
  }
}

$('#driver-cards').addEventListener('click', (e) => {
  const view = viewOption();
  const ev = evaluate(plan, view);
  const linkBtn = e.target.closest('[data-copylink]');
  if (linkBtn) {
    const i = Number(linkBtn.dataset.copylink);
    copyText(phoneLink(ev.routes[i], i), linkBtn, 'Copy phone link');
    return;
  }
  const b = e.target.closest('[data-copy]');
  if (b) {
    const i = Number(b.dataset.copy);
    const r = ev.routes[i];
    const lines = [`${driverName(i)} – ${fmtDateLong(plan.date)}`, `Leave ${plan.depot.name} ${fmtTime(plan.start)}`];
    r.order.forEach((idx, n) => {
      const s = plan.stops[idx - 1];
      const extra = [s.priority ? `PRIORITY by ${fmtTime(toMin(s.by))}` : '', s.notes, s.today].filter(Boolean).join(' – ');
      lines.push(`${n + 1}. ${fmtTime(r.stops[n].arrive)} ${s.name}, ${s.address}${extra ? ` (${extra})` : ''}`);
    });
    lines.push(`Back at ${plan.depot.name} about ${fmtTime(r.finish)}`);
    lines.push(`Route on your phone: ${phoneLink(r, i)}`);
    copyText(lines.join('\n'), b, 'Copy for text');
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
  const p = problemFor(plan, opt.k);
  const only = opt.orders.map((_, j) => (j === to ? 0 : Infinity));
  opt.orders = insertStop(opt.orders, p, stop, only);
  afterEdit(opt);
}

// ---------- Add a late order ----------

function renderAddStop() {
  const inPlan = new Set(plan.stops.map((s) => s.id));
  const list = clients.filter((c) => c.active !== false && !inPlan.has(c.id)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const sel = $('#add-client');
  const keep = sel.value;
  sel.innerHTML = `<option value="">Choose a client…</option>` + list.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  sel.value = list.some((c) => c.id === keep) ? keep : '';
  if (!$('#add-by').value) $('#add-by').value = settings.priorityBy;
}

$('#btn-add-stop').addEventListener('click', async (e) => {
  const c = clients.find((x) => x.id === $('#add-client').value);
  if (!c) return alert('Choose a client to add.');
  const btn = e.target;
  btn.disabled = true;
  const status = (t) => (btn.textContent = t || 'Add to routes');
  try {
    if ((await locateMissing([c], status)).length) return alert(`${c.name} has no map location yet. Open it in the Clients tab and click Find.`);
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
    const nowMin = plan.date === localDate() ? new Date().getHours() * 60 + new Date().getMinutes() : -1;
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
    alert('Could not add the stop: ' + err.message);
  } finally {
    btn.disabled = false;
    status('');
  }
});

$('#btn-print').addEventListener('click', () => window.print());

function renderMap(view, ev) {
  const el = $('#map');
  if (!window.L) {
    el.hidden = true;
    return;
  }
  if (!map) {
    map = L.map(el);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    mapLayer = L.layerGroup().addTo(map);
  }
  mapLayer.clearLayers();
  const d = [plan.depot.lat, plan.depot.lng];
  const pts = [d];
  L.marker(d, { icon: L.divIcon({ className: '', html: '<div class="pin depot">W</div>', iconSize: [26, 26] }), zIndexOffset: 1000 })
    .bindPopup(esc(plan.depot.name))
    .addTo(mapLayer);
  ev.routes.forEach((r, i) => {
    const color = COLORS[i % COLORS.length];
    const line = [d];
    r.order.forEach((idx, n) => {
      const s = plan.stops[idx - 1];
      const ll = [s.lat, s.lng];
      line.push(ll);
      pts.push(ll);
      L.marker(ll, { icon: L.divIcon({ className: '', html: `<div class="pin" style="background:${color}">${n + 1}</div>`, iconSize: [26, 26] }) })
        .bindPopup(`<b>${esc(s.name)}</b><br>${esc(driverName(i))} · stop ${n + 1}<br>${fmtTime(r.stops[n].arrive)}`)
        .addTo(mapLayer);
    });
    line.push(d);
    if (r.order.length) L.polyline(line, { color, weight: 4, opacity: 0.75 }).addTo(mapLayer);
  });
  setTimeout(() => {
    map.invalidateSize();
    map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 14 });
  }, 0);
}

// ---------- History tab ----------

let historyWeek = weekStart(localDate());
let weekRows = [];

function renderHistory() {
  const history = store.getHistory();
  const rules = payRules();
  const rate = num(settings.payRate, 14);
  $('#week-of').value = historyWeek;
  const rows = weekSummary(history, historyWeek, { ...rules, rate });
  const dayHead = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(historyWeek, i);
    return `<th class="num">${DAY_NAMES[weekdayOf(d)]} ${Number(d.slice(8))}</th>`;
  }).join('');
  $('#week-rows').innerHTML =
    `<tr><th>Driver</th>${dayHead}<th class="num">Total</th><th class="num">Overtime</th><th class="num">Est. pay</th></tr>` +
    (rows.length
      ? rows
          .map((r) => {
            const over = r.total > rules.regWeekMin;
            return `<tr><td><b>${esc(r.name)}</b></td>${r.days.map((m, i) => `<td class="num">${m == null ? '' : fmtHours(m)}${r.fromTruck[i] ? ' 🚚' : ''}</td>`).join('')}
            <td class="num ${over ? 'bad-text' : ''}"><b>${fmtHours(r.total)}</b></td>
            <td class="num">${r.ot >= 0.5 ? fmtHours(r.ot) : '—'}</td><td class="num">${fmtMoney(r.pay)}</td></tr>`;
          })
          .join('')
      : '<tr><td colspan="11" class="muted">Nothing saved for this week yet.</td></tr>');
  weekRows = rows;

  const dates = Object.keys(history).sort().reverse();
  $('#history-days').innerHTML = dates.length
    ? dates
        .slice(0, 60)
        .map((date) => {
          const h = history[date];
          return `<div class="history-day" data-date="${date}">
            <div class="row wrap between"><b>${esc(fmtDateLong(date))}</b>
              <span class="small">${h.stops ? `${h.stops} stops · ${Math.round(h.miles || 0)} mi` : 'no plan in the app'}
              <button class="link danger" data-del="${date}">Delete</button></span></div>
            <table><tbody>${(h.drivers || [])
              .map((d, i) => `<tr><td>${esc(d.name)}</td><td class="small">${d.stops ? `${d.stops} stops` : ''}</td>
                <td><label class="inline small">Back <input type="time" data-back="${i}" value="${fmtTimeInput(d.back)}" /></label>
                  <span class="muted small">${d.source === 'truck' ? '🚚 from truck' : d.source === 'manual' ? '✎ typed in' : 'planned'}</span></td>
                <td class="small">${fmtHours(d.paid)} h</td></tr>`)
              .join('')}</tbody></table>
          </div>`;
        })
        .join('')
    : '<p class="muted">Nothing yet. Every plan you build is saved here under its date.</p>';
}

function fmtTimeInput(min) {
  if (min == null) return '';
  const m = Math.round(min);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

$('#week-of').addEventListener('change', (e) => {
  if (!e.target.value) return;
  historyWeek = weekStart(e.target.value);
  renderHistory();
});
// Payroll: fetch every truck's trips for the week and record each day's real return time.
$('#btn-week-trucks').addEventListener('click', async (e) => {
  const btn = e.target;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Getting truck data…';
  try {
    const st = await api.call('geotabStatus');
    if (!st.connected) throw new Error('Connect Geotab first (Settings → Truck tracking).');
    const devices = await loadDevices();
    const pairs = truckPairs(devices);
    const from = localDayRange(historyWeek).from;
    const to = localDayRange(addDays(historyWeek, 6)).to;
    const week = await api.call('geotabDay', { deviceIds: pairs.map(([, id]) => id), from, to, trail: false });
    const depot = settings.depotLat == null ? null : { lat: Number(settings.depotLat), lng: Number(settings.depotLng) };
    if (!depot) throw new Error('Set the warehouse location in Settings first — return times are found by the truck arriving there.');
    let found = 0;
    for (let i = 0; i < 7; i++) {
      const date = addDays(historyWeek, i);
      if (date > localDate()) break;
      for (const [name, id] of pairs) {
        const trips = (week.trucks[id]?.trips || []).filter((t) => localDate(new Date(t.start)) === date);
        if (!trips.length) continue;
        const r = analyzeDay({ trips, depot, radius: num(settings.geotabRadius, 200) });
        if (r.back == null) continue;
        setActualBack(date, name, Math.round(minuteOfDay(r.back)), 'truck');
        found++;
      }
    }
    renderHistory();
    $('#week-msg').textContent = found ? `Got ${found} return time(s) from the trucks. Times typed in by hand were kept.` : 'No truck returns to the warehouse found for this week.';
  } catch (err) {
    if (err instanceof api.NotLoggedIn) return showLogin('Please log in again.');
    $('#week-msg').innerHTML = `<span class="bad-text">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

$('#btn-week-csv').addEventListener('click', () => {
  if (!weekRows.length) return alert('Nothing to download for this week.');
  const rate = num(settings.payRate, 14);
  const days = Array.from({ length: 7 }, (_, i) => addDays(historyWeek, i));
  const rows = [
    ['Driver', ...days.map((d) => `${DAY_NAMES[weekdayOf(d)]} ${d}`), 'Total hours', 'Regular hours', 'Overtime hours', 'Rate', 'Pay'],
    ...weekRows.map((r) => [
      r.name,
      ...r.days.map((m) => (m == null ? '' : fmtHours(m))),
      fmtHours(r.total),
      fmtHours(r.total - r.ot),
      fmtHours(r.ot),
      rate.toFixed(2),
      r.pay.toFixed(2),
    ]),
  ];
  download(`payroll-week-of-${historyWeek}.csv`, toCsv(rows), 'text/csv');
});

$('#btn-week-prev').addEventListener('click', () => { historyWeek = addDays(historyWeek, -7); renderHistory(); });
$('#btn-week-next').addEventListener('click', () => { historyWeek = addDays(historyWeek, 7); renderHistory(); });

// Set a driver's real return time for a day and recalculate that day's pay.
// source: 'manual' (typed in History) or 'truck' (from Geotab; never overrides a typed time).
function setActualBack(date, name, back, source) {
  if (back == null) return false;
  // Days without a plan in the app (or a truck nobody planned) still count for pay.
  const h = store.getHistory()[date] || { drivers: [], stops: 0, miles: 0, fuel: 0, shiftStart: payRules().shiftStart };
  let d = h.drivers.find((x) => x.name === name);
  if (!d) {
    d = { name, stops: 0, paid: 0, ot: 0, labor: 0 };
    h.drivers.push(d);
  }
  if (source === 'truck' && d.source === 'manual') return false;
  if (d.source === source && Math.abs(d.back - back) < 1) return false;
  const rules = payRules();
  const shift = h.shiftStart ?? rules.shiftStart;
  d.back = back;
  d.source = source;
  d.paid = Math.max(0, back - shift);
  const otAt = overtimeStart({ ...rules, shiftStart: shift, weekBeforeMin: minutesBefore(store.getHistory(), date, d.name) });
  d.ot = Math.max(0, Math.min(d.paid, back - otAt));
  d.labor = laborCost(d.paid, d.ot, num(settings.payRate, 14));
  h.labor = h.drivers.reduce((a, x) => a + (x.labor || 0), 0);
  h.total = h.labor + (h.fuel || 0);
  store.saveHistoryDay(date, h);
  return true;
}

$('#history-days').addEventListener('change', (e) => {
  const input = e.target.closest('[data-back]');
  if (!input) return;
  const date = input.closest('[data-date]').dataset.date;
  const d = store.getHistory()[date].drivers[Number(input.dataset.back)];
  setActualBack(date, d.name, toMin(input.value), 'manual');
  renderHistory();
});
$('#history-days').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del]');
  if (!b || !confirm(`Delete the saved routes for ${fmtDateLong(b.dataset.del)}?`)) return;
  store.deleteHistoryDay(b.dataset.del);
  renderHistory();
});

// ---------- Clients tab ----------

function renderClients() {
  const q = $('#client-search').value.trim().toLowerCase();
  const list = clients
    .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.address || '').toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  $('#client-count').textContent = `(${clients.length})`;
  $('#client-rows').innerHTML = list
    .map(
      (c) => `<tr data-id="${c.id}">
      <td class="name">${esc(c.name)}</td>
      <td class="addr">${esc(c.address)}${hasLoc(c) ? '' : ' <span class="warn-text">⚠ not located</span>'}</td>
      <td class="small">${esc(daysLabel(c.days))}</td>
      <td class="small">${num(c.unload, settings.defaultUnload)} min</td>
      <td class="small">${c.open || c.close ? `${c.open ? fmtTime(toMin(c.open)) : '…'} – ${c.close ? fmtTime(toMin(c.close)) : '…'}` : ''}</td>
      <td class="small">${esc(c.notes || '')}</td>
      <td class="row small-gap"><button class="link" data-act="edit">Edit</button><button class="link danger" data-act="delete">Delete</button></td>
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
  if (b.dataset.act === 'delete' && confirm(`Delete ${c.name}?`)) {
    clients = clients.filter((x) => x.id !== id);
    saveClients();
    renderClients();
  }
});

const dialog = $('#client-dialog');
const cform = $('#client-form');
let editing = null;

$('#client-days').innerHTML = DAY_NAMES.map((d, i) => `<label><input type="checkbox" data-day="${i}" /> ${d}</label>`).join('');

function openClient(c) {
  editing = c || null;
  $('#client-dialog-title').textContent = c ? 'Edit client' : 'Add client';
  cform.reset();
  const v = c || { unload: settings.defaultUnload, days: [false, true, true, true, true, true, false] };
  for (const f of ['name', 'address', 'lat', 'lng', 'unload', 'open', 'close', 'notes']) cform.elements[f].value = v[f] ?? '';
  cform.querySelectorAll('[data-day]').forEach((cb) => (cb.checked = !!v.days?.[cb.dataset.day]));
  $('#client-locate-msg').textContent = '';
  dialog.showModal();
}

async function locateInto(form, addressField, latField, lngField, msgEl) {
  const address = form.elements[addressField].value.trim();
  if (!address) return false;
  msgEl.textContent = 'Looking up…';
  try {
    const g = await locate(address);
    form.elements[latField].value = g.lat;
    form.elements[lngField].value = g.lng;
    msgEl.innerHTML = `Found: ${esc(g.formatted)}${g.partial ? ' <span class="warn-text">(partial match, check it)</span>' : ''}`;
    return true;
  } catch (err) {
    msgEl.innerHTML = `<span class="bad-text">${esc(err.message)}</span>`;
    return false;
  }
}

$('#btn-add-client').addEventListener('click', () => openClient(null));
$('#btn-cancel-client').addEventListener('click', () => dialog.close());
$('#btn-locate-client').addEventListener('click', () => locateInto(cform, 'address', 'lat', 'lng', $('#client-locate-msg')));
cform.elements.address.addEventListener('change', () => {
  cform.elements.lat.value = '';
  cform.elements.lng.value = '';
});

cform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = cform.elements;
  if (el.lat.value === '' && settings.apiKey) await locateInto(cform, 'address', 'lat', 'lng', $('#client-locate-msg'));
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

$('#btn-locate-all').addEventListener('click', async (e) => {
  const todo = clients.filter((c) => !hasLoc(c));
  if (!todo.length) return alert('Every client already has a location.');
  const btn = e.target;
  btn.disabled = true;
  let ok = 0;
  const failed = [];
  for (const c of todo) {
    btn.textContent = `Finding ${ok + failed.length + 1}/${todo.length}…`;
    try {
      const g = await locate(c.address);
      c.lat = g.lat;
      c.lng = g.lng;
      ok++;
    } catch (err) {
      failed.push(`${c.name}: ${err.message}`);
      if (/API key|limit/i.test(err.message)) break;
    }
  }
  saveClients();
  renderClients();
  btn.disabled = false;
  btn.textContent = 'Find missing locations';
  alert(`Located ${ok} client(s).${failed.length ? '\n\nProblems:\n' + failed.join('\n') : ''}`);
});

const CSV_HEADER = ['name', 'address', 'days', 'unload', 'earliest', 'latest', 'notes', 'lat', 'lng'];

$('#btn-export-csv').addEventListener('click', () => {
  const rows = [CSV_HEADER, ...clients.map((c) => [c.name, c.address, daysLabel(c.days).replace('—', ''), c.unload, c.open, c.close, c.notes, c.lat ?? '', c.lng ?? ''])];
  download(`clients-${localDate()}.csv`, toCsv(rows), 'text/csv');
});

$('#csv-template').addEventListener('click', (e) => {
  e.preventDefault();
  download('clients-template.csv', toCsv([CSV_HEADER, ['Example Cafe', '123 Main St, El Paso, TX', 'Mon Wed Fri', '10', '', '13:00', 'Back door', '', '']]), 'text/csv');
});

$('#btn-import-csv').addEventListener('click', async () => {
  const text = await pickFile('.csv,text/csv');
  if (!text) return;
  const rows = parseCsv(text);
  if (rows.length < 2) return alert('That file has no client rows.');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const ix = {
    name: col('name', 'client', 'restaurant'),
    address: col('address', 'addr'),
    days: col('days', 'day', 'schedule'),
    unload: col('unload', 'unload minutes', 'service', 'minutes'),
    open: col('earliest', 'open', 'opens'),
    close: col('latest', 'close', 'closes'),
    notes: col('notes', 'note'),
    lat: col('lat', 'latitude'),
    lng: col('lng', 'lon', 'long', 'longitude'),
  };
  if (ix.name < 0 || ix.address < 0) return alert('The first row must include "name" and "address" columns.');
  const get = (r, k) => (ix[k] >= 0 ? (r[ix[k]] || '').trim() : '');
  const time = (t) => {
    const m = String(t).trim().match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
    if (!m) return '';
    let h = Number(m[1]);
    if (m[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
    if (m[3]?.toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m[2] || '00'}`;
  };
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
      open: time(get(r, 'open')),
      close: time(get(r, 'close')),
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
  alert(`Imported: ${added} new, ${updated} updated.${missing ? `\n\n${missing} client(s) still need a map location — click "Find missing locations".` : ''}`);
});

// ---------- Settings tab ----------

const sform = $('#settings-form');
const SETTING_FIELDS = [
  'depotName', 'depotAddress', 'depotLat', 'depotLng', 'shiftStart', 'start', 'latestReturn', 'payRate',
  'regularHoursPerDay', 'regularHoursPerWeek', 'fuelPerMile', 'defaultUnload', 'priorityBy', 'apiKey',
  'trafficTime', 'monthlyElementLimit', 'monthlyGeocodeLimit',
];
const NUMERIC = new Set(['depotLat', 'depotLng', 'payRate', 'regularHoursPerDay', 'regularHoursPerWeek', 'fuelPerMile', 'defaultUnload', 'monthlyElementLimit', 'monthlyGeocodeLimit']);

function renderSettings() {
  renderGeotabSettings();
  for (const f of SETTING_FIELDS) sform.elements[f].value = settings[f] ?? '';
  const u = store.getUsage();
  $('#usage-line').textContent =
    `This month: ${u.elements} of ${settings.monthlyElementLimit} drive-time lookups and ${u.geocodes} of ${settings.monthlyGeocodeLimit} address lookups used (counted by this browser).`;
  $('#matrix-line').textContent = `${Object.keys(store.getMatrixCache()).length} drive times saved. Daily planning reuses them, so it normally makes no Google requests.`;
  const sync = store.getSyncState();
  $('#sync-line').innerHTML = sync.error
    ? `<span class="bad-text">Last save to the Google Sheet failed: ${esc(sync.error)}</span>`
    : sync.last
      ? `Saved to the Google Sheet. Last synced ${new Date(sync.last).toLocaleString()}.`
      : 'Not synced yet.';
}

sform.addEventListener('click', (e) => {
  const b = e.target.closest('[data-reveal]');
  if (!b) return;
  const input = sform.elements[b.dataset.reveal];
  input.type = input.type === 'password' ? 'text' : 'password';
  b.textContent = input.type === 'password' ? 'Show' : 'Hide';
});

$('#btn-locate-depot').addEventListener('click', async () => {
  await locateInto(sform, 'depotAddress', 'depotLat', 'depotLng', $('#settings-saved'));
});
sform.elements.depotAddress.addEventListener('change', () => {
  sform.elements.depotLat.value = '';
  sform.elements.depotLng.value = '';
});

sform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = sform.elements;
  el.apiKey.value = el.apiKey.value.trim();
  if (el.depotLat.value === '' && el.apiKey.value) {
    settings.apiKey = el.apiKey.value;
    await locateInto(sform, 'depotAddress', 'depotLat', 'depotLng', $('#settings-saved'));
  }
  for (const f of SETTING_FIELDS) {
    const v = el[f].value;
    settings[f] = NUMERIC.has(f) ? (v === '' ? (f.startsWith('depot') ? null : store.DEFAULT_SETTINGS[f]) : Number(v)) : v;
  }
  saveSettings();
  renderSettings();
  renderDriverRows();
  $('#settings-saved').textContent = settings.depotLat == null ? 'Saved — but the warehouse still has no location.' : 'Saved.';
});

$('#btn-sync-now').addEventListener('click', async () => {
  await syncNow();
  renderSettings();
});

$('#btn-preload').addEventListener('click', async (e) => {
  if (!settings.apiKey) return alert('Add a Google API key first.');
  if (settings.depotLat == null) return alert('Set the warehouse location first.');
  const list = clients.filter((c) => c.active !== false && hasLoc(c));
  const points = [{ lat: Number(settings.depotLat), lng: Number(settings.depotLng) }, ...list.map((c) => ({ lat: Number(c.lat), lng: Number(c.lng) }))];
  const need = missingPlan(points, store.getMatrixCache());
  if (!need.elements) return alert('All drive times are already saved.');
  const u = store.getUsage().elements;
  if (!confirm(`This looks up ${need.elements} drive times (this month so far: ${u} of your ${settings.monthlyElementLimit} limit). Continue?`)) return;
  const btn = e.target;
  btn.disabled = true;
  await ensureDriveTimes(points, (t) => (btn.textContent = t), { askIfOverLimit: true });
  btn.disabled = false;
  btn.textContent = 'Pre-load drive times for all clients';
  renderSettings();
});

$('#btn-clear-matrix').addEventListener('click', () => {
  if (!confirm('Forget all saved drive times? They will be looked up again from Google (using your free monthly amount) the next time you plan.')) return;
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
    if (!confirm(`Replace your clients and settings with the backup from ${data.exported?.slice(0, 10) || 'file'}?`)) return;
    store.importBackup(data);
    reloadFromStore();
    alert('Backup restored.');
  } catch (err) {
    alert('Could not restore: ' + err.message);
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
    .map((d) => `<button class="${d === driverDate ? 'primary' : 'secondary'}" data-day="${d}">${d === today ? 'Today' : esc(fmtDateLong(d))}</button>`)
    .join('');
  const el = $('#driver-route');
  if (!me.driverName) {
    el.innerHTML = '<p class="card">Your account is not linked to a driver name yet. Ask the admin.</p>';
    return;
  }
  if (!driverDate) {
    el.innerHTML = `<p class="card">No route for you yet, ${esc(me.driverName)}. The office will send it after building today's routes — this page checks every couple of minutes.</p>`;
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
      alert('Could not save that — check the connection and try again.\n' + err.message);
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
let trucksLayer = null;
let trucksTimer = null;
let geotabDeviceList = null;

async function loadDevices() {
  if (!geotabDeviceList) geotabDeviceList = (await api.call('geotabDevices')).devices;
  return geotabDeviceList;
}

// [name, deviceId, hasDriver] for every truck: drivers' trucks first (in driver order), then the rest.
function truckPairs(devices) {
  const byDevice = new Map();
  for (const name of settings.drivers) {
    const id = settings.trucks?.[name];
    if (id && !byDevice.has(id)) byDevice.set(id, name);
  }
  const assigned = [...byDevice.entries()].filter(([id]) => devices.some((d) => d.id === id)).map(([id, name]) => [name, id, true]);
  const rest = devices.filter((d) => !byDevice.has(d.id)).map((d) => [d.name, d.id, false]);
  return [...assigned, ...rest];
}

function localDayRange(date) {
  const [y, m, d] = date.split('-').map(Number);
  return { from: new Date(y, m - 1, d).toISOString(), to: new Date(y, m - 1, d + 1).toISOString() };
}

function stateText(t) {
  if (!t) return '<span class="muted">No live position</span>';
  const mins = Math.round(parseDuration(t.stateFor));
  const age = (Date.now() - Date.parse(t.at)) / 60000;
  if (!t.communicating || age > 30) return `<span class="tag warn">No signal</span> last seen ${fmtTime(minuteOfDay(Date.parse(t.at)))}`;
  return t.driving
    ? `<span class="tag good">Driving</span> ${Math.round(t.speed * 0.621371)} mph · for ${fmtDur(mins)}`
    : `<span class="tag warn">Stopped</span> for ${fmtDur(mins)}`;
}

function timeOf(ms) {
  return ms == null ? '—' : fmtTime(minuteOfDay(ms));
}

async function renderTrucks() {
  clearTimeout(trucksTimer);
  const status = (t) => ($('#trucks-status').textContent = t);
  const note = $('#trucks-note');
  if (!$('#trucks-date').value) $('#trucks-date').value = localDate();
  const date = $('#trucks-date').value;
  const today = date === localDate();
  status('Loading…');
  try {
    const st = await api.call('geotabStatus');
    if (!st.connected) {
      note.innerHTML = 'Geotab is not connected yet. Go to <a href="#" data-goto="settings">Settings → Truck tracking</a>.';
      $('#truck-cards').innerHTML = '';
      return status('');
    }
    // Every truck in Geotab, named after its driver when one is assigned in Settings.
    const devices = await loadDevices();
    const pairs = truckPairs(devices);
    if (!pairs.length) {
      note.textContent = 'No trucks found in Geotab.';
      $('#truck-cards').innerHTML = '';
      return status('');
    }
    const [day, live] = await Promise.all([
      api.call('geotabDay', { deviceIds: pairs.map(([, id]) => id), ...localDayRange(date) }),
      today ? api.call('geotabLive') : Promise.resolve({ trucks: [] }),
    ]);
    const routes = store.getRoutes()[date]?.drivers || {};
    const byId = new Map(clients.map((c) => [c.id, c]));
    const depot = settings.depotLat == null ? null : { lat: Number(settings.depotLat), lng: Number(settings.depotLng) };
    let historyChanged = false;
    const rows = pairs.map(([name, id, driver], i) => {
      const route = routes[name];
      const planned = (route?.stops || [])
        .map((s) => {
          const c = byId.get(s.id);
          return c && hasLoc(c) ? { id: s.id, name: s.n, lat: Number(c.lat), lng: Number(c.lng), plannedArrive: s.t } : null;
        })
        .filter(Boolean);
      const truck = day.trucks[id] || { trips: [], trail: [] };
      const report = analyzeDay({ trips: truck.trips, depot, planned, radius: num(settings.geotabRadius, 200) });
      if (report.back != null && setActualBack(date, name, Math.round(minuteOfDay(report.back)), 'truck')) historyChanged = true;
      return {
        name,
        driver,
        color: COLORS[i % COLORS.length],
        device: devices.find((d) => d.id === id),
        route,
        report,
        trail: truck.trail,
        live: live.trucks.find((t) => t.id === id),
      };
    });
    note.textContent = today
      ? 'Live positions update every minute while this page is open. Return times feed into History automatically.'
      : 'Return times from the trucks are used in History (unless someone typed a time there).';
    if (historyChanged) note.textContent += ' History was updated with real return times.';
    renderTrucksMap(rows, depot);
    $('#truck-cards').innerHTML = rows.map(truckCard).join('');
    status(`Updated ${fmtTime(minuteOfDay(Date.now()))}`);
  } catch (err) {
    if (err instanceof api.NotLoggedIn) return showLogin('Please log in again.');
    status('');
    note.innerHTML = `<span class="bad-text">${esc(err.message)}</span>`;
  } finally {
    if (today && currentTab() === 'trucks') trucksTimer = setTimeout(renderTrucks, 60000);
  }
}

function truckCard(t) {
  const r = t.report;
  const visited = r.visits.filter((v) => v.visited).length;
  const visitRows = r.visits
    .map((v, n) => {
      let tag = '<span class="tag">Not reached</span>';
      if (v.visited) {
        tag = v.lateBy > 10 ? `<span class="tag bad">${Math.round(v.lateBy)} min late</span>` : v.lateBy < -10 ? `<span class="tag">${Math.round(-v.lateBy)} min early</span>` : '<span class="tag good">On time</span>';
      }
      return `<tr><td>${n + 1}</td><td>${esc(v.name)}</td><td>${fmtTime(v.plannedArrive)}</td>
        <td>${v.visited ? timeOf(v.arrive) : '—'}</td><td>${v.visited ? fmtDur(v.minutes) : ''}</td><td>${tag}</td></tr>`;
    })
    .join('');
  const unplanned = r.unplanned
    .map((u) => `<li>${timeOf(u.arrive)} · stopped ${fmtDur(u.minutes)} · <a href="https://www.google.com/maps?q=${u.lat},${u.lng}" target="_blank" rel="noopener">see place</a></li>`)
    .join('');
  return `<div class="card driver truck-card" style="--route:${t.color}">
    <div class="row between"><h3>${t.driver ? esc(t.name) : `🚚 ${esc(t.name)}`}</h3><span class="muted small">${t.driver ? `🚚 ${esc(t.device?.name || 'Unknown truck')}` : 'no driver assigned'}</span></div>
    ${$('#trucks-date').value === localDate() ? `<div class="live">${stateText(t.live)}</div>` : ''}
    <div class="stats">
      <span>Left <b>${timeOf(r.left)}</b></span>
      <span>Back <b>${r.back != null ? timeOf(r.back) : r.stillOut ? 'still out' : '—'}</b></span>
      <span>Driving <b>${fmtDur(r.driveMin)}</b></span>
      <span>Idling <b>${fmtDur(r.idleMin)}</b></span>
      <span><b>${r.miles.toFixed(0)}</b> mi</span>
      ${t.route ? `<span>Stops <b>${visited} of ${r.visits.length}</b></span>` : ''}
    </div>
    ${t.route ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Client</th><th>Planned</th><th>Arrived</th><th>Stayed</th><th></th></tr></thead><tbody>${visitRows}</tbody></table></div>` : '<p class="muted small">No planned route for this driver on this day.</p>'}
    ${r.unplanned.length ? `<h4>Stops that weren't on the route (${r.unplanned.length})</h4><ul class="small">${unplanned}</ul>` : ''}
  </div>`;
}

function renderTrucksMap(rows, depot) {
  const el = $('#trucks-map');
  if (!window.L) return (el.hidden = true);
  if (!trucksMap) {
    trucksMap = L.map(el);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(trucksMap);
    trucksLayer = L.layerGroup().addTo(trucksMap);
  }
  trucksLayer.clearLayers();
  const pts = [];
  if (depot) {
    pts.push([depot.lat, depot.lng]);
    L.marker([depot.lat, depot.lng], { icon: L.divIcon({ className: '', html: '<div class="pin depot">W</div>', iconSize: [26, 26] }) }).addTo(trucksLayer);
  }
  for (const t of rows) {
    if (t.trail.length > 1) L.polyline(t.trail, { color: t.color, weight: 3, opacity: 0.7 }).addTo(trucksLayer);
    t.trail.forEach((p) => pts.push(p));
    for (const v of t.report.visits) {
      pts.push([v.lat, v.lng]);
      L.marker([v.lat, v.lng], { icon: L.divIcon({ className: '', html: `<div class="plan-pin ${v.visited ? 'hit' : ''}" style="--route:${t.color}"></div>`, iconSize: [16, 16] }) })
        .bindPopup(`<b>${esc(v.name)}</b><br>${esc(t.name)} · planned ${fmtTime(v.plannedArrive)}<br>${v.visited ? `arrived ${timeOf(v.arrive)}, stayed ${fmtDur(v.minutes)}` : 'not reached'}`)
        .addTo(trucksLayer);
    }
    if (t.live && t.live.lat != null) {
      pts.push([t.live.lat, t.live.lng]);
      L.marker([t.live.lat, t.live.lng], {
        icon: L.divIcon({ className: '', html: `<div class="truck-pin"><div class="dot" style="background:${t.color}">🚚</div><span class="label">${esc(t.name)}</span></div>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
        zIndexOffset: 2000,
      })
        .bindPopup(`<b>${esc(t.name)}</b> · ${esc(t.device?.name || '')}<br>${stateText(t.live)}`)
        .addTo(trucksLayer);
    }
  }
  setTimeout(() => {
    trucksMap.invalidateSize();
    if (pts.length) trucksMap.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 14 });
  }, 0);
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
    $('#geotab-status').textContent = err.message;
    return;
  }
  $('#btn-geotab-clear').hidden = !st.connected;
  $('#btn-geotab-save').textContent = st.connected ? 'Change login' : 'Connect';
  $('#truck-assign').hidden = !st.connected;
  $('#geotab-status').innerHTML = st.connected ? `<span class="tag good">Connected</span> ${esc(st.userName)} · ${esc(st.database)}` : 'Not connected.';
  if (st.connected) {
    $('#g-server').value = st.server;
    $('#g-database').value = st.database;
    $('#g-user').value = st.userName;
    try {
      const devices = await loadDevices();
      const names = settings.drivers.slice(0, Math.max(settings.driverCount + 1, ...settings.drivers.map((n, i) => (settings.trucks?.[n] ? i + 1 : 0))));
      $('#truck-rows').innerHTML = names
        .map((n) => `<tr><td>${esc(n)}</td><td><select data-truck="${esc(n)}"><option value="">— no truck —</option>${devices
          .map((d) => `<option value="${esc(d.id)}" ${settings.trucks?.[n] === d.id ? 'selected' : ''}>${esc(d.name)}${d.plate ? ` (${esc(d.plate)})` : ''}</option>`)
          .join('')}</select></td></tr>`)
        .join('');
    } catch (err) {
      $('#truck-rows').innerHTML = `<tr><td class="bad-text">${esc(err.message)}</td></tr>`;
    }
  }
}

$('#btn-geotab-save').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  $('#geotab-status').textContent = 'Checking with Geotab…';
  try {
    await api.call('geotabSave', { server: $('#g-server').value, database: $('#g-database').value, userName: $('#g-user').value, password: $('#g-pass').value });
    $('#g-pass').value = '';
    geotabDeviceList = null;
    await renderGeotabSettings();
  } catch (err) {
    $('#geotab-status').innerHTML = `<span class="bad-text">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

$('#btn-geotab-clear').addEventListener('click', async () => {
  if (!confirm('Disconnect Geotab? Truck tracking stops until you connect again.')) return;
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

async function renderUsers() {
  uform.elements.driverName.innerHTML = settings.drivers.map((n) => `<option>${esc(n)}</option>`).join('');
  $('#user-driver-name').hidden = uform.elements.role.value !== 'driver';
  try {
    users = (await api.call('listUsers')).users;
  } catch (err) {
    $('#user-rows').innerHTML = `<tr><td colspan="4" class="bad-text">${esc(err.message)}</td></tr>`;
    return;
  }
  const me = api.getSession()?.user?.username;
  const label = { admin: 'Admin', secretary: 'Secretary', driver: 'Driver' };
  $('#user-rows').innerHTML = users
    .map((u) => `<tr data-user="${esc(u.username)}"><td><b>${esc(u.username)}</b>${u.username === me ? ' <span class="muted small">(you)</span>' : ''}</td>
      <td>${label[u.role]}</td><td>${esc(u.driverName || '')}</td>
      <td class="row small-gap"><button class="link" data-uact="edit">Edit / reset password</button>${u.username === me ? '' : '<button class="link danger" data-uact="delete">Remove</button>'}</td></tr>`)
    .join('');
}

function resetUserForm() {
  editingUser = null;
  uform.reset();
  uform.elements.username.disabled = false;
  $('#user-form-title').textContent = 'Add a person';
  $('#btn-user-cancel').hidden = true;
  $('#user-driver-name').hidden = uform.elements.role.value !== 'driver';
}

uform.elements.role.addEventListener('change', () => ($('#user-driver-name').hidden = uform.elements.role.value !== 'driver'));
$('#btn-user-cancel').addEventListener('click', resetUserForm);

$('#user-rows').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-uact]');
  if (!b) return;
  const u = users.find((x) => x.username === b.closest('tr').dataset.user);
  if (b.dataset.uact === 'edit') {
    editingUser = u;
    uform.elements.username.value = u.username;
    uform.elements.username.disabled = true;
    uform.elements.role.value = u.role;
    if (u.driverName && !settings.drivers.includes(u.driverName)) {
      uform.elements.driverName.insertAdjacentHTML('beforeend', `<option>${esc(u.driverName)}</option>`);
    }
    uform.elements.driverName.value = u.driverName || settings.drivers[0];
    uform.elements.password.value = '';
    $('#user-form-title').textContent = `Edit ${u.username}`;
    $('#btn-user-cancel').hidden = false;
    $('#user-driver-name').hidden = u.role !== 'driver';
    uform.scrollIntoView({ behavior: 'smooth' });
  }
  if (b.dataset.uact === 'delete' && confirm(`Remove ${u.username}? They will be logged out everywhere.`)) {
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
  if (!editingUser && !user.password) return ($('#user-msg').textContent = 'Give them a password.');
  try {
    await api.call('saveUser', { user });
    $('#user-msg').textContent = `Saved ${user.username}.`;
    resetUserForm();
    renderUsers();
  } catch (err) {
    $('#user-msg').textContent = err.message;
  }
});

// ---------- Login ----------

const lform = $('#login-form');
let setupMode = false;

async function showLogin(msg = '') {
  document.body.classList.add('logged-out');
  delete document.body.dataset.role;
  $('#login-msg').textContent = msg;
  $('#login-msg').className = 'small' + (msg ? ' bad' : '');
  const url = api.getServerUrl();
  lform.elements.server.value = url;
  $('#server-box').hidden = !!url;
  setupMode = false;
  $('#setup-box').hidden = true;
  $('#login-btn').textContent = 'Log in';
  if (!url) return;
  try {
    setupMode = (await api.call('status')).needsSetup;
  } catch (err) {
    $('#server-box').hidden = false;
    $('#login-msg').textContent = err.message;
    $('#login-msg').className = 'small bad';
  }
  $('#setup-box').hidden = !setupMode;
  if (setupMode) $('#login-btn').textContent = 'Create admin account';
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
  if (!api.getServerUrl()) return showLogin('Enter the server address first.');
  $('#login-btn').disabled = true;
  try {
    const user = setupMode ? await api.setupAdmin(el.setupCode.value, el.username.value, el.password.value) : await api.login(el.username.value, el.password.value);
    lform.reset();
    store.setSyncState({ last: null, error: '' });
    await enterApp(user);
  } catch (err) {
    $('#login-msg').textContent = err.message;
    $('#login-msg').className = 'small bad';
  } finally {
    $('#login-btn').disabled = false;
  }
});

$('#btn-logout').addEventListener('click', async () => {
  if (!confirm('Log out? This computer will forget the saved data until someone logs in again (it stays safe in the Google Sheet).')) return;
  await api.logout();
  location.reload();
});

$('#btn-password').addEventListener('click', async () => {
  const oldPassword = prompt('Current password:');
  if (!oldPassword) return;
  const newPassword = prompt('New password (at least 6 characters):');
  if (!newPassword) return;
  try {
    await api.call('changePassword', { oldPassword, newPassword });
    alert('Password changed.');
  } catch (err) {
    alert(err.message);
  }
});

async function enterApp(user) {
  document.body.classList.remove('logged-out');
  document.body.dataset.role = user.role;
  const label = { admin: 'Admin', secretary: 'Secretary', driver: 'Driver' }[user.role];
  $('#who').textContent = `${user.username} · ${label}`;
  await initSync({
    remoteChanged: reloadFromStore,
    status: (t) => ($('#sync-status').textContent = t),
    loggedOut: () => showLogin('Please log in again.'),
  });
  if (document.body.classList.contains('logged-out')) return;
  settings = store.getSettings();
  clients = store.getClients();
  if (user.role === 'driver') return showTab('driver');
  plan = store.getLastPlan();
  if (plan && !plan.problem) plan = null;
  renderPlanControls();
  loadDay(planDate);
  renderBanner();
  renderResults();
  showTab('plan');
}

// ---------- Start ----------

const session = api.getSession();
if (api.getServerUrl() && session) enterApp(session.user);
else showLogin();
