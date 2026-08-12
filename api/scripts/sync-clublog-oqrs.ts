// Run weekly via the hamstation-clublog-sync systemd timer (see deploy/). Club Log
// publishes a bulk export of every user's callsign with an `oqrs` boolean —
// no API key needed, just a public zip download. We only care about
// membership in the oqrs:true set, not any of the file's other fields.
//
// Some keys carry a "_YY" trip-year suffix for operators who've uploaded
// multiple distinct DXpedition logs under the same base callsign (e.g.
// "1A0C_14") — stripped so matching against our own log's plain calls works.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { db } from '../src/db';

const URL = 'https://cdn.clublog.org/clublog-users.json.zip';

const res = await fetch(URL);
if (!res.ok) throw new Error(`Club Log fetch failed: ${res.status}`);
const buf = await res.arrayBuffer();

const tmpDir = mkdtempSync(path.join(tmpdir(), 'clublog-'));
const zipPath = path.join(tmpDir, 'users.zip');
try {
  await Bun.write(zipPath, buf);

  const proc = Bun.spawn(['unzip', '-p', zipPath], { stdout: 'pipe', stderr: 'pipe' });
  const jsonText = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`unzip exited with code ${exitCode}`);

  const data = JSON.parse(jsonText) as Record<string, { oqrs?: boolean }>;
  const oqrsCalls = new Set<string>();
  for (const [key, val] of Object.entries(data)) {
    if (val.oqrs === true) {
      oqrsCalls.add(key.replace(/_\d+$/, '').toUpperCase());
    }
  }

  const replace = db.transaction((calls: string[]) => {
    db.exec('DELETE FROM clublog_oqrs');
    const insert = db.query('INSERT OR IGNORE INTO clublog_oqrs (call) VALUES (?)');
    for (const call of calls) insert.run(call);
  });
  replace([...oqrsCalls]);

  console.log(`Synced ${oqrsCalls.size} OQRS-enabled callsigns from Club Log.`);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
