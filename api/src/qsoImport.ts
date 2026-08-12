import { db } from './db';
import type { AdifRecord } from './adif';
import { resolveLatLon } from './maidenhead';
import { invalidateCache } from './ttlCache';

// ADIF's STATE field is reused by many DXCC entities for their own primary
// subdivisions (Canadian provinces, Russian oblasts, etc.) — only treat it as
// a US state when the country is actually one of these US-related entities.
const US_DXCC_ENTITIES = new Set(['United States', 'Alaska', 'Hawaii']);

/** Normalizes an ADIF STATE value for a US-related DXCC entity, e.g. "Ca." -> "CA". */
export function usState(country: string | undefined, state: string | undefined): string | null {
  if (!country || !state || !US_DXCC_ENTITIES.has(country)) return null;
  const normalized = state.trim().replace(/\.$/, '').toUpperCase();
  return normalized || null;
}

const VALID_CONTINENTS = new Set(['NA', 'SA', 'EU', 'AF', 'AS', 'OC', 'AN']);

/** Normalizes an ADIF CONT value, e.g. "Eu" -> "EU"; rejects garbage like "&#". */
export function normalizeContinent(cont: string | undefined): string | null {
  if (!cont) return null;
  const normalized = cont.trim().toUpperCase();
  return VALID_CONTINENTS.has(normalized) ? normalized : null;
}

/** Normalizes an ADIF CQZ value (CQ zone, 1-40); rejects out-of-range/garbage values. */
export function normalizeCqz(cqz: string | undefined): string | null {
  if (!cqz) return null;
  const n = Number(cqz.trim());
  return Number.isInteger(n) && n >= 1 && n <= 40 ? String(n) : null;
}

/**
 * Normalizes an ADIF CNTY value (US county-hunting format "ST,County Name").
 * Stored as-is once validated — this is self-contained (already carries its
 * own state prefix), so it's read directly rather than combined with the
 * separate STATE column, which has been seen to disagree with it in the wild
 * (e.g. a rover QSO logged CNTY="CT,Fairfield" alongside STATE="FL").
 */
export function normalizeCnty(cnty: string | undefined): string | null {
  if (!cnty) return null;
  const trimmed = cnty.trim();
  const m = trimmed.match(/^([A-Za-z]{2}),\s*(.+)$/);
  if (!m) return null;
  return `${m[1].toUpperCase()},${m[2].trim()}`;
}

/** Normalizes an ADIF IOTA reference (e.g. "na-027" -> "NA-027"); rejects malformed values. */
export function normalizeIota(iota: string | undefined): string | null {
  if (!iota) return null;
  const normalized = iota.trim().toUpperCase();
  return /^[A-Z]{2}-\d{3}$/.test(normalized) ? normalized : null;
}

const insertStmt = db.query(`
  INSERT INTO qsos (call, qso_date, time_on, band, mode, freq, rst_sent, rst_rcvd, gridsquare, country, lotw_qsl_rcvd, lotw_qsl_rcvd_date, raw_adif, lat, lon, my_lat, my_lon, my_gridsquare, state, continent, cqz, cnty, iota)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(call, qso_date, time_on, band, mode) DO UPDATE SET
    lotw_qsl_rcvd = excluded.lotw_qsl_rcvd,
    lotw_qsl_rcvd_date = excluded.lotw_qsl_rcvd_date,
    lat = excluded.lat,
    lon = excluded.lon,
    my_lat = excluded.my_lat,
    my_lon = excluded.my_lon,
    my_gridsquare = excluded.my_gridsquare,
    state = excluded.state,
    continent = excluded.continent,
    cqz = excluded.cqz,
    cnty = excluded.cnty,
    iota = excluded.iota
`);

/** Upserts ADIF-parsed QSO records (from an LoTW file or the QRZ Logbook API) into the qsos table. */
export function importAdifRecords(records: AdifRecord[]): number {
  let imported = 0;
  const insertMany = db.transaction((recs: AdifRecord[]) => {
    for (const r of recs) {
      if (!r.CALL || !r.QSO_DATE) continue;
      const contact = resolveLatLon(r.LAT, r.LON, r.GRIDSQUARE);
      const home = resolveLatLon(r.MY_LAT, r.MY_LON, r.MY_GRIDSQUARE);
      insertStmt.run(
        r.CALL,
        r.QSO_DATE,
        r.TIME_ON ?? null,
        r.BAND?.toUpperCase() ?? null,
        r.MODE?.toUpperCase() ?? null,
        r.FREQ ?? null,
        r.RST_SENT ?? null,
        r.RST_RCVD ?? null,
        r.GRIDSQUARE ?? null,
        r.COUNTRY ?? null,
        r.LOTW_QSL_RCVD ?? null,
        r.LOTW_QSLRDATE ?? null,
        JSON.stringify(r),
        contact?.lat ?? null,
        contact?.lon ?? null,
        home?.lat ?? null,
        home?.lon ?? null,
        r.MY_GRIDSQUARE ?? null,
        usState(r.COUNTRY, r.STATE),
        normalizeContinent(r.CONT),
        normalizeCqz(r.CQZ),
        normalizeCnty(r.CNTY),
        normalizeIota(r.IOTA),
      );
      imported++;
    }
  });
  insertMany(records);
  // Every route that caches a qsos-derived response (awards.ts, /qsos/geo,
  // /qsos/unconfirmed, /stats/distance) shares this one invalidation point
  // rather than each sync path (QRZ/eQSL/LoTW/manual ADIF/manual entry)
  // needing its own call -- they all funnel through here.
  if (imported > 0) {
    invalidateCache('awards:');
    invalidateCache('qsos:');
    invalidateCache('stats:distance');
  }
  return imported;
}
