import { Hono } from 'hono';
import { getLastHeard } from '../brandmeister';
import { getBrandmeisterTalkgroups } from '../serviceCredentials';

export const brandmeisterRoutes = new Hono();

// Public, read-only, same reasoning as /api/radio/status -- this is live
// status for public display on /radio, not a secret. `configured` lets the
// frontend tell "no talkgroups set up" apart from "configured but quiet
// right now" -- an empty entries array alone can't distinguish those.
brandmeisterRoutes.get('/lastheard', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ configured: getBrandmeisterTalkgroups().length > 0, entries: getLastHeard() });
});
