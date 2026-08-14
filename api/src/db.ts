import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR ?? path.join(import.meta.dir, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(path.join(DATA_DIR, 'photos'), { recursive: true });
mkdirSync(path.join(DATA_DIR, 'photos', 'thumbs'), { recursive: true });
mkdirSync(path.join(DATA_DIR, 'eqsl-cards'), { recursive: true });

export const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
export const PHOTOS_THUMBS_DIR = path.join(PHOTOS_DIR, 'thumbs');
export const EQSL_CARDS_DIR = path.join(DATA_DIR, 'eqsl-cards');

export const db = new Database(path.join(DATA_DIR, 'hamstation.sqlite'));
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS qsos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call TEXT NOT NULL,
    qso_date TEXT NOT NULL,
    time_on TEXT,
    band TEXT,
    mode TEXT,
    freq TEXT,
    rst_sent TEXT,
    rst_rcvd TEXT,
    gridsquare TEXT,
    country TEXT,
    lotw_qsl_rcvd TEXT,
    lotw_qsl_rcvd_date TEXT,
    raw_adif TEXT,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(call, qso_date, time_on, band, mode)
  );

  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    caption TEXT,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
    has_thumbnail INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  -- date in YYYYMMDD, matching qsos.qso_date, so it joins directly with no conversion.
  CREATE TABLE IF NOT EXISTS solar_data (
    date TEXT PRIMARY KEY,
    sfi REAL,
    sfi_adjusted REAL,
    a_index REAL,
    k_index REAL,
    k_index_max REAL,
    sunspot_number REAL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Base callsigns (portable "_YY" trip suffixes stripped) known to have Club
  -- Log OQRS enabled, from their public clublog-users.json.zip bulk export.
  -- Membership-only — we don't need any of the other fields in that file.
  CREATE TABLE IF NOT EXISTS clublog_oqrs (
    call TEXT PRIMARY KEY,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Club Log's global DXCC most-wanted ranking (clublog.org/mostwanted.php,
  -- no API key needed), keyed by ADIF DXCC entity code -- see
  -- data/adifDxccCodes.ts for how that code maps to this site's own entity
  -- names. Powers /awards's Most-Wanted card (rank ascending = most wanted
  -- first) instead of the plain alphabetical list it used before.
  CREATE TABLE IF NOT EXISTS clublog_most_wanted (
    adif_code INTEGER PRIMARY KEY,
    rank INTEGER NOT NULL,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Curated list of ham satellites worth tracking (Voice/FT8-capable only —
  -- see scripts/seed-satellites.ts for the source verification behind each
  -- entry). "enabled" is user-configurable via the admin-protected toggle on
  -- /satellites; the seed data itself doesn't change unless a satellite goes
  -- permanently silent and needs replacing.
  CREATE TABLE IF NOT EXISTS satellites (
    norad_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    mode TEXT NOT NULL,
    uplink TEXT,
    downlink TEXT,
    notes TEXT,
    enabled INTEGER NOT NULL DEFAULT 1
  );

  -- Latest two-line element set per satellite, refreshed from CelesTrak.
  CREATE TABLE IF NOT EXISTS satellite_tle (
    norad_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    line1 TEXT NOT NULL,
    line2 TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Single-row watermark for incremental QRZ Logbook syncs (see qrz.ts).
  CREATE TABLE IF NOT EXISTS qrz_sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_synced_date TEXT
  );

  -- Single-row watermark for incremental LoTW report syncs (see lotw.ts).
  CREATE TABLE IF NOT EXISTS lotw_sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_synced_date TEXT
  );

  -- Single-row watermark for incremental eQSL.cc inbox syncs (see eqsl.ts).
  -- Stored in eQSL's own RcvdSince format (YYYYMMDDHHMM), not YYYY-MM-DD like
  -- qrz_sync_state, since that's what gets sent back to their API as-is.
  CREATE TABLE IF NOT EXISTS eqsl_sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_synced_at TEXT
  );

  -- Cooldown tracking for the needed-DX email alert (scripts/check-needed-dx.ts)
  -- -- one row per callsign we've already emailed about, so a station sitting
  -- on the spot feed for hours doesn't trigger a fresh email every check.
  CREATE TABLE IF NOT EXISTS alerted_dx_spots (
    call TEXT PRIMARY KEY,
    alerted_at TEXT NOT NULL
  );

  -- Cooldown tracking for VHF/Sporadic-E band-opening alerts
  -- (scripts/check-vhf-opening.ts) -- one row per band, since the point is
  -- "an opening is happening," not per-spot, so an opening that keeps
  -- producing new spots for hours only alerts once per cooldown window.
  CREATE TABLE IF NOT EXISTS alerted_vhf_bands (
    band TEXT PRIMARY KEY,
    alerted_at TEXT NOT NULL
  );

  -- Edge-trigger state for the X-class solar flare alert
  -- (scripts/check-solar-flare.ts) -- unlike the VHF/DX alerts (cooldown by
  -- elapsed time), this tracks whether flux was ALREADY X-class as of the
  -- last check, so a single prolonged flare only alerts once (on the rising
  -- edge into X-class) rather than re-alerting every 5-minute check while it
  -- stays elevated. Resets to 0 once flux drops back below X-class, so a
  -- genuinely new flare after a quiet period alerts again.
  CREATE TABLE IF NOT EXISTS flare_alert_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    was_x_class INTEGER NOT NULL DEFAULT 0
  );

  -- Edge-trigger state for the solar wind / incoming geomagnetic storm alert
  -- (scripts/check-solar-wind.ts) -- same rising-edge pattern as
  -- flare_alert_state, so a sustained southward-Bz period only alerts once.
  CREATE TABLE IF NOT EXISTS wind_alert_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    was_south_bz INTEGER NOT NULL DEFAULT 0
  );

  -- Edge-trigger state for the geomagnetic-storm (Kp-index/aurora) alert
  -- (scripts/check-solar-kp.ts) -- same rising-edge pattern as
  -- flare_alert_state/wind_alert_state above.
  CREATE TABLE IF NOT EXISTS kp_alert_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    was_storm INTEGER NOT NULL DEFAULT 0
  );

  -- Edge-trigger state for the tropospheric ducting alert
  -- (scripts/check-tropo-ducting.ts) -- same rising-edge pattern as the
  -- other space/atmospheric-weather alerts above.
  CREATE TABLE IF NOT EXISTS tropo_alert_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    was_ducting INTEGER NOT NULL DEFAULT 0
  );

  -- On-demand eQSL card image cache (see eqslCard.ts). Deliberately NOT a
  -- bulk-fetched gallery -- eQSL's GeteQSL.cfm is rate-limited (max 6/min,
  -- explicitly forbids mass-downloading an entire Inbox) and requires
  -- per-QSO parameters, so cards are only ever fetched one at a time when
  -- actually viewed from the log, then cached here so the same QSO is never
  -- re-fetched. image_path is NULL for a confirmed "no card available"
  -- result (also cached, so a QSO with no graphic isn't re-queried on every
  -- view either).
  CREATE TABLE IF NOT EXISTS eqsl_cards (
    qso_id INTEGER PRIMARY KEY REFERENCES qsos(id),
    image_path TEXT,
    fetched_at TEXT NOT NULL
  );

  -- Single-row SMTP config for the needed-DX email alert, editable from
  -- /admin rather than requiring shell access to the Pi. smtp_pass is
  -- plaintext at rest here, same tradeoff already made for QRZ_API_KEY in
  -- .env -- this DB file isn't exposed outside the Pi.
  CREATE TABLE IF NOT EXISTS alert_email_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    smtp_host TEXT,
    smtp_port INTEGER,
    smtp_user TEXT,
    smtp_pass TEXT,
    alert_to TEXT,
    enabled INTEGER NOT NULL DEFAULT 0
  );

  -- One row per on-air session (TX key-down to key-up), so "last used" and a
  -- history survive an api restart -- the live connection state itself
  -- (flexRadio.ts) is in-memory only and rebuilds on reconnect.
  CREATE TABLE IF NOT EXISTS radio_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    frequency_mhz REAL,
    mode TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_radio_sessions_started ON radio_sessions(started_at);

  -- Whether the FlexRadio background connection should be running at all --
  -- defaults to off so the connection isn't held open constantly; toggled
  -- from /radio itself, persisted here so the choice survives an api restart.
  CREATE TABLE IF NOT EXISTS radio_monitoring (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0
  );

  -- Admin-configured station identity/QTH -- one row of "facts about this
  -- station" (callsign, location) rather than separate tables per field,
  -- same reasoning as service_credentials grouping unrelated-but-single-row
  -- config together. lat/lon/grid take priority over
  -- /api/conditions/home's older fallback of inferring location from
  -- whichever my_lat/my_lon pair appears on the most logged QSOs (kept as a
  -- fallback for a Pi that hasn't set this yet, and for a fresh install with
  -- no QSOs logged at all). callsign has no such fallback -- there's nothing
  -- to infer it from on a brand-new install, so callers treat an unset
  -- callsign as "this feature isn't configured yet" rather than guessing.
  -- lat/lon are nullable (unlike the NOT NULL they started with) since a
  -- fresh install may set its callsign well before its location -- the two
  -- are independent, both optional, on this same row.
  CREATE TABLE IF NOT EXISTS station_location (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    callsign TEXT,
    label TEXT,
    lat REAL,
    lon REAL,
    grid TEXT
  );

  -- Third-party service credentials (QRZ Logbook API key, eQSL.cc login),
  -- editable from /admin rather than requiring shell access to the Pi (see
  -- serviceCredentials.ts). Plaintext at rest, same tradeoff already made
  -- for alert_email_config's smtp_pass -- this DB file isn't exposed outside
  -- the Pi. Falls back to the older QRZ_API_KEY/EQSL_USERNAME/EQSL_PASSWORD
  -- .env vars when a row's column is unset, so a Pi already configured via
  -- set-qrz-key.ts/set-eqsl-credentials.ts keeps working untouched.
  CREATE TABLE IF NOT EXISTS service_credentials (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    qrz_api_key TEXT,
    eqsl_username TEXT,
    eqsl_password TEXT,
    lotw_username TEXT,
    lotw_password TEXT
  );

  -- Admin-configurable tile order/visibility for a page's card grid (home,
  -- tools, electronics). No row for a given page means "use the default
  -- markup order, nothing hidden" -- rows only appear once an admin actually
  -- customizes that page, so a fresh install needs no seed data here.
  CREATE TABLE IF NOT EXISTS tile_layout (
    page TEXT NOT NULL,
    tile_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (page, tile_id)
  );
