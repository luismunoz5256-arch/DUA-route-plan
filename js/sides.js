// Sides of town: each driver can have a home side (west, east, Horizon/Socorro, central), and each
// stop's side comes from where it is compared with the warehouse. A stop leans toward the driver
// of its side, but it's only a preference: it moves to another driver when that saves money.
// The lines suit El Paso with the warehouse on Hawkins (downtown is about 10 km west of it).

export const SIDES = ['west', 'east', 'southeast', 'central'];

// Which side a place is on: km east (dx) and north (dy) of the warehouse.
export function sideOf(place, depot) {
  const dx = (Number(place.lng) - depot.lng) * 111.32 * Math.cos((depot.lat * Math.PI) / 180);
  const dy = (Number(place.lat) - depot.lat) * 110.57;
  if (dx < -12) return 'west'; // the west side, Sunland Park, Canutillo, Anthony
  if (dy < -6 && dx > -6) return 'southeast'; // lower valley, Socorro, Horizon City
  if (dx > 4) return 'east';
  return 'central'; // downtown, northeast, around the warehouse
}

// sides: { driverName: side }. The first driver in `order` whose side it is, or ''.
export function sideDriver(place, depot, sides, order) {
  if (!depot || !sides) return '';
  const side = sideOf(place, depot);
  return order.find((name) => sides[name] === side) || '';
}

// The sides as first set up: Driver 1 west, 2 east, 3 Horizon/Socorro, 4 central.
export function defaultSides(order) {
  return Object.fromEntries(SIDES.map((side, i) => [order[i], side]).filter(([name]) => name));
}
