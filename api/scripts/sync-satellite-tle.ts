// Run periodically via the hamstation-satellite-sync systemd timer (see deploy/).
// Pulls the full CelesTrak amateur-radio TLE group (no API key needed) and
// keeps only the entries matching our curated satellites table — no point
// storing orbital elements for the ~90 other cataloged amateur satellites
// we don't track.
import { db } from '../src/db';

const URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle';

const res = await fetch(URL);
if (!res.ok) throw new Error(`CelesTrak fetch failed: ${res.status}`);
const text = await res.text();

const lines = text.split('\n').map((l) => l.trimEnd());
const wanted = new Set(
  (db.query('SELECT norad_id FROM satellites').all() as { norad_id: number }[]).map((r) => r.norad_id),
);

const upsert = db.query(
  `INSERT INTO satellite_tle (norad_id, name, line1, line2, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
   ON CONFLICT(norad_id) DO UPDATE SET name = excluded.name, line1 = excluded.line1, line2 = excluded.line2, updated_at = excluded.updated_at`,
);

let updated = 0;
for (let i = 0; i + 2 < lines.length; i += 3) {
  const name = lines[i].trim();
  const line1 = lines[i + 1];
  const line2 = lines[i + 2];
  if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) continue;
  const noradId = Number(line1.slice(2, 7));
  if (!wanted.has(noradId)) continue;
  upsert.run(noradId, name, line1, line2);
  updated++;
}

console.log(`Synced TLE data for ${updated} of ${wanted.size} tracked satellites.`);
