import { Hono } from 'hono';
import { createSession, deleteSession, requireAuth, loginLockoutRemainingMs, recordLoginFailure, recordLoginSuccess, createWsTicket } from '../auth';

export const authRoutes = new Hono();

authRoutes.post('/login', async (c) => {
  const remainingMs = loginLockoutRemainingMs();
  if (remainingMs > 0) {
    c.header('Retry-After', String(Math.ceil(remainingMs / 1000)));
    return c.json({ error: `Too many failed attempts — try again in ${Math.ceil(remainingMs / 1000)}s` }, 429);
  }

  const { password } = await c.req.json<{ password?: string }>();
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (!hash || !password) {
    recordLoginFailure();
    return c.json({ error: 'unauthorized' }, 401);
  }
  const ok = await Bun.password.verify(password, hash);
  if (!ok) {
    recordLoginFailure();
    return c.json({ error: 'unauthorized' }, 401);
  }
  recordLoginSuccess();
  const token = createSession();
  return c.json({ token });
});

authRoutes.post('/logout', requireAuth, async (c) => {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (token) deleteSession(token);
  return c.json({ ok: true });
});

// Mints a short-lived, single-use ticket for the radio-audio WebSocket to
// authenticate with instead of the long-lived session token -- see
// createWsTicket()'s comment in auth.ts for why.
authRoutes.post('/ws-ticket', requireAuth, (c) => c.json({ ticket: createWsTicket() }));
