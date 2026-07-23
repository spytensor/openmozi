/**
 * Google Chat channel plugin — outgoing notifications via Incoming
 * Webhook URLs. Interactive (user ↔ MOZI) support is deferred because it
 * requires Google Workspace + Cloud project + JWT verification.
 */

import type {
  ChannelPlugin,
  ChannelRuntime,
  ChannelStartContext,
  ChannelWizardContext,
  ChannelWizardResult,
} from '../registry.js';
import {
  hasAnyWebhookConfigured,
  isGoogleChatId,
  sendDirectMessage,
  validateWebhookUrl,
} from '../googlechat.js';

function normalizeSpaceKey(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export const googleChatPlugin: ChannelPlugin = {
  id: 'googlechat',
  label: 'Google Chat (notifications)',
  description: 'Outgoing Incoming-Webhook notifications into Google Chat spaces.',
  docsPath: 'docs/channels/googlechat.md',
  envKeys: [] /* dynamic: GCHAT_WEBHOOK_<SPACEKEY> */,
  status: 'beta',
  capabilities: { direction: 'outgoing_only', inboundMedia: false, outboundMedia: false, proactive: true, editing: false, deletion: false },

  isConfigured(env = process.env) {
    return hasAnyWebhookConfigured(env);
  },

  isChatId(value: string) {
    return isGoogleChatId(value);
  },

  // Outgoing-only: no start/stop runtime; the proactive sender is registered
  // when the plugin is selected.
  async start(_ctx: ChannelStartContext): Promise<ChannelRuntime | null> {
    if (!hasAnyWebhookConfigured()) return null;
    return {
      stop() {
        /* no-op */
      },
      async sendDirect(chatId, text) {
        if (!isGoogleChatId(chatId)) return false;
        return sendDirectMessage(chatId, text);
      },
    };
  },

  async runWizard({ prompts }: ChannelWizardContext): Promise<ChannelWizardResult | null> {
    prompts.log.info('Google Chat (Incoming Webhook) setup:');
    prompts.log.info('1. Open the target Google Chat space → ⋮ → Apps & integrations → Webhooks.');
    prompts.log.info('2. Add webhook → Name it (e.g. "MOZI") → Save → copy the URL.');
    prompts.log.info('3. (Optional) Repeat for each space; each gets its own env var.');
    prompts.log.info('Note: interactive bot mode (user chats with MOZI) is deferred — see docs/channels/UNSUPPORTED.md.');

    const spaceKey = await prompts.text({
      message: 'A short nickname for this space (alphanumerics, e.g. "team-ops"):',
      placeholder: 'team-ops',
      validate: (v) =>
        !v?.trim() ? 'Nickname is required' : !/[A-Za-z0-9]/.test(v) ? 'Must contain at least one alphanumeric' : undefined,
    });
    if (prompts.isCancel(spaceKey)) return null;
    const normalized = normalizeSpaceKey(String(spaceKey));

    const url = await prompts.text({
      message: 'Incoming Webhook URL:',
      placeholder: 'https://chat.googleapis.com/v1/spaces/...',
      validate: (v) =>
        !v?.trim() ? 'URL is required' : !v.startsWith('https://chat.googleapis.com/') ? 'Must be a chat.googleapis.com URL' : undefined,
    });
    if (prompts.isCancel(url)) return null;

    const spinner = prompts.spinner();
    spinner.start('Posting a test message to the space...');
    const result = await validateWebhookUrl(String(url));
    if (!result.valid) {
      spinner.stop(`Webhook failed: ${result.error ?? 'rejected'}. Not saved.`);
      return null;
    }
    spinner.stop('Test message delivered.');

    return {
      env: {
        [`GCHAT_WEBHOOK_${normalized}`]: String(url).trim(),
      },
    };
  },
};
