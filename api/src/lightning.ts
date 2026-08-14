// Live lightning-strike proximity tracking via Blitzortung.org's public
// MQTT feed -- a free, community-run lightning detection network with no
// official API docs, so (same spirit as kiwiSdr.ts) the protocol details
// below were confirmed live against the real broker rather than trusted
// from secondhand sources alone:
//   - Broker: mqtt://blitzortung.ha.sed.pl:1883, no auth, plain MQTT.
//   - Topics: `blitzortung/1.1/<geohash split into one char per level>/#`
//     -- confirmed by subscribing to the full firehose (`blitzortung/1.1/#`)
//     and checking that a real strike's own lat/lon, independently
//     geohash-encoded here, exactly matches the topic it arrived on
//     (34/34 matched at 6-char precision in testing).
//   - Payload: JSON `{lat, lon, time, status, region}` -- `time` is
//     NANOSECONDS since the Unix epoch (confirmed by converting a live
//     strike's timestamp and checking it landed within a second of the
//     actual wall-clock moment it arrived).
//
// The geohash encoder below is hand-rolled (the standard base32
// interleaved-bit algorithm) rather than pulled from an npm package --
// the only "geohash" package on npm is an unmaintained 0.0.1 release with
// no meaningful adoption, not something worth trusting for a real-time
// feed. Verified correct the same way as the topic format above.
import mqtt, { type MqttClient } from 'mqtt';
import { db } from './db';
import { getEffectiveHomeLocation } from './stationLocation';
import { distanceKm } from './maidenhead';
import { getAlertConfig } from './alertConfig';
import { sendAlertEmail } from './alertEmail';
import { sendNtfyAlert } from './alertNtfy';

