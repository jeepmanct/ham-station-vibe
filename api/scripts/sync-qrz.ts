// Run daily via the hamstation-qrz-sync systemd timer (see deploy/). Calls the
// same import pipeline as the authenticated POST /api/qsos/import/qrz
// route, just invoked directly instead of over HTTP, so a timer doesn't
// need a login session/token to trigger it. Always incremental — a full
// resync is a manual/recovery action, not something the daily timer needs.
import { syncFromQrz } from '../src/qrz';
import { getQrzApiKey } from '../src/serviceCredentials';

const apiKey = getQrzApiKey();
if (!apiKey) {
  console.error('QRZ API key is not configured — set it under Admin, or with scripts/set-qrz-key.ts');
  process.exit(1);
}

const result = await syncFromQrz(apiKey);
console.log(`Synced ${result.imported} of ${result.total} QRZ record(s) (${result.incremental ? 'incremental' : 'full'}).`);
