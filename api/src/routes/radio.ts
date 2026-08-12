import { Hono } from 'hono';
import { requireAuth } from '../auth';
import { getFlexRadioStatus, getRecentRadioSessions, setMonitoring, sendSliceControl, setRadioControlVisible, setRadioHardwareVisible, discoverFlexRadios } from '../flexRadio';

export const radioRoutes = new Hono();

radioRoutes.get('/status', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(getFlexRadioStatus());
});

// Deliberately ungated (no requireAuth) -- this only pauses/resumes a
// read-only status connection, doesn't touch any radio setting or expose
// anything not already shown on the public /radio page, and the whole
// point is quick on-demand checking rather than something worth a login.
radioRoutes.post('/monitoring', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.enabled !== 'boolean') {
    return c.json({ error: 'enabled (boolean) is required' }, 400);
  }
  setMonitoring(body.enabled);
  return c.json(getFlexRadioStatus());
});

radioRoutes.get('/sessions', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(getRecentRadioSessions());
});

// Admin-only, unlike everything else in this file -- this is the one
// endpoint that actually writes to the radio (frequency/mode), so it gets
// the same requireAuth treatment as the site's other write actions rather
// than the public treatment monitoring gets. Receive-only by construction:
// see sendSliceControl()'s own comment for what it does and doesn't send.
radioRoutes.post('/control', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body?.frequencyMhz === undefined && body?.mode === undefined) {
    return c.json({ error: 'frequencyMhz and/or mode is required' }, 400);
  }
  const result = await sendSliceControl({
    frequencyMhz: body.frequencyMhz !== undefined ? Number(body.frequencyMhz) : undefined,
    mode: body.mode !== undefined ? String(body.mode).toUpperCase() : undefined,
  });
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

// Admin-only site setting for whether the Remote Control (Receive Only)
// card shows up on /radio at all -- independent of the monitoring toggle
// above, and independent of whether *this* admin session is logged in:
// turning it off hides the card for everyone, including the admin, until
// it's turned back on here. Feature-flag for a card the site owner doesn't
// consider finished yet, not a security control (the card's own controls
// are still admin-login-gated regardless of this setting).
radioRoutes.post('/control-visibility', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.visible !== 'boolean') {
    return c.json({ error: 'visible (boolean) is required' }, 400);
  }
  setRadioControlVisible(body.visible);
  return c.json(getFlexRadioStatus());
});

// Admin-only site setting for whether the FlexRadio hardware-status section
// (Monitor toggle, On the Air, meters, Recent Sessions) shows up on /radio
// at all -- for an installer of this codebase without a FlexRadio. PSK
// Reporter/WSPR/RBN reception reports are untouched by this, same
// reasoning as control-visibility above.
radioRoutes.post('/hardware-visibility', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.visible !== 'boolean') {
    return c.json({ error: 'visible (boolean) is required' }, 400);
  }
  setRadioHardwareVisible(body.visible);
  return c.json(getFlexRadioStatus());
});

// Admin-only: listens for ~3s of real FlexRadio discovery broadcasts on the
// LAN and returns whatever's found, for the "Detect" button next to the IP
// field in Service Credentials -- doesn't touch this module's own
// persistent connection at all, just a temporary separate listener.
radioRoutes.post('/detect', requireAuth, async (c) => {
  const found = await discoverFlexRadios();
  return c.json({ found });
});
