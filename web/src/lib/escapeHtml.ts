// Escapes text interpolated into an innerHTML template literal -- for pages
// that render rows from open, unmoderated third-party feeds (DX cluster
// spot comments, WSPR/RBN/PSK Reporter receiver fields, BrandMeister
// talkgroup/operator names) where the source text isn't under this site's
// control. Pages rendering only this site's own DB or static data don't
// need this. For new code, prefer building rows via createElement/
// textContent instead (see tools.astro's HamQTH lookup or photos.astro) --
// this exists for pages already structured around innerHTML template
// strings, where escaping the interpolated values is the smaller change.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
