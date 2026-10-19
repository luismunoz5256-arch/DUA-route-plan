// Leaflet helpers shared by the route map (Plan tab) and the trucks map (Trucks tab).
import { esc } from './util.js';

// Returns { map, layer } for a map in `el`, created on first use; null if Leaflet didn't load.
export function mapIn(el, existing) {
  if (!window.L) {
    el.hidden = true;
    return null;
  }
  if (existing) {
    existing.layer.clearLayers();
    return existing;
  }
  const map = L.map(el);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  return { map, layer: L.layerGroup().addTo(map) };
}

export function pin(layer, latLng, html, size, popup, zIndexOffset = 0) {
  const icon = L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  const m = L.marker(latLng, { icon, zIndexOffset }).addTo(layer);
  if (popup) m.bindPopup(popup);
  return m;
}

export function depotPin(layer, depot, name) {
  return pin(layer, [depot.lat, depot.lng], '<div class="pin depot">W</div>', 26, esc(name || ''), 1000);
}

// Fit the view to the points once the map is visible (it may have just been un-hidden).
export function fit(m, points) {
  setTimeout(() => {
    m.map.invalidateSize();
    if (points.length) m.map.fitBounds(L.latLngBounds(points), { padding: [30, 30], maxZoom: 14 });
  }, 0);
}
