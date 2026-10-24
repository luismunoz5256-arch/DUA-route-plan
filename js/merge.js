// Combine two copies of the shared data (this computer's and the Google Sheet's).
// Each client and history day carries an `updated` time; the newer copy wins.
// Deleted clients leave a tombstone so the delete spreads to other computers.
//
// Shape: { clients: [], deletedClients: {id: time}, history: {date: entry},
//          matrix / matrix2: {pair: [min, meters]} (midday / afternoon), settings: {}, settingsUpdated: time,
//          routes: {date: {updated, drivers}}, done: {date: {driver: {stopId: time}}},
//          days: {date: {updated, selected, ...}}, plans: {date: {updated, ...plan}} }
// `done` belongs to the server (drivers tick stops there), so b's copy wins when a is local.

export function mergeData(a, b) {
  if (!b) return a;
  if (!a) return b;
  const deletedClients = { ...(a.deletedClients || {}) };
  for (const [id, t] of Object.entries(b.deletedClients || {})) deletedClients[id] = Math.max(t, deletedClients[id] || 0);

  const byId = new Map();
  for (const c of [...(a.clients || []), ...(b.clients || [])]) {
    const cur = byId.get(c.id);
    if (!cur || (c.updated || 0) > (cur.updated || 0)) byId.set(c.id, c);
  }
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
  };
}

// JSON with sorted keys, so two equal objects always give the same text.
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}
