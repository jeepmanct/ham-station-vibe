import { db } from './db';

type Row = {
  qrz_api_key: string | null;
  eqsl_username: string | null;
  eqsl_password: string | null;
  lotw_username: string | null;
  lotw_password: string | null;
  flex_radio_ip: string | null;
  open_repeater_api_key: string | null;
  open_repeater_lat: number | null;
  open_repeater_lng: number | null;
  open_repeater_radius_km: number | null;
  hamqth_username: string | null;
  hamqth_password: string | null;
  brandmeister_talkgroups: string | null;
};

function getRow(): Row | null {
  return db
    .query(
      'SELECT qrz_api_key, eqsl_username, eqsl_password, lotw_username, lotw_password, flex_radio_ip, open_repeater_api_key, open_repeater_lat, open_repeater_lng, open_repeater_radius_km, hamqth_username, hamqth_password, brandmeister_talkgroups FROM service_credentials WHERE id = 1',
    )
    .get() as Row | null;
}

// DB value wins when set; falls back to the old .env-based setup
// (set-qrz-key.ts / set-eqsl-credentials.ts) so a Pi that was already
// configured before this admin page existed keeps working without
// re-entering anything. LoTW has no such env-based predecessor -- it was
// always a manual file upload before this -- so it has no fallback.
export function getQrzApiKey(): string | null {
  return getRow()?.qrz_api_key || process.env.QRZ_API_KEY || null;
}

export function getEqslCredentials(): { callsign: string; password: string } | null {
  const row = getRow();
  const callsign = row?.eqsl_username || process.env.EQSL_USERNAME || null;
  const password = row?.eqsl_password || process.env.EQSL_PASSWORD || null;
  return callsign && password ? { callsign, password } : null;
}

export function getLotwCredentials(): { callsign: string; password: string } | null {
  const row = getRow();
  return row?.lotw_username && row.lotw_password ? { callsign: row.lotw_username, password: row.lotw_password } : null;
}

// DB value wins, falls back to the older FLEX_RADIO_IP .env var -- same
// convention as the QRZ/eQSL getters above, so a Pi already configured via
// .env keeps working untouched until someone sets it here instead.
export function getFlexRadioIp(): string | null {
  return getRow()?.flex_radio_ip || process.env.FLEX_RADIO_IP || null;
}

// No .env-based predecessor -- this is a new integration, DB-only.
export function getOpenRepeaterConfig(): { apiKey: string; lat: number; lng: number; radiusKm: number } | null {
  const row = getRow();
  if (!row?.open_repeater_api_key || row.open_repeater_lat == null || row.open_repeater_lng == null) return null;
  return {
    apiKey: row.open_repeater_api_key,
    lat: row.open_repeater_lat,
    lng: row.open_repeater_lng,
    radiusKm: row.open_repeater_radius_km ?? 50,
  };
}

// No .env-based predecessor -- this is a new integration, DB-only.
export function getHamQthCredentials(): { username: string; password: string } | null {
  const row = getRow();
  return row?.hamqth_username && row.hamqth_password
    ? { username: row.hamqth_username, password: row.hamqth_password }
    : null;
}

