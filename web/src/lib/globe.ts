// Orthographic projection for the 3D globe view on /map -- rotates the
// sphere so (centerLonDeg, centerLatDeg) faces the viewer, then projects
// every other point onto the 2D view plane. Standard cartographic
// orthographic-azimuthal formula (the same projection D3's geoOrthographic
// implements), not something improvised for this page.
//
// Returns unit-sphere view-space coordinates (x, y in [-1, 1], z in
// [-1, 1]) -- NOT yet scaled to a canvas radius or offset to a canvas
// center, callers do that. z > 0 means the point faces the viewer; z <= 0
// means it's on the far side of the globe and should be culled rather
// than drawn.
export type ProjectedPoint = { x: number; y: number; z: number };

export function projectPoint(latDeg: number, lonDeg: number, centerLatDeg: number, centerLonDeg: number): ProjectedPoint {
  const lat = (latDeg * Math.PI) / 180;
  const dLon = ((lonDeg - centerLonDeg) * Math.PI) / 180;
  const phi0 = (centerLatDeg * Math.PI) / 180;

  const x = Math.cos(lat) * Math.sin(dLon);
  const y = Math.cos(phi0) * Math.sin(lat) - Math.sin(phi0) * Math.cos(lat) * Math.cos(dLon);
  const z = Math.sin(phi0) * Math.sin(lat) + Math.cos(phi0) * Math.cos(lat) * Math.cos(dLon);
  return { x, y, z };
}

/** Land polygon rings (each an array of [lon, lat] pairs), simplified from
 * Natural Earth's public-domain 110m land dataset -- fetched once and
 * cached in memory for the page's lifetime rather than re-fetched every
 * time the globe view is opened. */
let landCache: [number, number][][] | null = null;
export async function loadLandPolygons(): Promise<[number, number][][]> {
  if (landCache) return landCache;
  const res = await fetch('/globe-land-110m.json');
  landCache = (await res.json()) as [number, number][][];
  return landCache;
}
