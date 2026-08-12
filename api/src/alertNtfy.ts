import { getAlertConfig } from './alertConfig';

/**
 * Sends a push notification via ntfy.sh's public server — no account, no
 * API key, just POST to https://ntfy.sh/{topic}. The topic name is the
 * only thing standing between "your alerts" and anyone else who guesses
 * it (ntfy.sh's public server has no per-topic auth), so /admin nudges
 * toward a long random one rather than something guessable.
 */
export async function sendNtfyAlert(title: string, message: string): Promise<void> {
  const { ntfy } = getAlertConfig();
  if (!ntfy) {
    throw new Error('Push alerting is not configured — set it up under Admin.');
  }

  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(ntfy.topic)}`, {
    method: 'POST',
    // ntfy's header values must be ASCII — fine here since alert titles are
    // plain callsigns/counts, never operator-entered free text.
    headers: { Title: title },
    body: message,
  });
  if (!res.ok) {
    throw new Error(`ntfy.sh request failed: HTTP ${res.status}`);
  }
}
