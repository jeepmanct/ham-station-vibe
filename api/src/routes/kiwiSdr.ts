import { Hono } from 'hono';
import { requireAuth } from '../auth';
import {
  getKiwiSdrStatus,
  setFrequency,
  setBandwidth,
  setAgc,
  setWfZoom,
  setKiwiSdrEnabled,
  sampleNoiseFloor,
} from '../kiwiSdr';

export const kiwiSdrRoutes = new Hono();

kiwiSdrRoutes.get('/status', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(await getKiwiSdrStatus());
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
// FlexRadio's remote control. Same reasoning applies to bandwidth/AGC/zoom
// below -- all just adjust how this one receive-only channel is heard or
// displayed, nothing that could key a transmitter.
kiwiSdrRoutes.post('/tune', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.freqKhz !== 'number' || typeof body.mode !== 'string') {
    return c.json({ error: 'Invalid request body' }, 400);
  }
  const result = setFrequency(body.freqKhz, body.mode.toLowerCase());
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(await getKiwiSdrStatus());
});

kiwiSdrRoutes.post('/bandwidth', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || (body.bandwidth !== 'narrow' && body.bandwidth !== 'normal' && body.bandwidth !== 'wide')) {
    return c.json({ error: 'bandwidth must be "narrow", "normal", or "wide"' }, 400);
  }
  const result = setBandwidth(body.bandwidth);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(await getKiwiSdrStatus());
});

kiwiSdrRoutes.post('/agc', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.enabled !== 'boolean') return c.json({ error: 'Invalid request body' }, 400);
  const result = setAgc(body.enabled);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(await getKiwiSdrStatus());
});

kiwiSdrRoutes.post('/zoom', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.zoom !== 'number') return c.json({ error: 'Invalid request body' }, 400);
  const result = setWfZoom(body.zoom);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(await getKiwiSdrStatus());
});

// Admin-only: whether the /kiwisdr page shows its content at all.
kiwiSdrRoutes.post('/enabled', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.enabled !== 'boolean') return c.json({ error: 'Invalid request body' }, 400);
  setKiwiSdrEnabled(body.enabled);
  return c.json(await getKiwiSdrStatus());
});
