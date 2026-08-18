import { Hono } from 'hono';
import { db } from '../db';
import { getStationLocation } from '../stationLocation';
import { ttlCached } from '../ttlCache';

export const statsRoutes = new Hono();

statsRoutes.get('/summary', (c) => {
  const totals = db
    .query('SELECT COUNT(*) as total, COUNT(DISTINCT call) as distinctCalls FROM qsos')
    .get() as { total: number; distinctCalls: number };

  const busiestDay = db
    .query('SELECT qso_date, COUNT(*) as count FROM qsos GROUP BY qso_date ORDER BY count DESC LIMIT 1')
    .get() as { qso_date: string; count: number } | null;

  const years = db.query('SELECT DISTINCT substr(qso_date, 1, 4) as year FROM qsos ORDER BY year').all() as { year: string }[];

  c.header('Cache-Control', 'no-store');
  return c.json({
    total: totals.total,
    distinctCalls: totals.distinctCalls,
    busiestDay,
    yearsActive: years.length,
    firstYear: years[0]?.year ?? null,
    lastYear: years[years.length - 1]?.year ?? null,
  });
});

const toRad = (d: number) => (d * Math.PI) / 180;
function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const DISTANCE_BUCKETS_MI = [0, 300, 600, 1200, 2500, 4000, 5000, 6000, 8000, 10000, 12500];

function computeDistance() {
  // Admin-configured Station Location wins when set, same as
  // /api/conditions/home and /api/qsos/geo.
  const configured = getStationLocation();
  const home = configured
    ? { lat: configured.lat, lon: configured.lon }
    : (db
        .query(
          `SELECT my_lat as lat, my_lon as lon, COUNT(*) as count
       FROM qsos WHERE my_lat IS NOT NULL AND my_lon IS NOT NULL
       GROUP BY my_lat, my_lon ORDER BY count DESC LIMIT 1`,
        )
        .get() as { lat: number; lon: number } | null);

  if (!home) {
    return { longest: null, topTen: [], buckets: [] };
  }

  const rows = db.query(`SELECT call, qso_date, band, lat, lon FROM qsos WHERE lat IS NOT NULL AND lon IS NOT NULL`).all() as {
    call: string;
    qso_date: string;
    band: string | null;
    lat: number;
    lon: number;
  }[];

  let longest: { call: string; qsoDate: string; km: number } | null = null;
  const buckets = new Array(DISTANCE_BUCKETS_MI.length - 1).fill(0);
  const withDistance: { call: string; qsoDate: string; band: string | null; km: number }[] = [];

  for (const r of rows) {
    const km = distanceKm(home.lat, home.lon, r.lat, r.lon);
    const mi = km * 0.621371;
    if (!longest || km > longest.km) longest = { call: r.call, qsoDate: r.qso_date, km };
    withDistance.push({ call: r.call, qsoDate: r.qso_date, band: r.band, km });
    for (let i = 0; i < DISTANCE_BUCKETS_MI.length - 1; i++) {
      if (mi >= DISTANCE_BUCKETS_MI[i] && mi < DISTANCE_BUCKETS_MI[i + 1]) {
        buckets[i]++;
        break;
      }
    }
  }

  const topTen = withDistance
    .sort((a, b) => b.km - a.km)
    .slice(0, 10)
    .map((r) => ({ ...r, km: Math.round(r.km) }));

  return {
    longest: longest ? { ...longest, km: Math.round(longest.km) } : null,
    topTen,
    buckets: buckets.map((count, i) => ({
      min: DISTANCE_BUCKETS_MI[i],
      max: DISTANCE_BUCKETS_MI[i + 1],
      count,
    })),
  };
}

// Full-table haversine + sort on every request otherwise -- only changes
// when new QSOs sync, same caching reasoning as /awards.
statsRoutes.get('/distance', async (c) => {
  c.header('Cache-Control', 'no-store');
  const result = await ttlCached('stats:distance', 5 * 60 * 1000, async () => computeDistance())();
  return c.json(result);
});

