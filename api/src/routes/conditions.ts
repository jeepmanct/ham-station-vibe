import { Hono } from 'hono';
import { db } from '../db';
import { resolveCallsignEntity } from '../dxccPrefixes';
import { workedEntitiesByCallsign, normalizeNg3kEntity } from '../dxNeeded';
import { getStationLocation, getStationCallsign } from '../stationLocation';
import { ttlCached } from '../ttlCache';

// These proxy routes previously hit their upstream (dxheat.com, PSK
// Reporter, wspr.live, reversebeacon.net, WA7BNM, NG3K) fresh on every
// single request -- with the frontend polling several of these every 60s
// from /radio and /conditions, every open browser tab independently
// re-triggered the same upstream fetch every minute. Caching collapses
// concurrent requests within the TTL window into one upstream call
// regardless of visitor count. Deliberately short of each route's own
// polling interval so a given client's next poll always sees fresh-enough
// data, not stale-until-next-tick data.
//
// Failures are NOT cached -- each cached fetcher throws on a non-ok
// response or network error rather than swallowing to an empty array
// itself, so ttlCached() (which only stores on a resolved value) never
// caches a transient upstream hiccup; the route handler's own try/catch
// still returns [] to the client for that one request, same as before,
// but the very next request retries the real upstream instead of serving
// a cached empty result for the rest of the TTL window.
const LIVE_FEED_TTL_MS = 50_000;
const CALENDAR_FEED_TTL_MS = 15 * 60 * 1000;


export const conditionsRoutes = new Hono();

conditionsRoutes.get('/today', (c) => {
  const row = db
    .query('SELECT date, sfi, a_index, k_index, sunspot_number FROM solar_data ORDER BY date DESC LIMIT 1')
    .get() as { date: string; sfi: number | null; a_index: number | null; k_index: number | null; sunspot_number: number | null } | null;
  c.header('Cache-Control', 'no-store');
  if (!row) return c.json(null);
  return c.json({
    date: row.date,
    sfi: row.sfi,
    aIndex: row.a_index,
    kIndex: row.k_index,
    sunspotNumber: row.sunspot_number,
  });
});

// Home station coordinates, for sunrise/sunset/grayline calculations client-side.
// The admin-configured QTH (station_location table) wins when set; falls
// back to the older "most common my_lat/my_lon" inference (same trick used
// for the distance stats) for a Pi that hasn't set one yet.
conditionsRoutes.get('/home', (c) => {
  c.header('Cache-Control', 'no-store');
  const configured = getStationLocation();
  if (configured) return c.json({ lat: configured.lat, lon: configured.lon, grid: configured.grid });

  const row = db
    .query(
      `SELECT my_lat as lat, my_lon as lon, my_gridsquare as grid, COUNT(*) as count
       FROM qsos WHERE my_lat IS NOT NULL AND my_lon IS NOT NULL
       GROUP BY my_lat, my_lon ORDER BY count DESC LIMIT 1`,
    )
    .get() as { lat: number; lon: number; grid: string | null } | null;
  return c.json(row ? { lat: row.lat, lon: row.lon, grid: row.grid } : null);
});

// "Needed" is resolved from the spotted callsign itself via cty.dat's prefix
// rules (dxccPrefixes.ts) — genuinely entity-precise (distinguishes England
// from Scotland, Sicily from mainland Italy, Alaska from the rest of the US,
// etc.), a real upgrade over the previous ISO-country-flag approach, which
// could only ever be as precise as dxheat's own "Flag" field (many-to-one
// for any split entity). Still a personal convenience list, not a certified
// award-tracking tool — an unresolved callsign just gets no badge.
function neededStatus(dxCall: string | undefined, worked: Set<string>): 'needed' | 'worked' | null {
  if (!dxCall) return null;
  const resolved = resolveCallsignEntity(dxCall);
  if (!resolved) return null;
  return worked.has(resolved.entity) ? 'worked' : 'needed';
}

