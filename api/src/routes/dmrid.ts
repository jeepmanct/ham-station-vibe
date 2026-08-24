import { Hono } from 'hono';

export const dmrIdRoutes = new Hono();

// radioid.net's own public user database API -- no API key required
// (confirmed live), just asks callers to "be gentle" since excessive
// requests get blocked. A plain on-demand lookup triggered by an explicit
// button click (not polled/live-as-you-type), same spirit as that ask.
// Accepts either a callsign or a numeric DMR ID in the same field --
// confirmed live that both ?callsign= and ?id= return the identical
// response shape.
async function lookupDmr(query: string) {
  const isNumeric = /^\d+$/.test(query);
  const param = isNumeric ? `id=${encodeURIComponent(query)}` : `callsign=${encodeURIComponent(query)}`;
  const res = await fetch(`https://radioid.net/api/dmr/user/?${param}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`radioid.net HTTP ${res.status}`);
  const body = (await res.json()) as {
    count: number;
    results: { callsign: string; id: number; fname: string; surname: string; city: string; state: string; country: string }[];
  };
  return body.results;
}

dmrIdRoutes.get('/lookup', async (c) => {
  c.header('Cache-Control', 'no-store');
  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ error: 'q is required' }, 400);
  try {
    const results = await lookupDmr(q);
    return c.json({ results });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Lookup failed' }, 502);
  }
});
