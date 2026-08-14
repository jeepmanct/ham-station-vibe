// Site-wide distance unit preference (set under Admin) -- fetched once per
// page load and cached in memory for the rest of that page's lifetime,
// not re-fetched on every distance formatted. Defaults to 'mi' if the
// fetch fails for any reason, matching the site's own default preference
// rather than silently falling back to km.
export type DistanceUnit = 'km' | 'mi';

const KM_PER_MI = 1.609344;

let cached: DistanceUnit | null = null;

export async function fetchDistanceUnit(): Promise<DistanceUnit> {
  if (cached) return cached;
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    cached = data.distanceUnit === 'km' ? 'km' : 'mi';
  } catch {
    cached = 'mi';
  }
  return cached;
}

/** Converts a km value to the given unit and formats it with the unit suffix, e.g. "142 mi" or "228 km". */
export function formatDistance(km: number, unit: DistanceUnit, decimals = 0): string {
  const value = unit === 'mi' ? km / KM_PER_MI : km;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals })} ${unit}`;
}
