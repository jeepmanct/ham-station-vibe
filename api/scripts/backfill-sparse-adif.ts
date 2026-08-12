// One-time backfill: re-runs importAdifRecords() against the raw_adif
// already stored for any QSO still missing country/continent/cqz/lat --
// mainly LoTW-sourced records imported before qsoImport.ts started falling
// back to a callsign-resolved country/continent/CQ-zone/approximate
// lat-lon when the source ADIF didn't supply them (LoTW's own export is
// sparse; it never includes these fields at all). Since importAdifRecords
// upserts on (call, qso_date, time_on, band, mode), re-running it against
// already-imported rows just fills in what's missing -- it doesn't
// duplicate anything.
import { db } from '../src/db';
import { importAdifRecords } from '../src/qsoImport';
import type { AdifRecord } from '../src/adif';

const rows = db
  .query(`SELECT raw_adif FROM qsos WHERE country IS NULL OR continent IS NULL OR cqz IS NULL OR lat IS NULL`)
  .all() as { raw_adif: string }[];

const records = rows.map((r) => JSON.parse(r.raw_adif) as AdifRecord);
const imported = importAdifRecords(records);

console.log(`Reprocessed ${imported} of ${rows.length} candidate row(s).`);
