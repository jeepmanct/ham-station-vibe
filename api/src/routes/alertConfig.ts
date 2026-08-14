import { Hono } from 'hono';
import { requireAuth } from '../auth';
import { getAlertConfigPublic, setAlertConfig } from '../alertConfig';
import { sendAlertEmail } from '../alertEmail';
import { sendNtfyAlert } from '../alertNtfy';
import { seedDxccConfirmationBaseline } from '../dxccConfirmedAlert';

export const alertConfigRoutes = new Hono();

alertConfigRoutes.get('/', requireAuth, (c) => c.json(getAlertConfigPublic()));

// Body may include an `email` object, an `ntfy` object, or both — each
// channel's config is saved independently, so updating one never touches
// the other's stored settings.
alertConfigRoutes.post('/', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (
    !body?.email &&
    !body?.ntfy &&
    body?.vhfEnabled === undefined &&
    body?.flareEnabled === undefined &&
    body?.windEnabled === undefined &&
    body?.dxUsSpottersOnly === undefined &&
    body?.vhfUsSpottersOnly === undefined &&
    body?.kpEnabled === undefined &&
    body?.tropoEnabled === undefined &&
    body?.satPassEnabled === undefined &&
    body?.lightningEnabled === undefined &&
    body?.dxccConfirmedEnabled === undefined
  ) {
    return c.json(
      {
        error:
          'email, ntfy, vhfEnabled, flareEnabled, windEnabled, kpEnabled, tropoEnabled, satPassEnabled, lightningEnabled, dxccConfirmedEnabled, dxUsSpottersOnly, or vhfUsSpottersOnly is required',
      },
      400,
    );
  }

  if (body.email) {
    if (!body.email.smtpHost || !body.email.smtpUser || !body.email.alertTo) {
      return c.json({ error: 'email.smtpHost, email.smtpUser, and email.alertTo are required' }, 400);
    }
  }
  if (body.ntfy && !body.ntfy.topic) {
    return c.json({ error: 'ntfy.topic is required' }, 400);
  }

  // Seed BEFORE saving -- reads the pre-update enabled state so this only
  // fires on a genuine false->true transition, not every time the form is
  // saved while already on.
  const wasDxccConfirmedEnabled = getAlertConfigPublic().dxccConfirmedEnabled;

  setAlertConfig({
    email: body.email
      ? {
          smtpHost: String(body.email.smtpHost).trim(),
          smtpPort: Number(body.email.smtpPort) || 587,
          smtpUser: String(body.email.smtpUser).trim(),
          smtpPass: body.email.smtpPass ? String(body.email.smtpPass) : undefined,
          alertTo: String(body.email.alertTo).trim(),
          enabled: !!body.email.enabled,
        }
      : undefined,
    ntfy: body.ntfy ? { topic: String(body.ntfy.topic).trim(), enabled: !!body.ntfy.enabled } : undefined,
    vhfEnabled: body.vhfEnabled !== undefined ? !!body.vhfEnabled : undefined,
    flareEnabled: body.flareEnabled !== undefined ? !!body.flareEnabled : undefined,
    windEnabled: body.windEnabled !== undefined ? !!body.windEnabled : undefined,
    dxUsSpottersOnly: body.dxUsSpottersOnly !== undefined ? !!body.dxUsSpottersOnly : undefined,
    vhfUsSpottersOnly: body.vhfUsSpottersOnly !== undefined ? !!body.vhfUsSpottersOnly : undefined,
    kpEnabled: body.kpEnabled !== undefined ? !!body.kpEnabled : undefined,
    tropoEnabled: body.tropoEnabled !== undefined ? !!body.tropoEnabled : undefined,
    satPassEnabled: body.satPassEnabled !== undefined ? !!body.satPassEnabled : undefined,
    lightningEnabled: body.lightningEnabled !== undefined ? !!body.lightningEnabled : undefined,
    dxccConfirmedEnabled: body.dxccConfirmedEnabled !== undefined ? !!body.dxccConfirmedEnabled : undefined,
  });

  if (body.dxccConfirmedEnabled === true && !wasDxccConfirmedEnabled) {
    seedDxccConfirmationBaseline();
  }

  return c.json(getAlertConfigPublic());
});

// Sends a real test email/push through the currently-saved config so the
// user can verify credentials work immediately, rather than waiting for a
// real needed-DX spot (which might not happen for hours or days).
alertConfigRoutes.post('/test-email', requireAuth, async (c) => {
  try {
    await sendAlertEmail(
      'Test alert',
      "This is a test email from your site's needed-DX alert configuration. If you received this, it's working.",
    );
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Send failed' }, 502);
  }
});

alertConfigRoutes.post('/test-ntfy', requireAuth, async (c) => {
  try {
    await sendNtfyAlert('Test alert', "This is a test push from your site's needed-DX alert configuration. If you received this, it's working.");
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Send failed' }, 502);
  }
});
