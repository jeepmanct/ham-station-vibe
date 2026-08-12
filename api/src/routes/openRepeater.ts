import { Hono } from 'hono';
import { requireAuth } from '../auth';
import { fetchNearbyRepeaters } from '../openRepeater';

export const openRepeaterRoutes = new Hono();

// Both routes are admin-only and deliberately not linked from anywhere on
// the public site. Open Repeater's data is CC0 and its terms don't have
// RepeaterBook's "no public directory/finder" restriction, but this stays
// scoped to the admin-only lookup that was already asked for -- making it
// public would be a separate, deliberate decision, not a side effect of
// switching data providers.

openRepeaterRoutes.post('/verify', requireAuth, async (c) => {
  const result = await fetchNearbyRepeaters();
  if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
  return c.json({ ok: true, count: result.results.length, sample: result.results.slice(0, 3) });
});

openRepeaterRoutes.get('/search', requireAuth, async (c) => {
  const result = await fetchNearbyRepeaters();
  if (!result.ok) return c.json({ error: result.error }, 400);

  const modes = c.req.query('modes')?.split(',').filter(Boolean) ?? [];
  const bands = c.req.query('bands')?.split(',').filter(Boolean) ?? [];

  let results = result.results;
  if (modes.length) {
    const wanted = new Set(modes.map((m) => m.toLowerCase()));
    results = results.filter((r) => wanted.has(r.mode.toLowerCase()));
  }
  if (bands.length) {
    results = results.filter((r) => bands.includes(r.band));
  }

  return c.json({ results });
});