function parseYyyymmdd(d: string): Date {
  return new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8))));
}
function toYyyymmdd(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Activity calendar heatmap + streak tracking. `daily` covers the last 371
// days (53 weeks, matching a GitHub-style contribution grid); streaks are
// computed from the full all-time distinct-date list since a personal best
// might be older than a year.
statsRoutes.get('/activity', (c) => {
  const rows = db
    .query(`SELECT qso_date, COUNT(*) as count FROM qsos GROUP BY qso_date ORDER BY qso_date ASC`)
    .all() as { qso_date: string; count: number }[];

  let longestStreak = { length: 0, startDate: '', endDate: '' };
  let runStart = '';
  let runLength = 0;
  let prevDate: Date | null = null;

  for (const row of rows) {
    const date = parseYyyymmdd(row.qso_date);
    if (prevDate && (date.getTime() - prevDate.getTime()) / 86400000 === 1) {
      runLength++;
    } else {
      runStart = row.qso_date;
      runLength = 1;
    }
    if (runLength > longestStreak.length) {
      longestStreak = { length: runLength, startDate: runStart, endDate: row.qso_date };
    }
    prevDate = date;
  }

  // The streak ending at the most recent logged day — "current" only if that
  // day is today or yesterday, otherwise it's just the most recent past streak.
  let currentStreak = { length: 0, startDate: '', endDate: '', active: false };
  if (rows.length) {
    const lastRow = rows[rows.length - 1];
    let end = parseYyyymmdd(lastRow.qso_date);
    let start = end;
    let length = 1;
    for (let i = rows.length - 2; i >= 0; i--) {
      const date = parseYyyymmdd(rows[i].qso_date);
      if ((start.getTime() - date.getTime()) / 86400000 === 1) {
        start = date;
        length++;
      } else {
        break;
      }
    }
    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const daysSinceEnd = (todayUtc.getTime() - end.getTime()) / 86400000;
    currentStreak = {
      length,
      startDate: toYyyymmdd(start),
      endDate: lastRow.qso_date,
      active: daysSinceEnd <= 1,
    };
  }

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 370);
  const cutoffStr = toYyyymmdd(cutoff);
  const daily = rows.filter((r) => r.qso_date >= cutoffStr).map((r) => ({ date: r.qso_date, count: r.count }));

  c.header('Cache-Control', 'no-store');
  return c.json({ daily, longestStreak, currentStreak });
});

statsRoutes.get('/by-year', (c) => {
  const rows = db
    .query(`SELECT substr(qso_date, 1, 4) as year, COUNT(*) as count FROM qsos GROUP BY year ORDER BY year ASC`)
    .all() as { year: string; count: number }[];
  c.header('Cache-Control', 'no-store');
  return c.json(rows);
});

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Combined hour-of-day x day-of-week grid, both in UTC (ADIF's native
// timezone — qso_date/time_on are never stored in local time). "Best time
// to operate" is inherently a UTC-band-propagation question anyway, so this
// is the more useful frame than converting to any one local timezone.
// A single 7x24 grid strictly subsumes the old separate byHour/
// byDayOfWeek breakdowns (each is just a row/column sum of this grid) while
// also showing combined patterns neither 1D view could — e.g. "mostly
// Saturday mornings" isn't visible from two independent marginal totals.
statsRoutes.get('/activity-pattern', (c) => {
  const rows = db
    .query(
      `SELECT CAST(strftime('%w', substr(qso_date,1,4) || '-' || substr(qso_date,5,2) || '-' || substr(qso_date,7,2)) AS INTEGER) as dow,
              CAST(substr(time_on, 1, 2) AS INTEGER) as hour,
              COUNT(*) as count
       FROM qsos WHERE time_on IS NOT NULL AND LENGTH(time_on) >= 2
       GROUP BY dow, hour`,
    )
    .all() as { dow: number; hour: number; count: number }[];

  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of rows) {
    if (r.dow >= 0 && r.dow < 7 && r.hour >= 0 && r.hour < 24) grid[r.dow][r.hour] = r.count;
  }

  c.header('Cache-Control', 'no-store');
  return c.json({ dayNames: DAY_NAMES, grid });
});

const BAND_HOUR_ROW_LIMIT = 8;

// Per-band hour-of-day breakdown, UTC (same reasoning as activity-pattern
// above). Deliberately a SEPARATE endpoint/grid rather than adding a band
// dimension to activity-pattern's 7x24 grid -- that would be a 7x24xN
// cube, awkward to render as a single flat heatmap, and "best hour for
// this band" doesn't actually need the day-of-week axis at all. Limited to
// the top BAND_HOUR_ROW_LIMIT bands by total QSO count (matches
// BAND_VARS.length on the frontend, which only has that many distinct
// categorical colors defined) -- a station's activity is normally
// concentrated on a handful of bands, so this doesn't meaningfully cut
// real signal, just long-tail noise.
statsRoutes.get('/band-hour-pattern', (c) => {
  const topBands = db
    .query(`SELECT band, COUNT(*) as count FROM qsos WHERE band IS NOT NULL GROUP BY band ORDER BY count DESC LIMIT ?`)
    .all(BAND_HOUR_ROW_LIMIT) as { band: string; count: number }[];
  const bands = topBands.map((b) => b.band);

  const rows = db
    .query(
      `SELECT band, CAST(substr(time_on, 1, 2) AS INTEGER) as hour, COUNT(*) as count
       FROM qsos WHERE band IS NOT NULL AND time_on IS NOT NULL AND LENGTH(time_on) >= 2
       GROUP BY band, hour`,
    )
    .all() as { band: string; hour: number; count: number }[];

  const grid: number[][] = bands.map(() => Array(24).fill(0));
  const bandIndex = new Map(bands.map((b, i) => [b, i]));
  for (const r of rows) {
    const idx = bandIndex.get(r.band);
    if (idx === undefined || r.hour < 0 || r.hour >= 24) continue;
    grid[idx][r.hour] = r.count;
  }

  c.header('Cache-Control', 'no-store');
  return c.json({ bands, grid });
});

