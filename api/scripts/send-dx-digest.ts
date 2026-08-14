// Weekly summary email/push -- unlike every other alert in this project,
// this is a scheduled DIGEST, not a threshold-triggered alert: it sends
// every week on schedule once turned on, even a quiet "nothing new this
// week" one, rather than only firing when some condition is met. Paired
// with deploy/hamstation-dx-digest.service + .timer, run once weekly
// (Sunday 08:00, after the daily QRZ/eQSL/LoTW syncs and Club Log's own
// Sunday sync would all have completed).
import { db } from '../src/db';
import { getAlertConfig } from '../src/alertConfig';
import { getEffectiveHomeLocation } from '../src/stationLocation';
import { distanceKm } from '../src/maidenhead';
import { resolveWorkedEntities } from '../src/dxccEntities';
import { sendAlertEmail } from '../src/alertEmail';
import { sendNtfyAlert } from '../src/alertNtfy';
import { formatDistance } from '../src/siteSettings';

function daysAgoYyyymmdd(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function main() {
  const cfg = getAlertConfig();
  if (!cfg.dxDigestEnabled) {
    console.log('DX Digest disabled — turn it on under Admin.');
    return;
  }
  const emailOn = cfg.email?.enabled ?? false;
  const ntfyOn = cfg.ntfy?.enabled ?? false;
  if (!emailOn && !ntfyOn) {
    console.log('DX Digest enabled, but no delivery channel (email/push) is on — set one up under Admin.');
    return;
  }

  const since = daysAgoYyyymmdd(7);

  const totals = db.query('SELECT COUNT(*) as total FROM qsos').get() as { total: number };
  const newQsos = db.query('SELECT COUNT(*) as c FROM qsos WHERE qso_date >= ?').get(since) as { c: number };
  const newConfirmations = db
    .query(`SELECT COUNT(*) as c FROM qsos WHERE (lotw_qsl_rcvd_date >= ? OR eqsl_qsl_rcvd_date >= ?)`)
    .get(since, since) as { c: number };

  // "Newly worked" = an entity whose earliest-ever QSO in the whole log
  // falls within this week -- not just "worked this week" (which would
  // also match a country worked many times before).
  const firstWorkedRows = db
    .query(`SELECT country, MIN(qso_date) as first FROM qsos WHERE country IS NOT NULL GROUP BY country HAVING first >= ?`)
    .all(since) as { country: string; first: string }[];
  const newEntities = [...resolveWorkedEntities(firstWorkedRows.map((r) => r.country))].sort();

  // Best DX this week -- farthest QSO by great-circle distance from the
  // configured Station Location. Skipped entirely if no location is set,
  // rather than falling back to the QSO-inference heuristic other routes
  // use -- a "farthest of the week" claim is exactly the kind of precise
  // number that inference shouldn't be trusted for.
  let bestDx: { call: string; country: string | null; distanceKm: number } | null = null;
  const home = getEffectiveHomeLocation();
  if (home) {
    const weekRows = db
      .query(`SELECT call, country, lat, lon FROM qsos WHERE qso_date >= ? AND lat IS NOT NULL AND lon IS NOT NULL`)
      .all(since) as { call: string; country: string | null; lat: number; lon: number }[];
    for (const r of weekRows) {
      const dist = distanceKm(home, { lat: r.lat, lon: r.lon });
      if (!bestDx || dist > bestDx.distanceKm) bestDx = { call: r.call, country: r.country, distanceKm: dist };
    }
  }

  const lines = [
    `${newQsos.c} new QSO${newQsos.c === 1 ? '' : 's'} this week (${totals.total} total logged).`,
    `${newConfirmations.c} new confirmation${newConfirmations.c === 1 ? '' : 's'} (LoTW or eQSL) this week.`,
    newEntities.length
      ? `Newly worked ${newEntities.length === 1 ? 'entity' : 'entities'}: ${newEntities.join(', ')}.`
      : 'No newly-worked DXCC entities this week.',
    bestDx
      ? `Best DX: ${bestDx.call}${bestDx.country ? ` (${bestDx.country})` : ''}, ${formatDistance(bestDx.distanceKm)}.`
      : 'No distance data available for this week’s QSOs.',
  ];
  const text = lines.join('\n');
  const subject = `Your weekly DX Digest — ${newQsos.c} QSO${newQsos.c === 1 ? '' : 's'} this week`;

  if (emailOn) {
    try {
      await sendAlertEmail(subject, text);
      console.log('Sent DX Digest email.');
    } catch (err) {
      console.log('DX Digest email failed:', err instanceof Error ? err.message : err);
    }
  }
  if (ntfyOn) {
    try {
      // Condensed -- a push notification isn't the place for the full
      // multi-line digest the email gets.
      await sendNtfyAlert(subject, lines[0]);
      console.log('Sent DX Digest push.');
    } catch (err) {
      console.log('DX Digest push failed:', err instanceof Error ? err.message : err);
    }
  }
}

await main();
