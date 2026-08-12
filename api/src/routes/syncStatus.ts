import { Hono } from 'hono';
import { getLastQrzSyncRunAt } from '../qrz';
import { getLastEqslSyncRunAt } from '../eqsl';
import { getLastLotwSyncRunAt } from '../lotw';
import { getLastSolarSyncAt } from '../solarData';

export const syncStatusRoutes = new Hono();

// Small aggregated "last synced" readout for every sync feature's admin/log
// button -- one request instead of four, and public rather than requireAuth
// since it's just freshness metadata (a timestamp), same sensitivity level
// as the satellite-TLE and Club Log OQRS last-synced displays elsewhere on
// the site, both of which are already unauthenticated.
syncStatusRoutes.get('/', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({
    qrz: getLastQrzSyncRunAt(),
    eqsl: getLastEqslSyncRunAt(),
    lotw: getLastLotwSyncRunAt(),
    solar: getLastSolarSyncAt(),
  });
});
