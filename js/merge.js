// Combine two copies of the shared data (this computer's and the Google Sheet's).
// Each client and history day carries an `updated` time; the newer copy wins.
// Deleted clients leave a tombstone so the delete spreads to other computers.
//
// Shape: { clients: [], deletedClients: {id: time}, history: {date: entry},
//          matrix / matrix2: {pair: [min, meters]} (midday / afternoon), settings: {}, settingsUpdated: time,
//          routes: {date: {updated, drivers}}, done: {date: {driver: {stopId: time}}},
//          days: {date: {updated, selected, ...}}, plans: {date: {updated, ...plan}},
//          orders: {date: {updated, ids}} }
// `done` belongs to the server (drivers tick stops there), so b's copy wins when a is local.

export function mergeData(a, b) {
  if (!b) return a;
  if (!a) return b;
  let deletedClients = { ...(a.deletedClients || {}) };
  for (const [id, t] of Object.entries(b.deletedClients || {})) deletedClients[id] = Math.max(t, deletedClients[id] || 0);

  const byId = new Map();
  for (const c of [...(a.clients || []), ...(b.clients || [])]) {
    const cur = byId.get(c.id);
    if (!cur || (c.updated || 0) > (cur.updated || 0)) byId.set(c.id, c);
  }
  deletedClients = withoutMassDeletes(deletedClients, byId.size);
  const clients = [...byId.values()].filter((c) => !(deletedClients[c.id] >= (c.updated || 0)));

  const byDate = (x, y) => {
    const out = { ...(x || {}) };
    for (const [date, e] of Object.entries(y || {})) {
      if (!out[date] || (e.updated || 0) > (out[date].updated || 0)) out[date] = e;
    }
    return out;
  };
  const history = byDate(a.history, b.history);
  const routes = byDate(a.routes, b.routes);
  const days = byDate(a.days, b.days);
  const plans = byDate(a.plans, b.plans);
  const orders = byDate(a.orders, b.orders);

  const aNewer = (a.settingsUpdated || 0) >= (b.settingsUpdated || 0);
  return {
    clients,
    deletedClients,
    history,
    matrix: { ...(b.matrix || {}), ...(a.matrix || {}) },
    matrix2: { ...(b.matrix2 || {}), ...(a.matrix2 || {}) },
    settings: aNewer ? a.settings : b.settings,
    settingsUpdated: Math.max(a.settingsUpdated || 0, b.settingsUpdated || 0),
    routes,
    done: b.done || a.done || {},
    days,
    plans,
    orders,
  };
}

// People delete clients one at a time. Most of the list deleted in the same minute means a computer
// lost its copy, so those deletes are ignored and the clients stay.
export function withoutMassDeletes(deleted, clientCount) {
  const byMinute = new Map();
  for (const [id, t] of Object.entries(deleted)) byMinute.set(Math.floor(t / 60000), [...(byMinute.get(Math.floor(t / 60000)) || []), id]);
  const out = { ...deleted };
  for (const ids of byMinute.values()) if (ids.length >= 5 && ids.length >= clientCount / 2) for (const id of ids) delete out[id];
  return out;
}

// What a sync would wipe out: lists that held at least 5 items and would lose more than half.
export function dataLoss(before, after) {
  const count = { clients: (d) => (d?.clients || []).length, history: (d) => Object.keys(d?.history || {}).length, routes: (d) => Object.keys(d?.routes || {}).length };
  return Object.entries(count)
    .filter(([, n]) => n(before) >= 5 && n(after) < n(before) / 2)
    .map(([name]) => name);
}

// JSON with sorted keys, so two equal objects always give the same text.
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}
