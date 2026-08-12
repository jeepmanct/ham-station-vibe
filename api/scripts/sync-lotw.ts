// Run daily via the hamstation-lotw-sync systemd timer (see deploy/). Calls the
// same import pipeline as the authenticated POST /api/qsos/import/lotw
// route, just invoked directly instead of over HTTP, so a timer doesn't
// need a login session/token to trigger it. Always incremental — a full
// resync is a manual/recovery action, not something the daily timer needs.
import { syncFromLotw } from '../src/lotw';
import { getLotwCredentials } from '../src/serviceCredentials';

const creds = getLotwCredentials();
if (!creds) {
  console.error('LoTW credentials are not configured — set them under Admin');
  process.exit(1);
}

const result = await syncFromLotw(creds.callsign, creds.password);
console.log(`Imported ${result.imported} of ${result.total} LoTW record(s) (${result.incremental ? 'incremental' : 'full'}).`);