`);

const SEED_SATELLITES: {
  noradId: number;
  name: string;
  mode: string;
  uplink: string;
  downlink: string;
  notes: string;
}[] = [
  {
    noradId: 25544,
    name: 'ISS (Crossband Repeater)',
    mode: 'FM Voice',
    uplink: '145.990 MHz (67.0 Hz PL)',
    downlink: '437.800 MHz',
    notes: 'Not always active — the crew sometimes reconfigures the radio for packet/SSTV instead of the FM repeater.',
  },
  {
    noradId: 27607,
    name: 'SO-50',
    mode: 'FM Voice',
    uplink: '145.850 MHz (67.0 Hz PL)',
    downlink: '436.795 MHz',
    notes: 'The classic beginner-friendly FM bird — single channel, no Doppler-tuning the uplink needed.',
  },
  {
    noradId: 43017,
    name: 'AO-91 (RadFxSat / Fox-1B)',
    mode: 'FM Voice',
    uplink: '435.250 MHz (67.0 Hz PL)',
    downlink: '145.960 MHz',
    notes: '',
  },
  {
    noradId: 7530,
    name: 'AO-7',
    mode: 'SSB/CW Linear',
    uplink: '432.125–432.175 MHz',
    downlink: '145.925–145.975 MHz',
    notes: 'Launched 1974, the oldest active amateur satellite — only transmits in direct sunlight, its batteries died decades ago.',
  },
  {
    noradId: 24278,
    name: 'FO-29',
    mode: 'SSB/CW Linear',
    uplink: '145.900–146.000 MHz',
    downlink: '435.800–435.900 MHz',
    notes: 'Inverting transponder — uplink + downlink frequency always sums to 581.800 MHz.',
  },
  {
    noradId: 44909,
    name: 'RS-44',
    mode: 'SSB/CW Linear',
    uplink: '435.130–435.150 MHz (LSB)',
    downlink: '145.950–145.970 MHz (USB)',
    notes: 'Inverting transponder, consistently well-reported signal reports.',
  },
];
const insertSat = db.query(
  `INSERT OR IGNORE INTO satellites (norad_id, name, mode, uplink, downlink, notes) VALUES (?, ?, ?, ?, ?, ?)`,
);
for (const sat of SEED_SATELLITES) {
  insertSat.run(sat.noradId, sat.name, sat.mode, sat.uplink, sat.downlink, sat.notes);
}

const existingColumns = new Set(
  (db.query('PRAGMA table_info(qsos)').all() as { name: string }[]).map((c) => c.name),
);
for (const [name, type] of [
  ['lat', 'REAL'],
  ['lon', 'REAL'],
  ['my_lat', 'REAL'],
  ['my_lon', 'REAL'],
  ['my_gridsquare', 'TEXT'],
  ['state', 'TEXT'],
  ['continent', 'TEXT'],
  ['cqz', 'TEXT'],
  ['cnty', 'TEXT'],
  ['iota', 'TEXT'],
  ['eqsl_qsl_rcvd', 'TEXT'],
  ['eqsl_qsl_rcvd_date', 'TEXT'],
] as const) {
  if (!existingColumns.has(name)) {
    db.exec(`ALTER TABLE qsos ADD COLUMN ${name} ${type}`);
  }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_qsos_band ON qsos(band)');
db.exec('CREATE INDEX IF NOT EXISTS idx_qsos_qso_date ON qsos(qso_date)');
db.exec('CREATE INDEX IF NOT EXISTS idx_qsos_country ON qsos(country)');
db.exec('CREATE INDEX IF NOT EXISTS idx_qsos_state ON qsos(state)');
db.exec('CREATE INDEX IF NOT EXISTS idx_qsos_cnty ON qsos(cnty)');
db.exec('CREATE INDEX IF NOT EXISTS idx_qsos_iota ON qsos(iota)');
db.exec('CREATE INDEX IF NOT EXISTS idx_qsos_continent ON qsos(continent)');
db.exec('CREATE INDEX IF NOT EXISTS idx_qsos_cqz ON qsos(cqz)');
// `mode` is one of the 4 primary log/map filter dimensions (band/mode/
// country/state) alongside the indexed ones above -- was the one missing
// index, meaning a modes=FT8-only filter forced a full-table scan.
db.exec('CREATE INDEX IF NOT EXISTS idx_qsos_mode ON qsos(mode)');
db.exec('CREATE INDEX IF NOT EXISTS idx_qsos_gridsquare ON qsos(gridsquare)');
// Both used by /qsos/unconfirmed's OR-based WHERE clause -- SQLite can use
// an index per OR branch (the "OR optimization") even though it can't use
// a single composite index across both, so each column still gets indexed
// individually.
db.exec('CREATE INDEX IF NOT EXISTS idx_qsos_lotw_qsl_rcvd ON qsos(lotw_qsl_rcvd)');
db.exec('CREATE INDEX IF NOT EXISTS idx_qsos_eqsl_qsl_rcvd ON qsos(eqsl_qsl_rcvd)');
// Expression index matching /qsos/oqrs-matches' `o.call = UPPER(q.call)`
// join exactly -- without this, wrapping q.call in UPPER() at query time
// meant SQLite couldn't use the plain call index and had to compute
// UPPER() per row during a full scan.
db.exec('CREATE INDEX IF NOT EXISTS idx_qsos_call_upper ON qsos(UPPER(call))');

// Whether a resized thumbnail exists for this photo (thumbs/<filename>,
// generated at upload time going forward) -- existing photos uploaded
// before thumbnailing existed default to 0 until backfill-photo-
// thumbnails.ts runs once, and GET /api/photos falls back to the full-size
// URL for any row still at 0.
const photoColumns = new Set((db.query('PRAGMA table_info(photos)').all() as { name: string }[]).map((c) => c.name));
if (!photoColumns.has('has_thumbnail')) {
  db.exec('ALTER TABLE photos ADD COLUMN has_thumbnail INTEGER NOT NULL DEFAULT 0');
}

// station_location started with lat/lon as NOT NULL and no callsign column
// -- SQLite can't drop a NOT NULL constraint with a plain ALTER TABLE, so an
// existing table with the old shape gets rebuilt (copy into a fresh table
// with the new schema, drop the old one, rename). Only ever at most one row
// on this table, so this is cheap regardless of when it runs.
{
  const stationLocationInfo = db.query('PRAGMA table_info(station_location)').all() as { name: string; notnull: number }[];
  const latCol = stationLocationInfo.find((c) => c.name === 'lat');
  const needsRebuild = stationLocationInfo.length > 0 && (latCol?.notnull === 1 || !stationLocationInfo.some((c) => c.name === 'callsign'));
  if (needsRebuild) {
    db.exec(`
      CREATE TABLE station_location_new (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        callsign TEXT,
        label TEXT,
        lat REAL,
        lon REAL,
        grid TEXT
      );
      INSERT INTO station_location_new (id, label, lat, lon, grid)
        SELECT id, label, lat, lon, grid FROM station_location;
      DROP TABLE station_location;
      ALTER TABLE station_location_new RENAME TO station_location;
    `);
  }
}

// ntfy.sh push-notification alert channel, added alongside the original
// email-only alert_email_config table -- same incremental-column pattern as
// qsos above, since that table already exists on the live Pi.
const alertConfigColumns = new Set(
  (db.query('PRAGMA table_info(alert_email_config)').all() as { name: string }[]).map((c) => c.name),
);
for (const [name, type] of [
  ['ntfy_topic', 'TEXT'],
  ['ntfy_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  // Independent of email/ntfy channel enablement (those mean "is this
  // channel active for alerts at all") -- this is a separate trigger, off
  // by default, for the VHF/Sporadic-E band-opening check reusing whichever
  // channel(s) are already enabled.
  ['vhf_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  // Same independent-trigger pattern as vhf_enabled, for the X-class solar
  // flare alert.
  ['flare_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['wind_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  // Filters the Needed-DX spot check to only alert on spots posted by a
  // US-based spotter (United States/Alaska/Hawaii) -- a spot from a
  // Russian or Japanese spotter doesn't say much about whether the station
  // is workable from here, since propagation is directional. Defaults on
  // (1) since that's the behavior actually wanted; a checkbox on
  // /admin turns it off to see every needed spot regardless of who posted it.
  ['dx_us_spotters_only', 'INTEGER NOT NULL DEFAULT 1'],
  // Same idea as dx_us_spotters_only, independent toggle -- a US-based
  // spotter on 6m/2m is a much better sign of a Sporadic-E opening actually
  // reachable from here than a European or Asian one, so the same filter
  // applies, but kept as its own setting rather than sharing the Needed-DX
  // one since a user might reasonably want them set differently (VHF spots
  // are rare enough that seeing every one regardless of spotter could still
  // be worth it even with the DX-spot feed filtered to US-only).
  ['vhf_us_spotters_only', 'INTEGER NOT NULL DEFAULT 1'],
  // Same independent-trigger pattern as flare_enabled/wind_enabled, for the
  // geomagnetic-storm (Kp-index/aurora) alert.
  ['kp_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  // Same independent-trigger pattern, for the tropospheric ducting alert.
  ['tropo_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  // Same independent-trigger pattern, for the satellite-pass alert.
  ['sat_pass_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  // Same independent-trigger pattern, for the nearby-lightning alert --
  // also requires lightning_monitoring.enabled to be on, same relationship
  // radio's alert-worthy features have to radio_monitoring.enabled.
  ['lightning_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  // Same independent-trigger pattern, for the "a needed DXCC entity just
  // got confirmed" alert -- see alerted_dxcc_confirmations' own comment
  // for the baseline-seeding this relies on.
  ['dxcc_confirmed_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  // Unlike every other flag in this list, this one gates a scheduled
  // digest, not a threshold-triggered alert -- it always sends on its
  // weekly schedule once turned on, even in a quiet week with nothing new
  // to report. See scripts/send-dx-digest.ts.
  ['dx_digest_enabled', 'INTEGER NOT NULL DEFAULT 0'],
] as const) {
  if (!alertConfigColumns.has(name)) {
    db.exec(`ALTER TABLE alert_email_config ADD COLUMN ${name} ${type}`);
  }
}

// One row per satellite pass already alerted on, so the every-5-minutes
// checker (which sees the same upcoming pass across many runs before it
// actually happens) doesn't re-notify for it every time it runs.
db.exec(`
  CREATE TABLE IF NOT EXISTS alerted_satellite_passes (
    norad_id INTEGER NOT NULL,
    aos_time TEXT NOT NULL,
    alerted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (norad_id, aos_time)
  );
