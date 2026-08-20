import { Hono } from 'hono';
import { requireAuth } from '../auth';
import {
  getKiwiSdrStatus,
  setFrequency,
  setBandwidth,
  setFilterWidth,
  setAgc,
  setManualGain,
  setNoiseBlanker,
  setWfZoom,
  setWfSpeed,
  setWfContrast,
  setKiwiSdrEnabled,
  sampleNoiseFloor,
  switchToPublicReceiver,
  switchToOwnReceiver,
} from '../kiwiSdr';
import { fetchPublicKiwiDirectory } from '../kiwiPublicDirectory';
import { distanceKm } from '../maidenhead';
import { getEffectiveHomeLocation } from '../stationLocation';

export const kiwiSdrRoutes = new Hono();

kiwiSdrRoutes.get('/status', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(await getKiwiSdrStatus());
});

// Takes ~1.5s to respond -- see sampleNoiseFloor()'s comment for why this
// is a deliberate spot-check, not a fast/cacheable status read.
kiwiSdrRoutes.get('/noise-floor', async (c) => {
  const result = await sampleNoiseFloor();
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(result);
});

// Open to everyone, not admin-gated -- see kiwiSdr.ts's header comment for
// why a shared-receiver retune doesn't need the same access control as
// FlexRadio's remote control. Same reasoning applies to bandwidth/AGC/zoom
// below -- all just adjust how this one receive-only channel is heard or
// displayed, nothing that could key a transmitter.
kiwiSdrRoutes.post('/tune', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.freqKhz !== 'number' || typeof body.mode !== 'string') {
    return c.json({ error: 'Invalid request body' }, 400);
  }
  const result = setFrequency(body.freqKhz, body.mode.toLowerCase());
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(await getKiwiSdrStatus());
});

kiwiSdrRoutes.post('/bandwidth', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || (body.bandwidth !== 'narrow' && body.bandwidth !== 'normal' && body.bandwidth !== 'wide')) {
    return c.json({ error: 'bandwidth must be "narrow", "normal", or "wide"' }, 400);
  }
  const result = setBandwidth(body.bandwidth);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(await getKiwiSdrStatus());
});

// Fine width control alongside the preset buttons above -- see
// setFilterWidth()'s comment for why this doesn't replace them.
kiwiSdrRoutes.post('/filter-width', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.widthHz !== 'number') {
    return c.json({ error: 'widthHz must be a number' }, 400);
  }
  const result = setFilterWidth(body.widthHz);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(await getKiwiSdrStatus());
});

kiwiSdrRoutes.post('/agc', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.enabled !== 'boolean') return c.json({ error: 'Invalid request body' }, 400);
  const result = setAgc(body.enabled);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(await getKiwiSdrStatus());
});

// Only actually takes effect while AGC is off -- see setManualGain()'s comment.
kiwiSdrRoutes.post('/manual-gain', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.gain !== 'number') return c.json({ error: 'gain must be a number' }, 400);
  const result = setManualGain(body.gain);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(await getKiwiSdrStatus());
});

kiwiSdrRoutes.post('/noise-blanker', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be a boolean' }, 400);
  if (body.gateUs !== undefined && typeof body.gateUs !== 'number') return c.json({ error: 'gateUs must be a number' }, 400);
  if (body.threshPercent !== undefined && typeof body.threshPercent !== 'number') {
    return c.json({ error: 'threshPercent must be a number' }, 400);
  }
  const result = setNoiseBlanker(body.enabled, body.gateUs, body.threshPercent);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(await getKiwiSdrStatus());
});

kiwiSdrRoutes.post('/zoom', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.zoom !== 'number') return c.json({ error: 'Invalid request body' }, 400);
  const result = setWfZoom(body.zoom);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(await getKiwiSdrStatus());
});

kiwiSdrRoutes.post('/wf-speed', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.speed !== 'number') return c.json({ error: 'speed must be a number' }, 400);
  const result = setWfSpeed(body.speed);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(await getKiwiSdrStatus());
});

kiwiSdrRoutes.post('/wf-contrast', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.percent !== 'number') return c.json({ error: 'percent must be a number' }, 400);
  const result = setWfContrast(body.percent);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(await getKiwiSdrStatus());
});

// Read-only, open to everyone -- same access level as the status endpoint
// above, just a list of other receivers rather than this one's state.
kiwiSdrRoutes.get('/public-directory', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    const entries = await fetchPublicKiwiDirectory();
    const home = getEffectiveHomeLocation();
    const withDistance = entries.map((e) => ({
      ...e,
      distanceKm:
        home && e.lat != null && e.lon != null
          ? Math.round(distanceKm({ lat: home.lat, lon: home.lon }, { lat: e.lat, lon: e.lon }))
          : null,
    }));
    withDistance.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    return c.json({ entries: withDistance });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Could not load the public receiver directory' }, 502);
  }
});

// Open to everyone -- same "shared showcase receiver" reasoning as /tune
// above: picking a different (already-vetted) public receiver has no
// remote-control/TX risk. `id` is looked up against the server's own
// cached directory fetch below rather than trusted directly, so this can't
// be used to point the backend's outbound connection at an arbitrary
// host/port (which would otherwise make this an open relay, including to
// this server's own LAN).
kiwiSdrRoutes.post('/public/switch', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.id !== 'string') return c.json({ error: 'Invalid request body' }, 400);
  let entries;
  try {
    entries = await fetchPublicKiwiDirectory();
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Could not load the public receiver directory' }, 502);
  }
  const entry = entries.find((e) => e.id === body.id);
  if (!entry) return c.json({ error: 'That receiver is no longer listed -- refresh the list and try again.' }, 404);
  const result = switchToPublicReceiver(entry.hostname, entry.port, entry.name);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(await getKiwiSdrStatus());
});

kiwiSdrRoutes.post('/public/reset', async (c) => {
  const result = switchToOwnReceiver();
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(await getKiwiSdrStatus());
});

// Admin-only: whether the /kiwisdr page shows its content at all.
kiwiSdrRoutes.post('/enabled', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.enabled !== 'boolean') return c.json({ error: 'Invalid request body' }, 400);
  setKiwiSdrEnabled(body.enabled);
  return c.json(await getKiwiSdrStatus());
});
