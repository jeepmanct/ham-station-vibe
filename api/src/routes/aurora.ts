// Real-time auroral oval, from NOAA SWPC's own OVATION model output --
// the same production forecast used by aurora-chasing apps, not a
// hand-derived oval shape from just the Kp index. Paired with the
// current planetary Kp reading for a plain-number summary alongside the
// map. Distinct from solar.ts's solar_data table, which is daily-
// resolution SFI/A/K history, not live space weather.
import { Hono } from 'hono';
import { ttlCached } from '../ttlCache';

export const auroraRoutes = new Hono();

const OVATION_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
// NOAA regenerates the OVATION product every few minutes; during an
// active storm the oval can visibly move within that window, so this
// stays short rather than matching the daily solar data's much longer
// cache lifetime.
const TTL_MS = 5 * 60 * 1000;

type OvationPoint = [lon: number, lat: number, aurora: number];

async function fetchOval(): Promise<{ observedAt: string; points: OvationPoint[] }> {
  const res = await fetch(OVATION_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`OVATION aurora feed HTTP ${res.status}`);
  const data = (await res.json()) as { 'Observation Time': string; coordinates: OvationPoint[] };
  // Drop the ~70% of the 65,160-point global grid reading near-zero --
  // irrelevant to render and not worth shipping to every visitor. NOAA
  // publishes longitude as 0-360; Leaflet (and every other map library
  // this site uses) expects -180..180.
  const points = data.coordinates
    .filter(([, , aurora]) => aurora > 3)
    .map(([lon, lat, aurora]): OvationPoint => [lon > 180 ? lon - 360 : lon, lat, aurora]);
  return { observedAt: data['Observation Time'], points };
}
const fetchOvalCached = ttlCached('aurora:oval', TTL_MS, fetchOval);

async function fetchKp(): Promise<{ time: string; kp: number } | null> {
  const res = await fetch(KP_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Planetary K-index feed HTTP ${res.status}`);
  const rows = (await res.json()) as { time_tag: string; Kp: number }[];
  const latest = rows[rows.length - 1];
  return latest ? { time: latest.time_tag, kp: latest.Kp } : null;
}
const fetchKpCached = ttlCached('aurora:kp', TTL_MS, fetchKp);

auroraRoutes.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    const [oval, kp] = await Promise.all([fetchOvalCached(), fetchKpCached()]);
    return c.json({ observedAt: oval.observedAt, points: oval.points, kp: kp?.kp ?? null, kpTime: kp?.time ?? null });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Could not load aurora data' }, 502);
  }
});
