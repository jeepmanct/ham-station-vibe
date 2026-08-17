import { db } from './db';
import { parseAdif, type AdifRecord } from './adif';
import { importAdifRecords } from './qsoImport';

const LOTW_REPORT_URL = 'https://lotw.arrl.org/lotwuser/lotwreport.adi';

// Deliberately NOT "since forever" -- just old enough to predate any
// realistic ham radio QSO (earliest amateur digital logging predates this
// easily). Passed explicitly on a full sync rather than omitting the date
// filter -- confirmed live that omitting it does NOT mean "all time" the
// way it does for eQSL's RcvdSince. LoTW instead silently applies its own
// "system supplied default" of roughly the last week, which on a first-ever
// sync would return only a handful of records instead of the real several
// thousand. Caught immediately by comparing the sync result against the
// existing lotw_qsl_rcvd='Y' count already in the DB, which should never be
// dramatically outnumbered by the record count a "full" sync claims.
const EARLIEST_PLAUSIBLE_RX_SINCE = '1990-01-01';

/**
 * Fetches QSO/confirmation records from LoTW's ADIF report endpoint. Not a
 * documented public API in the REST sense, but a real, long-standing
 * URL-based mechanism -- the same one third-party logging software
 * (DXKeeper, Log4OM, etc.) has used for years to pull LoTW data
 * programmatically, and one ARRL does document on its own help pages
 * (lotw.arrl.org/lotw-help/developer-query-qsos-qsls). Confirmed live (with
 * a throwaway bad-password request) that a failure re-renders the login
 * page with a detectable "Username/password incorrect" message, same
 * discipline as the QRZ/eQSL/FlexRadio integrations elsewhere in this
 * project.
 *
 * `rxSince`, if passed, is a YYYY-MM-DD date.
 *
 * Requests `qso_qsl=no` -- despite the name, this means "don't filter to
 * QSL-confirmed only," i.e. return every QSO record on file regardless of
 * confirmation status, not just the ones LoTW has matched against the other
 * station's own upload. Confirmed live (2026-08-12) against this exact
 * account: `qso_qsl=yes` returned only confirmed records, `qso_qsl=no`
 * returned the full set including QSL_RCVD=N rows. The "since" parameter
 * name changes with the mode -- `qso_qslsince` only applies when
 * qso_qsl=yes (filters by confirmation date); the equivalent for qso_qsl=no
 * is `qso_qsorxsince` (filters by when LoTW received/processed the record).
 * Passing the wrong one for the mode doesn't error, it just silently falls
 * back to LoTW's own short default window -- caught live the same way as
 * the all-time-default issue above, by requesting a known-old date and
 * checking the response header's "(user supplied value)" vs. "(system
 * supplied default)" annotation.
 *
 * Does NOT trust the qso_qsl parameter as the sole confirmation signal --
 * importAdifRecords() below reads each record's own LOTW_QSL_RCVD field
 * per-row regardless, same as it already does for a manually-uploaded LoTW
 * file, so a record's actual confirmed/not-confirmed status is always
 * correct even though the request itself no longer filters on it.
 *
 * 120s timeout, not the more typical 8-20s used elsewhere in this project --
 * confirmed live that a full-history request (now including unconfirmed
 * QSOs, ~15,500 records on this account) genuinely took ~45 seconds
 * server-side (LoTW builds the report on demand, similar to eQSL's "Super
 * Fast Version" needing to generate a file first); a shorter timeout was
 * tried first and failed on exactly this case.
 */
export async function fetchLotwAdif(callsign: string, password: string, rxSince?: string): Promise<string> {
  const params = new URLSearchParams({
    login: callsign,
    password,
    qso_query: '1',
    qso_qsl: 'no',
    qso_qsorxsince: rxSince ?? EARLIEST_PLAUSIBLE_RX_SINCE,
  });

  const res = await fetch(`${LOTW_REPORT_URL}?${params.toString()}`, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) {
    throw new Error(`LoTW request failed: HTTP ${res.status}`);
  }
  const text = await res.text();

  if (/username\/password incorrect/i.test(text)) {
    throw new Error('LoTW username/password incorrect');
  }
  if (!/<eoh>/i.test(text)) {
    throw new Error('Unexpected LoTW response (no ADIF content found) -- the account or report request may need attention');
  }
  return text;
}

