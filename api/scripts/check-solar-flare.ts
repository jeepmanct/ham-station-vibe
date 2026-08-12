// Checks NOAA SWPC's real-time GOES X-ray flux feed for an X-class solar
// flare (HF blackout risk) and emails/pushes an alert. Standalone script,
// same pattern as check-vhf-opening.ts -- paired with
// deploy/hamstation-flare-alert.service + .timer, run every ~5 minutes.
//
// Edge-triggered, not time-cooldown-based like the DX/VHF alerts: a single
// flare can stay elevated for 10-60+ minutes, so this tracks whether the
// last check was already X-class (flare_alert_state.was_x_class) and only
// alerts on the rising edge into X-class, resetting once flux drops back
// below the threshold so a genuinely new flare after a quiet period still
// alerts. No alert is sent when a flare ends.
//
// Flux comes from the standard GOES 0.1-0.8nm (long) channel, the one used
// for the conventional A/B/C/M/X flare classification -- verified live
// against https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json
// (2026-08-10), not assumed from memory.
import { db } from '../src/db';
import { sendAlertEmail } from '../src/alertEmail';
import { sendNtfyAlert } from '../src/alertNtfy';
import { getAlertConfig } from '../src/alertConfig';

const XRAY_URL = 'https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json';
const X_CLASS_THRESHOLD = 1e-4;

type XrayReading = { time_tag: string; flux: number; energy: string };

function classifyFlux(flux: number): string {
  if (flux >= 1e-4) return `X${(flux / 1e-4).toFixed(1)}`;
  if (flux >= 1e-5) return `M${(flux / 1e-5).toFixed(1)}`;
  if (flux >= 1e-6) return `C${(flux / 1e-6).toFixed(1)}`;
  if (flux >= 1e-7) return `B${(flux / 1e-7).toFixed(1)}`;
  return `A${(flux / 1e-8).toFixed(1)}`;
}

function getWasXClass(): boolean {
  const row = db.query('SELECT was_x_class FROM flare_alert_state WHERE id = 1').get() as { was_x_class: number } | null;
  return row?.was_x_class === 1;
}

function setWasXClass(value: boolean) {
  db.query(
    `INSERT INTO flare_alert_state (id, was_x_class) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET was_x_class = excluded.was_x_class`,
  ).run(value ? 1 : 0);
}

async function main() {
  const cfg = getAlertConfig();
  const emailOn = cfg.email?.enabled ?? false;
  const ntfyOn = cfg.ntfy?.enabled ?? false;
  if (!cfg.flareEnabled) {
    console.log('Solar flare alerts disabled — turn it on under Admin.');
    return;
  }
  if (!emailOn && !ntfyOn) {
    console.log('Solar flare alerts enabled, but no delivery channel (email/push) is on — set one up under Admin.');
    return;
  }

  const res = await fetch(XRAY_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    console.log(`NOAA SWPC fetch failed: HTTP ${res.status}`);
    return;
  }
  const readings = (await res.json()) as XrayReading[];
  const longChannel = readings.filter((r) => r.energy === '0.1-0.8nm').sort((a, b) => (a.time_tag < b.time_tag ? -1 : 1));
  const latest = longChannel[longChannel.length - 1];
  if (!latest) {
    console.log('No X-ray flux readings in the NOAA response.');
    return;
  }

  const isXClass = latest.flux >= X_CLASS_THRESHOLD;
  const wasXClass = getWasXClass();

  if (!isXClass) {
    if (wasXClass) setWasXClass(false);
    console.log(`Current flux: ${classifyFlux(latest.flux)} (${latest.time_tag}) — below X-class, nothing to do.`);
    return;
  }
  if (wasXClass) {
    console.log(`Still X-class (${classifyFlux(latest.flux)}) — already alerted for this event, not re-alerting.`);
    return;
  }

  const flareClass = classifyFlux(latest.flux);
  const subject = `X-class solar flare: ${flareClass}`;
  const text =
    `An X-class solar flare is in progress (${flareClass}, as of ${latest.time_tag}).\n\n` +
    `X-class flares can cause HF radio blackouts, especially on the sunlit side of the Earth, ` +
    `lasting from minutes to a few hours.\n\n` +
    `Live data: https://www.swpc.noaa.gov/products/goes-x-ray-flux`;

  let delivered = false;
  if (emailOn) {
    try {
      await sendAlertEmail(subject, text);
      console.log('Emailed flare alert.');
      delivered = true;
    } catch (err) {
      console.log('Email alert failed:', err instanceof Error ? err.message : err);
    }
  }
  if (ntfyOn) {
    try {
      await sendNtfyAlert(subject, text);
      console.log('Sent ntfy flare push.');
      delivered = true;
    } catch (err) {
      console.log('ntfy alert failed:', err instanceof Error ? err.message : err);
    }
  }
  if (!delivered) {
    console.log('All configured alert channels failed — not recording state, will retry next check.');
    return;
  }

  setWasXClass(true);
  console.log(`Alerted on X-class flare: ${flareClass}`);
}

await main();
