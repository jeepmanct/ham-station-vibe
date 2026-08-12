// Shared "have I worked this DXCC entity" logic for anything that needs to
// flag a *specific callsign or entity name* against the log — live DX spots
// and the announced-DXpedition calendar. Both resolve via callsign prefix
// (dxccPrefixes.ts) rather than the log's own qsos.country strings, and
// deliberately resolve the WORKED side the same way (every distinct worked
// call run through the same resolver) rather than mixing methods — using
// qsos.country for one side and prefix-resolution for the other would create
// false "needed" claims wherever the two disagree (e.g. an IT9 contact
// logged with country "Italy" is really the separate "Sicily" entity by
// prefix — comparing consistently avoids surfacing that kind of mismatch as
// a false gap).
import { db } from './db';
import { resolveCallsignEntity } from './dxccPrefixes';
import { DXCC_ENTITIES } from './dxccEntities';

const ENTITY_NAMES = new Set(DXCC_ENTITIES.map((e) => e.name));

let cache: { set: Set<string>; at: number } | null = null;
const CACHE_MS = 5 * 60 * 1000;

/** Every DXCC entity worked, resolved from the log's distinct callsigns (not the country field). */
export function workedEntitiesByCallsign(): Set<string> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.set;
  const rows = db.query('SELECT DISTINCT call FROM qsos').all() as { call: string }[];
  const set = new Set<string>();
  for (const r of rows) {
    const resolved = resolveCallsignEntity(r.call);
    if (resolved) set.add(resolved.entity);
  }
  cache = { set, at: Date.now() };
  return set;
}

// ng3k.com's ADXO feed abbreviates entity names differently than cty.dat
// (our canonical list, shared with dxccEntities.ts's Most-Wanted card) — a
// handful of genuine one-offs plus a couple of general abbreviation patterns
// ("... Is" -> "... Islands", "St " -> "St. ", " and " -> " & ") cover every
// entity seen active/upcoming on the feed as of 2026-08-06. An unresolved
// name just gets no needed/worked badge rather than a guess.
const NG3K_ALIASES: Record<string, string> = {
  'Antigua': 'Antigua & Barbuda',
  'Christmas I': 'Christmas Island',
  'Dem Rep Congo': 'Dem. Rep. of the Congo',
  'Kosovo': 'Republic of Kosovo',
  'Lord Howe I': 'Lord Howe Island',
  'Marianas': 'Mariana Islands',
  'Peter I': 'Peter 1 Island',
  'Sao Tome and Principe I': 'Sao Tome & Principe',
};

export function normalizeNg3kEntity(raw: string): string | null {
  const trimmed = raw.trim();
  if (ENTITY_NAMES.has(trimmed)) return trimmed;
  if (NG3K_ALIASES[trimmed]) return NG3K_ALIASES[trimmed];
  const normalized = trimmed.replace(/\bSt /g, 'St. ').replace(/ and /g, ' & ').replace(/ Is$/, ' Islands');
  return ENTITY_NAMES.has(normalized) ? normalized : null;
}
