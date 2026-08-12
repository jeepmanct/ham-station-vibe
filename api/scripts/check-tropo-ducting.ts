// Checks for tropospheric-ducting-favorable atmospheric conditions at the
// station's own configured location (Admin -> Station Location) and
// emails/pushes an alert. Standalone script, same edge-triggered pattern as
// check-solar-flare.ts/check-solar-wind.ts/check-solar-kp.ts -- paired with
// deploy/hamstation-tropo-alert.service + .timer.
//
// Deliberately requires a configured Station Location and does nothing
// without one -- there's no sane "default" location for a VHF/UHF
// propagation check, unlike the space-weather alerts above which are
// inherently global. getStationLocation() (not the qsos-inference fallback
// /api/conditions/home also uses) is checked directly, so an unconfigured
// station genuinely gets no tropo alerts rather than a wrong-location one.
//
// Uses Open-Meteo's free, no-API-key forecast API
// (https://open-meteo.com/en/docs) for temperature/relative-humidity/
// geopotential-height at the 1000hPa and 925hPa pressure levels (roughly
// 0-700m AGL, the layer most near-surface ducting occurs in), and computes
// the standard ITU-R P.453 atmospheric radio refractivity (N-units) at each
// level to get a vertical gradient dN/dz. Reference gradient is about
// -39 N-units/km; "super-refraction" (tropo-favorable) starts around
// -100 N/km, true ducting around -157 N/km -- this alert triggers at the
// former as an earlier, more useful heads-up. Confirmed live 2026-08-12
// against real Connecticut coordinates that the formula produces physically
// sane values (surface N ~320-360, gradients ~-30 to -65 N/km on an
// ordinary day).
import { getAlertConfig } from '../src/alertConfig';
import { getStationLocation } from '../src/stationLocation';
import { sendAlertEmail } from '../src/alertEmail';
import { sendNtfyAlert } from '../src/alertNtfy';
import { db } from '../src/db';

const DUCTING_THRESHOLD_N_PER_KM = -100;

type HourlyWeather = {
  time: string[];
  temperature_1000hPa: number[];
  temperature_925hPa: number[];
  relative_humidity_1000hPa: number[];
  relative_humidity_925hPa: number[];
  geopotential_height_1000hPa: number[];
  geopotential_height_925hPa: number[];
};

function refractivity(tempC: number, rhPct: number, pressureHpa: number): number {
  const tempK = tempC + 273.15;
  const satVaporPressure = 6.1094 * Math.exp((17.625 * tempC) / (tempC + 243.04));
  const vaporPressure = (rhPct / 100) * satVaporPressure;
  return 77.6 * (pressureHpa / tempK) + 3.73e5 * (vaporPressure / (tempK * tempK));
}

function getWasDucting(): boolean {
  const row = db.query('SELECT was_ducting FROM tropo_alert_state WHERE id = 1').get() as { was_ducting: number } | null;
  return row?.was_ducting === 1;
}

function setWasDucting(value: boolean) {
  db.query(
    `INSERT INTO tropo_alert_state (id, was_ducting) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET was_ducting = excluded.was_ducting`,
  ).run(value ? 1 : 0);
}

async function main() {
  const cfg = getAlertConfig();
  const emailOn = cfg.email?.enabled ?? false;
  const ntfyOn = cfg.ntfy?.enabled ?? false;
  if (!cfg.tropoEnabled) {
    console.log('Tropo ducting alerts disabled — turn it on under Admin.');
    return;
  }
  if (!emailOn && !ntfyOn) {
    console.log('Tropo ducting alerts enabled, but no delivery channel (email/push) is on — set one up under Admin.');
    return;
  }

  const location = getStationLocation();
  if (!location) {
    console.log('No Station Location configured under Admin — tropo ducting alerts need one to know where to check.');
    return;
  }

  const params = new URLSearchParams({
    latitude: String(location.lat),
    longitude: String(location.lon),
    hourly: 'temperature_1000hPa,temperature_925hPa,relative_humidity_1000hPa,relative_humidity_925hPa,geopotential_height_1000hPa,geopotential_height_925hPa',
    forecast_days: '1',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    console.log(`Open-Meteo fetch failed: HTTP ${res.status}`);
    return;
  }
  const body = (await res.json()) as { hourly: HourlyWeather };
  const hourly = body.hourly;

  const nowIso = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  let idx = hourly.time.findIndex((t) => t.startsWith(nowIso));
  if (idx < 0) idx = 0; // Fall back to the first available hour rather than skip the check entirely.

  const n1000 = refractivity(hourly.temperature_1000hPa[idx], hourly.relative_humidity_1000hPa[idx], 1000);
  const n925 = refractivity(hourly.temperature_925hPa[idx], hourly.relative_humidity_925hPa[idx], 925);
  const dzKm = (hourly.geopotential_height_925hPa[idx] - hourly.geopotential_height_1000hPa[idx]) / 1000;
  const gradient = (n925 - n1000) / dzKm;

  const isDucting = gradient <= DUCTING_THRESHOLD_N_PER_KM;
  const wasDucting = getWasDucting();

  if (!isDucting) {
    if (wasDucting) setWasDucting(false);
    console.log(`Refractivity gradient: ${gradient.toFixed(1)} N/km at ${hourly.time[idx]} — below ducting-favorable threshold, nothing to do.`);
    return;
  }
  if (wasDucting) {
    console.log(`Still ducting-favorable (${gradient.toFixed(1)} N/km) — already alerted for this event, not re-alerting.`);
    return;
  }

  const subject = `Tropo ducting favorable: ${gradient.toFixed(0)} N/km`;
  const text =
    `Atmospheric conditions near your station location (${location.label ?? `${location.lat.toFixed(2)}, ${location.lon.toFixed(2)}`}) ` +
    `currently favor tropospheric ducting on VHF/UHF (refractivity gradient ${gradient.toFixed(0)} N-units/km as of ${hourly.time[idx]} UTC, ` +
    `vs. a normal ~-39 N/km).\n\n` +
    `Strong negative gradients like this can extend 2m/70cm/microwave range well beyond line-of-sight, sometimes hundreds of miles.\n\n` +
    `This is a simplified estimate (near-surface layer only, not a full ray-trace), not a substitute for a dedicated tropo forecast map.`;

  let delivered = false;
  if (emailOn) {
    try {
      await sendAlertEmail(subject, text);
      console.log('Emailed tropo ducting alert.');
      delivered = true;
    } catch (err) {
      console.log('Email alert failed:', err instanceof Error ? err.message : err);
    }
  }
  if (ntfyOn) {
    try {
      await sendNtfyAlert(subject, text);
      console.log('Sent ntfy tropo ducting push.');
      delivered = true;
    } catch (err) {
      console.log('ntfy alert failed:', err instanceof Error ? err.message : err);
    }
  }
  if (!delivered) {
    console.log('All configured alert channels failed — not recording state, will retry next check.');
    return;
  }

  setWasDucting(true);
  console.log(`Alerted on tropo ducting: ${gradient.toFixed(1)} N/km`);
}

await main();
