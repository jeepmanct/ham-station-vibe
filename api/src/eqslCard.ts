import path from 'node:path';
import { db, EQSL_CARDS_DIR } from './db';

const GETEQSL_URL = 'https://www.eQSL.cc/qslcard/GeteQSL.cfm';

type Qso = { id: number; call: string; qso_date: string; time_on: string | null; band: string | null; mode: string | null };

/**
 * Fetches a single QSL card image for one QSO via eQSL's official (if
 * sparsely documented) GeteQSL.cfm program -- confirmed live against a real
 * confirmed QSO (2026-08-10) that it needs full per-QSO parameters (not
 * just a callsign) and returns an HTML fragment with `<img src="...">`
 * pointing to a temporary file that must be downloaded promptly (eQSL
 * purges it after a few hours). Not every eQSL-confirmed QSO has an
 * available graphic -- eQSL returns "Error: I cannot find that log entry"
 * for some, which is treated as a normal, cacheable "no card" result here,
 * not a failure.
 */
async function fetchCardImageUrl(callsign: string, password: string, qso: Qso): Promise<string | null> {
  const params = new URLSearchParams({
    Username: callsign,
    Password: password,
    CallsignFrom: qso.call,
    QSOYear: qso.qso_date.slice(0, 4),
    QSOMonth: qso.qso_date.slice(4, 6),
    QSODay: qso.qso_date.slice(6, 8),
    QSOHour: (qso.time_on ?? '0000').slice(0, 2),
    QSOMinute: (qso.time_on ?? '0000').slice(2, 4),
    QSOBand: qso.band ?? '',
    QSOMode: qso.mode ?? '',
  });
  const res = await fetch(`${GETEQSL_URL}?${params.toString()}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`eQSL card request failed: HTTP ${res.status}`);
  }
  const html = await res.text();

  const errorMatch = html.match(/Error:\s*(.*?)(?:<|\n|$)/i);
  if (errorMatch) return null;

  const imgMatch = html.match(/<img\s+src="([^"]+)"/i);
  if (!imgMatch) return null;

  return new URL(imgMatch[1], 'https://www.eQSL.cc/').toString();
}

function getRow(qsoId: number): { image_path: string | null; fetched_at: string } | null {
  return db.query('SELECT image_path, fetched_at FROM eqsl_cards WHERE qso_id = ?').get(qsoId) as
    | { image_path: string | null; fetched_at: string }
    | null;
}

function saveRow(qsoId: number, imagePath: string | null) {
  db.query(
    `INSERT INTO eqsl_cards (qso_id, image_path, fetched_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(qso_id) DO UPDATE SET image_path = excluded.image_path, fetched_at = excluded.fetched_at`,
  ).run(qsoId, imagePath);
}

/**
 * Returns the cached card (fetching + caching it first if this is the first
 * time it's been viewed). `imagePath` is a URL path under /media/eqsl-cards,
 * matching the existing photo-serving convention, or null if no card is
 * available for this QSO (a real, cacheable outcome, not an error).
 */
export async function getOrFetchEqslCard(qsoId: number, callsign: string, password: string): Promise<{ imagePath: string | null; cached: boolean }> {
  const existing = getRow(qsoId);
  if (existing) return { imagePath: existing.image_path, cached: true };

  const qso = db.query('SELECT id, call, qso_date, time_on, band, mode FROM qsos WHERE id = ?').get(qsoId) as Qso | null;
  if (!qso) throw new Error('QSO not found');

  const imageUrl = await fetchCardImageUrl(callsign, password, qso);
  if (!imageUrl) {
    saveRow(qsoId, null);
    return { imagePath: null, cached: false };
  }

  const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
  if (!imgRes.ok) throw new Error(`eQSL card image download failed: HTTP ${imgRes.status}`);
  const ext = path.extname(new URL(imageUrl).pathname) || '.jpg';
  const filename = `${qsoId}${ext}`;
  await Bun.write(path.join(EQSL_CARDS_DIR, filename), await imgRes.arrayBuffer());

  const imagePath = `/media/eqsl-cards/${filename}`;
  saveRow(qsoId, imagePath);
  return { imagePath, cached: false };
}
