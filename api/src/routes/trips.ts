import { Hono } from 'hono';
import { requireAuth } from '../auth';
import { getTrips, createTrip, updateTrip, deleteTrip } from '../trips';

export const tripRoutes = new Hono();

// Public -- a trip's label/callsign/location isn't sensitive, and both the
// manual QSO form (to pick "operating as") and /map's trip selector need
// this list without requiring a login.
tripRoutes.get('/', (c) => c.json(getTrips()));

function parseBody(body: Record<string, unknown> | null) {
  if (!body?.label || !body?.callsign || body.lat == null || body.lon == null) return null;
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    label: String(body.label).trim(),
    callsign: String(body.callsign).trim().toUpperCase(),
    lat,
    lon,
    grid: body.grid ? String(body.grid).trim().toUpperCase() : null,
    startDate: body.startDate ? String(body.startDate) : null,
    endDate: body.endDate ? String(body.endDate) : null,
  };
}

tripRoutes.post('/', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const cfg = parseBody(body);
  if (!cfg) return c.json({ error: 'label, callsign, lat, and lon are required' }, 400);
  return c.json(createTrip(cfg));
});

tripRoutes.patch('/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => null);
  const cfg = parseBody(body);
  if (!cfg) return c.json({ error: 'label, callsign, lat, and lon are required' }, 400);
  const updated = updateTrip(id, cfg);
  if (!updated) return c.json({ error: 'Trip not found' }, 404);
  return c.json(updated);
});

tripRoutes.delete('/:id', requireAuth, (c) => {
  deleteTrip(Number(c.req.param('id')));
  return c.json({ ok: true });
});
