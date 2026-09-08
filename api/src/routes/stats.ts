import { Hono } from 'hono';
import { db } from '../db';
import { getStationLocation } from '../stationLocation';
import { ttlCached } from '../ttlCache';
import { ADIF_DXCC_CODE_TO_ENTITY } from '../data/adifDxccCodes';

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

// Milestone QSO numbers -- a curated round-number list rather than every
// power of ten, so e.g. a log that's currently at 15,412 gets a "15,000th"
// entry instead of nothing between 10,000 and 20,000.
const MILESTONE_STEPS = [1, 100, 500, 1000, 2500, 5000, 7500, 10000, 12500, 15000, 17500, 20000, 25000, 30000, 40000, 50000];

const SOLO_CATCH_SAMPLE_SIZE = 8;
const RAREST_DXCC_SAMPLE_SIZE = 8;
const TOUGH_CONDITIONS_SAMPLE_SIZE = 5;

/**
 * "Notable QSOs" -- a curated highlight reel distinct from the raw log
 * (/log) and the achievement-progress cards (/awards): milestone contacts
 * (the Nth QSO ever), the rarest DXCC entities actually worked (by Club
 * Log's real global demand ranking, not just alphabetical), one-and-done
 * "solo catches" (a grid/IOTA group/county worked exactly once and never
 * again), and QSOs made during the worst logged geomagnetic conditions --
 * each a different kind of "worth remembering" that pure counts don't
 * surface on their own.
 */
function computeNotable() {
  const total = db.query('SELECT COUNT(*) as n FROM qsos').get() as { n: number };

  const orderedRows = db.query(`SELECT call, qso_date, band, mode, country FROM qsos ORDER BY qso_date ASC, time_on ASC, id ASC`).all() as {
    call: string;
    qso_date: string;
    band: string | null;
    mode: string | null;
    country: string | null;
  }[];
  const milestones = MILESTONE_STEPS.filter((n) => n <= orderedRows.length).map((n) => {
    const row = orderedRows[n - 1];
    return { n, call: row.call, qsoDate: row.qso_date, band: row.band, mode: row.mode, country: row.country };
  });

  // Rarest DXCC actually worked -- cross-references the log's worked
  // entities against Club Log's global demand ranking (same source/mapping
  // /awards' Most-Wanted card uses for NEEDED entities), just applied to
  // entities already in the log instead. Lower rank = more wanted/rarer
  // worldwide. Entities Club Log doesn't rank are simply excluded here
  // (unlike Most-Wanted's alphabetical fallback for unranked entities) --
  // there's no honest way to call something "notable for rarity" without a
  // real rank to back it up.
  const rankRows = db.query('SELECT adif_code, rank FROM clublog_most_wanted').all() as { adif_code: number; rank: number }[];
  const rankByEntity = new Map<string, number>();
  for (const row of rankRows) {
    const entity = ADIF_DXCC_CODE_TO_ENTITY[row.adif_code];
    if (entity) rankByEntity.set(entity, row.rank);
  }
  const dxccRows = db
    .query(`SELECT country, COUNT(*) as qsoCount, MIN(qso_date) as firstWorked FROM qsos WHERE country IS NOT NULL GROUP BY country`)
    .all() as { country: string; qsoCount: number; firstWorked: string }[];
  const rarestDxcc = dxccRows
    .map((r) => ({ country: r.country, qsoCount: r.qsoCount, firstWorked: r.firstWorked, rank: rankByEntity.get(r.country) ?? null }))
    .filter((r): r is typeof r & { rank: number } => r.rank != null)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, RAREST_DXCC_SAMPLE_SIZE);

  // Solo catches -- a grid/IOTA group/county worked exactly once and never
  // repeated. Since each group here has exactly one row (HAVING c = 1),
  // MAX(call)/MAX(qso_date) just reads back that one row's own values --
  // no real aggregation happening, just a convenient way to pull a single
  // group's row without a window function. Same 4-char grid bucketing
  // /awards' VUCC card uses (a full 6-char gridsquare is finer than the
  // standard VUCC/notable-catch unit).
  function soloCatches(rows: { key: string; call: string; qsoDate: string; c: number }[]) {
    const sorted = [...rows]
      .sort((a, b) => (a.qsoDate < b.qsoDate ? 1 : a.qsoDate > b.qsoDate ? -1 : 0))
      .map(({ key, call, qsoDate }) => ({ key, call, qsoDate }));
    return { count: sorted.length, samples: sorted.slice(0, SOLO_CATCH_SAMPLE_SIZE) };
  }
  const soloGridRows = db
    .query(
      `SELECT SUBSTR(gridsquare, 1, 4) as key, MAX(call) as call, MAX(qso_date) as qsoDate, COUNT(*) as c
       FROM qsos WHERE gridsquare IS NOT NULL AND LENGTH(gridsquare) >= 4 GROUP BY key HAVING c = 1`,
    )
    .all() as { key: string; call: string; qsoDate: string; c: number }[];
  const soloIotaRows = db
    .query(`SELECT iota as key, MAX(call) as call, MAX(qso_date) as qsoDate, COUNT(*) as c FROM qsos WHERE iota IS NOT NULL GROUP BY key HAVING c = 1`)
    .all() as { key: string; call: string; qsoDate: string; c: number }[];
  const soloCountyRows = db
    .query(`SELECT cnty as key, MAX(call) as call, MAX(qso_date) as qsoDate, COUNT(*) as c FROM qsos WHERE cnty IS NOT NULL GROUP BY key HAVING c = 1`)
    .all() as { key: string; call: string; qsoDate: string; c: number }[];
  const soloGrids = soloCatches(soloGridRows);
  const soloIota = soloCatches(soloIotaRows);
  const soloCounties = soloCatches(soloCountyRows);

  // Toughest conditions -- QSOs made on the days with the highest logged
  // planetary K-index (worse geomagnetic conditions generally mean worse
  // HF propagation), a fun "worked anyway" flex distinct from the
  // longest-distance leaderboard already on /stats (that one's about
  // geography, this one's about timing/conditions).
  const toughConditions = db
    .query(
      `SELECT q.call, q.qso_date as qsoDate, q.band, q.mode, s.k_index as kIndex, s.a_index as aIndex
       FROM qsos q JOIN solar_data s ON s.date = q.qso_date
       WHERE s.k_index IS NOT NULL
       ORDER BY s.k_index DESC, q.qso_date DESC
       LIMIT ?`,
    )
    .all(TOUGH_CONDITIONS_SAMPLE_SIZE) as { call: string; qsoDate: string; band: string | null; mode: string | null; kIndex: number; aIndex: number | null }[];

  return {
    totalQsos: total.n,
    milestones,
    rarestDxcc,
    soloCatches: { grids: soloGrids, iota: soloIota, counties: soloCounties },
    toughConditions,
  };
}

statsRoutes.get('/notable', async (c) => {
  c.header('Cache-Control', 'no-store');
  const result = await ttlCached('stats:notable', 5 * 60 * 1000, async () => computeNotable())();
  return c.json(result);
});
