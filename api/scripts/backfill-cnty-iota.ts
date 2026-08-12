// One-time backfill: populate the `cnty` and `iota` columns for rows
// imported before they existed, using each row's stored raw_adif JSON.
import { db } from '../src/db';
import { normalizeCnty, normalizeIota } from '../src/qsoImport';

const rows = db.query(`SELECT id, raw_adif FROM qsos WHERE cnty IS NULL OR iota IS NULL`).all() as { id: number; raw_adif: string }[];

const update = db.query(`UPDATE qsos SET cnty = ?, iota = ? WHERE id = ?`);

let updatedCnty = 0;
let updatedIota = 0;
const updateMany = db.transaction((items: typeof rows) => {
  for (const row of items) {
    const r = JSON.parse(row.raw_adif) as Record<string, string>;
    const cnty = normalizeCnty(r.CNTY);
    const iota = normalizeIota(r.IOTA);
    if (cnty) updatedCnty++;
    if (iota) updatedIota++;
    update.run(cnty, iota, row.id);
  }
});
updateMany(rows);

console.log(`Backfilled cnty on ${updatedCnty} rows, iota on ${updatedIota} rows (of ${rows.length} candidates).`);
