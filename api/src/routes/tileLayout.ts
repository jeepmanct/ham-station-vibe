import { Hono } from 'hono';
import { requireAuth } from '../auth';
import { getTileLayout, setTileLayout, clearTileLayout, type TileLayoutEntry } from '../tileLayout';

export const tileLayoutRoutes = new Hono();

// Fixed allowlist rather than accepting any string -- keeps the table from
// accumulating rows for typos/old page names, and matches the fixed set of
// pages that actually render a customizable tile grid.
const KNOWN_PAGES = new Set(['home', 'tools', 'electronics']);

// GET is public, same reasoning as station-location: every visitor's page
// render needs it to know the saved order, and none of this is sensitive.
tileLayoutRoutes.get('/:page', (c) => {
  const page = c.req.param('page');
  if (!KNOWN_PAGES.has(page)) return c.json({ error: 'unknown page' }, 404);
  c.header('Cache-Control', 'no-store');
  return c.json(getTileLayout(page));
});

tileLayoutRoutes.post('/:page', requireAuth, async (c) => {
  const page = c.req.param('page');
  if (!KNOWN_PAGES.has(page)) return c.json({ error: 'unknown page' }, 404);
  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body?.tiles)) return c.json({ error: 'tiles array is required' }, 400);
  const tiles: TileLayoutEntry[] = body.tiles
    .filter((t: unknown): t is { id?: unknown; hidden?: unknown } => typeof t === 'object' && t !== null)
    .map((t: { id?: unknown; hidden?: unknown }) => ({ tileId: String(t.id ?? ''), hidden: !!t.hidden }))
    .filter((t: TileLayoutEntry) => t.tileId);
  setTileLayout(page, tiles);
  return c.json(getTileLayout(page));
});

tileLayoutRoutes.delete('/:page', requireAuth, (c) => {
  const page = c.req.param('page');
  if (!KNOWN_PAGES.has(page)) return c.json({ error: 'unknown page' }, 404);
  clearTileLayout(page);
  return c.json([]);
});
