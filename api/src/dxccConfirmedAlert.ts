// "Notify me when a needed DXCC entity gets confirmed" -- support for the
// alert type toggled from Admin (dxcc_confirmed_enabled) and checked daily
// by scripts/check-dxcc-confirmed.ts. Confirmation here means LoTW
// specifically (lotw_qsl_rcvd = 'Y'), matching /awards' own DXCC award
// computation exactly -- unlike the more permissive "LoTW or eQSL" used
// elsewhere on the site (the QSL Confirmation dashboard, the DXCC map's
// marker coloring), since this alert is about a real DXCC award credit,
// which eQSL doesn't count toward.
import { db } from './db';
import { resolveWorkedEntities } from './dxccEntities';

/** Canonical (cty.dat-matching) entity names for every DXCC entity confirmed via LoTW. */
export function getLotwConfirmedEntities(): Set<string> {
  const rows = db.query(`SELECT DISTINCT country FROM qsos WHERE country IS NOT NULL AND lotw_qsl_rcvd = 'Y'`).all() as {
    country: string;
  }[];
  return resolveWorkedEntities(rows.map((r) => r.country));
}

/**
 * Marks every currently-confirmed entity as "already known" without
 * alerting on any of them -- called once, right when the alert is first
 * turned on (see routes/alertConfig.ts), so enabling it doesn't
 * immediately fire off one email per entity confirmed years ago. Only
 * entities that cross into "confirmed" AFTER this baseline is recorded
 * will ever reach the actual alert in the check script.
 */
export function seedDxccConfirmationBaseline() {
  const confirmed = getLotwConfirmedEntities();
  const insert = db.query('INSERT OR IGNORE INTO alerted_dxcc_confirmations (entity) VALUES (?)');
  for (const entity of confirmed) insert.run(entity);
}
