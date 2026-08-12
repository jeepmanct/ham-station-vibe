export type LatLon = { lat: number; lon: number };

/** Converts a Maidenhead grid locator (4, 6, or 8 chars) to its center point. */
export function gridToLatLon(grid: string): LatLon | null {
  const g = grid.trim().toUpperCase();
  if (g.length < 4 || g.length % 2 !== 0) return null;
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2})?)?$/.test(g)) return null;

  let lon = (g.charCodeAt(0) - 65) * 20 - 180;
  let lat = (g.charCodeAt(1) - 65) * 10 - 90;
  lon += Number(g[2]) * 2;
  lat += Number(g[3]) * 1;
  let lonCell = 2;
  let latCell = 1;

  if (g.length >= 6) {
    lon += (g.charCodeAt(4) - 65) * (2 / 24);
    lat += (g.charCodeAt(5) - 65) * (1 / 24);
    lonCell = 2 / 24;
    latCell = 1 / 24;
  }
  if (g.length >= 8) {
    lon += Number(g[6]) * (lonCell / 10);
    lat += Number(g[7]) * (latCell / 10);
    lonCell /= 10;
    latCell /= 10;
  }

  return { lat: lat + latCell / 2, lon: lon + lonCell / 2 };
}

const FIELD_LETTERS = 'ABCDEFGHIJKLMNOPQR';
const SUBSQUARE_LETTERS = 'abcdefghijklmnopqrstuvwx';

/** Converts a lat/lon to a 6-character Maidenhead grid locator. */
export function latLonToGrid(lat: number, lon: number): string | null {
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  let adjLon = lon + 180;
  let adjLat = lat + 90;

  const fieldLon = Math.floor(adjLon / 20);
  const fieldLat = Math.floor(adjLat / 10);
  adjLon %= 20;
  adjLat %= 10;

  const squareLon = Math.floor(adjLon / 2);
  const squareLat = Math.floor(adjLat / 1);
  adjLon %= 2;
  adjLat %= 1;

  const subLon = Math.floor((adjLon / 2) * 24);
  const subLat = Math.floor((adjLat / 1) * 24);

  return `${FIELD_LETTERS[fieldLon]}${FIELD_LETTERS[fieldLat]}${squareLon}${squareLat}${SUBSQUARE_LETTERS[subLon]}${SUBSQUARE_LETTERS[subLat]}`;
}

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;
const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in km between two coordinates. */
export function distanceKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Initial great-circle bearing in degrees (0-360, 0 = north) from a to b. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
