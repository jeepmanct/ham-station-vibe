export type AdifRecord = Record<string, string>;

const FIELD_RE = /<([a-zA-Z_0-9]+):(\d+)(?::[a-zA-Z])?>/g;

function parseRecord(chunk: string): AdifRecord {
  const record: AdifRecord = {};
  FIELD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FIELD_RE.exec(chunk))) {
    const [, name, lenStr] = match;
    const len = Number(lenStr);
    const start = match.index + match[0].length;
    const value = chunk.slice(start, start + len);
    record[name.toUpperCase()] = value;
    FIELD_RE.lastIndex = start + len;
  }
  return record;
}

/** Parses an ADIF (.adi) file body, as exported by ARRL Logbook of The World, into QSO records. */
export function parseAdif(content: string): AdifRecord[] {
  const eohIndex = content.search(/<eoh>/i);
  const body = eohIndex >= 0 ? content.slice(eohIndex + '<eoh>'.length) : content;
  const chunks = body.split(/<eor>/i).map((c) => c.trim()).filter(Boolean);
  return chunks.map(parseRecord);
}

/** Serializes a single QSO record back into ADIF field format, terminated with <EOR>. */
export function buildAdifRecord(fields: AdifRecord): string {
  const parts = Object.entries(fields)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<${k}:${v.length}>${v}`);
  return parts.join(' ') + ' <EOR>';
}

/**
 * Formats decimal-degree coordinates into ADIF's real LAT/LON shape
 * (`XDDD MM.MMM`, hemisphere letter + degrees + decimal minutes -- see
 * maidenhead.ts's parseAdifLatLon, which is the reverse of this and is
 * what resolveLatLon() actually reads). A plain decimal string like
 * "52.2297" silently fails that parse and falls through to grid-square
 * precision instead -- caught live while testing the Trips feature: a
 * QSO logged with an exact GPS-derived lat/lon came back positioned at
 * its grid square's center (a ~100km box) instead of the real point,
 * because the earlier `MY_LAT = String(lat)` pattern (both here and in
 * the pre-existing home-location manual-entry path) never produced
 * ADIF's expected format in the first place.
 */
export function formatAdifLatLon(lat: number, lon: number): { LAT: string; LON: string } {
  function format(value: number, positiveHemi: string, negativeHemi: string): string {
    const hemi = value < 0 ? negativeHemi : positiveHemi;
    const abs = Math.abs(value);
    const deg = Math.floor(abs);
    const min = (abs - deg) * 60;
    return `${hemi}${String(deg).padStart(3, '0')} ${min.toFixed(3)}`;
  }
  return { LAT: format(lat, 'N', 'S'), LON: format(lon, 'E', 'W') };
}
