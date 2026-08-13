import * as satellite from 'satellite.js';

export type SatPass = { aos: Date; los: Date; maxElevationDeg: number };

function elevationDeg(satrec: satellite.SatRec, observerGd: satellite.GeodeticLocation, date: Date): number | null {
  const pv = satellite.propagate(satrec, date);
  if (!pv || !pv.position) return null;
  const gmst = satellite.gstime(date);
  const ecf = satellite.eciToEcf(pv.position as satellite.EciVec3<number>, gmst);
  const look = satellite.ecfToLookAngles(observerGd, ecf);
  return (look.elevation * 180) / Math.PI;
}

function refineCrossing(
  satrec: satellite.SatRec,
  observerGd: satellite.GeodeticLocation,
  tLow: Date,
  tHigh: Date,
  rising: boolean,
): Date {
  let lo = tLow.getTime();
  let hi = tHigh.getTime();
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const elev = elevationDeg(satrec, observerGd, new Date(mid));
    if (elev === null) break;
    const above = elev >= 0;
    if (rising ? above : !above) hi = mid;
    else lo = mid;
  }
  return new Date((lo + hi) / 2);
}

/**
 * Ported from web/src/pages/satellites.astro's identical client-side pass
 * finder (same step-then-binary-search-refine approach) -- this is the
 * server-side counterpart used by check-satellite-passes.ts, which has no
 * browser to run the original in. Keep both in sync if the algorithm ever
 * changes.
 *
 * Finds the next pass starting from `from`, then keeps searching for
 * additional passes up to `maxHours` out, returning up to `limit` of them.
 * Each pass also gets its max elevation (a coarse peak found once at the
 * pass's midpoint, then refined by sampling every 10s across [AOS, LOS] --
 * plenty precise for an alert threshold, not meant for pointing an antenna).
 */
export function findUpcomingPasses(
  satrec: satellite.SatRec,
  observerGd: satellite.GeodeticLocation,
  from: Date,
  maxHours = 48,
  limit = 5,
): SatPass[] {
  const passes: SatPass[] = [];
  const stepSec = 30;
  let t = from.getTime();
  let prevElev = elevationDeg(satrec, observerGd, new Date(t));
  const maxSteps = (maxHours * 3600) / stepSec;

  for (let i = 0; i < maxSteps && passes.length < limit; i++) {
    t += stepSec * 1000;
    const elev = elevationDeg(satrec, observerGd, new Date(t));
    if (prevElev !== null && elev !== null && prevElev < 0 && elev >= 0) {
      const aos = refineCrossing(satrec, observerGd, new Date(t - stepSec * 1000), new Date(t), true);

      // Find LOS by continuing to step forward from AOS.
      let losT = aos.getTime();
      let losPrevElev = 0;
      let los: Date | null = null;
      const losStepSec = 15;
      for (let j = 0; j < (3 * 3600) / losStepSec; j++) {
        losT += losStepSec * 1000;
        const losElev = elevationDeg(satrec, observerGd, new Date(losT));
        if (losElev !== null && losPrevElev >= 0 && losElev < 0) {
          los = refineCrossing(satrec, observerGd, new Date(losT - losStepSec * 1000), new Date(losT), false);
          break;
        }
        if (losElev !== null) losPrevElev = losElev;
      }
      if (los) {
        let maxElev = 0;
        const sampleStepMs = 10_000;
        for (let sampleT = aos.getTime(); sampleT <= los.getTime(); sampleT += sampleStepMs) {
          const sampleElev = elevationDeg(satrec, observerGd, new Date(sampleT));
          if (sampleElev !== null && sampleElev > maxElev) maxElev = sampleElev;
        }
        passes.push({ aos, los, maxElevationDeg: maxElev });
        t = los.getTime();
        prevElev = elevationDeg(satrec, observerGd, new Date(t));
        continue;
      }
    }
    prevElev = elev;
  }
  return passes;
}

export function observerFromLatLon(lat: number, lon: number): satellite.GeodeticLocation {
  return {
    longitude: satellite.degreesToRadians(lon),
    latitude: satellite.degreesToRadians(lat),
    height: 0.05, // km -- generic ground-level assumption, matching the client-side tracker
  };
}
