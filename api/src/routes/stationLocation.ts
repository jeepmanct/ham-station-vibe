import { Hono } from 'hono';
import { requireAuth } from '../auth';
import {
  getStationLocation,
  setStationLocation,
  clearStationLocation,
  getStationCallsign,
  setStationCallsign,
} from '../stationLocation';

export const stationLocationRoutes = new Hono();

// GET is public (no requireAuth) -- the admin form needs it, but so does
// site branding (header/footer/page title) on every public page, and none
// of this is a secret (the location is already derivable from the public
// QSO log's MY_LAT/MY_LON fields via /api/conditions/home, and the callsign
// is, definitionally, public -- it's an FCC-issued license identifier).
stationLocationRoutes.get('/', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ callsign: getStationCallsign(), location: getStationLocation() });
});

stationLocationRoutes.post('/', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body?.callsign !== undefined) {
    const callsign = String(body.callsign).trim();
    if (!callsign) return c.json({ error: 'callsign cannot be blank' }, 400);
    setStationCallsign(callsign);
  }
  if (body?.lat !== undefined || body?.lon !== undefined) {
    const lat = Number(body?.lat);
    const lon = Number(body?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return c.json({ error: 'Valid lat and lon are required' }, 400);
    }
    setStationLocation({ label: body.label ? String(body.label).trim() : undefined, lat, lon });
  }
  return c.json({ callsign: getStationCallsign(), location: getStationLocation() });
});

// Clears the location only -- callsign has no equivalent "clear" action from
// the UI (every feature that reads it needs *a* callsign to function at
// all, so there's no useful "unset" state to offer once one's been entered).
stationLocationRoutes.delete('/', requireAuth, (c) => {
  clearStationLocation();
  return c.json({ callsign: getStationCallsign(), location: getStationLocation() });
});
