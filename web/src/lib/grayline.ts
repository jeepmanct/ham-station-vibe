const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Solar declination + equation of time for a given moment (NOAA-style approximation). */
function solarPosition(date: Date): { declDeg: number; eqTimeMinutes: number } {
  const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
  const n = (date.getTime() - J2000) / 86400000; // days since J2000

  const L = ((280.46 + 0.9856474 * n) % 360 + 360) % 360; // mean longitude (deg)
  const g = toRad(((357.528 + 0.9856003 * n) % 360 + 360) % 360); // mean anomaly
  const lambda = toRad(L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)); // ecliptic longitude
  const epsilon = toRad(23.439 - 0.0000004 * n); // obliquity of the ecliptic

  const declDeg = toDeg(Math.asin(Math.sin(epsilon) * Math.sin(lambda)));
  const alpha = toDeg(Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda)));

  let eqTimeDeg = L - alpha;
  while (eqTimeDeg > 180) eqTimeDeg -= 360;
  while (eqTimeDeg < -180) eqTimeDeg += 360;

  return { declDeg, eqTimeMinutes: eqTimeDeg * 4 };
}

/** Subsolar point (where the sun is directly overhead) for a given time. */
export function subsolarPoint(date: Date): { lat: number; lon: number } {
  const { declDeg, eqTimeMinutes } = solarPosition(date);
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let lon = -15 * (utcHours - 12 + eqTimeMinutes / 60);
  lon = ((lon + 180) % 360 + 360) % 360 - 180;

  return { lat: declDeg, lon };
}

/**
 * Sunrise/sunset/solar-noon (UTC) for an observer at (lat, lon) on the given
 * date, using the standard NOAA sunrise equation (accounts for atmospheric
 * refraction + the sun's apparent radius via the 90.833° reference angle).
 * Returns null for polar day/night, when the sun never crosses the horizon.
 */
export function sunriseSunset(date: Date, lat: number, lon: number): { sunrise: Date; sunset: Date; solarNoon: Date } | null {
  const { declDeg, eqTimeMinutes } = solarPosition(date);
  const decl = toRad(declDeg);
  const latRad = toRad(lat);

  const cosH = (Math.cos(toRad(90.833)) - Math.sin(latRad) * Math.sin(decl)) / (Math.cos(latRad) * Math.cos(decl));
  if (cosH < -1 || cosH > 1) return null;
  const haDeg = toDeg(Math.acos(cosH));

  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const minutesToDate = (m: number) => new Date(dayStart + m * 60000);

  const solarNoonMin = 720 - 4 * lon - eqTimeMinutes;
  return {
    sunrise: minutesToDate(solarNoonMin - 4 * haDeg),
    sunset: minutesToDate(solarNoonMin + 4 * haDeg),
    solarNoon: minutesToDate(solarNoonMin),
  };
}

/**
 * Points along the day/night terminator for a given time — the great circle
 * 90° from the subsolar point. Parameterized directly over longitude, which
 * has exactly one valid latitude solution each (tan is single-valued over a
 * 180° span), so this traces one continuous closed curve with no separate
 * antimeridian handling needed.
 */
export function terminatorPoints(date: Date, steps = 361): [number, number][] {
  const sun = subsolarPoint(date);
  const dec = toRad(sun.lat);
  // Avoid blowing up right at equinox (tan(dec) -> 0).
  const tanDec = Math.abs(Math.tan(dec)) < 1e-6 ? (Math.tan(dec) < 0 ? -1e-6 : 1e-6) : Math.tan(dec);

  const points: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const lon = -180 + (360 / steps) * i;
    const H = toRad(lon - sun.lon);
    const lat = toDeg(Math.atan(-Math.cos(H) / tanDec));
    points.push([lat, lon]);
  }
  return points;
}
