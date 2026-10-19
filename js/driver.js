// Phone page for one driver, opened from a link. The whole route travels inside the link
// (after the #), so nothing is stored on a server. "Done" ticks are saved on the phone only.
import { decodeRoute } from './share.js';
import { renderRoute } from './routeview.js';

const el = document.querySelector('#stops');

function render() {
  let route;
  try {
    route = decodeRoute(location.hash.slice(1));
  } catch {
    el.innerHTML = '<p class="error">This route link is incomplete. Ask the office to send it again.</p>';
    return;
  }
  const doneKey = 'dua.done.' + location.hash.slice(1, 60);
  let done = {};
  try {
    done = JSON.parse(localStorage.getItem(doneKey) || '{}');
  } catch {}
  document.title = `${route.driver} – route`;
  renderRoute(el, route, done, (stop, isDone) => {
    done[stop] = isDone;
    try {
      localStorage.setItem(doneKey, JSON.stringify(done));
    } catch {}
    render();
  });
}

window.addEventListener('hashchange', render);
render();
