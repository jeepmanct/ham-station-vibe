import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { authRoutes } from './routes/auth';
import { photoRoutes } from './routes/photos';
import { qsoRoutes } from './routes/qsos';
import { solarRoutes } from './routes/solar';
import { awardsRoutes } from './routes/awards';
import { conditionsRoutes } from './routes/conditions';
import { potaRoutes } from './routes/pota';
import { statsRoutes } from './routes/stats';
import { satelliteRoutes } from './routes/satellites';
import { geocodeRoutes } from './routes/geocode';
import { alertConfigRoutes } from './routes/alertConfig';
import { radioRoutes } from './routes/radio';
import { serviceCredentialsRoutes } from './routes/serviceCredentials';
import { openRepeaterRoutes } from './routes/openRepeater';
import { hamqthRoutes } from './routes/hamqth';
import { brandmeisterRoutes } from './routes/brandmeister';
import { stationLocationRoutes } from './routes/stationLocation';
import { syncStatusRoutes } from './routes/syncStatus';
import { tileLayoutRoutes } from './routes/tileLayout';
import { bearingRoutes } from './routes/bearing';
import { dstarRoutes } from './routes/dstar';
import { systemStatsRoutes } from './routes/systemStats';
import { backupRoutes } from './routes/backup';
import { kiwiSdrRoutes } from './routes/kiwiSdr';
import { guestbookRoutes } from './routes/guestbook';
import { lightningRoutes } from './routes/lightning';
import { examQuestionRoutes } from './routes/examQuestion';
import { siteSettingsRoutes } from './routes/siteSettings';
import { auroraRoutes } from './routes/aurora';
import { pushRoutes } from './routes/push';
import { startLightningMonitoring } from './lightning';
import { startFlexRadioClient, registerAudioListener, unregisterAudioListener } from './flexRadio';
import {
  registerAudioListener as registerKiwiAudioListener,
  unregisterAudioListener as unregisterKiwiAudioListener,
  registerWaterfallListener as registerKiwiWaterfallListener,
  unregisterWaterfallListener as unregisterKiwiWaterfallListener,
} from './kiwiSdr';
import { startBrandmeisterListener } from './brandmeister';
import { consumeWsTicket } from './auth';
import { PHOTOS_DIR, EQSL_CARDS_DIR } from './db';

const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true }));
app.route('/api/auth', authRoutes);
app.route('/api/photos', photoRoutes);
app.route('/api/qsos', qsoRoutes);
app.route('/api/solar', solarRoutes);
app.route('/api/aurora', auroraRoutes);
app.route('/api/awards', awardsRoutes);
app.route('/api/conditions', conditionsRoutes);
app.route('/api/pota', potaRoutes);
app.route('/api/stats', statsRoutes);
app.route('/api/satellites', satelliteRoutes);
app.route('/api/geocode', geocodeRoutes);
app.route('/api/alert-config', alertConfigRoutes);
app.route('/api/radio', radioRoutes);
app.route('/api/service-credentials', serviceCredentialsRoutes);
app.route('/api/sync-status', syncStatusRoutes);
app.route('/api/openrepeater', openRepeaterRoutes);
app.route('/api/hamqth', hamqthRoutes);
app.route('/api/brandmeister', brandmeisterRoutes);
app.route('/api/station-location', stationLocationRoutes);
app.route('/api/tile-layout', tileLayoutRoutes);
app.route('/api/bearing', bearingRoutes);
app.route('/api/dstar', dstarRoutes);
app.route('/api/system', systemStatsRoutes);
app.route('/api/backup', backupRoutes);
app.route('/api/kiwisdr', kiwiSdrRoutes);
app.route('/api/guestbook', guestbookRoutes);
app.route('/api/lightning', lightningRoutes);
app.route('/api/exam', examQuestionRoutes);
app.route('/api/settings', siteSettingsRoutes);
app.route('/api/push', pushRoutes);
// Registered before the general /media/* handler below -- Hono matches
// middleware in registration order, and eqsl-card images live in their own
// directory, not under PHOTOS_DIR.
//
// Cache-Control set explicitly since Hono's serveStatic doesn't set one on
// its own -- every full-size photo/card filename is a content-stable
// crypto.randomUUID() (a new upload always gets a new name, never reuses an
// existing URL for different content), so a long immutable cache is safe
// there. Thumbnails are the one exception: thumbFilename() derives a
// thumbnail's name from the ORIGINAL photo's filename, not its own content
// hash, so a thumbnail that's later regenerated (a thumbnailing bugfix, an
// intentional backfill) reuses the same URL for genuinely different bytes
// -- immutable caching on that URL would keep serving the stale version
// forever. Kept short + revalidatable instead, just for that one path.
app.use('/media/*', async (c, next) => {
  c.header(
    'Cache-Control',
    c.req.path.startsWith('/media/thumbs/') ? 'public, max-age=3600, must-revalidate' : 'public, max-age=31536000, immutable',
  );
  await next();
});
app.use('/media/eqsl-cards/*', serveStatic({ root: EQSL_CARDS_DIR, rewriteRequestPath: (p) => p.replace(/^\/media\/eqsl-cards/, '') }));
app.use('/media/*', serveStatic({ root: PHOTOS_DIR, rewriteRequestPath: (p) => p.replace(/^\/media/, '') }));

