// One-time backfill: populate the `continent` column for rows imported before
// it existed, using each row's stored raw_adif JSON.
import { db } from '../src/db';
import { normalizeContinent } from '../src/qsoImport';

const rows = db.query(`SELECT id, raw_adif FROM qsos WHERE continent IS NULL`).all() as { id: number; raw_adif: string }[];

const update = db.query(`UPDATE qsos SET continent = ? WHERE id = ?`);

let updated = 0;
const updateMany = db.transaction((items: typeof rows) => {
  for (const row of items) {
    const r = JSON.parse(row.raw_adif) as Record<string, string>;
    const continent = normalizeContinent(r.CONT);
    if (continent) {
      update.run(continent, row.id);
      updated++;
    }
  }
});
updateMany(rows);

console.log(`Backfilled ${updated} of ${rows.length} candidate rows.`);
