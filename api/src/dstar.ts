// Example integration, watching one specific reflector (REF069, Connecticut's
// D-STAR network) -- there's no single universal D-STAR "last heard" API the
// way BrandMeister provides for DMR, so this points at one reflector's own
// dashboard. Swap REF069_URL and MODULE_LABELS below for your own local
// reflector's dashboard URL and module usage (most REF/XRF/DCS reflectors
// running the classic DPLUS software publish the same page shape -- check
// yours at the same path this one uses, `/`).
export type DstarLastHeardEntry = { call: string; message: string; module: string; time: string };

const REF069_URL = 'http://ref069.dyndns.org/';

// Connecticut D-STAR Group's own published module usage --
// see https://ctdstar.org/reflector.html.
const MODULE_LABELS: Record<string, string> = {
  A: 'Emergency use only',
  B: 'General use',
  C: 'Main CT/New England network',
  D: 'Digital data/testing',
  E: 'Echo testing only',
};

export function moduleLabel(module: string): string {
  return MODULE_LABELS[module] ?? module;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

/**
 * REF069 (Connecticut D-STAR Group's reflector) publishes a classic DPLUS
 * dashboard -- plain HTML, no API, http-only (no TLS on this small
 * dyndns-hosted server). Regex-parsed against its "Last Heard" table
 * specifically -- the page also has a separate "Remote Users" table
 * (currently-registered stations, some just "listening") higher up with
 * the same 4-column shape, which this deliberately skips in favor of the
 * one with real per-transmission timestamps.
 *
 * The displayed "Last TX on" time is shown as-is rather than converted to
 * a relative "X minutes ago" figure -- this small personal server's clock
 * timezone isn't documented anywhere, and guessing wrong would show a
 * confidently incorrect delta rather than an honest raw timestamp.
 */
export async function fetchDstarLastHeard(): Promise<DstarLastHeardEntry[]> {
  const res = await fetch(REF069_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`REF069 dashboard fetch failed: HTTP ${res.status}`);
  const html = await res.text();

  const sectionStart = html.indexOf('>Last Heard<');
  if (sectionStart === -1) return [];
  const section = html.slice(sectionStart);

  const rowRe = /<tr bgcolor="#D3DCE6">([\s\S]*?)<\/tr>/g;
  const entries: DstarLastHeardEntry[] = [];
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(section))) {
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      cells.push(stripTags(cellMatch[1]));
    }
    // The header row uses <th>, not <td> -- naturally yields 0 cells here
    // and gets skipped by this same length check, no special-casing needed.
    if (cells.length < 4 || !cells[0]) continue;
    const [call, message, module, time] = cells;
    entries.push({ call, message, module, time });
  }
  return entries;
}
