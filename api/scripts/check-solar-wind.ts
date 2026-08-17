// Checks NOAA SWPC's real-time solar wind feed for a strong southward IMF
// (Bz) reading -- an early-warning signal for an incoming geomagnetic
// disturbance, typically 15-60 minutes ahead of the effect actually showing
// up in the planetary K-index (which the VHF-opening alert doesn't watch,
// and which itself only updates every 3 hours). Standalone script, same
// pattern as check-solar-flare.ts -- paired with
// deploy/hamstation-wind-alert.service + .timer, run every ~5 minutes.
//
// Edge-triggered like the flare alert, not time-cooldown -- a southward Bz
// period can last hours, so this only alerts on the rising edge into
// "strong south," resetting once it turns back north/weak.
//
// Endpoints and field names confirmed live (2026-08-10), not from NOAA's
// sparse docs: real-time solar wind data lives under
// /json/rtsw/rtsw_mag_1m.json (magnetometer) and rtsw_wind_1m.json
// (plasma/speed) -- NOT the /products/solar-wind/ path a first guess (and
// several web results) suggested, which 404s. Each file mixes readings
// from multiple spacecraft (seen live: SOLAR1, IMAP, ACE) with only one
// marked `active: true` at a time -- that's NOAA's own designated primary
// feed, so this filters on that rather than assuming array order or a
// specific spacecraft name (the active source can and does change).
import { db } from '../src/db';
import { sendAlertEmail } from '../src/alertEmail';
import { sendNtfyAlert } from '../src/alertNtfy';
import { getAlertConfig } from '../src/alertConfig';
import { fetchJsonLenient } from '../src/fetchJson';

const MAG_URL = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json';
const PLASMA_URL = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json';
const BZ_SOUTH_THRESHOLD = -10; // nT -- commonly cited threshold for a strong southward IMF

type MagReading = { time_tag: string; active: boolean; bz_gsm: number | null };
type PlasmaReading = { time_tag: string; active: boolean; proton_speed: number | null };

function latestActive<T extends { time_tag: string; active: boolean }>(readings: T[]): T | null {
  const active = readings.filter((r) => r.active).sort((a, b) => (a.time_tag < b.time_tag ? 1 : -1));
  return active[0] ?? null;
}

function getWasSouthBz(): boolean {
  const row = db.query('SELECT was_south_bz FROM wind_alert_state WHERE id = 1').get() as { was_south_bz: number } | null;
  return row?.was_south_bz === 1;
}

function setWasSouthBz(value: boolean) {
  db.query(
    `INSERT INTO wind_alert_state (id, was_south_bz) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET was_south_bz = excluded.was_south_bz`,
  ).run(value ? 1 : 0);
}

async function main() {
  const cfg = getAlertConfig();
  const emailOn = cfg.email?.enabled ?? false;
  const ntfyOn = cfg.ntfy?.enabled ?? false;
  if (!cfg.windEnabled) {
    console.log('Solar wind alerts disabled — turn it on under Admin.');
    return;
  }
  if (!emailOn && !ntfyOn) {
    console.log('Solar wind alerts enabled, but no delivery channel (email/push) is on — set one up under Admin.');
    return;
  }

  const [magRes, plasmaRes] = await Promise.all([
    fetch(MAG_URL, { signal: AbortSignal.timeout(8000) }),
    fetch(PLASMA_URL, { signal: AbortSignal.timeout(8000) }),
  ]);
  if (!magRes.ok) {
    console.log(`NOAA SWPC mag fetch failed: HTTP ${magRes.status}`);
    return;
  }
  const magReadings = await fetchJsonLenient<MagReading[]>(magRes);
  const latestMag = latestActive(magReadings);
  if (!latestMag || latestMag.bz_gsm == null) {
    console.log('No active Bz reading in the NOAA response.');
    return;
  }

  let speedText = '';
  if (plasmaRes.ok) {
    const plasmaReadings = await fetchJsonLenient<PlasmaReading[]>(plasmaRes);
    const latestPlasma = latestActive(plasmaReadings);
    if (latestPlasma?.proton_speed != null) speedText = `, solar wind speed ${latestPlasma.proton_speed.toFixed(0)} km/s`;
  }

  const bz = latestMag.bz_gsm;
  const isSouth = bz <= BZ_SOUTH_THRESHOLD;
  const wasSouth = getWasSouthBz();

  if (!isSouth) {
    if (wasSouth) setWasSouthBz(false);
    console.log(`Bz: ${bz.toFixed(1)} nT (${latestMag.time_tag}) — not strongly southward, nothing to do.`);
    return;
  }
  if (wasSouth) {
    console.log(`Still south (Bz ${bz.toFixed(1)} nT) — already alerted for this event, not re-alerting.`);
    return;
  }

  const subject = `Solar wind: strong southward Bz (${bz.toFixed(1)} nT)`;
  const text =
    `The interplanetary magnetic field has turned strongly southward (Bz ${bz.toFixed(1)} nT as of ${latestMag.time_tag}${speedText}).\n\n` +
    `A sustained southward Bz couples solar wind energy into Earth's magnetosphere and often precedes a geomagnetic disturbance ` +
    `(K-index rise, possible VHF/aurora opening or HF degradation) by 15-60 minutes.\n\n` +
    `Live data: https://www.swpc.noaa.gov/products/real-time-solar-wind`;

  let delivered = false;
  if (emailOn) {
    try {
      await sendAlertEmail(subject, text);
      console.log('Emailed solar wind alert.');
      delivered = true;
    } catch (err) {
      console.log('Email alert failed:', err instanceof Error ? err.message : err);
    }
  }
  if (ntfyOn) {
    try {
      await sendNtfyAlert(subject, text);
      console.log('Sent ntfy solar wind push.');
      delivered = true;
    } catch (err) {
      console.log('ntfy alert failed:', err instanceof Error ? err.message : err);
    }
  }
  if (!delivered) {
    console.log('All configured alert channels failed — not recording state, will retry next check.');
    return;
  }

  setWasSouthBz(true);
  console.log(`Alerted on southward Bz: ${bz.toFixed(1)} nT`);
}

await main();