const BROKER_URL = 'mqtt://blitzortung.ha.sed.pl:1883';
const TILE_PRECISION = 3; // ~156km x 156km cells at this precision
const TILE_OFFSET_KM = 150; // spacing for the 3x3 sample grid below -- slightly less than a full cell width so adjacent tiles overlap rather than leaving gaps
const DISPLAY_RADIUS_KM = 100; // matches the radius the wider Blitzortung/Home-Assistant community defaults to for general situational awareness
const ALERT_RADIUS_KM = 20; // deliberately much tighter than the display radius -- this is the "seriously, consider disconnecting" threshold, not "lightning exists somewhere nearby"
const STRIKE_RETENTION_MS = 2 * 60 * 60 * 1000; // 2h of history for the live map/feed
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // don't re-alert more than once per 30 min even if a storm keeps producing close strikes

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function encodeGeohash(lat: number, lon: number, precision: number): string {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let hash = '';
  let bit = 0;
  let ch = 0;
  let evenBit = true;
  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        ch |= 1 << (4 - bit);
        lonMin = mid;
      } else {
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        ch |= 1 << (4 - bit);
        latMin = mid;
      } else {
        latMax = mid;
      }
    }
    evenBit = !evenBit;
    if (bit < 4) {
      bit++;
    } else {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

// A 3x3 grid of sample points ~150km apart, each geohash-encoded and
// deduped -- not a proper geohash-neighbor walk (which needs real bit
// manipulation to get right), but achieves the same practical "a few
// overlapping tiles around the center point" coverage with much simpler,
// easier-to-verify code. The precise haversine filter in handleMessage()
// below catches anything a tile's rectangular edges let through that's
// actually outside DISPLAY_RADIUS_KM.
function computeTiles(lat: number, lon: number): string[] {
  const latDeltaDeg = TILE_OFFSET_KM / 111;
  const lonDeltaDeg = TILE_OFFSET_KM / (111 * Math.cos((lat * Math.PI) / 180));
  const tiles = new Set<string>();
  for (const dLat of [-1, 0, 1]) {
    for (const dLon of [-1, 0, 1]) {
      tiles.add(encodeGeohash(lat + dLat * latDeltaDeg, lon + dLon * lonDeltaDeg, TILE_PRECISION));
    }
  }
  return [...tiles];
}

export type Strike = { lat: number; lon: number; distanceKm: number; timestamp: number };

let client: MqttClient | null = null;
let strikes: Strike[] = [];
let lastAlertAt = 0;

function getMonitoringEnabledFromDb(): boolean {
  const row = db.query('SELECT enabled FROM lightning_monitoring WHERE id = 1').get() as { enabled: number } | null;
  return row?.enabled === 1;
}

function setMonitoringEnabledInDb(enabled: boolean) {
  db.query(
    `INSERT INTO lightning_monitoring (id, enabled) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled`,
  ).run(enabled ? 1 : 0);
}

function pruneOldStrikes() {
  const cutoff = Date.now() - STRIKE_RETENTION_MS;
  strikes = strikes.filter((s) => s.timestamp >= cutoff);
}

async function maybeAlert(strike: Strike) {
  if (strike.distanceKm > ALERT_RADIUS_KM) return;
  const cfg = getAlertConfig();
  if (!cfg.lightningEnabled) return;
  const emailOn = cfg.email?.enabled ?? false;
  const ntfyOn = cfg.ntfy?.enabled ?? false;
  if (!emailOn && !ntfyOn) return;
  if (Date.now() - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = Date.now();

  const subject = `Lightning ${strike.distanceKm.toFixed(0)}km from your station`;
  const text = `A lightning strike was detected ${strike.distanceKm.toFixed(1)} km from your station location -- worth considering whether to disconnect antennas if this keeps up.`;
  if (emailOn) {
    try {
      await sendAlertEmail(subject, text);
    } catch {
      // Best-effort -- a failed alert shouldn't crash the listener.
    }
  }
  if (ntfyOn) {
    try {
      await sendNtfyAlert(subject, text);
    } catch {
      // Same.
    }
  }
}

function handleMessage(_topic: string, payload: Buffer) {
  const home = getEffectiveHomeLocation();
  if (!home) return;
  let data: { lat?: unknown; lon?: unknown; time?: unknown };
  try {
    data = JSON.parse(payload.toString());
  } catch {
    return;
  }
  if (typeof data.lat !== 'number' || typeof data.lon !== 'number') return;
  const dist = distanceKm(home, { lat: data.lat, lon: data.lon });
  if (dist > DISPLAY_RADIUS_KM) return; // tiles are rectangular, radius is circular -- some messages land outside it
  const timestamp = typeof data.time === 'number' ? Math.round(data.time / 1e6) : Date.now();
  const strike: Strike = { lat: data.lat, lon: data.lon, distanceKm: dist, timestamp };
  strikes.push(strike);
  pruneOldStrikes();
  maybeAlert(strike).catch(() => {});
}

function connect() {
  if (client) return;
  const home = getEffectiveHomeLocation();
  // No station location configured (yet) -- nothing to center tiles on.
  // Left as "enabled but not actually connected" rather than refusing the
  // toggle outright, so turning this on ahead of setting a location just
  // works retroactively the next time monitoring is toggled after a
  // location is set.
  if (!home) return;

  const tiles = computeTiles(home.lat, home.lon);
  const topics = tiles.map((t) => `blitzortung/1.1/${t.split('').join('/')}/#`);
  const c = mqtt.connect(BROKER_URL, { connectTimeout: 10_000, reconnectPeriod: 10_000 });
  client = c;
  c.on('connect', () => c.subscribe(topics));
  c.on('message', handleMessage);
  c.on('error', () => {
    // mqtt.js's own reconnectPeriod handles retrying -- nothing to do here
    // beyond not letting an unhandled 'error' event crash the process.
  });
}

function disconnect() {
  client?.end(true);
  client = null;
  strikes = [];
}

/** Admin-only toggle for the persistent background connection -- see db.ts's table comment for why this defaults off. */
export function setLightningMonitoring(enabled: boolean) {
  setMonitoringEnabledInDb(enabled);
  if (enabled) connect();
  else disconnect();
}

/** Called once at API boot -- reconnects only if monitoring was left on before the last restart, same pattern as flexRadio.ts's startFlexRadioClient(). */
export function startLightningMonitoring() {
  if (getMonitoringEnabledFromDb()) connect();
}

export function getLightningStatus() {
  pruneOldStrikes();
  const closest = strikes.length ? Math.min(...strikes.map((s) => s.distanceKm)) : null;
  const home = getEffectiveHomeLocation();
  return {
    enabled: getMonitoringEnabledFromDb(),
    locationConfigured: !!home,
    homeLat: home?.lat ?? null,
    homeLon: home?.lon ?? null,
    connected: client?.connected ?? false,
    strikeCount: strikes.length,
    closestDistanceKm: closest,
    displayRadiusKm: DISPLAY_RADIUS_KM,
    alertRadiusKm: ALERT_RADIUS_KM,
  };
}

export function getRecentStrikes(): Strike[] {
  pruneOldStrikes();
  return strikes;
}
