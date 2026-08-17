// Checks the live DX spot feed for stations from a DXCC entity not yet
// worked and emails a digest of anything new. Standalone script bypassing
// HTTP/auth, same pattern as the other sync-timer scripts in this
// directory — paired with deploy/hamstation-dx-alert.service + .timer, run every
// ~10 minutes via systemd.
//
// A callsign already emailed about within the cooldown window is skipped —
// dxheat's spot feed re-lists an active station repeatedly, and without
// this every check would re-alert on the same contact for as long as it
// stays on the air.
import { db } from '../src/db';
import { resolveCallsignEntity, isUsSpotterCallsign } from '../src/dxccPrefixes';
import { workedEntitiesByCallsign } from '../src/dxNeeded';
import { sendAlertEmail } from '../src/alertEmail';
import { sendNtfyAlert } from '../src/alertNtfy';
import { getAlertConfig, getSiteUrl } from '../src/alertConfig';

const COOLDOWN_HOURS = 3;

type DxSpot = { DXCall?: string; Band?: number; Mode?: string; Frequency?: string; Spotter?: string; Comment?: string };

async function main() {
  const cfg = getAlertConfig();
  const emailOn = cfg.email?.enabled ?? false;
  const ntfyOn = cfg.ntfy?.enabled ?? false;
  if (!emailOn && !ntfyOn) {
    console.log('Needed-DX alerts disabled or not configured — set it up under Admin.');
    return;
  }

  // 15s, not 8s -- dxheat occasionally runs slow, and this check has no
  // real time pressure (runs every 10 minutes regardless), so a longer
  // timeout trades nothing for fewer false-failure TimeoutErrors (confirmed
  // via journalctl: 44 of these over 10 days, all against this exact call).
  const res = await fetch('https://dxheat.com/source/spots/', { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    console.log(`dxheat fetch failed: HTTP ${res.status}`);
    return;
  }
  const spots = (await res.json()) as DxSpot[];

  const worked = workedEntitiesByCallsign();
  const cooldownCutoff = new Date(Date.now() - COOLDOWN_HOURS * 3600 * 1000).toISOString();
  const alreadyAlerted = new Set(
    (db.query('SELECT call FROM alerted_dx_spots WHERE alerted_at > ?').all(cooldownCutoff) as { call: string }[]).map((r) => r.call),
  );

  const seen = new Map<string, { call: string; entity: string; band: number | null; mode: string | null; freq: string | null; spotter: string | null; comment: string | null }>();
  for (const s of spots) {
    const call = s.DXCall;
    if (!call || alreadyAlerted.has(call) || seen.has(call)) continue;
    const resolved = resolveCallsignEntity(call);
    if (!resolved || worked.has(resolved.entity)) continue;
    // A spot from a Russian or Japanese station doesn't say much about
    // whether this is workable from here -- propagation is directional, so
    // "does this alert reflect what I could plausibly hear" hinges on where
    // the spotter is, not just whether the DX entity itself is needed. Skips
    // a spot with no resolvable spotter callsign too, same reasoning as an
    // unresolvable DX call above: no confidence either way isn't a "yes."
    if (cfg.dxUsSpottersOnly && !isUsSpotterCallsign(s.Spotter)) continue;
    seen.set(call, { call, entity: resolved.entity, band: s.Band ?? null, mode: s.Mode ?? null, freq: s.Frequency ?? null, spotter: s.Spotter ?? null, comment: s.Comment ?? null });
  }

  if (!seen.size) {
    console.log('No new needed DX spots.');
    return;
  }

  const toAlert = [...seen.values()];
  const lines = toAlert.map(
    (n) => `${n.call} — ${n.entity} — ${n.band ? `${n.band}m` : ''} ${n.mode ?? ''} ${n.freq ? `(${n.freq} kHz)` : ''} — spotted by ${n.spotter ?? '?'}${n.comment ? `: ${n.comment}` : ''}`,
  );
  const siteUrl = getSiteUrl();
  const text = `${toAlert.length} newly-spotted needed DXCC ${toAlert.length === 1 ? 'entity' : 'entities'}:\n\n${lines.join('\n')}${siteUrl ? `\n\nLive spots: ${siteUrl}/conditions` : ''}`;
  const subject = `${toAlert.length} needed DX spotted`;

  // Each channel is tried independently -- one failing (bad SMTP creds, an
  // unreachable ntfy.sh) shouldn't stop the other from delivering. Cooldown
  // is only recorded if at least one channel actually got through, so a
  // fully-broken config keeps retrying next check instead of silently
  // "using up" the alert for a spot the operator never actually heard about.
  let delivered = false;
  if (emailOn) {
    try {
      await sendAlertEmail(subject, text);
      console.log('Emailed alert.');
      delivered = true;
    } catch (err) {
      console.log('Email alert failed:', err instanceof Error ? err.message : err);
    }
  }
  if (ntfyOn) {
    try {
      await sendNtfyAlert(subject, text);
      console.log('Sent ntfy push alert.');
      delivered = true;
    } catch (err) {
      console.log('ntfy alert failed:', err instanceof Error ? err.message : err);
    }
  }
  if (!delivered) {
    console.log('All configured alert channels failed — not recording cooldown, will retry next check.');
    return;
  }

  const now = new Date().toISOString();
  const upsert = db.query(
    `INSERT INTO alerted_dx_spots (call, alerted_at) VALUES (?, ?)
     ON CONFLICT(call) DO UPDATE SET alerted_at = excluded.alerted_at`,
  );
  for (const n of toAlert) upsert.run(n.call, now);

  console.log(`Alerted on ${toAlert.length} needed spot(s): ${toAlert.map((n) => n.call).join(', ')}`);
}

await main();
