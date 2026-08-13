import { Hono } from 'hono';
import { fetchDstarLastHeard, moduleLabel } from '../dstar';
import { ttlCached } from '../ttlCache';

export const dstarRoutes = new Hono();

// A small, hobbyist-run dyndns server -- polled gently rather than on
// every page view, same reasoning as every other third-party feed cached
// via ttlCached (see conditions.ts).
const DSTAR_TTL_MS = 2 * 60 * 1000;
const getCachedLastHeard = ttlCached('dstar:lastheard', DSTAR_TTL_MS, fetchDstarLastHeard);

dstarRoutes.get('/lastheard', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    const entries = await getCachedLastHeard();
    return c.json({ entries: entries.map((e) => ({ ...e, moduleLabel: moduleLabel(e.module) })) });
  } catch {
    return c.json({ entries: [] });
  }
});