// Confirmation coverage by method, plus a per-year trend of "% of that
// year's QSOs confirmed via LoTW or eQSL as of today" -- deliberately NOT a
// per-QSO follow-up list (that's /api/qsos/unconfirmed, already surfaced as
// the "Confirmed Nowhere" checklist on /tools; this endpoint is the
// aggregate picture, not a duplicate of that one).
statsRoutes.get('/qsl-confirmation', (c) => {
  const totals = db
    .query(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN lotw_qsl_rcvd = 'Y' THEN 1 ELSE 0 END) as confirmedLotw,
              SUM(CASE WHEN eqsl_qsl_rcvd = 'Y' THEN 1 ELSE 0 END) as confirmedEqsl,
              SUM(CASE WHEN lotw_qsl_rcvd = 'Y' OR eqsl_qsl_rcvd = 'Y' THEN 1 ELSE 0 END) as confirmedEither,
              SUM(CASE WHEN lotw_qsl_rcvd = 'Y' AND eqsl_qsl_rcvd = 'Y' THEN 1 ELSE 0 END) as confirmedBoth
       FROM qsos`,
    )
    .get() as { total: number; confirmedLotw: number; confirmedEqsl: number; confirmedEither: number; confirmedBoth: number };

  const byYear = db
    .query(
      `SELECT substr(qso_date, 1, 4) as year, COUNT(*) as total,
              SUM(CASE WHEN lotw_qsl_rcvd = 'Y' OR eqsl_qsl_rcvd = 'Y' THEN 1 ELSE 0 END) as confirmed
       FROM qsos
       GROUP BY year
       ORDER BY year ASC`,
    )
    .all() as { year: string; total: number; confirmed: number }[];

  c.header('Cache-Control', 'no-store');
  return c.json({ ...totals, byYear });
});

// Confirmation *velocity*: how fast new confirmations are actually arriving,
// based on the LoTW/eQSL received-date stamps (not qso_date -- a QSO logged
// years ago can be confirmed today). Used to project time-to-next-milestone.
statsRoutes.get('/qsl-velocity', (c) => {
  const confirmedTotal = db
    .query(`SELECT COUNT(*) as n FROM qsos WHERE lotw_qsl_rcvd = 'Y' OR eqsl_qsl_rcvd = 'Y'`)
    .get() as { n: number };

  const events = db
    .query(
      `SELECT
         CASE
           WHEN lotw_qsl_rcvd_date IS NOT NULL AND lotw_qsl_rcvd_date != ''
                AND (eqsl_qsl_rcvd_date IS NULL OR eqsl_qsl_rcvd_date = '' OR lotw_qsl_rcvd_date <= eqsl_qsl_rcvd_date)
             THEN lotw_qsl_rcvd_date
           ELSE eqsl_qsl_rcvd_date
         END as confirmedDate
       FROM qsos
       WHERE (lotw_qsl_rcvd = 'Y' OR eqsl_qsl_rcvd = 'Y')
         AND ((lotw_qsl_rcvd_date IS NOT NULL AND lotw_qsl_rcvd_date != '') OR (eqsl_qsl_rcvd_date IS NOT NULL AND eqsl_qsl_rcvd_date != ''))`,
    )
    .all() as { confirmedDate: string }[];

  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = `${cutoff.getFullYear()}${String(cutoff.getMonth() + 1).padStart(2, '0')}${String(cutoff.getDate()).padStart(2, '0')}`;
  const recent90 = events.filter((e) => e.confirmedDate >= cutoffStr).length;
  const ratePerDay = recent90 / 90;

  const milestoneStep = 500;
  const nextMilestone = Math.ceil((confirmedTotal.n + 1) / milestoneStep) * milestoneStep;
  const remaining = nextMilestone - confirmedTotal.n;
  const daysToMilestone = ratePerDay > 0 ? remaining / ratePerDay : null;
  const estimatedDate = daysToMilestone != null ? new Date(now.getTime() + daysToMilestone * 86400000).toISOString().slice(0, 10) : null;

  c.header('Cache-Control', 'no-store');
  return c.json({
    confirmedTotal: confirmedTotal.n,
    recentConfirmations90d: recent90,
    ratePerDay: Math.round(ratePerDay * 100) / 100,
    nextMilestone,
    daysToMilestone: daysToMilestone != null ? Math.round(daysToMilestone) : null,
    estimatedDate,
  });
});
