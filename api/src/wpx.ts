// CQ WPX (Worked All Prefixes) prefix extraction. Real ham callsigns mix two
// portable/reciprocal-license conventions in the wild — "LOCATION/HOMECALL"
// (e.g. 9A/AD8AK: a US ham operating in Croatia under reciprocal rules) and
// "HOMECALL/LOCATION" (e.g. AB2E/VP9: a US ham portable in Bermuda) — and
// WPX credits the operating location in both cases, not a fixed position.
// The distinguishing signal: a bare location prefix (9A, VP9, EI, 4L) is
// already nothing more than a prefix — extracting a prefix from it yields
// itself unchanged — while a real callsign (AD8AK, AB2E) has a suffix that
// gets stripped off. This is a pragmatic approximation, not a certified
// contest-scoring implementation — good enough for a personal log's award
// tracking, not for submitting an official WPX award application.
const NON_LOCATING_SUFFIXES = new Set(['P', 'M', 'MM', 'AM', 'QRP', 'A']);

function extractRaw(base: string): string {
  const withDigitSuffix = base.match(/^(\d*[A-Z]+\d+)/);
  if (withDigitSuffix) return withDigitSuffix[1];
  const lettersOnly = base.match(/^(\d*[A-Z]+)/);
  return lettersOnly ? lettersOnly[1] : base;
}

function classifyPart(part: string): 'bare' | 'full' | 'ignore' {
  if (NON_LOCATING_SUFFIXES.has(part)) return 'ignore';
  // No real country prefix is a bare 4+ letter string with no digit at all
  // (that's almost certainly a tag like "POTA", not a location indicator).
  if (!/\d/.test(part) && part.length > 3) return 'ignore';
  return extractRaw(part) === part ? 'bare' : 'full';
}

export function wpxPrefix(rawCall: string): string {
  const call = rawCall.toUpperCase().trim();
  const parts = call.split('/').filter(Boolean);
  let base: string;
  if (parts.length === 1) {
    base = parts[0];
  } else {
    const classified = parts.map((p) => ({ part: p, cls: classifyPart(p) }));
    const bare = classified.filter((c) => c.cls === 'bare');
    const full = classified.filter((c) => c.cls === 'full');
    if (bare.length === 1 && full.length === 1 && /^\d+$/.test(bare[0].part)) {
      // A bare numeral-only suffix (e.g. W1AW/4) is a call-area substitution,
      // not a location prefix by itself — WPX convention swaps it into the
      // home call's own letter-prefix (W1AW/4 -> W4), rather than crediting
      // the bare digit or the unmodified home prefix.
      const homeLetters = full[0].part.match(/^[A-Z]+/)?.[0] ?? full[0].part;
      base = homeLetters + bare[0].part;
    } else if (bare.length === 1) {
      base = bare[0].part;
    } else if (full.length === 1) {
      base = full[0].part;
    } else {
      base = parts[0];
    }
  }
  return extractRaw(base);
}
