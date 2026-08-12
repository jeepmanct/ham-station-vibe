import { Hono } from 'hono';
import { db } from '../db';
import { requireAuth } from '../auth';

export const satelliteRoutes = new Hono();

satelliteRoutes.get('/', (c) => {
  const rows = db
    .query(
      `SELECT s.norad_id as noradId, s.name, s.mode, s.uplink, s.downlink, s.notes, s.enabled,
              t.line1, t.line2, t.updated_at as tleUpdatedAt
       FROM satellites s
       LEFT JOIN satellite_tle t ON t.norad_id = s.norad_id
       ORDER BY s.mode DESC, s.name ASC`,
    )
    .all() as {
    noradId: number;
    name: string;
    mode: string;
    uplink: string | null;
    downlink: string | null;
    notes: string | null;
    enabled: number;
    line1: string | null;
    line2: string | null;
    tleUpdatedAt: string | null;
  }[];

  c.header('Cache-Control', 'no-store');
  return c.json(
    rows.map((r) => ({
      noradId: r.noradId,
      name: r.name,
      mode: r.mode,
      uplink: r.uplink,
      downlink: r.downlink,
      notes: r.notes,
      enabled: r.enabled === 1,
      tle: r.line1 && r.line2 ? { line1: r.line1, line2: r.line2, updatedAt: r.tleUpdatedAt } : null,
    })),
  );
});

satelliteRoutes.patch('/:noradId', requireAuth, async (c) => {
  const noradId = Number(c.req.param('noradId'));
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: 'enabled (boolean) is required' }, 400);
  }
  const result = db.query('UPDATE satellites SET enabled = ? WHERE norad_id = ?').run(body.enabled ? 1 : 0, noradId);
  if (result.changes === 0) return c.json({ error: 'Satellite not found' }, 404);
  return c.json({ ok: true });
});
