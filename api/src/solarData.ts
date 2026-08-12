import { db } from './db';

const GFZ_SOURCE_URL = 'https://kp.gfz-potsdam.de/app/files/Kp_ap_Ap_SN_F107_since_1932.txt';

export type SolarRecord = {
  date: string; // YYYYMMDD
  sfi: number | null;
  sfiAdjusted: number | null;
  aIndex: number | null;
  kIndex: number | null;
  kIndexMax: number | null;
  sunspotNumber: number | null;
};

const num = (s: string): number | null => {
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Parses GFZ Potsdam's combined Kp/ap/Ap/SN/F10.7 file. Format documented at
 * https://kp.gfz-potsdam.de/app/files/Kp_ap_Ap_SN_F107_format.txt — space-separated
 * columns, missing values as -1/-1.0/-1.000.
 */
export function parseGfzSolarData(text: string): SolarRecord[] {
  const records: SolarRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.trim().split(/\s+/);
    if (f.length < 28) continue;

    const date = `${f[0]}${f[1]}${f[2]}`;
    const kpValues = f.slice(7, 15).map(Number);
    const hasAllKp = kpValues.every((v) => v >= 0);

    records.push({
      date,
      sfi: num(f[25]),
      sfiAdjusted: num(f[26]),
      aIndex: num(f[23]),
      kIndex: hasAllKp ? kpValues.reduce((a, b) => a + b, 0) / kpValues.length : null,
      kIndexMax: hasAllKp ? Math.max(...kpValues) : null,
      sunspotNumber: num(f[24]),
    });
  }
  return records;
}

// The full file is the entire 1932-present history (~5.5MB, 34k+ rows) --
// re-fetching and re-parsing all of it on every routine sync is wasteful
// when only the last day or two has actually changed. GFZ's server
// advertises `Accept-Ranges: bytes` (confirmed live), and the file is
// chronologically ordered with fixed-width rows, so a plain HTTP suffix
// range request for just the tail gets recent data without needing a
// separate watermark/sync-state table the way QRZ/eQSL/LoTW's syncs do --
// there's nothing to track, the server just hands back the newest rows
// directly. ~156 bytes/row measured live; 100,000 bytes covers roughly the
// last 640 days, comfortably more than enough margin for the daily sync
// timer while still being under 2% of the full file's size.
const INCREMENTAL_TAIL_BYTES = 100_000;

export async function fetchGfzSolarData(full = false): Promise<string> {
  // `Accept-Encoding: identity` matters here, confirmed live -- Bun's fetch()
  // auto-negotiates gzip by default, and this server ignores Range entirely
  // (silently falls back to a full 200 response) whenever compression is
  // also being negotiated on the same request. Range only actually takes
  // effect (206 Partial Content) once compression is explicitly turned off.
  const res = await fetch(
    GFZ_SOURCE_URL,
    full ? undefined : { headers: { Range: `bytes=-${INCREMENTAL_TAIL_BYTES}`, 'Accept-Encoding': 'identity' } },
  );
  if (!res.ok && res.status !== 206) {
    throw new Error(`GFZ solar data request failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  // A suffix range request can (and does) land mid-line for its first row --
  // parseGfzSolarData()'s own `f.length < 28` check already skips any
  // resulting malformed partial line, so no special handling needed here.
  return text;
}

const upsertStmt = db.query(`
  INSERT INTO solar_data (date, sfi, sfi_adjusted, a_index, k_index, k_index_max, sunspot_number, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(date) DO UPDATE SET
    sfi = excluded.sfi,
    sfi_adjusted = excluded.sfi_adjusted,
    a_index = excluded.a_index,
    k_index = excluded.k_index,
    k_index_max = excluded.k_index_max,
    sunspot_number = excluded.sunspot_number,
    updated_at = excluded.updated_at
`);

export function importSolarRecords(records: SolarRecord[]): number {
  const insertMany = db.transaction((recs: SolarRecord[]) => {
    for (const r of recs) {
      upsertStmt.run(r.date, r.sfi, r.sfiAdjusted, r.aIndex, r.kIndex, r.kIndexMax, r.sunspotNumber);
    }
  });
  insertMany(records);
  return records.length;
}

/**
 * When solar data last synced, for UI display. No dedicated sync-state table
 * for this one (see fetchGfzSolarData()'s comment on why -- range requests
 * need no watermark) -- `updated_at` is stamped on every upserted row by the
 * query above, so its max across the table is exactly "when did a sync last
 * actually touch this data."
 */
export function getLastSolarSyncAt(): string | null {
  const row = db.query('SELECT MAX(updated_at) as m FROM solar_data').get() as { m: string | null } | null;
  if (!row?.m) return null;
  // `datetime('now')` (used by the upsert above) returns "YYYY-MM-DD HH:MM:SS"
  // in UTC but with neither a 'T' separator nor a 'Z'/offset suffix --
  // ambiguous enough that `new Date(...)` on the frontend risks parsing it as
  // local time in some browsers. Normalize to real ISO 8601 before it leaves
  // the server, matching the plain `.toISOString()` the other three syncs'
  // `last_run_at` already use.
  return `${row.m.replace(' ', 'T')}Z`;
}
