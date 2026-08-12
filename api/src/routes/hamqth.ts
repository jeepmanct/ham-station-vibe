import { Hono } from 'hono';
import { lookupCallsign } from '../hamqth';

export const hamqthRoutes = new Hono();

// Deliberately public (no requireAuth) -- this is a read-only callsign
// lookup tool for any site visitor, same reasoning as /api/geocode: the
// admin's HamQTH login is used server-side only and never reaches the
// browser, so there's no secret exposed by leaving this ungated.
hamqthRoutes.get('/lookup', async (c) => {
  const callsign = c.req.query('callsign')?.trim();
  if (!callsign) return c.json({ error: 'callsign is required' }, 400);
  const result = await lookupCallsign(callsign);
  if (!result.ok) return c.json({ error: result.error }, 400);
  c.header('Cache-Control', 'no-store');
  return c.json(result.result);
});
