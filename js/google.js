// Google Maps Platform calls (Geocoding API + Routes API), made straight from the browser.

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
  if (data.status === 'ZERO_RESULTS') throw new Error(`Address not found: ${address}`);
  throw new Error(data.error_message || `Google geocoding error: ${data.status}`);
}

const MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const CHUNK = 10; // 10 x 10 = 100 elements per request, well under Google's per-request limit

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
        throw new Error(`Google Routes API error ${res.status}${msg ? ': ' + msg : ''}`);
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
