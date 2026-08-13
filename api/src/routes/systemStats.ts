import { Hono } from 'hono';
import { requireAuth } from '../auth';
import { getSystemStats, rebootSystem } from '../systemStats';

export const systemStatsRoutes = new Hono();

// Public -- server load/memory/disk/temp isn't sensitive, same reasoning
// as every other live-status panel already public on this site (DMR/RBN/
// PSK Reporter last-heard, radio hardware status, etc.).
systemStatsRoutes.get('/stats', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(await getSystemStats());
});

// Admin-only -- unlike everything else on this page, this one actually
// changes the state of the physical machine.
systemStatsRoutes.post('/reboot', requireAuth, async (c) => {
  try {
    await rebootSystem();
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Reboot command failed' }, 500);
  }
});
