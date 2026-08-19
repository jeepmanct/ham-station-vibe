import { Hono } from 'hono';
import { requireAuth } from '../auth';
import { db } from '../db';
import { getVapidPublicKey } from '../alertWebPush';

export const pushRoutes = new Hono();

// Public -- the browser needs this key before it can even attempt to
// subscribe, same reasoning as any other public read-only config value
// (it's not a secret; VAPID's private half never leaves the server).
pushRoutes.get('/vapid-public-key', (c) => c.json({ publicKey: getVapidPublicKey() }));

pushRoutes.post('/subscribe', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return c.json({ error: 'endpoint and keys.p256dh/keys.auth are required' }, 400);
  }
  db.query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
  ).run(String(endpoint), String(p256dh), String(auth), new Date().toISOString());
  return c.json({ ok: true });
});

pushRoutes.post('/unsubscribe', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.endpoint) return c.json({ error: 'endpoint is required' }, 400);
  db.query('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(body.endpoint));
  return c.json({ ok: true });
});
