// One-time backfill: populate the `state` column for rows imported before it
// existed, using each row's stored raw_adif JSON.
import { db } from '../src/db';
import { usState } from '../src/qsoImport';

const rows = db.query(`SELECT id, raw_adif FROM qsos WHERE state IS NULL`).all() as { id: number; raw_adif: string }[];

const update = db.query(`UPDATE qsos SET state = ? WHERE id = ?`);

let updated = 0;
const updateMany = db.transaction((items: typeof rows) => {
  for (const row of items) {
    const r = JSON.parse(row.raw_adif) as Record<string, string>;
    const state = usState(r.COUNTRY, r.STATE);
    if (state) {
      update.run(state, row.id);
      updated++;
    }
  }
});
updateMany(rows);

console.log(`Backfilled ${updated} of ${rows.length} candidate rows.`);
