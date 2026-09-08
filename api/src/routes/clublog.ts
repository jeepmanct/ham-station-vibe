import { Hono } from 'hono';
import { requireAuth } from '../auth';
import { getClublogCredentials } from '../serviceCredentials';
import { getStationCallsign } from '../stationLocation';
import { uploadFullLogToClubLog } from '../clublog';

export const clublogRoutes = new Hono();

// One-time/on-demand full-log backfill -- see clublog.ts's uploadFullLogToClubLog()
// for why this never sends putlogs.php's clear=1 flag (always merges, never
// flushes the account's existing Club Log data).
clublogRoutes.post('/upload', requireAuth, async (c) => {
  const creds = getClublogCredentials();
  if (!creds) {
    return c.json({ error: 'Club Log credentials are not fully configured — set them under Admin (email, password, and API key are all required).' }, 500);
  }
  const callsign = getStationCallsign();
  if (!callsign) {
    return c.json({ error: 'Station callsign is not set — configure Station Location under Admin first.' }, 500);
  }
  try {
    const result = await uploadFullLogToClubLog(creds, callsign);
    if (!result.ok) return c.json({ error: result.message }, 502);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Club Log upload failed' }, 502);
  }
});
