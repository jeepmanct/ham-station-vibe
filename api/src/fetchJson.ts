/**
 * NOAA SWPC's own JSON endpoints (real-time solar wind, planetary K-index,
 * GOES X-ray flux) serialize a missing/invalid float sensor reading as a
 * bare `NaN` token -- valid output from Python's `json.dumps` (which allows
 * it by default), but not valid JSON per spec (ECMA-404/RFC 8259), so
 * `Response.json()`/`JSON.parse()` reject the whole payload outright.
 * Confirmed live (2026-08-17): the solar-wind plasma feed had 24 such
 * tokens, deterministically breaking every check-solar-wind.ts run for
 * hours, while the exact same file with 0 NaN occurrences parses fine --
 * this isn't a network blip, it's data-dependent and will recur on any of
 * NOAA's SWPC feeds whenever a sensor reports one.
 *
 * `null` is the correct semantic stand-in (NaN already means "no valid
 * reading" here) and every caller's own type already treats these fields
 * as `| null`, so this doesn't need any caller-side changes beyond
 * swapping `res.json()` for `fetchJsonLenient(res)`.
 */
export async function fetchJsonLenient<T>(res: Response): Promise<T> {
  const text = await res.text();
  return JSON.parse(text.replace(/\bNaN\b/g, 'null')) as T;
}
