// Checks the live DX spot feed for 6m/2m activity and emails/pushes a
// digest when there's real DX-cluster-reported activity -- a rough but
// honest proxy for "there's a Sporadic-E (or other) opening happening."
// Standalone script, same pattern as check-needed-dx.ts -- paired with
// deploy/hamstation-vhf-alert.service + .timer, run every ~5 minutes (shorter
// than the DX-alert's 10, since Es openings can open and close within
// 15-30 minutes).
//
// Real gotcha found by testing against the live feed rather than
// guessing: dxheat's spot `Band` field is in *meters*, not MHz (6m = 6.0,
// 2m = 2.0) -- easy to get backwards if you assume it matches Frequency's
// units.
//
// Deliberately doesn't try to compute distance/"is this really Es" --
// the spotter's own grid isn't reliably present in the feed to compute
// it from, and VHF spots are inherently rare on a worldwide HF-oriented
// cluster (routine local VHF contacts aren't normally posted there), so
// any non-beacon 6m/2m spot showing up at all is already a reasonably
// strong signal something's open. The one geographic check that IS cheap
// enough to do reliably -- is the spotter a US station at all -- is applied
// separately below (vhfUsSpottersOnly), same idea as the Needed-DX alert's
// own filter. Cooldown is per-band, not per-spot, since the point is "an
// opening is happening," and an active opening can keep producing new spots
// for hours.
import { db } from '../src/db';
import { sendAlertEmail } from '../src/alertEmail';
import { sendNtfyAlert } from '../src/alertNtfy';
import { getAlertConfig, getSiteUrl } from '../src/alertConfig';
import { isUsSpotterCallsign } from '../src/dxccPrefixes';

const COOLDOWN_HOURS = 2;
const VHF_BANDS: Record<number, string> = { 6: '6m', 2: '2m' };

type DxSpot = { DXCall?: string; Spotter?: string; Band?: number; Mode?: string; Frequency?: string; Comment?: string; Beacon?: boolean };

async function main() {
  const cfg = getAlertConfig();
  const emailOn = cfg.email?.enabled ?? false;
  const ntfyOn = cfg.ntfy?.enabled ?? false;
  if (!cfg.vhfEnabled) {
    console.log('VHF opening alerts disabled — turn it on under Admin.');
    return;
  }
  if (!emailOn && !ntfyOn) {
    console.log('VHF opening alerts enabled, but no delivery channel (email/push) is on — set one up under Admin.');
    return;
  }

  const res = await fetch('https://dxheat.com/source/spots/', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    console.log(`dxheat fetch failed: HTTP ${res.status}`);
    return;
  }
  const spots = (await res.json()) as DxSpot[];

  const cooldownCutoff = new Date(Date.now() - COOLDOWN_HOURS * 3600 * 1000).toISOString();
  const alreadyAlerted = new Set(
    (db.query('SELECT band FROM alerted_vhf_bands WHERE alerted_at > ?').all(cooldownCutoff) as { band: string }[]).map((r) => r.band),
  );

  const byBand = new Map<string, DxSpot[]>();
  for (const s of spots) {
    if (s.Beacon || !s.Band || !(s.Band in VHF_BANDS)) continue;
    const bandLabel = VHF_BANDS[s.Band];
    if (alreadyAlerted.has(bandLabel)) continue;
    // Same reasoning as the Needed-DX check's own US-spotters-only filter: a
    // 6m/2m spot posted by a European or Asian station isn't a sign of an
    // opening reachable from here, so it shouldn't be able to trigger this
    // alert (or pad out its digest) on its own.
    if (cfg.vhfUsSpottersOnly && !isUsSpotterCallsign(s.Spotter)) continue;
    if (!byBand.has(bandLabel)) byBand.set(bandLabel, []);
    byBand.get(bandLabel)!.push(s);
  }

  if (!byBand.size) {
    console.log('No new VHF band activity.');
    return;
  }

  const sections = [...byBand.entries()].map(([band, bandSpots]) => {
    const lines = bandSpots
      .slice(0, 15)
      .map((s) => `  ${s.DXCall ?? '?'} — ${s.Mode ?? ''} ${s.Frequency ? `(${s.Frequency} kHz)` : ''} — spotted by ${s.Spotter ?? '?'}${s.Comment ? `: ${s.Comment}` : ''}`);
    return `${band} (${bandSpots.length} spot${bandSpots.length === 1 ? '' : 's'}):\n${lines.join('\n')}`;
  });
  const bandNames = [...byBand.keys()];
  const siteUrl = getSiteUrl();
  const text = `Possible VHF opening — DX-cluster activity on ${bandNames.join(', ')}:\n\n${sections.join('\n\n')}${siteUrl ? `\n\nLive spots: ${siteUrl}/conditions` : ''}`;
  const subject = `VHF opening: ${bandNames.join(', ')}`;

  let delivered = false;
  if (emailOn) {
    try {
      await sendAlertEmail(subject, text);
      console.log('Emailed VHF opening alert.');
      delivered = true;
    } catch (err) {
      console.log('Email alert failed:', err instanceof Error ? err.message : err);
    }
  }
  if (ntfyOn) {
    try {
      await sendNtfyAlert(subject, text);
      console.log('Sent ntfy VHF opening push.');
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
    `INSERT INTO alerted_vhf_bands (band, alerted_at) VALUES (?, ?)
     ON CONFLICT(band) DO UPDATE SET alerted_at = excluded.alerted_at`,
  );
  for (const band of bandNames) upsert.run(band, now);

  console.log(`Alerted on VHF activity: ${bandNames.join(', ')}`);
}

await main();
