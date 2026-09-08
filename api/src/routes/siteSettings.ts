import { Hono } from 'hono';
import { requireAuth } from '../auth';
import { getDistanceUnit, setDistanceUnit } from '../siteSettings';
import { getCartoApiKey } from '../serviceCredentials';

export const siteSettingsRoutes = new Hono();

// cartoApiKey is deliberately the real value, not a configured-only flag --
// unlike everything in serviceCredentials.ts it's not a secret, it has to
// be readable by every visitor's browser to fetch CARTO's basemap tiles
// (see db.ts's carto_api_key comment). Set via the same admin form as the
// other service credentials, just surfaced here publicly instead.
siteSettingsRoutes.get('/', (c) => c.json({ distanceUnit: getDistanceUnit(), cartoApiKey: getCartoApiKey() }));

siteSettingsRoutes.post('/', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body?.distanceUnit !== 'km' && body?.distanceUnit !== 'mi') {
    return c.json({ error: 'distanceUnit must be "km" or "mi"' }, 400);
  }
  setDistanceUnit(body.distanceUnit);
  return c.json({ distanceUnit: getDistanceUnit() });
});
