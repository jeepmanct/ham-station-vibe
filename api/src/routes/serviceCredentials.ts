import { Hono } from 'hono';
import { requireAuth } from '../auth';
import { getServiceCredentialsPublic, setServiceCredentials } from '../serviceCredentials';

export const serviceCredentialsRoutes = new Hono();

serviceCredentialsRoutes.get('/', requireAuth, (c) => c.json(getServiceCredentialsPublic()));

// Each field is optional and independent -- saving one doesn't touch the
// others, same convention as /api/alert-config.
serviceCredentialsRoutes.post('/', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Invalid request body' }, 400);
  setServiceCredentials({
    qrzApiKey: body.qrzApiKey ? String(body.qrzApiKey).trim() : undefined,
    eqslUsername: body.eqslUsername !== undefined ? String(body.eqslUsername).trim().toUpperCase() : undefined,
    eqslPassword: body.eqslPassword ? String(body.eqslPassword) : undefined,
    lotwUsername: body.lotwUsername !== undefined ? String(body.lotwUsername).trim().toUpperCase() : undefined,
    lotwPassword: body.lotwPassword ? String(body.lotwPassword) : undefined,
    flexRadioIp: body.flexRadioIp !== undefined ? String(body.flexRadioIp).trim() : undefined,
    openRepeaterApiKey: body.openRepeaterApiKey ? String(body.openRepeaterApiKey).trim() : undefined,
    openRepeaterLat: body.openRepeaterLat !== undefined ? Number(body.openRepeaterLat) : undefined,
    openRepeaterLng: body.openRepeaterLng !== undefined ? Number(body.openRepeaterLng) : undefined,
    openRepeaterRadiusKm: body.openRepeaterRadiusKm !== undefined ? Number(body.openRepeaterRadiusKm) : undefined,
    hamqthUsername: body.hamqthUsername !== undefined ? String(body.hamqthUsername).trim() : undefined,
    hamqthPassword: body.hamqthPassword ? String(body.hamqthPassword) : undefined,
    brandmeisterTalkgroups: body.brandmeisterTalkgroups !== undefined ? String(body.brandmeisterTalkgroups).trim() : undefined,
    kiwisdrHost: body.kiwisdrHost !== undefined ? String(body.kiwisdrHost).trim() : undefined,
  });
  return c.json(getServiceCredentialsPublic());
});
