/**
 * Slack channel plugin (Socket Mode).
 */

import pino from 'pino';
import type {
  ChannelPlugin,
  ChannelRuntime,
  ChannelStartContext,
  ChannelWizardContext,
  ChannelWizardResult,
} from '../registry.js';
import {
  createSlackAdapter,
  isSlackChatId,
  sendDirectMessage,
  validateBotToken,
} from '../slack.js';

const logger = pino({ name: 'mozi:channel:slack' });

export const slackPlugin: ChannelPlugin = {
  id: 'slack',
  label: 'Slack',
  description: 'Socket-Mode bot (no public webhook needed).',
  docsPath: 'docs/channels/slack.md',
  envKeys: ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN'],
  status: 'stable',
  capabilities: { direction: 'bidirectional', inboundMedia: false, outboundMedia: false, proactive: true, editing: false, deletion: false },

  isConfigured(env = process.env) {
    return Boolean(env.SLACK_APP_TOKEN?.trim() && env.SLACK_BOT_TOKEN?.trim());
  },

  isChatId(value: string) {
    return isSlackChatId(value);
  },

  async start(ctx: ChannelStartContext): Promise<ChannelRuntime | null> {
    const appToken = process.env.SLACK_APP_TOKEN?.trim();
    const botToken = process.env.SLACK_BOT_TOKEN?.trim();
    if (!appToken || !botToken) return null;
    try {
      const adapter = await createSlackAdapter(appToken, botToken, ctx.handler);
      return {
        async stop() {
          await adapter.stop();
        },
        async sendDirect(chatId, text) {
          if (!isSlackChatId(chatId)) return false;
          await sendDirectMessage(adapter.web, chatId, text);
          return true;
        },
      };
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to start Slack adapter');
      return null;
    }
  },

  async runWizard({ prompts }: ChannelWizardContext): Promise<ChannelWizardResult | null> {
    prompts.log.info('Slack setup (Socket Mode):');
    prompts.log.info('1. https://api.slack.com/apps → Create New App → From scratch.');
    prompts.log.info('2. Socket Mode → Enable; generate an App-Level Token with scope `connections:write` (xapp-...).');
    prompts.log.info('3. OAuth & Permissions → Bot Token Scopes: `chat:write`, `im:history`, `channels:history`, `groups:history`, `mpim:history`, `app_mentions:read`.');
    prompts.log.info('4. Event Subscriptions → Enable → Subscribe to bot events: `message.im`, `message.channels`, `app_mention`.');
    prompts.log.info('5. Install App to Workspace → copy Bot User OAuth Token (xoxb-...).');

    const appToken = await prompts.text({
      message: 'Slack App-Level Token (xapp-...):',
      placeholder: 'xapp-1-...',
      validate: (v) =>
        !v?.trim() ? 'App token is required' : !v.trim().startsWith('xapp-') ? 'Must start with xapp-' : undefined,
    });
    if (prompts.isCancel(appToken)) return null;

    const botToken = await prompts.text({
      message: 'Slack Bot User OAuth Token (xoxb-...):',
      placeholder: 'xoxb-...',
      validate: (v) =>
        !v?.trim() ? 'Bot token is required' : !v.trim().startsWith('xoxb-') ? 'Must start with xoxb-' : undefined,
    });
    if (prompts.isCancel(botToken)) return null;

    const spinner = prompts.spinner();
    spinner.start('Validating Slack bot token (auth.test)...');
    const result = await validateBotToken(String(botToken));
    if (!result.valid) {
      spinner.stop(`Invalid bot token: ${result.error ?? 'auth.test failed'}. Not saved.`);
      return null;
    }
    spinner.stop(`Slack workspace: ${result.teamName ?? '(unknown)'}${result.user ? ` as @${result.user}` : ''}`);
    return {
      env: {
        SLACK_APP_TOKEN: String(appToken).trim(),
        SLACK_BOT_TOKEN: String(botToken).trim(),
      },
    };
  },
};
