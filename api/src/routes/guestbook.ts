import { Hono } from 'hono';
import { requireAuth } from '../auth';
import { getApprovedEntries, getPendingEntries, submitGuestbookEntry, approveEntry, deleteEntry } from '../guestbook';

export const guestbookRoutes = new Hono();

// Caddy's reverse_proxy sets X-Forwarded-For automatically (no explicit
// config needed -- see /etc/caddy/Caddyfile) -- takes the first hop, which
// is the real client since this API is never reached except through Caddy.
// Falls back to a shared bucket for direct/unproxied requests (local
// testing), which just means rate limiting is shared across those, not a
// concern in production.
function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const forwarded = c.req.header('X-Forwarded-For');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

guestbookRoutes.get('/', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(getApprovedEntries());
});

guestbookRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Invalid request body' }, 400);
  const result = submitGuestbookEntry(
    {
      name: String(body.name ?? ''),
      callsign: String(body.callsign ?? ''),
      message: String(body.message ?? ''),
      honeypot: String(body.website ?? ''),
    },
    clientIp(c),
  );
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

guestbookRoutes.get('/pending', requireAuth, (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(getPendingEntries());
});

guestbookRoutes.post('/:id/approve', requireAuth, (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'Invalid id' }, 400);
  approveEntry(id);
  return c.json({ ok: true });
});

guestbookRoutes.delete('/:id', requireAuth, (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'Invalid id' }, 400);
  deleteEntry(id);
  return c.json({ ok: true });
});
