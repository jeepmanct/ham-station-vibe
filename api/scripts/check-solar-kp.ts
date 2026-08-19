// Checks NOAA SWPC's real-time planetary K-index feed for a geomagnetic
// storm (Kp >= 5, the standard "G1 minor storm" threshold on NOAA's space
// weather scale) and emails/pushes an alert. Standalone script, same pattern
// as check-solar-flare.ts/check-solar-wind.ts -- paired with
// deploy/hamstation-kp-alert.service + .timer, run every ~5 minutes.
//
// Edge-triggered like the other two, not time-cooldown -- a storm can stay
// elevated for hours, so this tracks kp_alert_state.was_storm and only
// alerts on the rising edge into Kp>=5, resetting once it drops back below
// so a genuinely new storm after a quiet period still alerts.
//
// Kp>=5 is a reasonable trigger for "check for aurora/6m opening" -- it's
// the same threshold NOAA itself uses for G1, and is roughly when aurora
// becomes visible at high-mid latitudes and 6m/2m aurora-mode openings
// start becoming plausible further south.
//
// Endpoint and field names confirmed live (2026-08-11):
// https://services.swpc.noaa.gov/json/planetary_k_index_1m.json -- an
// array of 1-minute estimated readings, field `kp_index` (integer 0-9).
import { db } from '../src/db';
import { sendAlertEmail } from '../src/alertEmail';
import { sendNtfyAlert } from '../src/alertNtfy';
import { sendWebPushAlert } from '../src/alertWebPush';
import { getAlertConfig } from '../src/alertConfig';
import { fetchJsonLenient } from '../src/fetchJson';

const KP_URL = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';
const KP_STORM_THRESHOLD = 5;

type KpReading = { time_tag: string; kp_index: number };

function getWasStorm(): boolean {
  const row = db.query('SELECT was_storm FROM kp_alert_state WHERE id = 1').get() as { was_storm: number } | null;
  return row?.was_storm === 1;
}

function setWasStorm(value: boolean) {
  db.query(
    `INSERT INTO kp_alert_state (id, was_storm) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET was_storm = excluded.was_storm`,
  ).run(value ? 1 : 0);
}

function stormScale(kp: number): string {
  if (kp >= 9) return 'G5 (Extreme)';
  if (kp >= 8) return 'G4 (Severe)';
  if (kp >= 7) return 'G3 (Strong)';
  if (kp >= 6) return 'G2 (Moderate)';
  return 'G1 (Minor)';
}

async function main() {
  const cfg = getAlertConfig();
  const emailOn = cfg.email?.enabled ?? false;
  const ntfyOn = cfg.ntfy?.enabled ?? false;
  const webPushOn = cfg.webPushEnabled ?? false;
  if (!cfg.kpEnabled) {
    console.log('Geomagnetic storm alerts disabled — turn it on under Admin.');
    return;
  }
  if (!emailOn && !ntfyOn && !webPushOn) {
    console.log('Geomagnetic storm alerts enabled, but no delivery channel (email/push) is on — set one up under Admin.');
    return;
  }

  const res = await fetch(KP_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    console.log(`NOAA SWPC fetch failed: HTTP ${res.status}`);
    return;
  }
  const readings = await fetchJsonLenient<KpReading[]>(res);
  const latest = [...readings].sort((a, b) => (a.time_tag < b.time_tag ? -1 : 1)).pop();
  if (!latest) {
    console.log('No Kp-index readings in the NOAA response.');
    return;
  }

  const isStorm = latest.kp_index >= KP_STORM_THRESHOLD;
  const wasStorm = getWasStorm();

  if (!isStorm) {
    if (wasStorm) setWasStorm(false);
    console.log(`Kp: ${latest.kp_index} (${latest.time_tag}) — below storm threshold, nothing to do.`);
    return;
  }
  if (wasStorm) {
    console.log(`Still storming (Kp ${latest.kp_index}) — already alerted for this event, not re-alerting.`);
    return;
  }

  const scale = stormScale(latest.kp_index);
  const subject = `Geomagnetic storm: Kp ${latest.kp_index} (${scale})`;
  const text =
    `A geomagnetic storm is in progress (Kp ${latest.kp_index}, ${scale}, as of ${latest.time_tag}).\n\n` +
    `Elevated Kp often means aurora visible further south than usual, and can bring 6m/2m aurora-mode openings ` +
    `while also degrading HF propagation (especially higher latitude paths).\n\n` +
    `Live data: https://www.swpc.noaa.gov/products/planetary-k-index`;

  let delivered = false;
  if (emailOn) {
    try {
      await sendAlertEmail(subject, text);
      console.log('Emailed geomagnetic storm alert.');
      delivered = true;
    } catch (err) {
      console.log('Email alert failed:', err instanceof Error ? err.message : err);
    }
  }
  if (ntfyOn) {
    try {
      await sendNtfyAlert(subject, text);
      console.log('Sent ntfy geomagnetic storm push.');
      delivered = true;
    } catch (err) {
      console.log('ntfy alert failed:', err instanceof Error ? err.message : err);
    }
  }
  if (webPushOn) {
    try {
      await sendWebPushAlert(subject, text);
      console.log('Sent web push geomagnetic storm alert.');
      delivered = true;
    } catch (err) {
      console.log('Web push alert failed:', err instanceof Error ? err.message : err);
    }
  }
  if (!delivered) {
    console.log('All configured alert channels failed — not recording state, will retry next check.');
    return;
  }

  setWasStorm(true);
  console.log(`Alerted on geomagnetic storm: Kp ${latest.kp_index} (${scale})`);
}

await main();
