import { Hono } from 'hono';
import { requireAuth } from '../auth';
import { getDistanceUnit, setDistanceUnit } from '../siteSettings';

export const siteSettingsRoutes = new Hono();

siteSettingsRoutes.get('/', (c) => c.json({ distanceUnit: getDistanceUnit() }));

siteSettingsRoutes.post('/', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body?.distanceUnit !== 'km' && body?.distanceUnit !== 'mi') {
    return c.json({ error: 'distanceUnit must be "km" or "mi"' }, 400);
  }
  setDistanceUnit(body.distanceUnit);
  return c.json({ distanceUnit: getDistanceUnit() });
});
