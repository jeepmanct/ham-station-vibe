import { db } from './db';
import { buildAdifRecord } from './adif';

/**
 * Club Log's real upload API, verified against their own support docs
 * (clublog.freshdesk.com) before building this -- there's no self-service
 * API key the way QRZ's Logbook API has; Club Log's `api` key must be
 * requested from their support desk against a specific account
 * email/password, which is why getClublogCredentials() requires all three
 * together rather than treating the API key as independently optional.
 *
 * Two endpoints, two very different jobs -- their own docs are explicit
 * that realtime.php must NOT be used for batch uploads (it's rate-limited
 * for one-QSO-at-a-time live logging), so this project mirrors that split
 * rather than reusing one for both: pushQsoToClubLog() for a single
 * manually-logged QSO (same "send to X" checkbox pattern already used for
 * QRZ), uploadFullLogToClubLog() for the one-time/on-demand full-log
 * backfill via putlogs.php's multipart file upload.
 */
const REALTIME_URL = 'https://clublog.org/realtime.php';
const PUTLOGS_URL = 'https://clublog.org/putlogs.php';

export type ClublogCreds = { email: string; password: string; apiKey: string };

export async function pushQsoToClubLog(creds: ClublogCreds, callsign: string, adifRecord: string): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(REALTIME_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      email: creds.email,
      password: creds.password,
      api: creds.apiKey,
      callsign,
      adif: adifRecord,
    }),
  });
  const message = (await res.text()).trim();
  // Their own docs describe both "QSO OK" and "QSO Duplicate" as 200s that
  // represent success (a duplicate just means Club Log already had it, not
  // that this push failed) -- anything else (400 rejected, 403 auth
  // failure, 500 server error) is a real failure.
  return { ok: res.ok, message: message || `HTTP ${res.status}` };
}

/**
 * Full-log backfill -- builds one ADIF file from every stored raw_adif
 * blob (same reconstruction export.adi already does, so this is a
 * complete round-trip export, not a lossy subset) and POSTs it as
 * multipart/form-data. Deliberately never sends putlogs.php's `clear=1`
 * flag -- their docs describe it as flushing the account's existing Club
 * Log data before the new file lands, the same class of one-way-door
 * destructive flag this project already refuses to send to QRZ's own
 * REPLACE option (see qrz.ts's pushQsoToQrz) -- merging is always the
 * only mode this function can produce, structurally, not just by default.
 */
export async function uploadFullLogToClubLog(creds: ClublogCreds, callsign: string): Promise<{ ok: boolean; message: string; qsoCount: number }> {
  const rows = db.query('SELECT raw_adif FROM qsos ORDER BY qso_date ASC, time_on ASC').all() as { raw_adif: string }[];
  const header = [`! ADIF export from ${callsign} for Club Log upload`, `<ADIF_VER:5>3.1.4`, `<EOH>`, ''].join('\n');
  const records = rows.map((row) => buildAdifRecord(JSON.parse(row.raw_adif)));
  const adifText = header + records.join('\n');

  const form = new FormData();
  form.set('email', creds.email);
  form.set('password', creds.password);
  form.set('api', creds.apiKey);
  form.set('callsign', callsign);
  form.set('file', new Blob([adifText], { type: 'text/plain' }), `${callsign.toLowerCase()}-qsos.adi`);

  const res = await fetch(PUTLOGS_URL, { method: 'POST', body: form });
  const message = (await res.text()).trim();
  return { ok: res.ok, message: message || `HTTP ${res.status}`, qsoCount: rows.length };
}
