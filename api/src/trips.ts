import { db } from './db';

export type Trip = {
  id: number;
  label: string;
  callsign: string;
  lat: number;
  lon: number;
  grid: string | null;
  startDate: string | null;
  endDate: string | null;
};

type Row = { id: number; label: string; callsign: string; lat: number; lon: number; grid: string | null; start_date: string | null; end_date: string | null };

function rowToTrip(r: Row): Trip {
  return { id: r.id, label: r.label, callsign: r.callsign, lat: r.lat, lon: r.lon, grid: r.grid, startDate: r.start_date, endDate: r.end_date };
}

/** Public (not admin-gated) -- a trip's label/callsign/location isn't sensitive, and both the manual QSO form and the map's trip selector need to read this list without a login. */
export function getTrips(): Trip[] {
  return (db.query('SELECT id, label, callsign, lat, lon, grid, start_date, end_date FROM trips ORDER BY start_date DESC, id DESC').all() as Row[]).map(rowToTrip);
}

export function getTrip(id: number): Trip | null {
  const row = db.query('SELECT id, label, callsign, lat, lon, grid, start_date, end_date FROM trips WHERE id = ?').get(id) as Row | null;
  return row ? rowToTrip(row) : null;
}

export function createTrip(cfg: { label: string; callsign: string; lat: number; lon: number; grid?: string | null; startDate?: string | null; endDate?: string | null }): Trip {
  const result = db
    .query('INSERT INTO trips (label, callsign, lat, lon, grid, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .get(cfg.label, cfg.callsign, cfg.lat, cfg.lon, cfg.grid ?? null, cfg.startDate ?? null, cfg.endDate ?? null) as { id: number };
  return getTrip(result.id)!;
}

export function updateTrip(id: number, cfg: { label: string; callsign: string; lat: number; lon: number; grid?: string | null; startDate?: string | null; endDate?: string | null }): Trip | null {
  db.query('UPDATE trips SET label = ?, callsign = ?, lat = ?, lon = ?, grid = ?, start_date = ?, end_date = ? WHERE id = ?').run(
    cfg.label,
    cfg.callsign,
    cfg.lat,
    cfg.lon,
    cfg.grid ?? null,
    cfg.startDate ?? null,
    cfg.endDate ?? null,
    id,
  );
  return getTrip(id);
}

/** QSOs already tagged with this trip keep their trip_id (and their real logged lat/lon/callsign) -- deleting a trip only removes it from the picker for future QSOs, it doesn't touch history. */
export function deleteTrip(id: number) {
  db.query('DELETE FROM trips WHERE id = ?').run(id);
}
