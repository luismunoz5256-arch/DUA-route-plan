// Packs one driver's route into a short, URL-safe string for the driver phone page.

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// route: { driver, date, leave, back, depot: {n, a}, stops: [{ n, a, t, p, o }] }
//   n = name, a = address, t = arrival (minutes), p = priority deadline (minutes) or 0, o = notes
//   x = 1 when added after the driver first got the list
// Also: f = 1 when the driving order is final (0 = still taking orders), c = when orders close (minutes),
//   g = names of stops taken off this driver's list
export function encodeRoute(route) {
  return toBase64Url(JSON.stringify(route));
}

export function decodeRoute(s) {
  const r = JSON.parse(fromBase64Url(s));
  if (!r || !Array.isArray(r.stops)) throw new Error('bad route');
  return r;
}
