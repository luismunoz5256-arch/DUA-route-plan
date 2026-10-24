// Draws one driver's route as big, phone-friendly cards (driver page and driver login).
import { esc, fmtTime } from './util.js';
import { t, locale } from './i18n.js';

function navUrl(place) {
  return 'https://www.google.com/maps/dir/?' + new URLSearchParams({ api: '1', travelmode: 'driving', destination: place });
}

// Routes carry the date as YYYY-MM-DD (older links had it already written out).
function showDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' });
}

// Loaded ticks share the done map, under "load:" + stop key, so they save the same way as Done.
export const LOADED = 'load:';

// Which view each route shows: 'route' or 'load' (the loading list). Until everything is
// loaded the loading list comes first; after that the route.
const views = {};

// route: packed route (see share.js). done: { stopKey: truthy, "load:stopKey": truthy }.
// onToggle(key, nowDone) for both Done and Loaded.
export function renderRoute(el, route, done, onToggle) {
  const key = (s, i) => s.id || String(i);
  const count = route.stops.filter((s, i) => done[key(s, i)]).length;
  const loaded = route.stops.filter((s, i) => done[LOADED + key(s, i)]).length;
  const viewKey = route.driver + route.date;
  const view = views[viewKey] || (loaded < route.stops.length && !count ? 'load' : 'route');
  const navigate = t('Navigate');
  const html = [
    `<div class="route-head"><h2>${esc(route.driver)}</h2>
      <div>${esc(showDate(route.date))} · ${t('leave {time}', { time: fmtTime(route.leave) })} · ${t('back about {time}', { time: fmtTime(route.back) })}</div>
      <div class="progress">${t('{n} of {total} stops done', { n: count, total: route.stops.length })} · 📦 ${t('{n} of {total} loaded', { n: loaded, total: route.stops.length })}</div></div>`,
    `<div class="view-switch" role="tablist">
      <button data-view="route" class="${view === 'route' ? 'on' : ''}">🚚 ${t('Route')}</button>
      <button data-view="load" class="${view === 'load' ? 'on' : ''}">📦 ${t('Loading list')}</button>
    </div>`,
  ];
  // Until orders close the list is for loading; the driving order is set after that.
  if (route.f === 0 && route.stops.length) {
    html.push(`<div class="load-note">📦 ${route.c ? t('Load these stops. More orders may be added until {time}; the driving order is set after that.', { time: fmtTime(route.c) }) : t('Load these stops. The driving order is set when orders close.')}</div>`);
  } else if (route.f === 1) {
    html.push(`<div class="load-note final">✓ ${t('Final driving order.')}</div>`);
  }
  if (route.g?.length) {
    html.push(`<div class="gone"><b>${t('Taken off your route — do not deliver:')}</b> ${route.g.map(esc).join(', ')}</div>`);
  }
  if (view === 'load') {
    html.push(`<p class="foot">${t('Load the last stop first, so the first stop ends up by the door.')}</p>`);
    // Last stop first: it goes in at the back of the truck.
    route.stops
      .map((s, i) => [s, i])
      .reverse()
      .forEach(([s, i], n) => {
        const k = LOADED + key(s, i);
        const where = n === 0 ? t('load first (back of the truck)') : n === route.stops.length - 1 ? t('load last (by the door)') : '';
        html.push(`<div class="stop load ${done[k] ? 'done' : ''}">
          <div class="num">${i + 1}</div>
          <div>
            <div>${s.x ? `<span class="new">${t('New')}</span> ` : ''}${where ? `<span class="muted-tag">${where}</span>` : ''}</div>
            <div class="name">${esc(s.n)}</div>
            ${s.o ? `<div class="note">📝 ${esc(s.o)}</div>` : ''}
            <div class="btns"><button data-stop="${esc(k)}" class="${done[k] ? '' : 'go'}">${done[k] ? t('Undo') : t('Loaded ✓')}</button></div>
          </div>
        </div>`);
      });
    el.innerHTML = html.join('');
    el.onclick = (e) => click(e);
    return;
  }
  route.stops.forEach((s, i) => {
    const isDone = !!done[key(s, i)];
    html.push(`<div class="stop ${isDone ? 'done' : ''}">
      <div class="num">${i + 1}</div>
      <div>
        <div><span class="time">${fmtTime(s.t)}</span> ${s.x ? `<span class="new">${t('New')}</span>` : ''} ${s.p ? `<span class="prio">${t('Priority · by {time}', { time: fmtTime(s.p) })}</span>` : ''}</div>
        <div class="name">${esc(s.n)}</div>
        <div class="addr">${esc(s.a)}</div>
        ${s.o ? `<div class="note">📝 ${esc(s.o)}</div>` : ''}
        <div class="btns">
          <a class="go" href="${esc(navUrl(s.a))}" target="_blank" rel="noopener">${navigate}</a>
          <button data-stop="${esc(key(s, i))}">${isDone ? t('Undo') : t('Done ✓')}</button>
        </div>
      </div>
    </div>`);
  });
  html.push(`<div class="stop depot"><div class="num">W</div><div>
    <div><span class="time">${fmtTime(route.back)}</span></div>
    <div class="name">${t('Back to {place}', { place: esc(route.depot.n) })}</div><div class="addr">${esc(route.depot.a)}</div>
    <div class="btns"><a class="go" href="${esc(navUrl(route.depot.a))}" target="_blank" rel="noopener">${navigate}</a></div></div></div>`);
  html.push(`<p class="foot">${t('Times are estimates. Tap <b>Navigate</b> for turn-by-turn directions in Google Maps.')}</p>`);
  el.innerHTML = html.join('');
  el.onclick = (e) => click(e);

  function click(e) {
    const v = e.target.closest('button[data-view]');
    if (v) {
      views[viewKey] = v.dataset.view;
      return renderRoute(el, route, done, onToggle);
    }
    const b = e.target.closest('button[data-stop]');
    if (b) onToggle(b.dataset.stop, !done[b.dataset.stop]);
  }
}
