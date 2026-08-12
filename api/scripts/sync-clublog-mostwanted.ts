// Run weekly via the hamstation-clublog-mostwanted-sync systemd timer (see
// deploy/) -- Club Log's global DXCC most-wanted ranking barely moves
// week-to-week, no need for anything more frequent. Public endpoint, no API
// key needed: returns a flat JSON object of rank -> ADIF DXCC entity code
// (confirmed live 2026-08-11, e.g. {"1":"344","2":"123",...}).
import { db } from '../src/db';

const URL = 'https://clublog.org/mostwanted.php?api=1';

const res = await fetch(URL);
if (!res.ok) throw new Error(`Club Log most-wanted fetch failed: ${res.status}`);
const data = (await res.json()) as Record<string, string>;

const replace = db.transaction((rows: [number, number][]) => {
  db.exec('DELETE FROM clublog_most_wanted');
  const insert = db.query('INSERT INTO clublog_most_wanted (adif_code, rank) VALUES (?, ?)');
  for (const [adifCode, rank] of rows) insert.run(adifCode, rank);
});

const rows: [number, number][] = Object.entries(data).map(([rank, adifCode]) => [Number(adifCode), Number(rank)]);
replace(rows);

console.log(`Synced ${rows.length} Club Log most-wanted rankings.`);
