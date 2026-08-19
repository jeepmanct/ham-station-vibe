// Checks every enabled satellite (Admin -> satellite list) for a pass
// starting soon, and emails/pushes an alert. Standalone script, same
// edge-triggered/frequent-check pattern as check-vhf-opening.ts -- paired
// with deploy/hamstation-sat-pass-alert.service + .timer, run every ~5
// minutes.
//
// Requires a configured Station Location (not the qsos-inference fallback
// other routes use) -- same reasoning as check-tropo-ducting.ts: AOS/LOS
// timing is precise enough that an inferred-not-configured location could
// give a meaningfully wrong "starting in 10 minutes" heads-up, worse than
// no alert at all.
//
// MIN_ELEVATION_DEG filters out grazing horizon-skimming passes not worth
// a heads-up for -- hardcoded rather than admin-configurable, a reasonable
// default for FM/SSB satellite work rather than a knob most people would
// tune. ALERT_LOOKAHEAD_MIN is how far before AOS the alert fires.
import { db } from '../src/db';
import { getAlertConfig } from '../src/alertConfig';
import { getStationLocation } from '../src/stationLocation';
import { sendAlertEmail } from '../src/alertEmail';
import { sendNtfyAlert } from '../src/alertNtfy';
import { sendWebPushAlert } from '../src/alertWebPush';
import { findUpcomingPasses, observerFromLatLon } from '../src/satellitePasses';
import * as satellite from 'satellite.js';

const MIN_ELEVATION_DEG = 20;
const ALERT_LOOKAHEAD_MIN = 15;

async function main() {
  const cfg = getAlertConfig();
  const emailOn = cfg.email?.enabled ?? false;
  const ntfyOn = cfg.ntfy?.enabled ?? false;
  const webPushOn = cfg.webPushEnabled ?? false;
  if (!cfg.satPassEnabled) {
    console.log('Satellite pass alerts disabled — turn it on under Admin.');
    return;
  }
  if (!emailOn && !ntfyOn && !webPushOn) {
    console.log('Satellite pass alerts enabled, but no delivery channel (email/push) is on — set one up under Admin.');
    return;
  }

  const location = getStationLocation();
  if (!location) {
    console.log('No Station Location configured under Admin — satellite pass alerts need one to know where to check.');
    return;
  }

  // Old dedup rows don't need to stick around once their pass is long past.
  db.exec(`DELETE FROM alerted_satellite_passes WHERE alerted_at < datetime('now', '-7 days')`);

  const already = new Set(
    (db.query('SELECT norad_id, aos_time FROM alerted_satellite_passes').all() as { norad_id: number; aos_time: string }[]).map(
      (r) => `${r.norad_id}:${r.aos_time}`,
    ),
  );

  const sats = db
    .query(
      `SELECT s.norad_id as noradId, s.name, s.mode, t.line1, t.line2
       FROM satellites s JOIN satellite_tle t ON t.norad_id = s.norad_id
       WHERE s.enabled = 1`,
    )
    .all() as { noradId: number; name: string; mode: string; line1: string; line2: string }[];

  if (!sats.length) {
    console.log('No enabled satellites with a TLE on file — nothing to check.');
    return;
  }

  const observerGd = observerFromLatLon(location.lat, location.lon);
  const now = new Date();
  const alerts: { sat: (typeof sats)[number]; pass: ReturnType<typeof findUpcomingPasses>[number] }[] = [];

  for (const sat of sats) {
    const satrec = satellite.twoline2satrec(sat.line1, sat.line2);
    const [next] = findUpcomingPasses(satrec, observerGd, now, 24, 1);
    if (!next) continue;
    const minutesToAos = (next.aos.getTime() - now.getTime()) / 60000;
    if (minutesToAos < 0 || minutesToAos > ALERT_LOOKAHEAD_MIN) continue;
    if (next.maxElevationDeg < MIN_ELEVATION_DEG) continue;
    if (already.has(`${sat.noradId}:${next.aos.toISOString()}`)) continue;
    alerts.push({ sat, pass: next });
  }

  if (!alerts.length) {
    console.log('No qualifying satellite passes starting soon.');
    return;
  }

  const insertAlerted = db.query('INSERT OR IGNORE INTO alerted_satellite_passes (norad_id, aos_time) VALUES (?, ?)');
  for (const { sat, pass } of alerts) {
    const durationMin = Math.round((pass.los.getTime() - pass.aos.getTime()) / 60000);
    const subject = `${sat.name} pass in ${Math.round((pass.aos.getTime() - now.getTime()) / 60000)} min (max ${Math.round(pass.maxElevationDeg)}°)`;
    const text =
      `${sat.name} (${sat.mode}) rises at your station location ${location.label ?? `${location.lat.toFixed(2)}, ${location.lon.toFixed(2)}`} ` +
      `at ${pass.aos.toUTCString()}, reaching a maximum elevation of ${Math.round(pass.maxElevationDeg)}° before setting at ${pass.los.toUTCString()} ` +
      `(~${durationMin} min pass).`;

    let delivered = false;
    if (emailOn) {
      try {
        await sendAlertEmail(subject, text);
        console.log(`Emailed pass alert for ${sat.name}.`);
        delivered = true;
      } catch (err) {
        console.log(`Email alert failed for ${sat.name}:`, err instanceof Error ? err.message : err);
      }
    }
    if (ntfyOn) {
      try {
        await sendNtfyAlert(subject, text);
        console.log(`Sent ntfy push for ${sat.name}.`);
        delivered = true;
      } catch (err) {
        console.log(`ntfy alert failed for ${sat.name}:`, err instanceof Error ? err.message : err);
      }
    }
    if (webPushOn) {
      try {
        await sendWebPushAlert(subject, text);
        console.log(`Sent web push for ${sat.name}.`);
        delivered = true;
      } catch (err) {
        console.log(`Web push alert failed for ${sat.name}:`, err instanceof Error ? err.message : err);
      }
    }
    if (delivered) insertAlerted.run(sat.noradId, pass.aos.toISOString());
    else console.log(`All configured alert channels failed for ${sat.name} — not recording state, will retry next check.`);
  }
}

await main();
