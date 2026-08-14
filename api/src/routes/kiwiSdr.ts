import { Hono } from 'hono';
import { requireAuth } from '../auth';
import { getKiwiSdrStatus, setFrequency, setKiwiSdrEnabled, sampleNoiseFloor } from '../kiwiSdr';

export const kiwiSdrRoutes = new Hono();

kiwiSdrRoutes.get('/status', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(getKiwiSdrStatus());
});

// Takes ~1.5s to respond -- see sampleNoiseFloor()'s comment for why this
// is a deliberate spot-check, not a fast/cacheable status read.
kiwiSdrRoutes.get('/noise-floor', async (c) => {
  const result = await sampleNoiseFloor();
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(result);
});

// Open to everyone, not admin-gated -- see kiwiSdr.ts's header comment for
// why a shared-receiver retune doesn't need the same access control as
// FlexRadio's remote control.
kiwiSdrRoutes.post('/tune', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.freqKhz !== 'number' || typeof body.mode !== 'string') {
    return c.json({ error: 'Invalid request body' }, 400);
  }
  const result = setFrequency(body.freqKhz, body.mode.toLowerCase());
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(getKiwiSdrStatus());
});

// Admin-only: whether the /kiwisdr page shows its content at all.
kiwiSdrRoutes.post('/enabled', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.enabled !== 'boolean') return c.json({ error: 'Invalid request body' }, 400);
  setKiwiSdrEnabled(body.enabled);
  return c.json(getKiwiSdrStatus());
});