async function fetchSpots() {
  const res = await fetch('https://dxheat.com/source/spots/', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`dxheat HTTP ${res.status}`);
  const spots = (await res.json()) as Record<string, unknown>[];
  const worked = workedEntitiesByCallsign();
  return spots.slice(0, 40).map((s) => ({
    spotter: s.Spotter,
    call: s.DXCall,
    frequency: s.Frequency,
    band: s.Band,
    mode: s.Mode,
    comment: s.Comment,
    time: s.Time,
    continent: s.Continent_dx,
    grid: s.DXLocator,
    lotw: s.LOTW,
    needed: neededStatus(s.DXCall as string | undefined, worked),
  }));
}

// Live DX spots, proxied server-side to avoid a third-party fetch from the
// browser (and so it fails gracefully behind our own API if dxheat is down).
conditionsRoutes.get('/spots', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    return c.json(await ttlCached('conditions:spots', LIVE_FEED_TTL_MS, fetchSpots)());
  } catch {
    return c.json([]);
  }
});

// Live "who's hearing me" reception reports from PSK Reporter, covering
// FT8/FT4/JS8/etc. and any other mode with a decoder that uploads spots
// there. Real-time propagation signal, distinct from the historical
// SFI/K-index numbers above. Last hour only — long enough to have data
// whenever the station's actually been on the air recently, short enough to
// stay "current."
async function fetchPskReports(callsign: string) {
  const res = await fetch(`https://retrieve.pskreporter.info/query?senderCallsign=${callsign}&flowStartSeconds=-3600`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`PSK Reporter HTTP ${res.status}`);
  const xml = await res.text();
  return parsePskReports(xml)
    .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    .slice(0, 40);
}

conditionsRoutes.get('/pskreporter', async (c) => {
  c.header('Cache-Control', 'no-store');
  const callsign = getStationCallsign();
  if (!callsign) return c.json([]);
  try {
    return c.json(await ttlCached('conditions:pskreporter', LIVE_FEED_TTL_MS, () => fetchPskReports(callsign))());
  } catch {
    return c.json([]);
  }
});

