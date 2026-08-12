import type { Context, Next } from 'hono';
import { db } from './db';

const SESSION_DAYS = 30;

export function createSession(): string {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.query('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').run(token, expiresAt);
  return token;
}

export function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  const row = db
    .query('SELECT expires_at FROM sessions WHERE token = ?')
    .get(token) as { expires_at: string } | null;
  if (!row) return false;
  return new Date(row.expires_at).getTime() > Date.now();
}

export function deleteSession(token: string) {
  db.query('DELETE FROM sessions WHERE token = ?').run(token);
}

export async function requireAuth(c: Context, next: Next) {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!isValidSession(token)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
}

// --- Login brute-force protection -----------------------------------------
// This is a single-admin site with one password to guess, reachable from the
// open internet via dynamic DNS -- there was previously no limit at all on
// login attempts. Deliberately a GLOBAL lockout (not per-IP): behind Caddy,
// trusting a client-supplied IP header for rate-limiting would just let an
// attacker spoof a fresh IP per request to bypass it, and since there's only
// one legitimate user, a global lockout doesn't create the "one bad actor
// locks out everyone else" problem a multi-tenant site would have -- it
// just means the real admin also waits out the same short backoff if they
// mistype their own password a few times in a row, which is an acceptable
// trade for closing an unlimited-guessing window.
//
// In-memory, per-process -- resets on a restart. That's fine here: the
// threat model is sustained automated guessing, not a single restart-timed
// attempt, and persisting this to the DB would add schema/cleanup complexity
// disproportionate to what a personal site needs.
const MAX_CONSECUTIVE_FAILURES = 5;
const BASE_LOCKOUT_MS = 5000;
const MAX_LOCKOUT_MS = 5 * 60 * 1000;

let consecutiveFailures = 0;
let lockedUntil = 0;

/** Returns remaining lockout milliseconds (0 if not locked). */
export function loginLockoutRemainingMs(): number {
  return Math.max(0, lockedUntil - Date.now());
}

export function recordLoginFailure() {
  consecutiveFailures++;
  if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
    const overBy = consecutiveFailures - MAX_CONSECUTIVE_FAILURES;
    const duration = Math.min(BASE_LOCKOUT_MS * 2 ** (overBy - 1), MAX_LOCKOUT_MS);
    lockedUntil = Date.now() + duration;
  }
}

export function recordLoginSuccess() {
  consecutiveFailures = 0;
  lockedUntil = 0;
}

// --- WebSocket audio auth ticket -------------------------------------------
// The radio-audio WebSocket can't use an Authorization header (the browser's
// native WebSocket API doesn't support custom headers on the upgrade
// request), so it authenticates via a `token` query param instead --
// previously the long-lived 30-day session token itself, which then sits in
// Caddy's access logs and browser history for as long as that session is
// valid. A short-lived, single-use ticket minted just before connecting
// closes that exposure: even if it leaks via a log line, it's already
// expired or consumed by the time anyone could reuse it.
const WS_TICKET_TTL_MS = 30_000;
const wsTickets = new Map<string, number>(); // ticket -> expiresAt

export function createWsTicket(): string {
  const ticket = crypto.randomUUID();
  wsTickets.set(ticket, Date.now() + WS_TICKET_TTL_MS);
  return ticket;
}

/** Single-use -- valid tickets are consumed (deleted) on first check, whether or not the caller goes on to use the result. */
export function consumeWsTicket(ticket: string | undefined): boolean {
  if (!ticket) return false;
  const expiresAt = wsTickets.get(ticket);
  wsTickets.delete(ticket);
  return !!expiresAt && expiresAt > Date.now();
}
