import { db } from './db';
import { latLonToGrid } from './maidenhead';

type Row = { callsign: string | null; label: string | null; lat: number | null; lon: number | null; grid: string | null };

function getRow(): Row | null {
  return db.query('SELECT callsign, label, lat, lon, grid FROM station_location WHERE id = 1').get() as Row | null;
}

export type StationLocation = { label: string | null; lat: number; lon: number; grid: string | null };

/** Admin-configured QTH if set; null when not yet configured (callers fall back to their own inference, e.g. conditions.ts's most-common-logged-coordinate heuristic) or when only the callsign has been set so far. */
export function getStationLocation(): StationLocation | null {
  const row = getRow();
  if (!row || row.lat == null || row.lon == null) return null;
  return { label: row.label, lat: row.lat, lon: row.lon, grid: row.grid };
}

/**
 * Admin-configured location if set, else the QSO-inference fallback
 * (most-common logged home coordinate) -- the same two-step lookup
 * conditions.ts's /home, qsos.ts's /geo, and stats.ts's /distance each
 * independently implement inline. New callers should use this instead of
 * re-deriving it; the existing inline copies are unchanged (low-risk,
 * already-working code, not worth touching just for this).
 */
export function getEffectiveHomeLocation(): { lat: number; lon: number; grid: string | null } | null {
  const configured = getStationLocation();
  if (configured) return { lat: configured.lat, lon: configured.lon, grid: configured.grid };
  const row = db
    .query(
      `SELECT my_lat as lat, my_lon as lon, my_gridsquare as grid, COUNT(*) as count
       FROM qsos WHERE my_lat IS NOT NULL AND my_lon IS NOT NULL
       GROUP BY my_lat, my_lon ORDER BY count DESC LIMIT 1`,
    )
    .get() as { lat: number; lon: number; grid: string | null } | null;
  return row ? { lat: row.lat, lon: row.lon, grid: row.grid } : null;
}

export function setStationLocation(cfg: { label?: string; lat: number; lon: number }) {
  const grid = latLonToGrid(cfg.lat, cfg.lon);
  const existing = getRow();
  db.query(
    `INSERT INTO station_location (id, callsign, label, lat, lon, grid) VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, lat = excluded.lat, lon = excluded.lon, grid = excluded.grid`,
  ).run(existing?.callsign ?? null, cfg.label || null, cfg.lat, cfg.lon, grid);
}

export function clearStationLocation() {
  const existing = getRow();
  if (existing?.callsign) {
    // A callsign is set -- keep the row (and the callsign), just clear the
    // location fields, rather than deleting the whole row out from under it.
    db.query('UPDATE station_location SET label = NULL, lat = NULL, lon = NULL, grid = NULL WHERE id = 1').run();
  } else {
    db.exec('DELETE FROM station_location WHERE id = 1');
  }
}

/**
 * The operator's own callsign -- this site's one piece of unavoidably
 * personal identity, used everywhere a hardcoded "N1AH"-style constant used
 * to be (POTA/PSK-Reporter/WSPR/RBN lookups, QSL card rendering, ADIF export
 * headers, page branding, third-party API User-Agent strings). No fallback
 * inference is possible the way location has one -- null just means "not
 * configured yet," and callers should degrade gracefully (hide the feature,
 * show a placeholder) rather than assume a value.
 */
export function getStationCallsign(): string | null {
  return getRow()?.callsign ?? null;
}

export function setStationCallsign(callsign: string) {
  const existing = getRow();
  db.query(
    `INSERT INTO station_location (id, callsign, label, lat, lon, grid) VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET callsign = excluded.callsign`,
  ).run(callsign.trim().toUpperCase() || null, existing?.label ?? null, existing?.lat ?? null, existing?.lon ?? null, existing?.grid ?? null);
}
