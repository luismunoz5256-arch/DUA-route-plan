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

// route: packed route (see share.js). done: { stopKey: truthy }. onToggle(stopKey, nowDone).
export function renderRoute(el, route, done, onToggle) {
  const key = (s, i) => s.id || String(i);
  const count = route.stops.filter((s, i) => done[key(s, i)]).length;
  const navigate = t('Navigate');
  const html = [
    `<div class="route-head"><h2>${esc(route.driver)}</h2>
      <div>${esc(showDate(route.date))} · ${t('leave {time}', { time: fmtTime(route.leave) })} · ${t('back about {time}', { time: fmtTime(route.back) })}</div>
      <div class="progress">${t('{n} of {total} stops done', { n: count, total: route.stops.length })}</div></div>`,
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
  el.onclick = (e) => {
    const b = e.target.closest('button[data-stop]');
    if (b) onToggle(b.dataset.stop, !done[b.dataset.stop]);
  };
}
