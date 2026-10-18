import * as store from './store.js';
import { geocode } from './google.js';
import { missingPlan, fillMissing, assemble, nextTrafficDeparture } from './matrix.js';
import { solve } from './solver.js';
import {
  esc, toMin, fmtTime, fmtDur, fmtMoney, localDate, weekdayOf, uid,
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
let map = null;
let mapLayer = null;

const num = (v, fallback) => (v === '' || v == null || Number.isNaN(Number(v)) ? fallback : Number(v));
const hasLoc = (c) => c.lat != null && c.lng != null && c.lat !== '' && c.lng !== '';
const isScheduled = (c, weekday) => c.active !== false && !!(c.days && c.days[weekday]);

function saveSettings() {
  store.saveSettings(settings);
  renderBanner();
}

function saveClients() {
  store.saveClients(clients);
  renderBanner();
}

// ---------- Tabs & banner ----------

function showTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== 'tab-' + name));
  if (name === 'plan') {
    renderStops();
    if (map) setTimeout(() => map.invalidateSize(), 0);
  }
  if (name === 'clients') renderClients();
  if (name === 'settings') renderSettings();
}

function renderBanner() {
  const msgs = [];
  if (settings.depotLat == null) msgs.push('Set the warehouse location in <a href="#" data-goto="settings">Settings</a> (click <b>Find</b> next to the address).');
  if (!settings.apiKey) msgs.push('No Google API key yet, so drive times will be rough estimates and addresses must be located by hand. Setup steps are in the README.');
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

// Make sure traffic drive times exist for these points. Returns a note about where times came from.
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

// ---------- Plan tab ----------

function newDay(date) {
  const weekday = weekdayOf(date);
  const selected = {};
  for (const c of clients) if (isScheduled(c, weekday)) selected[c.id] = { priority: false, by: settings.priorityBy, note: '' };
  return { selected, start: settings.start, endBy: settings.endBy };
}

function loadDay(date) {
  planDate = date;
  day = store.getDay(date) || newDay(date);
  $('#plan-start').value = day.start || settings.start;
  $('#plan-end').value = day.endBy || settings.endBy;
  renderStops();
}

function saveDay() {
  store.saveDay(planDate, day);
}

function renderPlanControls() {
  $('#plan-date').value = planDate;
  $('#plan-drivers').innerHTML = Array.from({ length: MAX_DRIVERS }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
  $('#plan-drivers').value = settings.driverCount;
  $('#plan-balance').value = settings.balance;
  renderDriverNames();
}

function renderDriverNames() {
  $('#driver-names').innerHTML = Array.from({ length: settings.driverCount }, (_, i) =>
    `<label>Driver ${i + 1} <input data-driver="${i}" value="${esc(settings.drivers[i] || `Driver ${i + 1}`)}" /></label>`).join('');
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
      return `<tr data-id="${c.id}" class="${s ? 'selected' : ''} ${isScheduled(c, weekday) ? 'scheduled' : ''}">
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
$('#plan-start').addEventListener('change', (e) => { day.start = e.target.value; saveDay(); });
$('#plan-end').addEventListener('change', (e) => { day.endBy = e.target.value; saveDay(); });
$('#plan-drivers').addEventListener('change', (e) => {
  settings.driverCount = Number(e.target.value);
  saveSettings();
  renderDriverNames();
});
$('#plan-balance').addEventListener('change', (e) => { settings.balance = e.target.value; saveSettings(); });
$('#driver-names').addEventListener('input', (e) => {
  const i = e.target.dataset.driver;
  if (i == null) return;
  settings.drivers[i] = e.target.value;
  saveSettings();
  if (plan) renderResults();
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

async function buildRoutes() {
  const status = (t) => ($('#plan-status').textContent = t);
  if (settings.depotLat == null) return alert('Set the warehouse location in Settings first.');
  const chosen = clients.filter((c) => day.selected[c.id]);
  if (!chosen.length) return alert('Check at least one stop.');
  const start = toMin($('#plan-start').value);
  const endBy = toMin($('#plan-end').value);
  if (start == null || endBy == null || endBy <= start) return alert('Check the leave and back-by times.');

  const btn = $('#btn-optimize');
  btn.disabled = true;
  const t0 = performance.now();
  try {
    // Locate any stops that have no coordinates yet.
    const missing = chosen.filter((c) => !hasLoc(c));
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
    const stillMissing = chosen.filter((c) => !hasLoc(c));
    if (stillMissing.length) {
      alert(`These clients have no map location yet. Open them in the Clients tab and click Find (or type the latitude/longitude):\n\n${stillMissing.map((c) => '• ' + c.name).join('\n')}`);
      return;
    }

    const depot = { lat: Number(settings.depotLat), lng: Number(settings.depotLng) };
    const points = [depot, ...chosen.map((c) => ({ lat: Number(c.lat), lng: Number(c.lng) }))];
    const cache = await ensureDriveTimes(points, status);
    const m = assemble(points, cache);

    const stops = chosen.map((c) => {
      const s = day.selected[c.id];
      const prio = s.priority ? toMin(s.by || settings.priorityBy) : null;
      const close = toMin(c.close);
      return {
        id: c.id, name: c.name, address: c.address, lat: Number(c.lat), lng: Number(c.lng),
        unload: num(c.unload, settings.defaultUnload), notes: c.notes || '', today: s.note || '',
        priority: !!s.priority, by: s.priority ? s.by || settings.priorityBy : '',
        open: toMin(c.open), due: prio == null ? close : close == null ? prio : Math.min(prio, close),
      };
    });
    const problem = {
      time: m.time,
      service: [0, ...stops.map((s) => s.unload)],
      open: [null, ...stops.map((s) => s.open)],
      due: [null, ...stops.map((s) => s.due)],
      start,
      endBy,
    };

    const k = settings.driverCount;
    const counts = [...new Set([k - 1, k, k + 1])].filter((x) => x >= 1 && x <= MAX_DRIVERS && (x <= stops.length || x === k));
    const options = [];
    for (const vehicles of counts) {
      status(`Optimizing routes for ${vehicles} driver${vehicles > 1 ? 's' : ''}…`);
      const r = await runSolve(
        { ...problem, vehicles },
        { timeLimitMs: vehicles === k ? 2500 : 1500, weights: { balance: BALANCE[settings.balance] ?? 0.15 } },
      );
      const routes = r.routes.map((route) => ({
        order: route.order,
        arrivals: route.stops.map((s) => ({ arrive: s.arrive, late: s.late })),
        finish: route.finish,
        duration: route.duration,
        drive: route.drive,
        miles: legsMeters(route.order, m.meters) / 1609.34,
        overtime: route.overtime,
      }));
      options.push({
        k: vehicles,
        routes,
        totalMinutes: r.totalMinutes,
        lastFinish: r.lastFinish,
        lateCount: r.lateStops.length,
        overtime: r.overtimeMinutes,
        cost: (r.totalMinutes / 60) * settings.payRate,
        miles: routes.reduce((s, x) => s + x.miles, 0),
      });
    }

    plan = {
      date: planDate,
      created: Date.now(),
      start,
      endBy,
      payRate: settings.payRate,
      requested: k,
      view: k,
      depot: { name: settings.depotName, address: settings.depotAddress, lat: depot.lat, lng: depot.lng },
      stops,
      options,
      source: { google: m.fromGoogle, estimated: m.estimated, trafficTime: settings.trafficTime },
    };
    store.saveLastPlan(plan);
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

function legsMeters(order, meters) {
  let prev = 0;
  let sum = 0;
  for (const i of order) {
    sum += meters[prev][i];
    prev = i;
  }
  if (order.length) sum += meters[prev][0];
  return sum;
}

// ---------- Results ----------

function bestOption(p) {
  const ok = p.options.filter((o) => !o.lateCount && o.overtime < 0.5 && o.routes.every((r) => r.order.length));
  const pool = ok.length ? ok : p.options;
  return pool.reduce((a, b) => (b.cost < a.cost - 0.005 ? b : a));
}

function driverName(i) {
  return settings.drivers[i] || `Driver ${i + 1}`;
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
  const view = plan.options.find((o) => o.k === plan.view) || best;

  $('#compare-rows').innerHTML =
    `<tr><th>Drivers</th><th>Back at warehouse</th><th>Last one back</th><th>Paid time</th><th>Labor</th><th>Miles</th><th></th></tr>` +
    plan.options
      .map((o) => {
        const problems = [];
        if (o.overtime >= 0.5) problems.push(`<span class="tag bad">Past ${fmtTime(plan.endBy)}</span>`);
        if (o.lateCount) problems.push(`<span class="tag bad">${o.lateCount} late</span>`);
        if (o.routes.some((r) => !r.order.length)) problems.push('<span class="tag">Not enough stops</span>');
        if (o === best) problems.unshift('<span class="tag good">Best</span>');
        const finishes = o.routes.filter((r) => r.order.length).map((r) => fmtTime(r.finish)).join(', ');
        return `<tr data-k="${o.k}" class="${o.k === view.k ? 'current' : ''}">
          <td><b>${o.k}</b>${o.k === plan.requested ? ' <span class="muted small">(requested)</span>' : ''}</td>
          <td class="small">${finishes}</td>
          <td>${fmtTime(o.lastFinish)}</td>
          <td>${fmtDur(o.totalMinutes)}</td>
          <td><b>${fmtMoney(o.cost)}</b></td>
          <td>${o.miles.toFixed(0)}</td>
          <td>${problems.join(' ')}</td>
        </tr>`;
      })
      .join('');

  const src = plan.source;
  $('#data-note').innerHTML = src.estimated
    ? `<span class="warn-text">⚠ ${src.estimated} of ${src.google + src.estimated} drive times are rough straight-line estimates${settings.apiKey ? '' : ' (no Google API key)'}. Times may be off.</span>`
    : `Drive times from Google with typical traffic around ${fmtTime(toMin(src.trafficTime))}.`;

  $('#plan-title').textContent = `${fmtDateLong(plan.date)} · ${view.k} driver${view.k > 1 ? 's' : ''}`;
  renderMap(view);
  $('#driver-cards').innerHTML = view.routes.map((r, i) => driverCard(r, i)).join('');
}

$('#compare-rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-k]');
  if (!tr) return;
  plan.view = Number(tr.dataset.k);
  store.saveLastPlan(plan);
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

function driverCard(r, i) {
  const color = COLORS[i % COLORS.length];
  if (!r.order.length) {
    return `<div class="card driver" style="--route:${color}"><h3>${esc(driverName(i))}</h3><p class="muted">No stops needed for this driver.</p></div>`;
  }
  const cost = (r.duration / 60) * plan.payRate;
  const rows = r.order
    .map((idx, n) => {
      const s = plan.stops[idx - 1];
      const a = r.arrivals[n];
      const tags = [];
      if (s.priority) tags.push(`<span class="tag prio">Priority · by ${fmtTime(toMin(s.by))}</span>`);
      if (a.late > 0.5) tags.push(`<span class="tag bad">${Math.round(a.late)} min late</span>`);
      const notes = [`Unload ${s.unload} min`, s.notes, s.today].filter(Boolean).map(esc).join(' · ');
      return `<li><span class="num">${n + 1}</span><span class="time">${fmtTime(a.arrive)}</span>
        <div><div class="who">${esc(s.name)} ${tags.join(' ')}</div><div class="addr">${esc(s.address)}</div><div class="note">${notes}</div></div></li>`;
    })
    .join('');
  const links = routeLinks(r);
  return `<div class="card driver" style="--route:${color}">
    <div class="row between"><h3>${esc(driverName(i))}</h3>
      ${r.overtime >= 0.5 ? `<span class="tag bad">${Math.round(r.overtime)} min past ${fmtTime(plan.endBy)}</span>` : `<span class="tag good">Back ${fmtTime(r.finish)}</span>`}</div>
    <div class="stats">
      <span>${esc(fmtDateLong(plan.date))}</span>
      <span>Stops <b>${r.order.length}</b></span>
      <span>Paid <b>${fmtDur(r.duration)} · ${fmtMoney(cost)}</b></span>
      <span>Driving <b>${fmtDur(r.drive)} · ${r.miles.toFixed(0)} mi</b></span>
    </div>
    <ol>
      <li class="depot"><span class="num">W</span><span class="time">${fmtTime(plan.start)}</span><div><div class="who">Leave ${esc(plan.depot.name)}</div></div></li>
      ${rows}
      <li class="depot"><span class="num">W</span><span class="time">${fmtTime(r.finish)}</span><div><div class="who">Back at ${esc(plan.depot.name)}</div></div></li>
    </ol>
    <div class="actions">
      ${links.map((l, n) => `<a class="secondary" href="${esc(l)}" target="_blank" rel="noopener">Open in Google Maps${links.length > 1 ? ` (part ${n + 1})` : ''}</a>`).join(' · ')}
      <button class="secondary" data-copy="${i}">Copy for text</button>
    </div>
  </div>`;
}

$('#driver-cards').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const view = plan.options.find((o) => o.k === plan.view) || bestOption(plan);
  const i = Number(b.dataset.copy);
  const r = view.routes[i];
  const lines = [`${driverName(i)} – ${fmtDateLong(plan.date)}`, `Leave ${plan.depot.name} ${fmtTime(plan.start)}`];
  r.order.forEach((idx, n) => {
    const s = plan.stops[idx - 1];
    const extra = [s.priority ? `PRIORITY by ${fmtTime(toMin(s.by))}` : '', s.notes, s.today].filter(Boolean).join(' – ');
    lines.push(`${n + 1}. ${fmtTime(r.arrivals[n].arrive)} ${s.name}, ${s.address}${extra ? ` (${extra})` : ''}`);
  });
  lines.push(`Back at ${plan.depot.name} about ${fmtTime(r.finish)}`);
  routeLinks(r).forEach((l, n, all) => lines.push(`Map${all.length > 1 ? ` part ${n + 1}` : ''}: ${l}`));
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    b.textContent = 'Copied!';
    setTimeout(() => (b.textContent = 'Copy for text'), 1500);
  } catch {
    prompt('Copy this text:', text);
  }
});

$('#btn-print').addEventListener('click', () => window.print());

function renderMap(view) {
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
  view.routes.forEach((r, i) => {
    const color = COLORS[i % COLORS.length];
    const line = [d];
    r.order.forEach((idx, n) => {
      const s = plan.stops[idx - 1];
      const ll = [s.lat, s.lng];
      line.push(ll);
      pts.push(ll);
      L.marker(ll, { icon: L.divIcon({ className: '', html: `<div class="pin" style="background:${color}">${n + 1}</div>`, iconSize: [26, 26] }) })
        .bindPopup(`<b>${esc(s.name)}</b><br>${esc(driverName(i))} · stop ${n + 1}<br>${fmtTime(r.arrivals[n].arrive)}`)
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
const SETTING_FIELDS = ['depotName', 'depotAddress', 'depotLat', 'depotLng', 'start', 'endBy', 'payRate', 'defaultUnload', 'priorityBy', 'apiKey', 'trafficTime', 'monthlyElementLimit', 'monthlyGeocodeLimit'];
const NUMERIC = new Set(['depotLat', 'depotLng', 'payRate', 'defaultUnload', 'monthlyElementLimit', 'monthlyGeocodeLimit']);

function renderSettings() {
  for (const f of SETTING_FIELDS) sform.elements[f].value = settings[f] ?? '';
  const u = store.getUsage();
  $('#usage-line').textContent =
    `This month: ${u.elements} of ${settings.monthlyElementLimit} drive-time lookups and ${u.geocodes} of ${settings.monthlyGeocodeLimit} address lookups used (counted by this browser).`;
  $('#matrix-line').textContent = `${Object.keys(store.getMatrixCache()).length} drive times saved in this browser. Daily planning reuses them, so it normally makes no Google requests.`;
}

$('#btn-show-key').addEventListener('click', (e) => {
  const input = sform.elements.apiKey;
  input.type = input.type === 'password' ? 'text' : 'password';
  e.target.textContent = input.type === 'password' ? 'Show' : 'Hide';
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
  $('#settings-saved').textContent = settings.depotLat == null ? 'Saved — but the warehouse still has no location.' : 'Saved.';
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
    settings = store.getSettings();
    clients = store.getClients();
    renderSettings();
    renderPlanControls();
    loadDay(planDate);
    renderBanner();
    alert('Backup restored.');
  } catch (err) {
    alert('Could not restore: ' + err.message);
  }
});

// ---------- Start ----------

renderPlanControls();
loadDay(planDate);
renderBanner();
renderResults();
