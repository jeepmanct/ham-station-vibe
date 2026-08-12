// Run daily via the hamstation-eqsl-sync systemd timer (see deploy/). Calls the
// same import pipeline as the authenticated POST /api/qsos/import/eqsl
// route, just invoked directly instead of over HTTP, so a timer doesn't
// need a login session/token to trigger it. Always incremental — a full
// resync is a manual/recovery action, not something the daily timer needs.
import { syncFromEqsl } from '../src/eqsl';
import { getEqslCredentials } from '../src/serviceCredentials';

const creds = getEqslCredentials();
if (!creds) {
  console.error('eQSL credentials are not configured — set them under Admin, or with scripts/set-eqsl-credentials.ts');
  process.exit(1);
}

const result = await syncFromEqsl(creds.callsign, creds.password);
console.log(
  `Matched ${result.matched} of ${result.total} eQSL inbox record(s) to logged QSOs ` +
    `(${result.unconfirmed} not yet reciprocally confirmed, ${result.unmatched} confirmed but not found in the log, ${result.incremental ? 'incremental' : 'full'}).`,
);