// This endpoint's ADIF uses the generic QSL_RCVD/QSLRDATE field names, NOT
// the LOTW_QSL_RCVD/LOTW_QSLRDATE names importAdifRecords() actually reads
// (which the manual "Import LoTW ADIF" web download and QRZ's own export
// both use) -- confirmed live against a real record that this endpoint's
// actual output differs from that assumption. Every record here is
// unambiguously LoTW's own confirmation data, so QSL_RCVD unambiguously
// means "confirmed via LoTW" -- remapped here rather than touching
// importAdifRecords() itself, which the other sources still rely on reading
// via the LOTW_-prefixed names correctly.
//
// Also truncates TIME_ON to 4 digits (HHMM) -- this endpoint sends 6-digit
// HHMMSS, but every other source feeding this DB (QRZ, manual ADIF upload)
// sends 4-digit HHMM, which is what qsos' upsert unique key actually
// matches on. Caught live, the expensive way: a first real full sync didn't
// error, just silently created ~10,900 duplicate rows instead of updating
// the matching existing ones, because "135259" != "1352" as far as the
// ON CONFLICT(call, qso_date, time_on, band, mode) key is concerned. Fixed
// here rather than in importAdifRecords() for the same reason as the field
// remap above -- don't touch shared logic other sources already rely on.
function normalizeLotwRecord(r: AdifRecord): AdifRecord {
  if (r.QSL_RCVD && !r.LOTW_QSL_RCVD) r.LOTW_QSL_RCVD = r.QSL_RCVD;
  if (r.QSLRDATE && !r.LOTW_QSLRDATE) r.LOTW_QSLRDATE = r.QSLRDATE;
  if (r.TIME_ON && r.TIME_ON.length > 4) r.TIME_ON = r.TIME_ON.slice(0, 4);
  return r;
}

function getLastSyncedDate(): string | null {
  const row = db.query('SELECT last_synced_date FROM lotw_sync_state WHERE id = 1').get() as { last_synced_date: string | null } | null;
  return row?.last_synced_date ?? null;
}

function setLastSyncedDate(date: string) {
  db.query(
    `INSERT INTO lotw_sync_state (id, last_synced_date) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_synced_date = excluded.last_synced_date`,
  ).run(date);
}

/** When a sync last actually ran (and how many records it imported), for UI display -- see db.ts's comment on `last_run_at` for why this is separate from the rxSince watermark above. */
export function getLastLotwSyncRun(): { at: string | null; count: number | null } {
  const row = db.query('SELECT last_run_at, last_run_count FROM lotw_sync_state WHERE id = 1').get() as { last_run_at: string | null; last_run_count: number | null } | null;
  return { at: row?.last_run_at ?? null, count: row?.last_run_count ?? null };
}

function setLastRun(timestamp: string, count: number) {
  db.query(
    `INSERT INTO lotw_sync_state (id, last_run_at, last_run_count) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_run_at = excluded.last_run_at, last_run_count = excluded.last_run_count`,
  ).run(timestamp, count);
}

/**
 * Syncs LoTW into the local DB via the exact same import pipeline the manual
 * "Import LoTW ADIF" file upload already uses -- unlike eQSL, LoTW's report
 * genuinely is this site's existing trusted QSO/confirmation source (that's
 * what the manual upload has always been), so there's no clobbering risk in
 * reusing the full upsert here. Brings in every QSO on file (confirmed or
 * not), not just confirmations -- see fetchLotwAdif()'s comment. Incremental
 * by default (records received since the last successful sync), pass
 * `full: true` to force a complete re-check; falls back to a full fetch
 * automatically if there's no prior sync recorded yet.
 */
export async function syncFromLotw(
  callsign: string,
  password: string,
  full = false,
): Promise<{ imported: number; total: number; incremental: boolean }> {
  const lastSynced = full ? null : getLastSyncedDate();
  const adif = await fetchLotwAdif(callsign, password, lastSynced ?? undefined);
  const records = parseAdif(adif).map(normalizeLotwRecord);
  const imported = importAdifRecords(records);
  setLastSyncedDate(new Date().toISOString().slice(0, 10));
  setLastRun(new Date().toISOString(), imported);
  return { imported, total: records.length, incremental: !!lastSynced };
}
