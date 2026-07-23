/**
 * Microsoft Teams — outgoing-only via Incoming Webhook connector
 * (Workflows in Teams, formerly "Office 365 Connectors").
 *
 * Like Google Chat, this is one-way: MOZI pushes messages into a Teams
 * channel. Interactive bots (user ↔ MOZI) require an Azure Bot Services
 * registration + public URL and are deferred (see UNSUPPORTED.md).
 *
 * chatId convention: `teams:<channelKey>`. Webhook URLs live in env
 * under TEAMS_WEBHOOK_<CHANNELKEY>.
 */

import pino from 'pino';

const logger = pino({ name: 'mozi:msteams' });

export const TEAMS_CHATID_PREFIX = 'teams:';
export const TEAMS_MAX_LENGTH = 27_000; // Teams limit is ~28k for text

export function isTeamsChatId(value: string): boolean {
  return value.startsWith(TEAMS_CHATID_PREFIX);
}

export function splitMessage(text: string, maxLength = TEAMS_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf('\n', maxLength);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', maxLength);
    if (cut <= 0) cut = maxLength;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function resolveWebhookUrl(chatId: string, env = process.env): string | null {
  if (!chatId.startsWith(TEAMS_CHATID_PREFIX)) return null;
  const key = chatId.slice(TEAMS_CHATID_PREFIX.length).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!key) return null;
  return env[`TEAMS_WEBHOOK_${key}`]?.trim() || null;
}

export function hasAnyWebhookConfigured(env = process.env): boolean {
  return Object.keys(env).some((k) => k.startsWith('TEAMS_WEBHOOK_') && Boolean(env[k]?.trim()));
}

/**
 * Validate a Teams Incoming Webhook URL. Supports both the older
 * outlook.office.com pattern and the newer Workflows-provided
 * prod-*.<region>.logic.azure.com pattern.
 */
export async function validateWebhookUrl(
  url: string,
): Promise<{ valid: boolean; error?: string }> {
  const trimmed = url.trim();
  const looksLikeTeams =
    /^https:\/\/([a-zA-Z0-9-]+\.)+(webhook\.office\.com|logic\.azure\.com|logic\.azure\.us|workflows\.(micro|microsoft)\.com)/.test(trimmed) ||
    /^https:\/\/prod-[^.]+\.[a-z-]+\.logic\.azure\.com/.test(trimmed);
  if (!looksLikeTeams) {
    return {
      valid: false,
      error: 'URL does not look like a Teams Incoming Webhook. Expected webhook.office.com or logic.azure.com.',
    };
  }
  try {
    const response = await fetch(trimmed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '✅ Agent Runtime connection test.' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return { valid: true };
    const body = await response.text().catch(() => '');
    return { valid: false, error: `HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}` };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** POST a text message to a Teams webhook. Body uses the simple text field. */
export async function sendWebhookMessage(url: string, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chunk }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Teams webhook failed: HTTP ${response.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    }
  }
}

export async function sendDirectMessage(chatId: string, text: string): Promise<boolean> {
  const url = resolveWebhookUrl(chatId);
  if (!url) {
    logger.warn({ chatId }, 'No Teams webhook configured for this chatId');
    return false;
  }
  await sendWebhookMessage(url, text);
  return true;
}