`);

// Whether the /kiwisdr page shows its content at all -- defaults ON (unlike
// radio_monitoring's control_visible, which defaults off for an
// unfinished feature): this one's already live and working by the time
// this toggle was added, so the default shouldn't silently take it away.
db.exec(`
  CREATE TABLE IF NOT EXISTS kiwisdr_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 1
  );

  -- Public guestbook. Entries start unapproved (approved=0) -- this is the
  -- first feature on the site where an anonymous visitor can write
  -- persistent content anyone else will see, so unlike everything else
  -- public here, it gets a moderation queue rather than publishing
  -- immediately. See guestbook.ts for the submission-side rate limiting.
  CREATE TABLE IF NOT EXISTS guestbook_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    callsign TEXT,
    message TEXT NOT NULL,
    submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
    approved INTEGER NOT NULL DEFAULT 0
  );

  -- Whether the persistent Blitzortung lightning-strike MQTT connection
  -- should be running at all -- same off-by-default, admin-toggled,
  -- restart-persisted shape as radio_monitoring (see that table's own
  -- comment). This one holds no credentials and needs no hardware, but the
  -- always-on background connection is the same kind of thing: opt-in, not
  -- something that should just start running the moment the code ships.
  CREATE TABLE IF NOT EXISTS lightning_monitoring (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0
  );

  -- One row per DXCC entity we've already told the operator about being
  -- LoTW-confirmed -- seeded with every already-confirmed entity the
  -- moment the alert is turned on (see dxccConfirmedAlert.ts's
  -- seedDxccConfirmationBaseline()), so enabling this doesn't immediately
  -- fire off 200+ emails for entities confirmed years ago. Only entities
  -- that cross into "confirmed" AFTER that baseline ever get alerted.
  CREATE TABLE IF NOT EXISTS alerted_dxcc_confirmations (
    entity TEXT PRIMARY KEY,
    alerted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Site-wide display preferences -- currently just the one, but a
  -- dedicated table (not folded into service_credentials, which is
  -- specifically external-service config) leaves room for more later
  -- without another migration-shaped decision. distance_unit defaults
  -- 'mi' -- this station's own preference, not a neutral default.
  CREATE TABLE IF NOT EXISTS site_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    distance_unit TEXT NOT NULL DEFAULT 'mi'
  );
