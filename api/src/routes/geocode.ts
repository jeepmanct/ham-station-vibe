import { Hono } from 'hono';

export const geocodeRoutes = new Hono();

// Proxied server-side rather than called from the browser: Nominatim's usage
// policy requires a descriptive User-Agent identifying the application,
// which browsers won't let client-side fetch() set.
geocodeRoutes.get('/', async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ error: 'q is required' }, 400);
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      // Nominatim's usage policy asks for an identifying User-Agent, ideally
      // with real contact info -- this generic value is honest (doesn't
      // claim a domain that isn't actually this installation's), but if
      // you're running this at real scale, consider swapping in your own
      // site URL/contact per https://operations.osmfoundation.org/policies/nominatim/
      headers: { 'User-Agent': 'self-hosted-ham-radio-site/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return c.json({ error: 'Geocoding service unavailable' }, 502);
    const results = (await res.json()) as { lat: string; lon: string; display_name: string }[];
    c.header('Cache-Control', 'no-store');
    if (!results.length) return c.json(null);
    const r = results[0];
    return c.json({ lat: Number(r.lat), lon: Number(r.lon), displayName: r.display_name });
  } catch {
    return c.json({ error: 'Geocoding failed' }, 502);
  }
});
