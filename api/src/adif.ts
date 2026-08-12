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
