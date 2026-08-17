import { db } from './db';
import { parseAdif } from './adif';
import { importAdifRecords } from './qsoImport';

const QRZ_LOGBOOK_API = 'https://logbook.qrz.com/api';

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * Fetches QSOs from the QRZ.com Logbook API and returns the raw ADIF payload.
 * Pass `modifiedSince` (YYYY-MM-DD) to fetch only records QRZ has modified on
 * or after that date via the API's OPTION:MODSINCE filter — deliberately
 * "modified" rather than "added," since it also catches LoTW-confirmation
 * status flipping on an old QSO, not just brand-new contacts.
 */
export async function fetchQrzAdif(apiKey: string, modifiedSince?: string): Promise<string> {
  const body: Record<string, string> = { KEY: apiKey, ACTION: 'FETCH' };
  if (modifiedSince) body.OPTION = `MODSINCE:${modifiedSince}`;
  const res = await fetch(QRZ_LOGBOOK_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) {
    throw new Error(`QRZ API request failed: HTTP ${res.status}`);
  }
  const text = await res.text();

  // QRZ's response isn't cleanly form-encoded: the ADIF field's value contains
  // literal `&` (as ADIF record separators) and HTML-escaped `<`/`>`. So we can
  // only trust query-string parsing for the fields *before* ADIF=, and must take
  // everything after it as one raw blob rather than re-splitting on `&`.
  const adifMarker = text.indexOf('ADIF=');
  const head = adifMarker >= 0 ? text.slice(0, adifMarker) : text;
  const headParams = new URLSearchParams(head);
  const result = headParams.get('RESULT');
  if (result !== 'OK') {
    const reason = headParams.get('REASON');
    // QRZ signals "zero records matched the filter" (e.g. a MODSINCE with
    // nothing new) as RESULT=FAIL&COUNT=0 with no REASON — not as a success
    // with empty data. Treat that specific shape as "nothing to import,"
    // not a real error; anything with an actual REASON still throws.
    if (headParams.get('COUNT') === '0' && !reason) return '';
    throw new Error(decodeEntities(reason ?? `QRZ API returned an error: ${text.slice(0, 200)}`));
  }
  if (adifMarker < 0) return '';
  return decodeEntities(text.slice(adifMarker + 'ADIF='.length));
}

/**
 * Pushes a single QSO to the QRZ.com logbook via the API's INSERT action.
 * Deliberately never sends OPTION=REPLACE — QRZ's own docs warn that option
 * "WILL overwrite confirmed QSOs with the supplied unconfirmed QSO," and
 * this is used for manually-logged contacts that have no LoTW confirmation
 * of their own to lose, so there's no scenario where overwriting is what we
 * want. Without REPLACE, QRZ itself refuses a duplicate (RESULT=FAIL with a
 * REASON describing it as one) rather than touching the existing record —
 * that refusal is surfaced as-is, not treated as an application error.
 */
export async function pushQsoToQrz(
  apiKey: string,
  adifRecord: string,
): Promise<{ result: 'OK' | 'FAIL' | string; logId: string | null; reason: string | null }> {
  const res = await fetch(QRZ_LOGBOOK_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ KEY: apiKey, ACTION: 'INSERT', ADIF: adifRecord }),
  });
  if (!res.ok) {
    throw new Error(`QRZ API request failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  const params = new URLSearchParams(text);
  const result = params.get('RESULT');
  if (!result) {
    throw new Error(`Unexpected QRZ response: ${text.slice(0, 200)}`);
  }
  const reason = params.get('REASON');
  return { result, logId: params.get('LOGID'), reason: reason ? decodeEntities(reason) : null };
}

function getLastSyncedDate(): string | null {
  const row = db.query('SELECT last_synced_date FROM qrz_sync_state WHERE id = 1').get() as { last_synced_date: string | null } | null;
  return row?.last_synced_date ?? null;
}

function setLastSyncedDate(date: string) {
  db.query(
    `INSERT INTO qrz_sync_state (id, last_synced_date) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_synced_date = excluded.last_synced_date`,
  ).run(date);
}

/** When a sync last actually ran (and how many records it imported), for UI display -- see db.ts's comment on `last_run_at` for why this is separate from the MODSINCE watermark above. */
export function getLastQrzSyncRun(): { at: string | null; count: number | null } {
  const row = db.query('SELECT last_run_at, last_run_count FROM qrz_sync_state WHERE id = 1').get() as { last_run_at: string | null; last_run_count: number | null } | null;
  return { at: row?.last_run_at ?? null, count: row?.last_run_count ?? null };
}

function setLastRun(timestamp: string, count: number) {
  db.query(
    `INSERT INTO qrz_sync_state (id, last_run_at, last_run_count) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_run_at = excluded.last_run_at, last_run_count = excluded.last_run_count`,
  ).run(timestamp, count);
}

/**
 * Syncs the QRZ logbook into the local DB. Incremental by default (MODSINCE
 * the last successful sync's date) so a routine sync doesn't re-pull the
 * entire multi-thousand-QSO logbook every time — pass `full: true` to bypass
 * that and force a complete resync (e.g. if the local DB ever needs rebuilding
 * from scratch). Falls back to a full fetch automatically if there's no prior
 * sync recorded yet.
 */
export async function syncFromQrz(apiKey: string, full = false): Promise<{ imported: number; total: number; incremental: boolean }> {
  const lastSynced = full ? null : getLastSyncedDate();
  const adif = await fetchQrzAdif(apiKey, lastSynced ?? undefined);
  const records = parseAdif(adif);
  const imported = importAdifRecords(records);
  setLastSyncedDate(new Date().toISOString().slice(0, 10));
  setLastRun(new Date().toISOString(), imported);
  return { imported, total: records.length, incremental: !!lastSynced };
}
