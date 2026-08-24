import { Hono } from 'hono';
import { ttlCached } from '../ttlCache';
import { getStationCallsign } from '../stationLocation';

export const sotaRoutes = new Hono();

// SOTA's own official database (sota.org.uk) doesn't expose a documented
// public read API the way pota.app does for POTA -- sotl.as is a
// well-known third-party SOTA community site whose own stats pages are a
// popular reference tool, and its backing API turned out to be open and
// unauthenticated. Confirmed live (captured via a real browser's network
// traffic loading https://sotl.as/activators/<call>, not guessed): no
// special headers needed, plain fetch() works, a 404 just means that
// callsign has no activator record on file rather than an error.
const SOTA_TTL_MS = 60_000;

// Only the recent-activations list, not "unique summits"/"total QSOs"/
// "associations" -- sotl.as's own page computes those by aggregating
// EVERY activation a prolific activator has ever logged (over a thousand
// for some), which isn't practical to fetch/cache just for a summary card.
// Every field returned here comes directly from the activator-stats
// endpoint itself.
async function fetchActivatorStats(callsign: string) {
  const res = await fetch(`https://sotl.as/api/activators/${encodeURIComponent(callsign)}`, { signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`SOTA HTTP ${res.status}`);
  return res.json();
}

async function fetchRecentActivations(callsign: string) {
  const res = await fetch(`https://sotl.as/api/activations/${encodeURIComponent(callsign)}`, { signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`SOTA HTTP ${res.status}`);
  const all = (await res.json()) as unknown[];
  return all.slice(0, 20);
}

sotaRoutes.get('/profile', async (c) => {
  c.header('Cache-Control', 'no-store');
  const callsign = getStationCallsign();
  if (!callsign) return c.json(null);
  try {
    const stats = await ttlCached('sota:stats', SOTA_TTL_MS, () => fetchActivatorStats(callsign))();
    if (!stats) return c.json({ stats: null, activations: [] });
    const activations = await ttlCached('sota:activations', SOTA_TTL_MS, () => fetchRecentActivations(callsign))();
    return c.json({ stats, activations });
  } catch {
    return c.json(null);
  }
});
