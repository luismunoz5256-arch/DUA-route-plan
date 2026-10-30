// Drivers' areas: each driver can have an area drawn on the map (a polygon). A client inside a
// driver's area goes to that driver; a driver marked flexible may also take stops from other
// areas, and anyone may take clients outside every area.
//
// areas = { driverName: { poly: [[lat, lng], ...], flex: true|false } }

// Ray casting: is the point inside the polygon?
export function insidePolygon(lat, lng, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// The driver whose area a place is in ('' if none). Drivers are checked in `order` (driver list).
export function areaOwner(place, areas, order) {
  for (const name of order) {
    const a = areas?.[name];
    if (a?.poly?.length >= 3 && insidePolygon(Number(place.lat), Number(place.lng), a.poly)) return name;
  }
  return '';
}

// Who may take a stop, as a bit mask of route indexes for the k drivers working (null = anyone):
// the area's driver plus the flexible drivers. If the area's driver isn't working, anyone.
export function allowedMask(owner, areas, order, k) {
  const index = order.indexOf(owner);
  if (!owner || index < 0 || index >= k) return null;
  let mask = 1 << index;
  order.slice(0, k).forEach((name, r) => {
    if (areas?.[name]?.flex) mask |= 1 << r;
  });
  return mask;
}
