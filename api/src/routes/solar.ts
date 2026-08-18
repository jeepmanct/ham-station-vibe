import { Hono } from 'hono';
import { db } from '../db';
import { requireAuth } from '../auth';
import { fetchGfzSolarData, parseGfzSolarData, importSolarRecords } from '../solarData';
import { ttlCached } from '../ttlCache';

export const solarRoutes = new Hono();

// Yearly averages — the raw daily series is 34k+ points, far too dense for a
// readable chart, and a year-over-year view is what actually shows solar
// cycles anyway.
solarRoutes.get('/history', (c) => {
  const rows = db
    .query(
      `SELECT substr(date, 1, 4) as year, AVG(sfi) as avgSfi, AVG(k_index) as avgK, AVG(a_index) as avgA
       FROM solar_data WHERE sfi IS NOT NULL GROUP BY year ORDER BY year ASC`,
    )
    .all() as { year: string; avgSfi: number; avgK: number; avgA: number }[];
  c.header('Cache-Control', 'no-store');
  return c.json(rows);
});

// Daily-resolution recent trend, distinct from /history's yearly averages
// above -- that one answers "where are we in the solar cycle," this one
// answers "how has propagation been the last few months," which is what
// Conditions' own trend chart needs. date is stored YYYYMMDD (sortable as
// text, matching qsos.qso_date's convention) so this orders/limits by row
// count rather than a SQLite date() arithmetic comparison, then reverses in
// JS to get ascending order for the chart.
solarRoutes.get('/recent', (c) => {
  const days = Math.min(Math.max(Number(c.req.query('days')) || 90, 7), 365);
  const rows = (
    db
      .query(
        `SELECT date, sfi, a_index as aIndex, k_index as kIndex, sunspot_number as sunspotNumber
         FROM solar_data WHERE sfi IS NOT NULL ORDER BY date DESC LIMIT ?`,
      )
      .all(days) as { date: string; sfi: number | null; aIndex: number | null; kIndex: number | null; sunspotNumber: number | null }[]
  ).reverse();
  c.header('Cache-Control', 'no-store');
  return c.json(rows);
});

// One specific day's numbers, by exact YYYYMMDD match -- used for "this day
// last year" comparisons rather than trends. Exact match only (no nearest-
// date fallback): daily coverage back to 1932 is essentially complete, and
// silently substituting a nearby day for the one actually asked about would
// be a wrong-but-plausible-looking answer, worse than just saying there's
// no data for that exact date.
solarRoutes.get('/on-date', (c) => {
  const date = c.req.query('date') ?? '';
  if (!/^\d{8}$/.test(date)) return c.json({ error: 'date must be YYYYMMDD' }, 400);
  const row = db
    .query(`SELECT date, sfi, a_index as aIndex, k_index as kIndex, sunspot_number as sunspotNumber FROM solar_data WHERE date = ?`)
    .get(date) as { date: string; sfi: number | null; aIndex: number | null; kIndex: number | null; sunspotNumber: number | null } | null;
  c.header('Cache-Control', 'no-store');
  return c.json(row);
});

const OUTLOOK_MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

// NOAA's 27-day outlook is plain fixed-format text, not JSON -- confirmed
// live (2026-08-10) at services.swpc.noaa.gov/text/27-day-outlook.txt.
// Example data line: "2026 Aug 10      90          12          4".
function parse27DayOutlook(text: string): { date: string; sfi: number; aIndex: number; kIndex: number }[] {
  const rows: { date: string; sfi: number; aIndex: number; kIndex: number }[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(\d{4})\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d+)\s+(\d+)\s+(\d+)\s*$/);
    if (!m) continue;
    const [, year, monAbbr, day, sfi, aIndex, kIndex] = m;
    const month = OUTLOOK_MONTHS[monAbbr];
    if (!month) continue;
    rows.push({ date: `${year}${month}${day.padStart(2, '0')}`, sfi: Number(sfi), aIndex: Number(aIndex), kIndex: Number(kIndex) });
  }
  return rows;
}

async function fetchForecast() {
  const res = await fetch('https://services.swpc.noaa.gov/text/27-day-outlook.txt', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`NOAA HTTP ${res.status}`);
  const text = await res.text();
  return parse27DayOutlook(text);
}

// Distinct from /recent above (historical) -- this is NOAA's predicted
// SFI/A/Kp for the next 27 days, "what's coming" rather than "what's
// happened." NOAA only republishes this bulletin roughly once a day, so an
// hour-long cache is nowhere near stale enough to matter, same
// don't-cache-failures reasoning as conditions.ts's proxy routes.
solarRoutes.get('/forecast', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    return c.json(await ttlCached('solar:forecast', 60 * 60 * 1000, fetchForecast)());
  } catch {
    return c.json([]);
  }
});

// Incremental by default (fetches only the last ~640 days via an HTTP range
// request, see fetchGfzSolarData()'s comment) -- pass ?full=1 to force a
// complete re-fetch/re-parse of the entire 1932-present file, e.g. if the
// local DB ever needs rebuilding from scratch.
solarRoutes.post('/sync', requireAuth, async (c) => {
  try {
    const full = c.req.query('full') === '1';
    const text = await fetchGfzSolarData(full);
    const records = parseGfzSolarData(text);
    const imported = importSolarRecords(records);
    return c.json({ imported, from: records[0]?.date, to: records[records.length - 1]?.date, full });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Solar data sync failed' }, 502);
  }
});
