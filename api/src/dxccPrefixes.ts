// Callsign -> DXCC entity resolution via cty.dat's own prefix rules (the
// same file dxccEntities.ts's entity list was drawn from), used wherever we
// need to know a *specific callsign's* entity rather than just diffing a
// worked-country list (DX spot "needed" flagging, DXpedition-calendar
// cross-referencing, manual QSO logging's country auto-fill). Entity names
// match dxccEntities.ts/DXCC_ENTITIES exactly since both come from the same
// source file, so no alias table is needed here.
//
// Deliberately skips cty.dat's `=EXACTCALL(zone)[itu]` override entries —
// those mostly correct CQ/ITU zone for a specific station, not its DXCC
// entity, and the general prefix rule already gets the entity right for the
// overwhelming majority of calls. Same "pragmatic approximation, not a
// certified contest-scoring tool" tradeoff already made in wpx.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';

// lat/lon are cty.dat's own per-entity reference coordinate (roughly the
// entity's population center or a well-known reference station) -- not a
// specific station's real QTH, but a reasonable approximate fallback for
// plotting a QSO on the map when nothing more precise (an explicit
// LAT/LON, or a GRIDSQUARE) came with the record. See qsoImport.ts.
type PrefixEntry = { entity: string; continent: string; cqZone: number; lat: number; lon: number };

// Same slash-side classification wpx.ts uses (bare location prefix vs. full
// home callsign) — deliberately NOT reusing wpxPrefix() itself, since its
// extractRaw() truncates to a short WPX-style prefix (e.g. "RI1FJL" -> "RI1"),
// which throws away characters cty.dat sometimes needs for a correct match
// (Franz Josef Land's own prefix is the 4-char "RI1F", one longer than
// "RI1" — truncating first would silently misresolve it to Russia). Here we
// only need to pick the right side of a portable call; the longest-prefix
// match below does its own, unrestricted-length matching against the result.
const NON_LOCATING_SUFFIXES = new Set(['P', 'M', 'MM', 'AM', 'QRP', 'A']);
function isBarePrefix(part: string): boolean {
  const digitSuffix = part.match(/^(\d*[A-Z]+\d+)/);
  const raw = digitSuffix ? digitSuffix[1] : (part.match(/^(\d*[A-Z]+)/)?.[1] ?? part);
  return raw === part;
}
function classifyPart(part: string): 'bare' | 'full' | 'ignore' {
  if (NON_LOCATING_SUFFIXES.has(part)) return 'ignore';
  if (!/\d/.test(part) && part.length > 3) return 'ignore';
  return isBarePrefix(part) ? 'bare' : 'full';
}
function operatingCallPart(rawCall: string): string {
  const call = rawCall.toUpperCase().trim();
  const parts = call.split('/').filter(Boolean);
  if (parts.length === 1) return parts[0];
  const classified = parts.map((p) => ({ part: p, cls: classifyPart(p) }));
  // A purely-numeric bare part (W1AW/4) is a call-area substitution, not a
  // location change — DXCC entity is unaffected, so it's excluded here in
  // favor of matching against the full home callsign instead.
  const bare = classified.filter((c) => c.cls === 'bare' && !/^\d+$/.test(c.part));
  const full = classified.filter((c) => c.cls === 'full');
  if (bare.length === 1) return bare[0].part;
  if (full.length === 1) return full[0].part;
  return parts[0];
}

