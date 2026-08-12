// One-time backfill: populate the `cqz` column for rows imported before it
// existed, using each row's stored raw_adif JSON.
import { db } from '../src/db';
import { normalizeCqz } from '../src/qsoImport';

const rows = db.query(`SELECT id, raw_adif FROM qsos WHERE cqz IS NULL`).all() as { id: number; raw_adif: string }[];

const update = db.query(`UPDATE qsos SET cqz = ? WHERE id = ?`);

let updated = 0;
const updateMany = db.transaction((items: typeof rows) => {
  for (const row of items) {
    const r = JSON.parse(row.raw_adif) as Record<string, string>;
    const cqz = normalizeCqz(r.CQZ);
    if (cqz) {
      update.run(cqz, row.id);
      updated++;
    }
  }
});
updateMany(rows);

console.log(`Backfilled ${updated} of ${rows.length} candidate rows.`);
