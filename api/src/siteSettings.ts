// Site-wide display preferences (currently just distance units) -- distinct
// from alertConfig.ts (notification settings) and serviceCredentials.ts
// (external-service access), this is purely "how should the site show
// things" state. Read by every page/script that displays a distance;
// changed from one place under Admin rather than each page carrying its
// own unit toggle.
import { db } from './db';

export type DistanceUnit = 'km' | 'mi';

function getRow(): { distance_unit: string } | null {
  return db.query('SELECT distance_unit FROM site_settings WHERE id = 1').get() as { distance_unit: string } | null;
}

export function getDistanceUnit(): DistanceUnit {
  return getRow()?.distance_unit === 'km' ? 'km' : 'mi';
}

export function setDistanceUnit(unit: DistanceUnit) {
  db.query(
    `INSERT INTO site_settings (id, distance_unit) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET distance_unit = excluded.distance_unit`,
  ).run(unit);
}

const KM_PER_MI = 1.609344;

/** Converts a km value to the site's preferred unit and formats it with the unit suffix, e.g. "142 mi" or "228 km". */
export function formatDistance(km: number, unit: DistanceUnit = getDistanceUnit(), decimals = 0): string {
  const value = unit === 'mi' ? km / KM_PER_MI : km;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals })} ${unit}`;
}
