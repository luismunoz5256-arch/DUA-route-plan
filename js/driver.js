// Phone page for one driver. The whole route travels inside the link (after the #),
// so nothing is stored on a server. "Done" ticks are saved on the driver's phone.
import { esc, fmtTime } from './util.js';
import { decodeRoute } from './share.js';

const $ = (s) => document.querySelector(s);

function navUrl(place) {
  return 'https://www.google.com/maps/dir/?' + new URLSearchParams({ api: '1', travelmode: 'driving', destination: place });
}

function render() {
  let r;
  try {
    r = decodeRoute(location.hash.slice(1));
  } catch {
    document.body.innerHTML = '<p class="error">This route link is incomplete. Ask the office to send it again.</p>';
    return;
  }
  const doneKey = 'dua.done.' + location.hash.slice(1, 60);
  let done = {};
  try {
    done = JSON.parse(localStorage.getItem(doneKey) || '{}');
  } catch {}
  const saveDone = () => {
    try {
      localStorage.setItem(doneKey, JSON.stringify(done));
    } catch {}
  };

  document.title = `${r.driver} – route`;
  $('#title').textContent = r.driver;
  $('#sub').textContent = `${r.date} · leave ${fmtTime(r.leave)} · back about ${fmtTime(r.back)}`;
  const count = Object.values(done).filter(Boolean).length;
  $('#progress').textContent = `${count} of ${r.stops.length} stops done`;

  const html = r.stops.map((s, i) => {
    const isDone = !!done[i];
    return `<div class="stop ${isDone ? 'done' : ''}">
      <div class="num">${i + 1}</div>
      <div>
        <div><span class="time">${fmtTime(s.t)}</span> ${s.p ? `<span class="prio">Priority · by ${fmtTime(s.p)}</span>` : ''}</div>
        <div class="name">${esc(s.n)}</div>
        <div class="addr">${esc(s.a)}</div>
        ${s.o ? `<div class="note">📝 ${esc(s.o)}</div>` : ''}
        <div class="btns">
          <a class="go" href="${esc(navUrl(s.a))}" target="_blank" rel="noopener">Navigate</a>
          <button data-i="${i}">${isDone ? 'Undo' : 'Done ✓'}</button>
        </div>
      </div>
    </div>`;
  });
  html.push(`<div class="stop depot"><div class="num">W</div><div>
    <div><span class="time">${fmtTime(r.back)}</span></div>
    <div class="name">Back to ${esc(r.depot.n)}</div><div class="addr">${esc(r.depot.a)}</div>
    <div class="btns"><a class="go" href="${esc(navUrl(r.depot.a))}" target="_blank" rel="noopener">Navigate</a></div></div></div>`);
  $('#stops').innerHTML = html.join('');
  $('#stops').onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    done[b.dataset.i] = !done[b.dataset.i];
    saveDone();
    render();
  };
  $('#footer').innerHTML = 'Times are estimates. Tap <b>Navigate</b> for turn-by-turn directions in Google Maps.';
}

window.addEventListener('hashchange', render);
render();