// Live "who's hearing me" reception reports from the WSPR network, via
// wspr.live's public read-only ClickHouse HTTP query interface -- WSPRnet's
// own site (wsprnet.org) has no clean JSON API, just an HTML table, so this
// community-run mirror (same underlying spot data) is what's actually usable
// programmatically. Same last-hour window as PSK Reporter above, though this
// will simply be empty whenever the station isn't actively beaconing WSPR.
// rx_lat/rx_lon/rx_loc come pre-resolved from the query itself, unlike PSK
// Reporter's report which only gives a grid square to convert client-side.
async function fetchWsprReports(callsign: string) {
  const query = `SELECT time, rx_sign, rx_lat, rx_lon, rx_loc, snr, frequency, distance FROM wspr.rx WHERE tx_sign = '${callsign}' AND time > now() - INTERVAL 60 MINUTE ORDER BY time DESC LIMIT 100 FORMAT JSON`;
  const res = await fetch(`https://db1.wspr.live/?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`wspr.live HTTP ${res.status}`);
  const body = (await res.json()) as {
    data: { time: string; rx_sign: string; rx_lat: number; rx_lon: number; rx_loc: string; snr: number; frequency: number; distance: number }[];
  };
  return body.data.map((r) => ({
    receiver: r.rx_sign,
    receiverGrid: r.rx_loc || null,
    lat: r.rx_lat,
    lon: r.rx_lon,
    frequency: r.frequency,
    snr: r.snr,
    distanceKm: r.distance,
    time: Math.floor(new Date(`${r.time.replace(' ', 'T')}Z`).getTime() / 1000),
  }));
}

conditionsRoutes.get('/wspr', async (c) => {
  c.header('Cache-Control', 'no-store');
  const callsign = getStationCallsign();
  if (!callsign) return c.json([]);
  try {
    return c.json(await ttlCached('conditions:wspr', LIVE_FEED_TTL_MS, () => fetchWsprReports(callsign))());
  } catch {
    return c.json([]);
  }
});

// Confirmed live-decoded mode-code table from reversebeacon.net's own
// spots.php?meta=1 response (dated 2026-08-10) -- their site has no
// documented public API, this is the same undocumented JSON endpoint their
// own live dashboard polls every 10s (found by reading their minified JS
// bundle, not guessed).
const RBN_MODES: Record<number, string> = {
  1: 'CW', 2: 'Phone', 5: 'FM', 10: 'PSK31', 11: 'RTTY', 12: 'BPSK', 13: 'GMSK', 14: 'FSK', 15: 'SSTV',
  16: 'MFSK', 17: 'QPSK', 20: 'EME', 21: 'JT65', 22: 'Hell', 23: 'DominoEX', 24: 'MT63', 25: 'RTTYM',
  26: 'THOR', 27: 'Throb', 28: 'Olivia', 29: 'Contestia', 30: 'PSK63', 31: 'PSK125', 32: 'JT9', 33: 'Opera',
  34: 'FT8', 35: 'SIM31', 36: 'PSK32', 37: 'ROS', 38: 'MSK144', 39: 'FSK441', 40: 'PSK', 41: 'QPSK31',
  42: 'T10', 43: 'SIM63', 44: 'JS8', 45: 'FT4', 999: 'Other',
};
type RbnSpot = [string, string, string, number, number, string, number, number, number, number, number];
type RbnCallInfo = [string, string, string, string, string, string, string, string];

// Live "who's hearing me" CW/RTTY skimmer reports from the Reverse Beacon
// Network -- the CW/RTTY analog of the PSK Reporter/WSPR cards above.
// reversebeacon.net has no documented public API either, just this
// undocumented JSON endpoint behind their own live map. Two real things
// confirmed only by reading their actual JS, not guessable from the site:
// (1) every request must include a `h` version-hash param the server
// validates -- omitting it (or sending a stale one) returns
// `{error:888, ver_h: <current>}`, which conveniently self-reports the
// correct value, so it's bootstrapped fresh on every request rather than
// hardcoded (their frontend reloads itself on a hash mismatch, implying it
// does change on deploys). (2) `call_info` (with lat/lon) covers BOTH the
// skimmer ("de") and spotted ("dx") callsigns appearing in the results, not
// just the spotted one -- verified live, since only the skimmer's location
// is actually needed here for the map.
async function fetchRbnReports(callsign: string) {
  const bootstrapRes = await fetch('https://www.reversebeacon.net/spots.php', { signal: AbortSignal.timeout(8000) });
  const bootstrap = (await bootstrapRes.json().catch(() => ({}))) as { ver_h?: string };
  if (!bootstrap.ver_h) throw new Error('RBN bootstrap returned no ver_h');

  const params = new URLSearchParams({ h: bootstrap.ver_h, cdx: callsign, ma: '3600', s: '0', r: '100' });
  const res = await fetch(`https://www.reversebeacon.net/spots.php?${params.toString()}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`RBN HTTP ${res.status}`);
  const body = (await res.json()) as { spots?: Record<string, RbnSpot>; call_info?: Record<string, RbnCallInfo> };
  const spots = body.spots ?? {};
  const callInfo = body.call_info ?? {};

  return Object.values(spots)
    .map(([de, freqKhz, , db, wpm, , , , , modeCode, epoch]) => {
      const info = callInfo[de];
      return {
        skimmer: de,
        lat: info ? Number(info[6]) : null,
        lon: info ? Number(info[7]) : null,
        frequency: Number(freqKhz) * 1000,
        db,
        wpm: wpm || null,
        mode: RBN_MODES[modeCode] ?? null,
        time: epoch,
      };
    })
    .sort((a, b) => b.time - a.time)
    .slice(0, 40);
}

conditionsRoutes.get('/rbn', async (c) => {
  c.header('Cache-Control', 'no-store');
  const callsign = getStationCallsign();
  if (!callsign) return c.json([]);
  try {
    return c.json(await ttlCached('conditions:rbn', LIVE_FEED_TTL_MS, () => fetchRbnReports(callsign))());
  } catch {
    return c.json([]);
  }
});

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) attrs[m[1]] = m[2];
  return attrs;
}

