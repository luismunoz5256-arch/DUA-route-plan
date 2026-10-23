// Google Maps Platform calls (Geocoding API + Routes API), made straight from the browser.
import { t } from './i18n.js';

// Rough box around El Paso to prefer local matches when looking up addresses.
const EL_PASO_BOUNDS = '31.55,-106.70|32.05,-106.00';

export async function geocode(apiKey, address) {
  const url =
    'https://maps.googleapis.com/maps/api/geocode/json?' +
    new URLSearchParams({ address, key: apiKey, region: 'us', bounds: EL_PASO_BOUNDS });
  const res = await fetch(url);
  const data = await res.json();
  if (data.status === 'OK') {
    const r = data.results[0];
    return {
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      formatted: r.formatted_address,
      partial: !!r.partial_match,
    };
  }
  if (data.status === 'ZERO_RESULTS') throw new Error(t('Address not found: {address}', { address }));
  throw new Error(data.error_message || t('Google address lookup error: {status}', { status: data.status }));
}

const MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
export const CHUNK = 10; // 10 x 10 = 100 elements per request, well under Google's per-request limit

function waypoint(p) {
  return { waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } };
}

// Traffic-aware drive times for every origin x destination pair.
// Returns [{ from, to, minutes, meters }] using indexes into the input arrays.
// onProgress(done, total, elementsBilled) runs after each request.
export async function routeMatrix(apiKey, origins, destinations, departureTime, onProgress) {
  const out = [];
  const total = Math.ceil(origins.length / CHUNK) * Math.ceil(destinations.length / CHUNK);
  let done = 0;
  for (let oi = 0; oi < origins.length; oi += CHUNK) {
    for (let di = 0; di < destinations.length; di += CHUNK) {
      const o = origins.slice(oi, oi + CHUNK);
      const d = destinations.slice(di, di + CHUNK);
      const res = await fetch(MATRIX_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,status,condition',
        },
        body: JSON.stringify({
          origins: o.map(waypoint),
          destinations: d.map(waypoint),
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_AWARE',
          departureTime: departureTime.toISOString(),
        }),
      });
      if (!res.ok) {
        let msg = '';
        try {
          msg = (await res.json()).error?.message || '';
        } catch {}
        throw new Error(t('Google drive-time lookup error {code}', { code: res.status }) + (msg ? ': ' + msg : ''));
      }
      const rows = await res.json();
      for (const r of rows) {
        // Google leaves out fields equal to 0, so missing indexes mean 0.
        if (r.condition && r.condition !== 'ROUTE_EXISTS') continue;
        out.push({
          from: oi + (r.originIndex ?? 0),
          to: di + (r.destinationIndex ?? 0),
          minutes: parseFloat(r.duration || '0s') / 60,
          meters: r.distanceMeters ?? 0,
        });
      }
      onProgress?.(++done, total, o.length * d.length);
    }
  }
  return out;
}

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const MAX_STOPS_BETWEEN = 25; // Google's limit on stops between the start and the end of one route

// Google's encoded polyline -> [[lat, lng], ...] (https://developers.google.com/maps/documentation/utilities/polylinealgorithm)
export function decodePolyline(text) {
  const out = [];
  let lat = 0;
  let lng = 0;
  for (let i = 0; i < text.length; ) {
    for (const axis of [0, 1]) {
      let shift = 0;
      let value = 0;
      let byte;
      do {
        byte = text.charCodeAt(i++) - 63;
        value |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = value & 1 ? ~(value >> 1) : value >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

// The roads a truck drives through `points` in order ([{ lat, lng }], warehouse first and last),
// as [[lat, lng], ...] for drawing on the map. Long routes are asked for in pieces.
export async function roadPath(apiKey, points) {
  const path = [];
  for (let i = 0; i < points.length - 1; i += MAX_STOPS_BETWEEN + 1) {
    const piece = points.slice(i, i + MAX_STOPS_BETWEEN + 2);
    const res = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'routes.polyline.encodedPolyline' },
      body: JSON.stringify({
        origin: waypoint(piece[0]).waypoint,
        destination: waypoint(piece[piece.length - 1]).waypoint,
        intermediates: piece.slice(1, -1).map((p) => waypoint(p).waypoint),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE', // only the shape is needed, and this costs less
      }),
    });
    if (!res.ok) throw new Error(t('Google route drawing error {code}', { code: res.status }));
    const encoded = (await res.json()).routes?.[0]?.polyline?.encodedPolyline;
    if (!encoded) throw new Error(t('Google found no road route.'));
    path.push(...decodePolyline(encoded));
  }
  return path;
}
