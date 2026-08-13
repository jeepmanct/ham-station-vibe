import { Hono } from 'hono';
import { db } from '../db';
import { resolveCallsignEntity } from '../dxccPrefixes';
import { getStationLocation } from '../stationLocation';
import { distanceKm, bearingDeg, type LatLon } from '../maidenhead';

export const bearingRoutes = new Hono();

// Great-circle heading + distance to a callsign's DXCC entity -- resolved
// from cty.dat's own reference coordinate for that entity (an
// approximation, not the specific station's real QTH; see
// dxccPrefixes.ts's PrefixEntry comment), same source qsoImport.ts already
// falls back to for LoTW-sourced QSOs missing precise location data. Good
// enough for pointing a beam -- typical antenna beamwidths are far wider
// than the error this approximation introduces.
bearingRoutes.get('/', (c) => {
  const call = c.req.query('call')?.trim().toUpperCase();
  if (!call) return c.json({ error: 'call is required' }, 400);

  const resolved = resolveCallsignEntity(call);
  if (!resolved) return c.json({ error: `Could not resolve a DXCC entity for "${call}"` }, 404);

  // Same "admin-configured Station Location wins, else infer from the most
  // common logged QSO coordinate" fallback every other home-location-aware
  // route uses (see /api/conditions/home, /api/qsos/geo, /api/stats/distance).
  const configured = getStationLocation();
  const home: LatLon | null = configured
    ? { lat: configured.lat, lon: configured.lon }
    : (db
        .query(
          `SELECT my_lat as lat, my_lon as lon, COUNT(*) as count
           FROM qsos WHERE my_lat IS NOT NULL AND my_lon IS NOT NULL
           GROUP BY my_lat, my_lon ORDER BY count DESC LIMIT 1`,
        )
        .get() as LatLon | null);
  if (!home) return c.json({ error: 'No home location available -- set Station Location under Admin, or log a QSO with a home grid square first.' }, 409);

  const target: LatLon = { lat: resolved.lat, lon: resolved.lon };
  const shortPath = bearingDeg(home, target);
  return c.json({
    call,
    entity: resolved.entity,
    continent: resolved.continent,
    distanceKm: distanceKm(home, target),
    bearingDeg: shortPath,
    longPathBearingDeg: (shortPath + 180) % 360,
  });
});
