import { db } from './db';
import { parseAdif, type AdifRecord } from './adif';
import { invalidateCache } from './ttlCache';

const EQSL_DOWNLOAD_URL = 'https://www.eqsl.cc/qslcard/DownloadInBox.cfm';

/**
 * Fetches QSL records from eQSL.cc's inbox as raw ADIF text.
 *
 * eQSL's endpoint isn't a clean JSON/ADIF API. Confirmed live against a real
 * account (not assumed from eQSL's own sparse docs, same discipline as the
 * QRZ/FlexRadio integrations elsewhere in this project) that a failure is an
 * HTML shell with an `<H3>Error: ...</H3>` message, and for an inbox of any
 * real size ("Super Fast Version") a success is *also* HTML -- not inline
 * ADIF -- with a link to a separately-generated `.adi` file under
 * `/downloadedfiles/` that has to be fetched as a second request. Handles
 * both that case and a plain inline-ADIF response (in case a small inbox or
 * a future account behaves differently), by checking for `<eoh>` first.
 *
 * `modifiedSince`, if passed, must already be in eQSL's own RcvdSince format
 * (YYYYMMDDHHMM) -- confirmed by testing that a wrong format (e.g. slashes)
 * fails with an explicit format-error message rather than being silently
 * reinterpreted.
 */