startFlexRadioClient();
startBrandmeisterListener();
startLightningMonitoring();

const port = Number(process.env.PORT ?? 3000);
console.log(`API listening on :${port}`);

// Radio audio (see flexRadio.ts's registerAudioListener) is the one thing
// on this site that's a genuine live stream, not a request/response --
// needs a WebSocket, which Hono's own routing doesn't handle, so it's
// intercepted here before falling through to the Hono app. FlexRadio audio
// is auth-gated like the tune control it's paired with, via a short-lived
// single-use `ticket` query param (POST /api/auth/ws-ticket) rather than an
// Authorization header (the browser's native WebSocket API can't set custom
// headers on the upgrade request) or the raw long-lived session token
// (previously used directly here -- see auth.ts's createWsTicket() comment
// for why that was a logging-exposure risk worth closing).
//
// KiwiSDR audio/waterfall are NOT ticket-gated -- unlike the FlexRadio
// stream, the underlying receiver is already fully public (this station's
// Kiwi is listed on the public proxy at n1ah.proxy.kiwisdr.com, reachable
// by anyone), so gating this site's own listen page behind login would just
// be friction with no actual access-control benefit.
type SocketData =
  | { kind: 'radio-audio'; listener?: (pcm: Int16Array) => void }
  | { kind: 'kiwi-audio'; listener?: (pcm: Int16Array) => void }
  | { kind: 'kiwi-waterfall'; listener?: (bins: Uint8Array) => void };

export default {
  port,
  // Bun's own default (10s) is shorter than at least one real upstream call
  // this API makes server-side before responding -- LoTW's full-sync report
  // genuinely takes ~45s (confirmed live 2026-08-12), likely true of other
  // large sync/import routes too. Discovered by accident: a real full LoTW
  // resync through this route (not a raw script bypassing Bun's HTTP layer)
  // got ECONNRESET at exactly 10s, logged server-side as "request timed out
  // after 10 seconds." 120s matches fetchLotwAdif()'s own client-side
  // upstream timeout.
  idleTimeout: 120,
  fetch(req: Request, server: { upgrade: (req: Request, opts?: { data: SocketData }) => boolean }) {
    const url = new URL(req.url);
    if (url.pathname === '/ws/radio-audio') {
      if (!consumeWsTicket(url.searchParams.get('ticket') ?? undefined)) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (server.upgrade(req, { data: { kind: 'radio-audio' } })) return;
      return new Response('Upgrade failed', { status: 500 });
    }
    if (url.pathname === '/ws/kiwisdr-audio') {
      if (server.upgrade(req, { data: { kind: 'kiwi-audio' } })) return;
      return new Response('Upgrade failed', { status: 500 });
    }
    if (url.pathname === '/ws/kiwisdr-waterfall') {
      if (server.upgrade(req, { data: { kind: 'kiwi-waterfall' } })) return;
      return new Response('Upgrade failed', { status: 500 });
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws: { data: SocketData; send: (data: ArrayBuffer | string) => void; close: () => void }) {
      if (ws.data.kind === 'radio-audio') {
        const listener = (pcm: Int16Array) => ws.send(pcm.buffer as ArrayBuffer);
        ws.data.listener = listener;
        registerAudioListener(listener).then((result) => {
          if (!result.ok) {
            ws.send(JSON.stringify({ error: result.error }));
            ws.close();
          }
        });
      } else if (ws.data.kind === 'kiwi-audio') {
        const listener = (pcm: Int16Array) => ws.send(pcm.buffer as ArrayBuffer);
        ws.data.listener = listener;
        registerKiwiAudioListener(listener).then((result) => {
          if (!result.ok) {
            ws.send(JSON.stringify({ error: result.error }));
            ws.close();
          }
        });
      } else if (ws.data.kind === 'kiwi-waterfall') {
        const listener = (bins: Uint8Array) => ws.send(bins.buffer as ArrayBuffer);
        ws.data.listener = listener;
        registerKiwiWaterfallListener(listener).then((result) => {
          if (!result.ok) {
            ws.send(JSON.stringify({ error: result.error }));
            ws.close();
          }
        });
      }
    },
    close(ws: { data: SocketData }) {
      if (!ws.data.listener) return;
      if (ws.data.kind === 'radio-audio') unregisterAudioListener(ws.data.listener);
      else if (ws.data.kind === 'kiwi-audio') unregisterKiwiAudioListener(ws.data.listener);
      else if (ws.data.kind === 'kiwi-waterfall') unregisterKiwiWaterfallListener(ws.data.listener);
    },
    message() {
      // No messages expected from the client -- audio/waterfall only flow one way.
    },
  },
};
