// Public KiwiSDR receiver directory -- lets the /kiwisdr page offer "listen
// to someone else's receiver" alongside this station's own. kiwisdr.com's
// own /public/ listing is deliberately gated behind a JS challenge (a
// client-side-generated auth token before the real list loads), clearly
// meant to block scripted access -- not something to route around. Instead
// this uses the same two sources the (open-source) VibeSDR app uses:
// rx.linkfanel.net's long-standing plain-JS mirror of that same list. Only
// that one source, not also Receiverbook, because Receiverbook also lists
// OpenWebRX receivers, a completely different protocol this app doesn't
// speak -- kiwiSdr.ts only knows the KiwiSDR SND/W-F frame format.
import { ttlCached } from './ttlCache';

const KIWI_LIST_URL = 'http://rx.linkfanel.net/kiwisdr_com.js';
// The list changes rarely (receivers coming on/offline over hours/days, not
// seconds) -- a long TTL keeps this from hammering a volunteer's mirror on
// every page load across every visitor.
const DIRECTORY_TTL_MS = 10 * 60 * 1000;

export type PublicKiwiEntry = {
  /** hostname:port -- the only thing /public/switch trusts as input, looked up server-side against this same cached list rather than accepting a client-supplied host (which would otherwise turn this endpoint into an open SSRF-style relay to arbitrary hosts). */
  id: string;
  name: string;
  hostname: string;
  port: number;
  location: string;
  users: number;
  usersMax: number;
  lat: number | null;
  lon: number | null;
  bestSnr: number | null;
};

/** Pulls a `var <name> = [ … ];` array out of a JS blob by walking balanced
 * brackets (string-aware) rather than regexing for the close, since these
 * arrays are large/nested. Same approach VibeSDR's directories.ts uses for
 * the same feed. */
function extractJsArray(text: string, varName: string): unknown[] | null {
  const start = text.indexOf(varName);
  if (start < 0) return null;
  const open = text.indexOf('[', start);
  if (open < 0) return null;
  let depth = 0;
  let inStr = false;
  let quote = '';
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        // Generated JS, not strict JSON -- trailing commas before a closing
        // bracket/brace are common here and JSON.parse rejects those.
        const slice = text.slice(open, i + 1).replace(/,(\s*[\]}])/g, '$1');
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchDirectory(): Promise<PublicKiwiEntry[]> {
  const res = await fetch(KIWI_LIST_URL, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Kiwi directory mirror HTTP ${res.status}`);
  const text = await res.text();
  const rows = extractJsArray(text, 'var kiwisdr_com');
  if (!rows) throw new Error('Could not parse the Kiwi directory mirror');

  const out: PublicKiwiEntry[] = [];
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    if (!r?.url || String(r.offline ?? '').toLowerCase() === 'yes') continue;
    // ext_api=0 is the owner's own "no third-party apps" flag -- a receiver
    // set this way accepts the connection, streams for ~10s, then closes
    // without explanation. Skip it here rather than let a visitor discover
    // that by trying.
    if (Number(r.ext_api) === 0) continue;
    // Web-888 hardware reports a different sw_version and speaks a variant
    // of the protocol this file hasn't been tested against -- kiwiSdr.ts
    // only ports the plain KiwiSDR SND/W-F frame handling. Out of scope for
    // now rather than guessing it's close enough.
    if (/web[_-]?888/i.test(String(r.sw_version ?? ''))) continue;

    let hostname: string;
    let port: number;
    try {
      const raw = String(r.url);
      const u = new URL(/^https?:/i.test(raw) ? raw : `http://${raw}`);
      hostname = u.hostname;
      port = u.port ? Number(u.port) : 8073;
    } catch {
      continue;
    }
    if (!hostname || !Number.isFinite(port) || port <= 0) continue;
    // Receivers behind restrictive NAT/firewalls get tunneled through
    // kiwisdr.com's own *.proxy.kiwisdr.com relay rather than being
    // reachable directly. Confirmed live (2026-08-19): a plain HTTP GET to
    // one of these succeeds and returns the receiver's real status page,
    // but a WebSocket connection to the same host/port opens successfully
    // and then never sends back a single byte -- not even the initial
    // MSG handshake -- while an otherwise-identical direct-address
    // receiver responds immediately. Whatever session/routing the proxy
    // tier needs for WS traffic isn't satisfied by this minimal client
    // (which only ports the *direct* KiwiSDR protocol, see this file's
    // header), so these silently hang instead of erroring -- worse than
    // just not listing them.
    if (/(^|\.)proxy\.kiwisdr\.com$/i.test(hostname)) continue;

    const users = Number(r.users) || 0;
    const usersMax = Number(r.users_max) || 0;
    if (usersMax > 0 && users >= usersMax) continue; // full -- would just fail to connect

    const gpsMatch = /\(([-\d.]+),\s*([-\d.]+)\)/.exec(String(r.gps ?? ''));
    const snrValues = String(r.snr ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isFinite(n));

    out.push({
      id: `${hostname}:${port}`,
      name: String(r.name ?? 'KiwiSDR')
        .replace(/<[^>]*>/g, '')
        .slice(0, 120),
      hostname,
      port,
      location: String(r.loc ?? ''),
      users,
      usersMax,
      lat: gpsMatch ? Number(gpsMatch[1]) : null,
      lon: gpsMatch ? Number(gpsMatch[2]) : null,
      bestSnr: snrValues.length ? Math.max(...snrValues) : null,
    });
  }
  return out;
}

export const fetchPublicKiwiDirectory = ttlCached('kiwisdr:public-directory', DIRECTORY_TTL_MS, fetchDirectory);
