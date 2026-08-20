/** Converts an ADIF-style YYYYMMDD date string to YYYY-MM-DD. Returns the input unchanged if it isn't 8 characters. */
export function formatDate(d: string): string {
  if (d.length !== 8) return d;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}
