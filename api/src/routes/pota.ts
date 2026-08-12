import { Hono } from 'hono';
import { ttlCached } from '../ttlCache';
import { getStationCallsign } from '../stationLocation';

export const potaRoutes = new Hono();

// POTA activation history doesn't change within a minute of browsing --
// caching collapses repeat visits/tabs into one upstream call, same
// reasoning as conditions.ts's proxy routes. Failures aren't cached (see
// that file's comment) -- fetchProfile() throws rather than swallowing to
// null itself, so a transient failure doesn't stick around for the TTL.
const POTA_TTL_MS = 60_000;

async function fetchProfile(callsign: string) {
  const res = await fetch(`https://api.pota.app/profile/${callsign}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`POTA HTTP ${res.status}`);
  return res.json();
}

potaRoutes.get('/profile', async (c) => {
  c.header('Cache-Control', 'no-store');
  const callsign = getStationCallsign();
  if (!callsign) return c.json(null);
  try {
    return c.json(await ttlCached('pota:profile', POTA_TTL_MS, () => fetchProfile(callsign))());
  } catch {
    return c.json(null);
  }
});