function parseCtyDat(raw: string): Map<string, PrefixEntry> {
  const prefixes = new Map<string, PrefixEntry>();
  const lines = raw.split('\n');
  // cty.dat's per-entity header: Name: CQ Zone: ITU Zone: Continent:
  // Latitude: Longitude: UTC offset: Primary Prefix: -- longitude is
  // stored as *positive = West* (the opposite of the usual positive =
  // East convention), negated below when read.
  const headerRe = /^(.+?):\s*(\d+):\s*\d+:\s*(\S+):\s*([\d.+-]+):\s*([\d.+-]+):\s*[\d.+-]+:\s*(\S+):$/;

  let entity: string | null = null;
  let continent = '';
  let cqZone = 0;
  let lat = 0;
  let lon = 0;
  let buffer = '';

  const flush = () => {
    if (!entity || !buffer) return;
    const tokens = buffer
      .replace(/;\s*$/, '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    for (const token of tokens) {
      if (token.startsWith('=')) continue; // exact-callsign override, not a prefix — skipped, see file header note
      const prefix = token.replace(/\(.*?\)|\[.*?\]|<.*?>/g, '').trim().toUpperCase();
      if (prefix && !prefixes.has(prefix)) prefixes.set(prefix, { entity, continent, cqZone, lat, lon });
    }
  };

  for (const rawLine of lines) {
    if (rawLine.trim() === '') continue;
    const isContinuation = /^\s/.test(rawLine);
    if (!isContinuation) {
      const header = headerRe.exec(rawLine.trim());
      if (header) {
        flush();
        entity = header[1].trim();
        cqZone = Number(header[2]);
        continent = header[3].trim();
        lat = Number(header[4]);
        lon = -Number(header[5]);
        buffer = '';
        continue;
      }
    }
    if (entity) buffer += rawLine.trim();
  }
  flush();

  return prefixes;
}

const PREFIX_TABLE = parseCtyDat(readFileSync(path.join(import.meta.dir, 'data', 'cty.dat'), 'utf-8'));

// One reference lat/lon per entity, deduped from PREFIX_TABLE's many
// prefix->entity rows (every prefix sharing an entity carries the exact
// same coordinate, since parseCtyDat() stamps it once per cty.dat header
// block and copies it onto each prefix token below it) -- first occurrence
// wins, arbitrarily, since they're identical anyway. Built once at module
// load, not per-call, since PREFIX_TABLE itself never changes at runtime.
const ENTITY_LOCATIONS = new Map<string, { lat: number; lon: number }>();
for (const entry of PREFIX_TABLE.values()) {
  if (!ENTITY_LOCATIONS.has(entry.entity)) ENTITY_LOCATIONS.set(entry.entity, { lat: entry.lat, lon: entry.lon });
}

/** cty.dat's reference coordinate for a DXCC entity (its own header line, not any specific station) -- used for entities with no logged QSO to derive a real position from, e.g. the "needed" markers on /awards' DXCC map. */
export function getDxccEntityLocation(entity: string): { lat: number; lon: number } | null {
  return ENTITY_LOCATIONS.get(entity) ?? null;
}

/**
 * Resolves a callsign to its DXCC entity name + continent via longest-prefix
 * match against cty.dat, after normalizing slash-portable calls (9A/AD8AK,
 * AB2E/VP9, W1AW/4, ...) to their operating location.
 */
export function resolveCallsignEntity(rawCall: string): (PrefixEntry & { prefix: string }) | null {
  const call = operatingCallPart(rawCall);
  for (let len = call.length; len >= 1; len--) {
    const candidate = call.slice(0, len);
    const hit = PREFIX_TABLE.get(candidate);
    if (hit) return { ...hit, prefix: candidate };
  }
  return null;
}

// DXCC treats mainland US, Alaska, and Hawaii as three separate entities
// despite all being "the US" in the everyday sense the US-spotters-only
// alert filters (Needed-DX, VHF opening) are meant to capture.
const US_SPOTTER_ENTITIES = new Set(['United States', 'Alaska', 'Hawaii']);

/** Whether a callsign resolves to a US-based DXCC entity -- shared by every alert check that filters on spotter location. */
export function isUsSpotterCallsign(rawCall: string | null | undefined): boolean {
  if (!rawCall) return false;
  const resolved = resolveCallsignEntity(rawCall);
  return !!resolved && US_SPOTTER_ENTITIES.has(resolved.entity);
}
