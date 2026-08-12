import { getHamQthCredentials } from './serviceCredentials';

export type HamQthResult = {
  callsign: string;
  nick: string | null;
  name: string | null;
  qth: string | null;
  country: string | null;
  grid: string | null;
  usState: string | null;
  iota: string | null;
  qslVia: string | null;
  lotw: boolean;
  eqsl: boolean;
  email: string | null;
  web: string | null;
};

// HamQTH's XML API is session-based rather than a static key: log in once
// with the admin's HamQTH account to get a session_id, then reuse it for
// lookups until it expires. Cached in module memory (not the DB) since it's
// short-lived and cheap to re-mint -- a fresh login on the first lookup
// after a service restart, or whenever a lookup reports the session as
// expired.
let cachedSessionId: string | null = null;

// Tiny regex-based extractor rather than pulling in an XML dependency --
// HamQTH's response is flat, non-repeating tags, which this handles fine.
function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? match[1].trim() || null : null;
}

async function login(): Promise<string> {
  const creds = getHamQthCredentials();
  if (!creds) throw new Error('HamQTH username/password must be set first.');
  const res = await fetch(
    `https://www.hamqth.com/xml.php?u=${encodeURIComponent(creds.username)}&p=${encodeURIComponent(creds.password)}`,
    { signal: AbortSignal.timeout(8000) },
  );
  const xml = await res.text();
  const error = extractTag(xml, 'error');
  if (error) throw new Error(error);
  const sessionId = extractTag(xml, 'session_id');
  if (!sessionId) throw new Error('HamQTH login returned no session_id.');
  cachedSessionId = sessionId;
  return sessionId;
}

async function lookupWithSession(callsign: string, sessionId: string): Promise<string> {
  const res = await fetch(
    `https://www.hamqth.com/xml.php?id=${encodeURIComponent(sessionId)}&callsign=${encodeURIComponent(callsign)}&prg=self-hosted-ham-site`,
    { signal: AbortSignal.timeout(8000) },
  );
  return res.text();
}

export async function lookupCallsign(callsign: string): Promise<{ ok: true; result: HamQthResult } | { ok: false; error: string }> {
  if (!getHamQthCredentials()) return { ok: false, error: 'HamQTH username/password must be set first.' };

  try {
    let sessionId = cachedSessionId ?? (await login());
    let xml = await lookupWithSession(callsign, sessionId);

    // Session expired between calls -- log in fresh and retry once.
    if (extractTag(xml, 'error')?.toLowerCase().includes('session')) {
      sessionId = await login();
      xml = await lookupWithSession(callsign, sessionId);
    }

    const error = extractTag(xml, 'error');
    if (error) return { ok: false, error };

    const foundCallsign = extractTag(xml, 'callsign');
    if (!foundCallsign) return { ok: false, error: 'No match found for that callsign.' };

    return {
      ok: true,
      result: {
        callsign: foundCallsign,
        nick: extractTag(xml, 'nick'),
        name: extractTag(xml, 'adr_name'),
        qth: extractTag(xml, 'qth'),
        country: extractTag(xml, 'country'),
        grid: extractTag(xml, 'grid'),
        usState: extractTag(xml, 'us_state'),
        iota: extractTag(xml, 'iota'),
        qslVia: extractTag(xml, 'qsl_via'),
        lotw: extractTag(xml, 'lotw') === 'Y',
        eqsl: extractTag(xml, 'eqsl') === 'Y',
        email: extractTag(xml, 'email'),
        web: extractTag(xml, 'web'),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
