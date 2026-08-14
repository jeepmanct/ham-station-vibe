import { Hono } from 'hono';
import { db } from '../db';
import { DXCC_ENTITIES, resolveWorkedEntities } from '../dxccEntities';
import { getDxccEntityLocation } from '../dxccPrefixes';
import { ADIF_DXCC_CODE_TO_ENTITY } from '../data/adifDxccCodes';
import { wpxPrefix } from '../wpx';
import { ttlCached } from '../ttlCache';

export const awardsRoutes = new Hono();

// Award standings only change when new QSOs are synced (a few times a day
// at most), but this computation runs ~15 GROUP BY queries plus a
// full-table WPX scan -- the single most expensive handler in the app.
// Cached per `band` filter value (a small, bounded set) rather than
// per-request.
const AWARDS_CACHE_TTL_MS = 5 * 60 * 1000;

const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

// The classic ARRL Worked All Continents award covers these 6 — Antarctica (AN)
// isn't one of them, but we still surface it separately as a fun "bonus" fact.
const WAC_CONTINENTS: Record<string, string> = {
  NA: 'North America', SA: 'South America', EU: 'Europe', AF: 'Africa', AS: 'Asia', OC: 'Oceania',
};

// Canonical low-to-high band order for display — LoTW's own band-endorsement
// list follows this order, not alphabetical (which would put "10M" after "160M").
const BAND_ORDER = [
  '160M', '80M', '75M', '60M', '40M', '30M', '20M', '17M', '15M', '12M', '10M',
  '6M', '4M', '2M', '1.25M', '70CM', '33CM', '23CM',
];
function bandRank(band: string): number {
  const i = BAND_ORDER.indexOf(band);
  return i === -1 ? BAND_ORDER.length : i;
}

