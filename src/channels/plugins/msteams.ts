import type {
  ChannelPlugin,
  ChannelRuntime,
  ChannelStartContext,
  ChannelWizardContext,
  ChannelWizardResult,
} from '../registry.js';
import {
  hasAnyWebhookConfigured,
  isTeamsChatId,
  sendDirectMessage,
  validateWebhookUrl,
} from '../msteams.js';

function normalizeChannelKey(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export const msTeamsPlugin: ChannelPlugin = {
  id: 'msteams',
  label: 'Microsoft Teams (notifications)',
  description: 'Outgoing Incoming-Webhook notifications into Teams channels.',
  docsPath: 'docs/channels/msteams.md',
  envKeys: [] /* dynamic: TEAMS_WEBHOOK_<CHANNELKEY> */,
  status: 'beta',
  capabilities: { direction: 'outgoing_only', inboundMedia: false, outboundMedia: false, proactive: true, editing: false, deletion: false },

  isConfigured(env = process.env) {
    return hasAnyWebhookConfigured(env);
  },

  isChatId(value: string) {
    return isTeamsChatId(value);
  },

  async start(_ctx: ChannelStartContext): Promise<ChannelRuntime | null> {
    if (!hasAnyWebhookConfigured()) return null;
    return {
      stop() {
        /* no-op */
      },
      async sendDirect(chatId, text) {
        if (!isTeamsChatId(chatId)) return false;
        return sendDirectMessage(chatId, text);
      },
    };
  },

  async runWizard({ prompts }: ChannelWizardContext): Promise<ChannelWizardResult | null> {
    prompts.log.info('Microsoft Teams (Incoming Webhook / Workflow) setup:');
    prompts.log.info('1. In Teams: channel ⋯ → Workflows → "Post to a channel when a webhook request is received".');
    prompts.log.info('   (Legacy O365 Connectors still work on tenants where they have not yet been disabled.)');
    prompts.log.info('2. Name the workflow (e.g. "MOZI") → Next → pick the team + channel → Add workflow.');
    prompts.log.info('3. Copy the generated webhook URL.');
    prompts.log.info('Note: interactive bot mode (user chats with MOZI) requires Azure Bot Services — see docs/channels/UNSUPPORTED.md.');

    const channelKey = await prompts.text({
      message: 'Nickname for this Teams channel (alphanumerics, e.g. "eng-alerts"):',
      placeholder: 'eng-alerts',
      validate: (v) =>
        !v?.trim() ? 'Nickname is required' : !/[A-Za-z0-9]/.test(v) ? 'Must contain at least one alphanumeric' : undefined,
    });
    if (prompts.isCancel(channelKey)) return null;
    const normalized = normalizeChannelKey(String(channelKey));

    const url = await prompts.text({
      message: 'Teams Incoming Webhook URL:',
      placeholder: 'https://<tenant>.webhook.office.com/webhookb2/... or https://prod-...logic.azure.com/...',
      validate: (v) =>
        !v?.trim()
          ? 'URL is required'
          : !/^https:\/\/([a-zA-Z0-9-]+\.)+(webhook\.office\.com|logic\.azure\.com)/.test(v)
            ? 'Must be a webhook.office.com or logic.azure.com URL'
            : undefined,
    });
    if (prompts.isCancel(url)) return null;

    const spinner = prompts.spinner();
    spinner.start('Posting a test message to the channel...');
    const result = await validateWebhookUrl(String(url));
    if (!result.valid) {
      spinner.stop(`Webhook failed: ${result.error ?? 'rejected'}. Not saved.`);
      return null;
    }
    spinner.stop('Test message delivered.');

    return {
      env: {
        [`TEAMS_WEBHOOK_${normalized}`]: String(url).trim(),
      },
    };
  },
};