function parsePskReports(xml: string) {
  const reports: {
    receiver: string;
    receiverGrid: string | null;
    receiverDxcc: string | null;
    frequency: number | null;
    mode: string | null;
    snr: number | null;
    time: number | null;
  }[] = [];
  const re = /<receptionReport\s+([^>]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const a = parseAttrs(m[1]);
    if (!a.senderCallsign) continue;
    reports.push({
      receiver: a.receiverCallsign,
      receiverGrid: a.receiverLocator ?? null,
      receiverDxcc: a.receiverDXCC ?? null,
      frequency: a.frequency ? Number(a.frequency) : null,
      mode: a.mode ?? null,
      snr: a.sNR ? Number(a.sNR) : null,
      time: a.flowStartSeconds ? Number(a.flowStartSeconds) : null,
    });
  }
  return reports;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function parseContestRss(xml: string): { title: string; link: string; description: string }[] {
  const items: { title: string; link: string; description: string }[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml))) {
    const block = match[1];
    const title = decodeXmlEntities(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
    const link = decodeXmlEntities(block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '');
    const description = decodeXmlEntities(block.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? '');
    if (title) items.push({ title, link, description });
  }
  return items;
}

// Upcoming ham radio contests, proxied from WA7BNM's public RSS feed (the
// standard reference contest calendar) for the same reasons as /spots.
async function fetchContests() {
  const res = await fetch('https://www.contestcalendar.com/calendar.rss', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`WA7BNM HTTP ${res.status}`);
  const xml = await res.text();
  return parseContestRss(xml).slice(0, 25);
}

conditionsRoutes.get('/contests', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    return c.json(await ttlCached('conditions:contests', CALENDAR_FEED_TTL_MS, fetchContests)());
  } catch {
    return c.json([]);
  }
});

// ng3k.com's title format: "Entity: DateRange -- Call -- QSL via: X". The
// description repeats those same fields one per line (each ending " --"),
// with a final free-text "By ..." operator/equipment line — whitespace is
// collapsed to a single line first so that trailing " --\n" line breaks
// become the same ' -- ' separator the title uses, then the last segment is
// taken as the info text.
function parseNg3kFeed(xml: string, worked: Set<string>) {
  const items: {
    entity: string;
    dateRange: string;
    call: string;
    qslVia: string;
    info: string;
    needed: boolean | null;
  }[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const title = decodeXmlEntities(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
    const description = decodeXmlEntities(block.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? '').replace(/\s+/g, ' ');
    const titleMatch = title.match(/^(.+?): (.+?) -- (.+?) -- QSL via: (.+)$/);
    if (!titleMatch) continue;
    const [, entityRaw, dateRange, call, qslVia] = titleMatch;
    const descParts = description.split(' -- ').filter(Boolean);
    const info = descParts[descParts.length - 1] ?? '';
    const entity = normalizeNg3kEntity(entityRaw);
    items.push({
      entity: entityRaw.trim(),
      dateRange: dateRange.trim(),
      call: call.trim(),
      qslVia: qslVia.trim(),
      info,
      needed: entity ? !worked.has(entity) : null,
    });
  }
  return items;
}

// Announced/active DXpeditions, proxied from NG3K's ADXO feed (the standard
// reference list for this) — cross-referenced against the log the same
// entity-precise way /spots is, so "needed" here means the same thing it
// means everywhere else on this site.
async function fetchDxpeditions() {
  const res = await fetch('https://www.ng3k.com/adxo.xml', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`NG3K HTTP ${res.status}`);
  const xml = await res.text();
  const worked = workedEntitiesByCallsign();
  return parseNg3kFeed(xml, worked).slice(0, 40);
}

conditionsRoutes.get('/dxpeditions', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    return c.json(await ttlCached('conditions:dxpeditions', CALENDAR_FEED_TTL_MS, fetchDxpeditions)());
  } catch {
    return c.json([]);
  }
});
