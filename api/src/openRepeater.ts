import { getOpenRepeaterConfig } from './serviceCredentials';

export type OpenRepeaterEntry = {
  id: string;
  callsign: string;
  frequencyMhz: number;
  offsetMhz: number | null;
  mode: string;
  band: string;
  city: string | null;
  lat: number | null;
  lng: number | null;
  status: string;
};

// This admin-page lookup is deliberately kept out of any public route --
// see the comment in routes/openRepeater.ts for why. Uses the /search
// endpoint (lat/lng/radius) rather than /repeaters (which filters by
// country/band/mode but not location), since this site already has the
// station's coordinates available and geographic search is the more useful
// scope for "what can I hit from here" than a whole-state list.
export async function fetchNearbyRepeaters(): Promise<
  { ok: true; results: OpenRepeaterEntry[] } | { ok: false; error: string }
> {
  const cfg = getOpenRepeaterConfig();
  if (!cfg) return { ok: false, error: 'Open Repeater API key and location must be set first.' };

  const params = new URLSearchParams({
    lat: String(cfg.lat),
    lng: String(cfg.lng),
    radius: String(cfg.radiusKm),
    limit: '200',
  });

  let res: Response;
  try {
    res = await fetch(`https://www.openrepeater.org/api/v1/search?${params}`, {
      headers: { 'X-API-Key': cfg.apiKey },
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    return { ok: false, error: `Request failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const body = await res.json().catch(() => null);
  if (!body) return { ok: false, error: `Open Repeater returned a non-JSON response (HTTP ${res.status}).` };
  if (!res.ok || body.error) {
    return { ok: false, error: body.error || `HTTP ${res.status}` };
  }
  const rows = Array.isArray(body.results) ? body.results : Array.isArray(body) ? body : null;
  if (!rows) return { ok: false, error: 'Unexpected response shape from Open Repeater (no results array).' };

  const results: OpenRepeaterEntry[] = rows.map((r: Record<string, unknown>) => ({
    id: String(r.id ?? ''),
    callsign: String(r.callsign ?? ''),
    frequencyMhz: Number(r.frequency) || 0,
    offsetMhz: r.offset != null ? Number(r.offset) : null,
    mode: String(r.mode ?? ''),
    band: String(r.band ?? ''),
    city: r.city != null ? String(r.city) : null,
    lat: r.lat != null ? Number(r.lat) : null,
    lng: r.lng != null ? Number(r.lng) : null,
    status: String(r.status ?? ''),
  }));

  return { ok: true, results };
}
