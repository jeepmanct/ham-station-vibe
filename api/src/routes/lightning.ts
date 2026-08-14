import { Hono } from 'hono';
import { requireAuth } from '../auth';
import { getLightningStatus, getRecentStrikes, setLightningMonitoring } from '../lightning';

export const lightningRoutes = new Hono();

lightningRoutes.get('/status', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(getLightningStatus());
});

lightningRoutes.get('/strikes', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(getRecentStrikes());
});

// Admin-only, unlike FlexRadio's equivalent public monitoring toggle (see
// routes/radio.ts's comment on that one) -- this one exists specifically
// for the operator's own safety alerting, not just a cosmetic status
// readout, so letting any visitor silently disable it carries real risk
// FlexRadio's toggle doesn't.
lightningRoutes.post('/monitoring', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) is required' }, 400);
  setLightningMonitoring(body.enabled);
  return c.json(getLightningStatus());
});
