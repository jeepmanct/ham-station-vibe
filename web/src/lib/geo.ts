const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/**
 * Computes points along the great-circle path between two coordinates (spherical
 * slerp), unwrapping longitude so the path renders continuously across the
 * antimeridian instead of jumping across the map.
 */
export function greatCircleArc(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  segments = 16,
): [number, number][] {
  const phi1 = toRad(lat1);
  const lambda1 = toRad(lon1);
  const phi2 = toRad(lat2);
  const lambda2 = toRad(lon2);

  const d = Math.acos(
    Math.min(1, Math.max(-1, Math.sin(phi1) * Math.sin(phi2) + Math.cos(phi1) * Math.cos(phi2) * Math.cos(lambda1 - lambda2))),
  );

  if (d < 1e-9) return [[lat1, lon1]];

  const points: [number, number][] = [];
  let prevLon = lon1;
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(phi1) * Math.cos(lambda1) + b * Math.cos(phi2) * Math.cos(lambda2);
    const y = a * Math.cos(phi1) * Math.sin(lambda1) + b * Math.cos(phi2) * Math.sin(lambda2);
    const z = a * Math.sin(phi1) + b * Math.sin(phi2);
    const lat = toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)));
    let lon = toDeg(Math.atan2(y, x));

    // Unwrap relative to the previous point so the path doesn't jump 360°.
    while (lon - prevLon > 180) lon -= 360;
    while (lon - prevLon < -180) lon += 360;
    prevLon = lon;

    points.push([lat, lon]);
  }
  return points;
}
