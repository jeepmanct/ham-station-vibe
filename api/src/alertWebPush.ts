import webpush from 'web-push';
import { db } from './db';
import { getSiteUrl } from './alertConfig';

type VapidKeys = { publicKey: string; privateKey: string };

// Generated once, lazily, and persisted -- every subscribed browser trusts
// this exact keypair, so regenerating it on a later run would silently
// invalidate every existing subscription (they'd all need to re-subscribe).
function getOrCreateVapidKeys(): VapidKeys {
  const row = db.query('SELECT public_key, private_key FROM vapid_keys WHERE id = 1').get() as
    | { public_key: string; private_key: string }
    | null;
  if (row) return { publicKey: row.public_key, privateKey: row.private_key };

  const keys = webpush.generateVAPIDKeys();
  db.query('INSERT INTO vapid_keys (id, public_key, private_key) VALUES (1, ?, ?)').run(keys.publicKey, keys.privateKey);
  return keys;
}

export function getVapidPublicKey(): string {
  return getOrCreateVapidKeys().publicKey;
}

function configureWebPush() {
  const keys = getOrCreateVapidKeys();
  // VAPID requires a contact subject that's either an https:// URL or a
  // mailto: address -- prefer the site's own URL (set in .env) since that's
  // the more specific/identifiable contact; a bare "mailto:" placeholder
  // when neither is known is still accepted by every push service tested.
  const siteUrl = getSiteUrl();
  const subject = siteUrl ?? 'mailto:admin@localhost';
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
}

type Subscription = { id: number; endpoint: string; p256dh: string; auth: string };

/**
 * Sends a native Web Push notification to every device subscribed via
 * /admin's "Enable on this device" flow. Unlike email/ntfy (one
 * destination), there can be several subscribed browsers at once, so this
 * fans out to all of them -- a single dead subscription (410 Gone, the
 * browser unsubscribed or cleared site data) is cleaned up and doesn't fail
 * the others.
 */
export async function sendWebPushAlert(title: string, message: string): Promise<void> {
  const subs = db.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions').all() as Subscription[];
  if (subs.length === 0) {
    throw new Error('No device is subscribed to browser push yet — click "Enable on this device" under Admin.');
  }

  configureWebPush();
  const siteUrl = getSiteUrl();
  const payload = JSON.stringify({ title, body: message, url: siteUrl ?? '/' });

  let delivered = 0;
  let lastError: unknown;
  for (const sub of subs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
      delivered++;
    } catch (err) {
      const statusCode = (err as { statusCode?: number })?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        db.query('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      } else {
        lastError = err;
      }
    }
  }

  if (delivered === 0) {
    throw lastError instanceof Error ? lastError : new Error('Web push delivery failed for every subscribed device.');
  }
}
