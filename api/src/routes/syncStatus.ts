import { Hono } from 'hono';
import { db } from '../db';
import { getLastQrzSyncRunAt } from '../qrz';
import { getLastEqslSyncRunAt } from '../eqsl';
import { getLastLotwSyncRunAt } from '../lotw';
import { getLastSolarSyncAt } from '../solarData';

export const syncStatusRoutes = new Hono();

function maxTimestamp(table: string, column: string): string | null {
  const row = db.query(`SELECT MAX(${column}) as ts FROM ${table}`).get() as { ts: string | null };
  return row.ts;
}

// Small aggregated "last synced" readout for every sync feature's admin/log
// button (and the public /sync-status page) -- one request instead of
// several. Public rather than requireAuth since it's just freshness
// metadata (timestamps), not the underlying data itself. Satellite TLE and
// Club Log don't have their own dedicated sync-state tables the way QRZ/
// eQSL/LoTW/solar do (see qrz.ts's getLastQrzSyncRunAt() comment on
// last_run_at) -- they're simple mirror tables, so MAX(updated_at)/
// MAX(synced_at) across all their rows already gives the same answer
// without needing a parallel single-row watermark table just for this.
syncStatusRoutes.get('/', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({
    qrz: getLastQrzSyncRunAt(),
    eqsl: getLastEqslSyncRunAt(),
    lotw: getLastLotwSyncRunAt(),
    solar: getLastSolarSyncAt(),
    satelliteTle: maxTimestamp('satellite_tle', 'updated_at'),
    clublogOqrs: maxTimestamp('clublog_oqrs', 'synced_at'),
    clublogMostWanted: maxTimestamp('clublog_most_wanted', 'synced_at'),
  });
});