`);

// LoTW login, added alongside the original QRZ/eQSL columns -- same
// incremental-column pattern, since service_credentials already exists on
// the live Pi.
const serviceCredColumns = new Set(
  (db.query('PRAGMA table_info(service_credentials)').all() as { name: string }[]).map((c) => c.name),
);
for (const [name, type] of [
  ['lotw_username', 'TEXT'],
  ['lotw_password', 'TEXT'],
  // FlexRadio's LAN IP -- same "editable from /admin instead of shell
  // access" reasoning as everything else in this table, falls back to the
  // older FLEX_RADIO_IP .env var (see flexRadio.ts) when unset. Not a
  // secret like the fields above, but lives here rather than a dedicated
  // table since it's the same category of thing: external-service access
  // config editable from one admin form.
  ['flex_radio_ip', 'TEXT'],
  // Open Repeater API key (openrepeater.org, free self-service registration,
  // CC0-licensed data) plus a lat/lng/radius search scope, for the
  // admin-only repeater-lookup feature -- switched from RepeaterBook after
  // finding their API requires per-application approval bound to a specific
  // registered User-Agent, which a self-service personal token can't supply.
  ['open_repeater_api_key', 'TEXT'],
  ['open_repeater_lat', 'REAL'],
  ['open_repeater_lng', 'REAL'],
  ['open_repeater_radius_km', 'REAL'],
  // HamQTH login (hamqth.com, free registration) for the public callsign
  // lookup tool on /tools -- HamQTH's XML API is session-based (login once,
  // reuse the session_id for lookups) rather than a static API key, but the
  // credentials themselves follow the exact same admin-configurable,
  // never-sent-to-the-browser pattern as everything else in this table.
  ['hamqth_username', 'TEXT'],
  ['hamqth_password', 'TEXT'],
  // Comma-separated DMR talkgroup IDs to watch for the DMR Last Heard panel
  // on /radio -- no API key needed (BrandMeister's live-activity feed is a
  // public, unauthenticated Socket.IO stream, see brandmeister.ts), just
  // which talkgroup(s) to filter it down to.
  ['brandmeister_talkgroups', 'TEXT'],
  // KiwiSDR's LAN address ("host:port", port defaults to 8073 if omitted) --
  // same "editable from /admin instead of shell access" reasoning as
  // flex_radio_ip. No credentials needed alongside it: unlike every other
  // row in this table, the KiwiSDR protocol itself carries its own
  // (optional) connect password inline in the SET auth command, and this
  // station's Kiwi has none set, so there's nothing else to store here.
  ['kiwisdr_host', 'TEXT'],
] as const) {
  if (!serviceCredColumns.has(name)) {
    db.exec(`ALTER TABLE service_credentials ADD COLUMN ${name} ${type}`);
  }
}

// One-time cleanup of the RepeaterBook columns above -- added and retired in
// the same session before any real data was ever stored in them.
for (const name of ['repeaterbook_token', 'repeaterbook_state', 'repeaterbook_county', 'repeaterbook_contact_email']) {
  if (serviceCredColumns.has(name)) {
    db.exec(`ALTER TABLE service_credentials DROP COLUMN ${name}`);
  }
}

// `last_run_at` on each *_sync_state table: a plain ISO timestamp set at the
// end of every sync run (full or incremental), purely for showing "last
// synced" in the UI. Deliberately separate from each table's existing
// watermark column (`last_synced_date`/`last_synced_at`) -- those are in
// whatever format the remote API itself needs (QRZ/LoTW: date-only; eQSL:
// its own RcvdSince YYYYMMDDHHMM), not necessarily a clean displayable
// datetime, and repurposing them for display risked touching the
// already-working incremental-fetch logic that reads them.
for (const table of ['qrz_sync_state', 'lotw_sync_state', 'eqsl_sync_state']) {
  const cols = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('last_run_at')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN last_run_at TEXT`);
  }
}