export async function fetchEqslAdif(callsign: string, password: string, modifiedSince?: string): Promise<string> {
  const params = new URLSearchParams({
    UserName: callsign,
    Password: password,
    QTHNickname: '',
    ConfirmedQSL: 'yes',
  });
  if (modifiedSince) params.set('RcvdSince', modifiedSince);

  const res = await fetch(`${EQSL_DOWNLOAD_URL}?${params.toString()}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`eQSL request failed: HTTP ${res.status}`);
  }
  const html = await res.text();

  const errorMatch = html.match(/<H3>\s*Error:\s*(.*?)\s*<\/H3>/i);
  if (errorMatch) {
    throw new Error(errorMatch[1]);
  }
  // eQSL signals "nothing matched the RcvdSince filter" as an ordinary-looking
  // "You have no log entries" page, not an error and not an ADIF/download
  // response -- confirmed live via a real incremental request that happened
  // to have zero new records. Treat it as a legitimately empty inbox.
  if (/<h3>\s*you have no log entries\s*<\/h3>/i.test(html)) return '';
  if (/<eoh>/i.test(html)) return html;

  const fileMatch = html.match(/href="([^"]+\.adi)"/i);
  if (!fileMatch) {
    throw new Error('Unexpected eQSL response: no ADIF content or download link found');
  }
  const fileUrl = new URL(fileMatch[1], res.url).toString();
  const fileRes = await fetch(fileUrl, { signal: AbortSignal.timeout(15000) });
  if (!fileRes.ok) {
    throw new Error(`eQSL ADIF file fetch failed: HTTP ${fileRes.status}`);
  }
  return fileRes.text();
}

function getLastSyncedAt(): string | null {
  const row = db.query('SELECT last_synced_at FROM eqsl_sync_state WHERE id = 1').get() as { last_synced_at: string | null } | null;
  return row?.last_synced_at ?? null;
}

function setLastSyncedAt(timestamp: string) {
  db.query(
    `INSERT INTO eqsl_sync_state (id, last_synced_at) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_synced_at = excluded.last_synced_at`,
  ).run(timestamp);
}

/** When a sync last actually ran (and how many confirmations it matched), for UI display -- see db.ts's comment on `last_run_at` for why this is separate from the RcvdSince watermark above (that one's in eQSL's own YYYYMMDDHHMM format, not a clean displayable datetime). */
export function getLastEqslSyncRun(): { at: string | null; count: number | null } {
  const row = db.query('SELECT last_run_at, last_run_count FROM eqsl_sync_state WHERE id = 1').get() as { last_run_at: string | null; last_run_count: number | null } | null;
  return { at: row?.last_run_at ?? null, count: row?.last_run_count ?? null };
}

function setLastRun(timestamp: string, count: number) {
  db.query(
    `INSERT INTO eqsl_sync_state (id, last_run_at, last_run_count) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_run_at = excluded.last_run_at, last_run_count = excluded.last_run_count`,
  ).run(timestamp, count);
}

/** Current UTC time in eQSL's RcvdSince format (YYYYMMDDHHMM). */
function nowAsEqslTimestamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
}

// Matches on call+date+band+mode(+time_on when available) against QSOs
// already in the log (from LoTW/QRZ/manual entry) and marks them
// eQSL-confirmed -- deliberately an UPDATE only, never an INSERT. eQSL's
// inbox is a confirmation feed, not a source of QSO truth, and its records
// may be sparser/less accurate than what's already logged (e.g. the other
// station's own logged band/mode), so a record that doesn't match anything
// already in the log is just left unmatched rather than creating a new,
// possibly-inaccurate row.
const updateWithTime = db.query(
  `UPDATE qsos SET eqsl_qsl_rcvd = 'Y', eqsl_qsl_rcvd_date = ?
   WHERE call = ? AND qso_date = ? AND band = ? AND mode = ? AND time_on = ?`,
);
const updateWithoutTime = db.query(
  `UPDATE qsos SET eqsl_qsl_rcvd = 'Y', eqsl_qsl_rcvd_date = ?
   WHERE call = ? AND qso_date = ? AND band = ? AND mode = ?`,
);

/**
 * Applies eQSL confirmation records to already-logged QSOs.
 *
 * Confirmed live against a real account that `ConfirmedQSL=yes` on the
 * request does NOT actually restrict the returned inbox to genuinely
 * reciprocally-confirmed QSLs -- it still includes plain "a card was sent"
 * records with no `EQSL_QSL_RCVD`/`EQSL_QSLRDATE` fields at all. So this
 * checks `EQSL_QSL_RCVD === 'Y'` itself per record (the same field name
 * LoTW's own import uses for the equivalent LOTW_QSL_RCVD flag) rather than
 * trusting the request parameter -- treating every returned record as
 * confirmed would have silently mislabeled every "card sent, not yet
 * reciprocally matched" QSO as eQSL-confirmed.
 */
export function applyEqslConfirmations(records: AdifRecord[]): { matched: number; unmatched: number; unconfirmed: number } {
  let matched = 0;
  let unmatched = 0;
  let unconfirmed = 0;
  const apply = db.transaction((recs: AdifRecord[]) => {
    for (const r of recs) {
      if (r.EQSL_QSL_RCVD !== 'Y') {
        unconfirmed++;
        continue;
      }
      if (!r.CALL || !r.QSO_DATE || !r.BAND || !r.MODE) {
        unmatched++;
        continue;
      }
      const call = r.CALL.toUpperCase();
      const band = r.BAND.toUpperCase();
      const mode = r.MODE.toUpperCase();
      const rcvdDate = r.EQSL_QSLRDATE ?? r.QSLRDATE ?? r.QSO_DATE;

      let changes = 0;
      if (r.TIME_ON) {
        changes = updateWithTime.run(rcvdDate, call, r.QSO_DATE, band, mode, r.TIME_ON).changes;
      }
      if (!changes) {
        changes = updateWithoutTime.run(rcvdDate, call, r.QSO_DATE, band, mode).changes;
      }
      if (changes) matched++;
      else unmatched++;
    }
  });
  apply(records);
  // eQSL confirmations are an UPDATE-only path that bypasses
  // importAdifRecords() entirely (see this function's own doc comment), so
  // it needs its own cache invalidation for the same reason.
  if (matched > 0) invalidateCache('qsos:unconfirmed');
  return { matched, unmatched, unconfirmed };
}

/**
 * Syncs eQSL confirmations into the local DB. Incremental by default
 * (RcvdSince the last successful sync) so a routine sync doesn't re-fetch
 * the whole inbox every time -- pass `full: true` to force a complete
 * re-check. Falls back to a full fetch automatically if there's no prior
 * sync recorded yet, same convention as syncFromQrz().
 */
export async function syncFromEqsl(
  callsign: string,
  password: string,
  full = false,
): Promise<{ matched: number; unmatched: number; unconfirmed: number; total: number; incremental: boolean }> {
  const lastSynced = full ? null : getLastSyncedAt();
  const html = await fetchEqslAdif(callsign, password, lastSynced ?? undefined);
  const records = parseAdif(html);
  const { matched, unmatched, unconfirmed } = applyEqslConfirmations(records);
  setLastSyncedAt(nowAsEqslTimestamp());
  setLastRun(new Date().toISOString(), matched);
  return { matched, unmatched, unconfirmed, total: records.length, incremental: !!lastSynced };
}
