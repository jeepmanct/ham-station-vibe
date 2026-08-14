// Checks for DXCC entities that have newly become LoTW-confirmed since the
// last check, and emails/pushes an alert for each. Standalone script,
// paired with deploy/hamstation-dxcc-confirmed-check.service + .timer, run
// once daily at 07:15 -- after the QRZ (06:30), eQSL (06:45), and LoTW
// (07:00) sync timers would all have already completed, so this always
// sees that day's freshest confirmation data rather than racing it.
//
// "Newly confirmed" is tracked via alerted_dxcc_confirmations, seeded with
// every already-confirmed entity the moment the alert was first turned on
// (see dxccConfirmedAlert.ts's seedDxccConfirmationBaseline(), called from
// routes/alertConfig.ts) -- this script just looks for confirmed entities
// NOT yet in that table, alerts, and records them, rather than trying to
// diff "yesterday vs today" directly.
import { getAlertConfig } from '../src/alertConfig';
import { getLotwConfirmedEntities } from '../src/dxccConfirmedAlert';
import { sendAlertEmail } from '../src/alertEmail';
import { sendNtfyAlert } from '../src/alertNtfy';
import { db } from '../src/db';

async function main() {
  const cfg = getAlertConfig();
  if (!cfg.dxccConfirmedEnabled) {
    console.log('DXCC confirmation alerts disabled — turn it on under Admin.');
    return;
  }
  const emailOn = cfg.email?.enabled ?? false;
  const ntfyOn = cfg.ntfy?.enabled ?? false;
  if (!emailOn && !ntfyOn) {
    console.log('DXCC confirmation alerts enabled, but no delivery channel (email/push) is on — set one up under Admin.');
    return;
  }

  const confirmed = getLotwConfirmedEntities();
  const already = new Set(
    (db.query('SELECT entity FROM alerted_dxcc_confirmations').all() as { entity: string }[]).map((r) => r.entity),
  );
  const newlyConfirmed = [...confirmed].filter((e) => !already.has(e));

  if (!newlyConfirmed.length) {
    console.log('No newly-confirmed DXCC entities.');
    return;
  }

  const insertAlerted = db.query('INSERT OR IGNORE INTO alerted_dxcc_confirmations (entity) VALUES (?)');
  for (const entity of newlyConfirmed) {
    const subject = `New DXCC confirmation: ${entity}`;
    const text = `${entity} is now confirmed via LoTW — one more toward DXCC.`;

    let delivered = false;
    if (emailOn) {
      try {
        await sendAlertEmail(subject, text);
        console.log(`Emailed confirmation alert for ${entity}.`);
        delivered = true;
      } catch (err) {
        console.log(`Email alert failed for ${entity}:`, err instanceof Error ? err.message : err);
      }
    }
    if (ntfyOn) {
      try {
        await sendNtfyAlert(subject, text);
        console.log(`Sent ntfy push for ${entity}.`);
        delivered = true;
      } catch (err) {
        console.log(`ntfy alert failed for ${entity}:`, err instanceof Error ? err.message : err);
      }
    }
    if (delivered) insertAlerted.run(entity);
    else console.log(`All configured alert channels failed for ${entity} — not recording state, will retry next check.`);
  }
}

await main();
