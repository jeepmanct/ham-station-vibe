import { getAlertConfig } from './alertConfig';

// Discord's message content cap -- a webhook POST with more than this in
// `content` is rejected outright rather than silently truncated, so this
// trims client-side instead of finding out via a 400 from a real alert.
const DISCORD_CONTENT_LIMIT = 2000;

/**
 * Sends a message via a Discord incoming webhook -- no bot, no OAuth, just
 * POST { content } to the per-channel URL the user pastes in from
 * Discord's own "Edit Channel > Integrations > Webhooks" screen. The
 * webhook URL itself is the only credential (same bearer-token shape as
 * ntfy's topic name, just non-guessable rather than merely obscure), so
 * it's stored/returned the same way SMTP's password is -- never round-
 * tripped back to the browser after saving.
 */
export async function sendDiscordAlert(title: string, message: string): Promise<void> {
  const { discord } = getAlertConfig();
  if (!discord) {
    throw new Error('Discord alerting is not configured — set it up under Admin.');
  }

  const content = `**${title}**\n${message}`.slice(0, DISCORD_CONTENT_LIMIT);

  const res = await fetch(discord.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook request failed: HTTP ${res.status}`);
  }
}
