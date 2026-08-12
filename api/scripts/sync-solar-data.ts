// Run daily via the hamstation-solar-sync systemd timer (see deploy/). Calls the
// same import pipeline as the authenticated POST /api/solar/sync route, just
// invoked directly instead of over HTTP, so a cron-style timer doesn't need
// a login session/token to trigger it.
import { fetchGfzSolarData, parseGfzSolarData, importSolarRecords } from '../src/solarData';

const text = await fetchGfzSolarData();
const records = parseGfzSolarData(text);
const imported = importSolarRecords(records);
console.log(`Synced ${imported} record(s), ${records[0]?.date} to ${records[records.length - 1]?.date}`);
