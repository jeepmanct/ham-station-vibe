// One-time backfill: populate lat/lon/my_lat/my_lon/my_gridsquare for rows
// imported before those columns existed, using each row's stored raw_adif JSON.
import { db } from '../src/db';
import { resolveLatLon } from '../src/maidenhead';

const rows = db
  .query(`SELECT id, raw_adif FROM qsos WHERE lat IS NULL OR my_lat IS NULL`)
  .all() as { id: number; raw_adif: string }[];

const update = db.query(
  `UPDATE qsos SET lat = ?, lon = ?, my_lat = ?, my_lon = ?, my_gridsquare = ? WHERE id = ?`,
);

let updated = 0;
const updateMany = db.transaction((items: typeof rows) => {
  for (const row of items) {
    const r = JSON.parse(row.raw_adif) as Record<string, string>;
    const contact = resolveLatLon(r.LAT, r.LON, r.GRIDSQUARE);
    const home = resolveLatLon(r.MY_LAT, r.MY_LON, r.MY_GRIDSQUARE);
    update.run(contact?.lat ?? null, contact?.lon ?? null, home?.lat ?? null, home?.lon ?? null, r.MY_GRIDSQUARE ?? null, row.id);
    updated++;
  }
});
updateMany(rows);

console.log(`Backfilled ${updated} of ${rows.length} candidate rows.`);