async function computeAwards(band: string | null) {
  const bandClause = band ? 'AND band = ?' : '';
  const bandParams = band ? [band] : [];

  const dxccRows = db
    .query(
      `SELECT country, COUNT(*) as qsoCount, MIN(qso_date) as firstWorked,
              MAX(CASE WHEN lotw_qsl_rcvd = 'Y' THEN 1 ELSE 0 END) as confirmed
       FROM qsos WHERE country IS NOT NULL ${bandClause} GROUP BY country ORDER BY country ASC`,
    )
    .all(...bandParams) as { country: string; qsoCount: number; firstWorked: string; confirmed: number }[];

  const stateRows = db
    .query(
      `SELECT state, COUNT(*) as qsoCount, MAX(CASE WHEN lotw_qsl_rcvd = 'Y' THEN 1 ELSE 0 END) as confirmed
       FROM qsos WHERE state IS NOT NULL ${bandClause} GROUP BY state`,
    )
    .all(...bandParams) as { state: string; qsoCount: number; confirmed: number }[];
  const stateByCode = new Map(stateRows.map((r) => [r.state, r]));

  const contRows = db
    .query(
      `SELECT continent, COUNT(*) as qsoCount, MAX(CASE WHEN lotw_qsl_rcvd = 'Y' THEN 1 ELSE 0 END) as confirmed
       FROM qsos WHERE continent IS NOT NULL ${bandClause} GROUP BY continent`,
    )
    .all(...bandParams) as { continent: string; qsoCount: number; confirmed: number }[];
  const contByCode = new Map(contRows.map((r) => [r.continent, r]));

  const gridRows = db
    .query(
      `SELECT SUBSTR(gridsquare, 1, 4) as grid, COUNT(*) as qsoCount,
              MAX(CASE WHEN lotw_qsl_rcvd = 'Y' THEN 1 ELSE 0 END) as confirmed
       FROM qsos WHERE gridsquare IS NOT NULL AND LENGTH(gridsquare) >= 4 ${bandClause}
       GROUP BY grid ORDER BY grid ASC`,
    )
    .all(...bandParams) as { grid: string; qsoCount: number; confirmed: number }[];

  // Per-band DXCC standings — this is what LoTW actually issues single-band DXCC
  // endorsements against (100 confirmed entities on that one band). Always
  // computed across every band, independent of the `band` filter above, so the
  // page can show "which single-band DXCC awards have I earned" regardless of
  // whatever band the rest of the page is currently filtered to.
  const bandDxccRows = db
    .query(
      `SELECT band, COUNT(DISTINCT country) as worked,
              COUNT(DISTINCT CASE WHEN lotw_qsl_rcvd = 'Y' THEN country END) as confirmed
       FROM qsos WHERE band IS NOT NULL AND country IS NOT NULL GROUP BY band`,
    )
    .all() as { band: string; worked: number; confirmed: number }[];
  const bandDxcc = bandDxccRows
    .map((r) => ({ band: r.band, worked: r.worked, confirmed: r.confirmed, achieved: r.confirmed >= 100 }))
    .sort((a, b) => bandRank(a.band) - bandRank(b.band));

  const bandRows = db
    .query('SELECT DISTINCT band FROM qsos WHERE band IS NOT NULL')
    .all() as { band: string }[];
  const bands = bandRows.map((r) => r.band).sort((a, b) => bandRank(a) - bandRank(b));

  // WAS by band — LoTW's single-band WAS endorsement needs 50 confirmed states on that band.
  const bandWasRows = db
    .query(
      `SELECT band, COUNT(DISTINCT state) as worked,
              COUNT(DISTINCT CASE WHEN lotw_qsl_rcvd = 'Y' THEN state END) as confirmed
       FROM qsos WHERE band IS NOT NULL AND state IS NOT NULL GROUP BY band`,
    )
    .all() as { band: string; worked: number; confirmed: number }[];
  const bandWas = bandWasRows
    .map((r) => ({ band: r.band, worked: r.worked, confirmed: r.confirmed, achieved: r.confirmed >= 50 }))
    .sort((a, b) => bandRank(a.band) - bandRank(b.band));

  // VUCC by band — real thresholds vary a lot by band (100 grids on 6M/2M down
  // to as few as 5 on some microwave bands), so we just show counts, no
  // achieved flag, rather than guess a threshold per band.
  const bandVuccRows = db
    .query(
      `SELECT band, COUNT(DISTINCT SUBSTR(gridsquare, 1, 4)) as worked,
              COUNT(DISTINCT CASE WHEN lotw_qsl_rcvd = 'Y' THEN SUBSTR(gridsquare, 1, 4) END) as confirmed
       FROM qsos WHERE band IS NOT NULL AND gridsquare IS NOT NULL AND LENGTH(gridsquare) >= 4
       GROUP BY band`,
    )
    .all() as { band: string; worked: number; confirmed: number }[];
  const bandVucc = bandVuccRows
    .map((r) => ({ band: r.band, worked: r.worked, confirmed: r.confirmed }))
    .sort((a, b) => bandRank(a.band) - bandRank(b.band));

  // DXCC by mode category — not an official ARRL/LoTW award name (unlike the
  // real "Triple Play WAS"), just a useful breakdown of DXCC progress by
  // Phone/CW/Digital, using the log's own mode field bucketed into the three
  // usual categories.
  const modeRows = db
    .query(
      `SELECT
         CASE WHEN mode IN ('SSB','USB','LSB','AM','FM') THEN 'Phone'
              WHEN mode = 'CW' THEN 'CW'
              ELSE 'Digital' END as category,
         country,
         MAX(CASE WHEN lotw_qsl_rcvd = 'Y' THEN 1 ELSE 0 END) as confirmed
       FROM qsos WHERE country IS NOT NULL AND mode IS NOT NULL
       GROUP BY category, country`,
    )
    .all() as { category: string; country: string; confirmed: number }[];
  const dxccByMode = ['Phone', 'CW', 'Digital'].map((category) => {
    const rows = modeRows.filter((r) => r.category === category);
    return { category, worked: rows.length, confirmed: rows.filter((r) => r.confirmed === 1).length };
  });

  // WAZ — CQ zones 1-40, from the qsos.cqz column (backfilled from ADIF's CQZ
  // field, the actual worked station's zone — more accurate than deriving it
  // from country, since some entities span multiple zones).
  const zoneRows = db
    .query(
      `SELECT cqz, COUNT(*) as qsoCount, MAX(CASE WHEN lotw_qsl_rcvd = 'Y' THEN 1 ELSE 0 END) as confirmed
       FROM qsos WHERE cqz IS NOT NULL GROUP BY cqz`,
    )
    .all() as { cqz: string; qsoCount: number; confirmed: number }[];
  const zoneByNum = new Map(zoneRows.map((r) => [Number(r.cqz), r]));
  const zones = Array.from({ length: 40 }, (_, i) => i + 1).map((zone) => {
    const row = zoneByNum.get(zone);
    return { zone, worked: !!row, confirmed: row?.confirmed === 1, qsoCount: row?.qsoCount ?? 0 };
  });

  // Most-wanted DXCC — the full cty.dat entity universe minus whatever the log
  // already resolves to a worked entity (see dxccEntities.ts for the name
  // reconciliation between QRZ's country strings and cty.dat's own naming).
  // Sorted by Club Log's real global demand ranking when available (rarest
  // first) via adifDxccCodes.ts's ADIF-code translation, falling back to
  // alphabetical for any entity Club Log doesn't rank or that code-mapping
  // couldn't resolve (e.g. Turkey, see that file's comment) -- unranked
  // entities are pushed to the end rather than mixed in, since an
  // alphabetical position would misleadingly look like a real rank.
  const allWorkedCountryRows = db
    .query('SELECT DISTINCT country FROM qsos WHERE country IS NOT NULL')
    .all() as { country: string }[];
  const resolvedWorked = resolveWorkedEntities(allWorkedCountryRows.map((r) => r.country));
  const rankRows = db.query('SELECT adif_code, rank FROM clublog_most_wanted').all() as {
    adif_code: number;
    rank: number;
  }[];
  const rankByEntity = new Map<string, number>();
  for (const row of rankRows) {
    const entity = ADIF_DXCC_CODE_TO_ENTITY[row.adif_code];
    if (entity) rankByEntity.set(entity, row.rank);
  }
  const mostWanted = DXCC_ENTITIES.filter((e) => !resolvedWorked.has(e.name))
    .map((e) => ({ name: e.name, cqZone: e.cqZone, continent: e.continent, rank: rankByEntity.get(e.name) ?? null }))
    .sort((a, b) => {
      if (a.rank != null && b.rank != null) return a.rank - b.rank;
      if (a.rank != null) return -1;
      if (b.rank != null) return 1;
      return a.name.localeCompare(b.name);
    });

  // WPX (Worked All Prefixes) — prefix isn't a column, so this walks every
  // call once in JS (see wpx.ts for the extraction rules/caveats).
  const wpxRows = db.query('SELECT call, qso_date, lotw_qsl_rcvd FROM qsos').all() as {
    call: string;
    qso_date: string;
    lotw_qsl_rcvd: string | null;
  }[];
  const wpxMap = new Map<string, { count: number; confirmed: boolean; firstWorked: string }>();
  for (const row of wpxRows) {
    const prefix = wpxPrefix(row.call);
    const entry = wpxMap.get(prefix) ?? { count: 0, confirmed: false, firstWorked: row.qso_date };
    entry.count++;
    if (row.lotw_qsl_rcvd === 'Y') entry.confirmed = true;
    if (row.qso_date < entry.firstWorked) entry.firstWorked = row.qso_date;
    wpxMap.set(prefix, entry);
  }
  const wpxPrefixes = Array.from(wpxMap.entries())
    .map(([prefix, e]) => ({ prefix, qsoCount: e.count, confirmed: e.confirmed, firstWorked: e.firstWorked }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
  const WPX_TIERS = [100, 200, 300, 500, 750, 1000, 1500, 2000, 2500, 3000];
  const wpxConfirmedCount = wpxPrefixes.filter((p) => p.confirmed).length;
  const wpxTier = WPX_TIERS.filter((t) => wpxConfirmedCount >= t).pop() ?? null;
  const wpxNextTier = WPX_TIERS.find((t) => wpxConfirmedCount < t) ?? null;

  // Triple Play WAS — the real ARRL award: all 50 states confirmed on each
  // of Phone, CW, and Digital. Independent of the band filter/mode-category
  // caveat above (this one IS an official award name).
  const triplePlayRows = db
    .query(
      `SELECT state,
              MAX(CASE WHEN mode IN ('SSB','USB','LSB','AM','FM') AND lotw_qsl_rcvd = 'Y' THEN 1 ELSE 0 END) as phone,
              MAX(CASE WHEN mode = 'CW' AND lotw_qsl_rcvd = 'Y' THEN 1 ELSE 0 END) as cw,
              MAX(CASE WHEN mode NOT IN ('SSB','USB','LSB','AM','FM','CW') AND lotw_qsl_rcvd = 'Y' THEN 1 ELSE 0 END) as digital
       FROM qsos WHERE state IS NOT NULL AND mode IS NOT NULL GROUP BY state`,
    )
    .all() as { state: string; phone: number; cw: number; digital: number }[];
  const triplePlay = {
    phone: triplePlayRows.filter((r) => r.phone === 1).length,
    cw: triplePlayRows.filter((r) => r.cw === 1).length,
    digital: triplePlayRows.filter((r) => r.digital === 1).length,
  };

  // USA Counties (USA-CA) — county-hunting award. The "official" total county
  // count varies by source/convention (~3,077 in the traditional county-hunting
  // count vs. 3,143 per the current US Census list), so rather than assert a
  // specific denominator, this uses the same open-ended tier-milestone
  // approach as WPX below.
  const cntyRows = db
    .query(
      `SELECT cnty, COUNT(*) as qsoCount, MAX(CASE WHEN lotw_qsl_rcvd = 'Y' THEN 1 ELSE 0 END) as confirmed,
              MIN(qso_date) as firstWorked
       FROM qsos WHERE cnty IS NOT NULL GROUP BY cnty`,
    )
    .all() as { cnty: string; qsoCount: number; confirmed: number; firstWorked: string }[];
  const counties = cntyRows
    .map((r) => ({ cnty: r.cnty, qsoCount: r.qsoCount, confirmed: r.confirmed === 1, firstWorked: r.firstWorked }))
    .sort((a, b) => a.cnty.localeCompare(b.cnty));
  const COUNTY_TIERS = [100, 250, 500, 750, 1000, 1500, 2000, 2500, 3000];
  const countyConfirmedCount = counties.filter((c) => c.confirmed).length;
  const countyTier = COUNTY_TIERS.filter((t) => countyConfirmedCount >= t).pop() ?? null;
  const countyNextTier = COUNTY_TIERS.find((t) => countyConfirmedCount < t) ?? null;

  // IOTA (Islands on the Air) — the ADIF field is already the official RSGB
  // reference code (e.g. "NA-027"), so no name-reconciliation is needed here
  // the way DXCC required. Same open-ended tier approach.
  const iotaRows = db
    .query(
      `SELECT iota, COUNT(*) as qsoCount, MAX(CASE WHEN lotw_qsl_rcvd = 'Y' THEN 1 ELSE 0 END) as confirmed,
              MIN(qso_date) as firstWorked
       FROM qsos WHERE iota IS NOT NULL GROUP BY iota`,
    )
    .all() as { iota: string; qsoCount: number; confirmed: number; firstWorked: string }[];
  const iotaGroups = iotaRows
    .map((r) => ({ iota: r.iota, qsoCount: r.qsoCount, confirmed: r.confirmed === 1, firstWorked: r.firstWorked }))
    .sort((a, b) => a.iota.localeCompare(b.iota));
  const IOTA_TIERS = [25, 50, 100, 250, 500, 750, 1000];
  const iotaConfirmedCount = iotaGroups.filter((i) => i.confirmed).length;
  const iotaTier = IOTA_TIERS.filter((t) => iotaConfirmedCount >= t).pop() ?? null;
  const iotaNextTier = IOTA_TIERS.find((t) => iotaConfirmedCount < t) ?? null;

  const states = Object.entries(US_STATES).map(([code, name]) => {
    const row = stateByCode.get(code);
    return { code, name, worked: !!row, confirmed: row?.confirmed === 1, qsoCount: row?.qsoCount ?? 0 };
  });

  const continents = Object.entries(WAC_CONTINENTS).map(([code, name]) => {
    const row = contByCode.get(code);
    return { code, name, worked: !!row, confirmed: row?.confirmed === 1, qsoCount: row?.qsoCount ?? 0 };
  });
  const antarctica = contByCode.get('AN');

  return {
    band,
    bands,
    bandDxcc,
    bandWas,
    bandVucc,
    dxccByMode,
    waz: {
      worked: zones.filter((z) => z.worked).length,
      confirmed: zones.filter((z) => z.confirmed).length,
      zones,
    },
    mostWanted,
    wpx: {
      worked: wpxPrefixes.length,
      confirmed: wpxConfirmedCount,
      tier: wpxTier,
      nextTier: wpxNextTier,
      prefixes: wpxPrefixes,
    },
    triplePlay,
    usaCounties: {
      worked: counties.length,
      confirmed: countyConfirmedCount,
      tier: countyTier,
      nextTier: countyNextTier,
      counties,
    },
    iota: {
      worked: iotaGroups.length,
      confirmed: iotaConfirmedCount,
      tier: iotaTier,
      nextTier: iotaNextTier,
      groups: iotaGroups,
    },
    dxcc: {
      worked: dxccRows.length,
      confirmed: dxccRows.filter((r) => r.confirmed === 1).length,
      entities: dxccRows.map((r) => ({
        country: r.country,
        qsoCount: r.qsoCount,
        firstWorked: r.firstWorked,
        confirmed: r.confirmed === 1,
      })),
    },
    was: {
      worked: states.filter((s) => s.worked).length,
      confirmed: states.filter((s) => s.confirmed).length,
      states,
    },
    wac: {
      worked: continents.filter((cc) => cc.worked).length,
      confirmed: continents.filter((cc) => cc.confirmed).length,
      continents,
      antarctica: antarctica ? { worked: true, confirmed: antarctica.confirmed === 1, qsoCount: antarctica.qsoCount } : null,
    },
    vucc: {
      worked: gridRows.length,
      confirmed: gridRows.filter((r) => r.confirmed === 1).length,
      grids: gridRows.map((r) => ({ grid: r.grid, qsoCount: r.qsoCount, confirmed: r.confirmed === 1 })),
    },
  };
}

awardsRoutes.get('/', async (c) => {
  const band = c.req.query('band')?.trim() || null;
  const result = await ttlCached(`awards:${band ?? 'all'}`, AWARDS_CACHE_TTL_MS, () => computeAwards(band))();
  c.header('Cache-Control', 'no-store');
  return c.json(result);
});

// One marker per DXCC entity: worked ones positioned at the average lat/lon
// of their own QSOs (a real, specific position beats a generic reference
// point when we actually have contacts to average); never-worked ("needed")
// ones positioned at cty.dat's own per-entity reference coordinate instead,
// via getDxccEntityLocation() -- there's no QSO to average for those, but
// cty.dat's header-line coordinate is a reasonable stand-in (this used to
// be genuinely unavailable, per the comment history here, until
// dxccPrefixes.ts started exposing it). Needed entities always get
// qsoCount: 0, confirmed: false -- the frontend uses `worked` to tell them
// apart from a worked-but-unconfirmed entity, which also has confirmed:
// false.
awardsRoutes.get('/dxcc-map', (c) => {
  const workedRows = db
    .query(
      `SELECT country, AVG(lat) as lat, AVG(lon) as lon, COUNT(*) as qsoCount,
              MAX(CASE WHEN lotw_qsl_rcvd = 'Y' OR eqsl_qsl_rcvd = 'Y' THEN 1 ELSE 0 END) as confirmed
       FROM qsos
       WHERE country IS NOT NULL AND lat IS NOT NULL AND lon IS NOT NULL
       GROUP BY country`,
    )
    .all() as { country: string; lat: number; lon: number; qsoCount: number; confirmed: number }[];

  const worked = workedRows.map((r) => ({
    country: r.country,
    lat: r.lat,
    lon: r.lon,
    qsoCount: r.qsoCount,
    confirmed: r.confirmed === 1,
    worked: true,
  }));

  const allWorkedCountryRows = db.query('SELECT DISTINCT country FROM qsos WHERE country IS NOT NULL').all() as { country: string }[];
  const resolvedWorked = resolveWorkedEntities(allWorkedCountryRows.map((r) => r.country));
  const needed = DXCC_ENTITIES.filter((e) => !resolvedWorked.has(e.name))
    .map((e) => {
      const loc = getDxccEntityLocation(e.name);
      return loc ? { country: e.name, lat: loc.lat, lon: loc.lon, qsoCount: 0, confirmed: false, worked: false } : null;
    })
    .filter((e) => e !== null);

  c.header('Cache-Control', 'no-store');
  return c.json([...worked, ...needed]);
});
