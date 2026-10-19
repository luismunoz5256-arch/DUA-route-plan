// Draws one driver's route as big, phone-friendly cards (driver page and driver login).
import { esc, fmtTime } from './util.js';

function navUrl(place) {
  return 'https://www.google.com/maps/dir/?' + new URLSearchParams({ api: '1', travelmode: 'driving', destination: place });
}

// route: packed route (see share.js). done: { stopKey: truthy }. onToggle(stopKey, nowDone).
export function renderRoute(el, route, done, onToggle) {
  const key = (s, i) => s.id || String(i);
  const count = route.stops.filter((s, i) => done[key(s, i)]).length;
  const html = [
    `<div class="route-head"><h2>${esc(route.driver)}</h2>
      <div>${esc(route.date)} · leave ${fmtTime(route.leave)} · back about ${fmtTime(route.back)}</div>
      <div class="progress">${count} of ${route.stops.length} stops done</div></div>`,
  ];
  route.stops.forEach((s, i) => {
    const isDone = !!done[key(s, i)];
    html.push(`<div class="stop ${isDone ? 'done' : ''}">
      <div class="num">${i + 1}</div>
      <div>
        <div><span class="time">${fmtTime(s.t)}</span> ${s.p ? `<span class="prio">Priority · by ${fmtTime(s.p)}</span>` : ''}</div>
        <div class="name">${esc(s.n)}</div>
        <div class="addr">${esc(s.a)}</div>
        ${s.o ? `<div class="note">📝 ${esc(s.o)}</div>` : ''}
        <div class="btns">
          <a class="go" href="${esc(navUrl(s.a))}" target="_blank" rel="noopener">Navigate</a>
          <button data-stop="${esc(key(s, i))}">${isDone ? 'Undo' : 'Done ✓'}</button>
        </div>
      </div>
    </div>`);
  });
  html.push(`<div class="stop depot"><div class="num">W</div><div>
    <div><span class="time">${fmtTime(route.back)}</span></div>
    <div class="name">Back to ${esc(route.depot.n)}</div><div class="addr">${esc(route.depot.a)}</div>
    <div class="btns"><a class="go" href="${esc(navUrl(route.depot.a))}" target="_blank" rel="noopener">Navigate</a></div></div></div>`);
  html.push('<p class="foot">Times are estimates. Tap <b>Navigate</b> for turn-by-turn directions in Google Maps.</p>');
  el.innerHTML = html.join('');
  el.onclick = (e) => {
    const b = e.target.closest('button[data-stop]');
    if (b) onToggle(b.dataset.stop, !done[b.dataset.stop]);
  };
}