// No API key involved at all -- just which talkgroup(s) to filter
// BrandMeister's public live-activity feed down to.
export function getBrandmeisterTalkgroups(): number[] {
  const raw = getRow()?.brandmeister_talkgroups;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Never includes the actual secrets -- just enough to render the admin form (a "configured" flag per secret, plus the non-secret usernames/callsigns/IP). */
export function getServiceCredentialsPublic() {
  const row = getRow();
  return {
    qrzApiKeyConfigured: !!(row?.qrz_api_key || process.env.QRZ_API_KEY),
    eqslUsername: row?.eqsl_username || process.env.EQSL_USERNAME || '',
    eqslPasswordConfigured: !!(row?.eqsl_password || process.env.EQSL_PASSWORD),
    lotwUsername: row?.lotw_username || '',
    lotwPasswordConfigured: !!row?.lotw_password,
    // Not a secret -- returned as plain text like the usernames above,
    // unlike the *Configured-only fields for the actual passwords/API key.
    flexRadioIp: row?.flex_radio_ip || process.env.FLEX_RADIO_IP || '',
    openRepeaterApiKeyConfigured: !!row?.open_repeater_api_key,
    openRepeaterLat: row?.open_repeater_lat ?? null,
    openRepeaterLng: row?.open_repeater_lng ?? null,
    openRepeaterRadiusKm: row?.open_repeater_radius_km ?? 50,
    hamqthUsername: row?.hamqth_username || '',
    hamqthPasswordConfigured: !!row?.hamqth_password,
    brandmeisterTalkgroups: row?.brandmeister_talkgroups || '',
  };
}

/** Each field is independent and optional -- omitting one (or sending it blank) keeps whatever's already stored, same "leave blank to keep existing" convention as the alert-email SMTP password. */
export function setServiceCredentials(cfg: {
  qrzApiKey?: string;
  eqslUsername?: string;
  eqslPassword?: string;
  lotwUsername?: string;
  lotwPassword?: string;
  flexRadioIp?: string;
  openRepeaterApiKey?: string;
  openRepeaterLat?: number;
  openRepeaterLng?: number;
  openRepeaterRadiusKm?: number;
  hamqthUsername?: string;
  hamqthPassword?: string;
  brandmeisterTalkgroups?: string;
}) {
  const existing = getRow();
  const qrzApiKey = cfg.qrzApiKey ? cfg.qrzApiKey : (existing?.qrz_api_key ?? null);
  const eqslUsername = cfg.eqslUsername !== undefined ? cfg.eqslUsername || null : (existing?.eqsl_username ?? null);
  const eqslPassword = cfg.eqslPassword ? cfg.eqslPassword : (existing?.eqsl_password ?? null);
  const lotwUsername = cfg.lotwUsername !== undefined ? cfg.lotwUsername || null : (existing?.lotw_username ?? null);
  const lotwPassword = cfg.lotwPassword ? cfg.lotwPassword : (existing?.lotw_password ?? null);
  const flexRadioIp = cfg.flexRadioIp !== undefined ? cfg.flexRadioIp || null : (existing?.flex_radio_ip ?? null);
  const openRepeaterApiKey = cfg.openRepeaterApiKey ? cfg.openRepeaterApiKey : (existing?.open_repeater_api_key ?? null);
  const openRepeaterLat = cfg.openRepeaterLat !== undefined ? cfg.openRepeaterLat : (existing?.open_repeater_lat ?? null);
  const openRepeaterLng = cfg.openRepeaterLng !== undefined ? cfg.openRepeaterLng : (existing?.open_repeater_lng ?? null);
  const openRepeaterRadiusKm =
    cfg.openRepeaterRadiusKm !== undefined ? cfg.openRepeaterRadiusKm : (existing?.open_repeater_radius_km ?? null);
  const hamqthUsername = cfg.hamqthUsername !== undefined ? cfg.hamqthUsername || null : (existing?.hamqth_username ?? null);
  const hamqthPassword = cfg.hamqthPassword ? cfg.hamqthPassword : (existing?.hamqth_password ?? null);
  const brandmeisterTalkgroups =
    cfg.brandmeisterTalkgroups !== undefined ? cfg.brandmeisterTalkgroups || null : (existing?.brandmeister_talkgroups ?? null);

  db.query(
    `INSERT INTO service_credentials (id, qrz_api_key, eqsl_username, eqsl_password, lotw_username, lotw_password, flex_radio_ip, open_repeater_api_key, open_repeater_lat, open_repeater_lng, open_repeater_radius_km, hamqth_username, hamqth_password, brandmeister_talkgroups) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       qrz_api_key = excluded.qrz_api_key,
       eqsl_username = excluded.eqsl_username,
       eqsl_password = excluded.eqsl_password,
       lotw_username = excluded.lotw_username,
       lotw_password = excluded.lotw_password,
       flex_radio_ip = excluded.flex_radio_ip,
       open_repeater_api_key = excluded.open_repeater_api_key,
       open_repeater_lat = excluded.open_repeater_lat,
       open_repeater_lng = excluded.open_repeater_lng,
       open_repeater_radius_km = excluded.open_repeater_radius_km,
       hamqth_username = excluded.hamqth_username,
       hamqth_password = excluded.hamqth_password,
       brandmeister_talkgroups = excluded.brandmeister_talkgroups`,
  ).run(
    qrzApiKey,
    eqslUsername,
    eqslPassword,
    lotwUsername,
    lotwPassword,
    flexRadioIp,
    openRepeaterApiKey,
    openRepeaterLat,
    openRepeaterLng,
    openRepeaterRadiusKm,
    hamqthUsername,
    hamqthPassword,
    brandmeisterTalkgroups,
  );
}
