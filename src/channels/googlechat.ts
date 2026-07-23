/**
 * Google Chat — outgoing-only via Incoming Webhook.
 *
 * Uses the per-space Incoming Webhook URL that Google Chat provides.
 * This is enough to deliver proactive notifications (reminders, task
 * completion, alerts) from MOZI into a Google Chat space. Bi-directional
 * messaging (users chatting with MOZI inside Google Chat) requires a
 * Google Workspace bot app + Cloud project and is deferred to a future
 * release — see docs/channels/UNSUPPORTED.md.
 *
 * chatId convention: `gchat:<spaceKey>` where spaceKey is a user-chosen
 * label (we store the URL in env under GCHAT_WEBHOOK_<SPACEKEY>). The
 * onboarding wizard only supports a single default space for simplicity;
 * power users can set additional env vars by hand.
 */

import pino from 'pino';

const logger = pino({ name: 'mozi:googlechat' });

export const GCHAT_CHATID_PREFIX = 'gchat:';
export const GCHAT_MAX_LENGTH = 4000; // Google Chat's text limit is 4096

export function isGoogleChatId(value: string): boolean {
  return value.startsWith(GCHAT_CHATID_PREFIX);
}

export function splitMessage(text: string, maxLength = GCHAT_MAX_LENGTH): string[] {
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

/**
 * Look up the webhook URL for a given chatId. Reads from env using the
 * suffix after the `gchat:` prefix (uppercased, non-alphanumerics
 * stripped) — e.g. `gchat:team-ops` → `GCHAT_WEBHOOK_TEAMOPS`.
 */
export function resolveWebhookUrl(chatId: string, env = process.env): string | null {
  if (!chatId.startsWith(GCHAT_CHATID_PREFIX)) return null;
  const key = chatId.slice(GCHAT_CHATID_PREFIX.length).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!key) return null;
  const url = env[`GCHAT_WEBHOOK_${key}`];
  return url?.trim() || null;
}

/** Validate an Incoming Webhook URL by posting a test ping. */
export async function validateWebhookUrl(
  url: string,
): Promise<{ valid: boolean; error?: string }> {
  const trimmed = url.trim();
  if (!/^https:\/\/chat\.googleapis\.com\/v1\/spaces\/[^/]+\/messages/.test(trimmed)) {
    return {
      valid: false,
      error: 'URL must start with https://chat.googleapis.com/v1/spaces/…/messages',
    };
  }
  try {
    const response = await fetch(trimmed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text: '✅ Agent Runtime connection test.' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return { valid: true };
    const body = await response.text().catch(() => '');
    return { valid: false, error: `HTTP ${response.status}${body ? `: ${body.slice(0, 120)}` : ''}` };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Post a text message to the webhook URL, chunking as necessary. */
export async function sendWebhookMessage(url: string, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text: chunk }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Google Chat webhook failed: HTTP ${response.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    }
  }
}

/**
 * Send a proactive message to a Google Chat space — the adapter API
 * `sendDirect` wraps this. Returns false if the chatId doesn't map to
 * a configured webhook URL.
 */
export async function sendDirectMessage(chatId: string, text: string): Promise<boolean> {
  const url = resolveWebhookUrl(chatId);
  if (!url) {
    logger.warn({ chatId }, 'No Google Chat webhook configured for this chatId');
    return false;
  }
  await sendWebhookMessage(url, text);
  return true;
}

/** For sanity/testing: accept any env and check if at least one webhook is configured. */
export function hasAnyWebhookConfigured(env = process.env): boolean {
  return Object.keys(env).some((k) => k.startsWith('GCHAT_WEBHOOK_') && Boolean(env[k]?.trim()));
}