// Whether the Remote Control (Receive Only) card on /radio is shown at all
// -- separate from radio_monitoring.enabled (which only pauses/resumes the
// live-status connection, not this specific admin feature's visibility).
// Defaults off: the feature isn't considered finished yet, so it starts
// hidden site-wide until explicitly turned back on from /admin.
const radioMonitoringColumns = new Set((db.query('PRAGMA table_info(radio_monitoring)').all() as { name: string }[]).map((c) => c.name));
if (!radioMonitoringColumns.has('control_visible')) {
  db.exec('ALTER TABLE radio_monitoring ADD COLUMN control_visible INTEGER NOT NULL DEFAULT 0');
}
// Whether the entire FlexRadio hardware-status section on /radio (the
// Monitor toggle, On the Air card, meters, Recent Sessions) is shown at
// all -- for an installer of this codebase who doesn't own a FlexRadio.
// Defaults ON (1), unlike control_visible above -- this site's own owner
// already has a working radio and uses this section today, so a fresh
// migration shouldn't hide something currently in use; a future installer
// without a radio can turn it off from /admin instead of needing to edit
// FLEX_RADIO_IP out of .env by hand. PSK Reporter/WSPR/RBN reception
// reports are deliberately NOT covered by this flag -- they're
// independent external data, not a connection to this station's own
// radio, and stay useful even with no FlexRadio at all.
if (!radioMonitoringColumns.has('hardware_visible')) {
  db.exec('ALTER TABLE radio_monitoring ADD COLUMN hardware_visible INTEGER NOT NULL DEFAULT 1');
}
