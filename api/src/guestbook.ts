// Public guestbook -- the first place on this site an anonymous visitor can
// write content that other visitors will later see, so it gets real spam
// defenses that nothing else public here needs: a honeypot field (a hidden
// input real browsers never fill in, but many simple bots do), per-IP rate
// limiting, and a moderation queue (new entries start unapproved; see
// db.ts's table comment). None of this is meant to stop a determined
// attacker, just the low-effort automated submissions a public form
// realistically attracts.
import { db } from './db';

const NAME_MAX = 60;
const CALLSIGN_MAX = 15;
const MESSAGE_MAX = 1000;

// In-memory, per-process, resets on restart -- same tradeoff as auth.ts's
// login lockout: the threat model here is a burst of automated submissions,
// not something that needs to survive a restart, so a DB table just for
// this would be more machinery than the problem calls for.
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 3;
const submissionsByIp = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (submissionsByIp.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  submissionsByIp.set(ip, recent);
  return recent.length >= RATE_LIMIT_MAX;
}

function recordSubmission(ip: string) {
  const recent = submissionsByIp.get(ip) ?? [];
  recent.push(Date.now());
  submissionsByIp.set(ip, recent);
}

export type GuestbookEntry = {
  id: number;
  name: string;
  callsign: string | null;
  message: string;
  submittedAt: string;
};

/** Approved entries only, newest first -- what the public page actually renders. */
export function getApprovedEntries(limit = 100): GuestbookEntry[] {
  return db
    .query(
      `SELECT id, name, callsign, message, submitted_at as submittedAt
       FROM guestbook_entries WHERE approved = 1 ORDER BY submitted_at DESC LIMIT ?`,
    )
    .all(limit) as GuestbookEntry[];
}

/** Admin-only moderation queue. */
export function getPendingEntries(): GuestbookEntry[] {
  return db
    .query(
      `SELECT id, name, callsign, message, submitted_at as submittedAt
       FROM guestbook_entries WHERE approved = 0 ORDER BY submitted_at ASC`,
    )
    .all() as GuestbookEntry[];
}

export type SubmitResult = { ok: true } | { ok: false; error: string };

/**
 * `honeypot` should be a form field named something plausible (e.g.
 * "website") that's hidden via CSS from real visitors but present in the
 * DOM -- a filled-in honeypot means whatever submitted this didn't render
 * CSS, i.e. almost certainly not a human using a browser. Rejected
 * silently (reports ok:true) rather than with an error, so a bot doesn't
 * learn its submission was specifically detected as spam.
 */
export function submitGuestbookEntry(
  input: { name: string; callsign: string; message: string; honeypot: string },
  ip: string,
): SubmitResult {
  if (input.honeypot.trim() !== '') return { ok: true };

  const name = input.name.trim();
  const message = input.message.trim();
  const callsign = input.callsign.trim().toUpperCase();
  if (!name) return { ok: false, error: 'Name is required' };
  if (!message) return { ok: false, error: 'Message is required' };
  if (name.length > NAME_MAX) return { ok: false, error: `Name must be ${NAME_MAX} characters or fewer` };
  if (callsign.length > CALLSIGN_MAX) return { ok: false, error: `Callsign must be ${CALLSIGN_MAX} characters or fewer` };
  if (message.length > MESSAGE_MAX) return { ok: false, error: `Message must be ${MESSAGE_MAX} characters or fewer` };

  if (isRateLimited(ip)) return { ok: false, error: 'Too many submissions -- please try again later' };
  recordSubmission(ip);

  db.query('INSERT INTO guestbook_entries (name, callsign, message) VALUES (?, ?, ?)').run(name, callsign || null, message);
  return { ok: true };
}

export function approveEntry(id: number) {
  db.query('UPDATE guestbook_entries SET approved = 1 WHERE id = ?').run(id);
}

export function deleteEntry(id: number) {
  db.query('DELETE FROM guestbook_entries WHERE id = ?').run(id);
}
