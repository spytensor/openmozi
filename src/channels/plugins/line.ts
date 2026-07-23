/**
 * LINE channel plugin — webhook-based.
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
  createLineAdapter,
  isLineChatId,
  sendDirectMessage,
  validateAccessToken,
} from '../line.js';

const logger = pino({ name: 'mozi:channel:line' });

export const linePlugin: ChannelPlugin = {
  id: 'line',
  label: 'LINE',
  description: 'LINE Messaging API — requires a public HTTPS webhook URL.',
  docsPath: 'docs/channels/line.md',
  envKeys: ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET'],
  status: 'stable',
  capabilities: { direction: 'bidirectional', inboundMedia: false, outboundMedia: false, proactive: true, editing: false, deletion: false },

  isConfigured(env = process.env) {
    return Boolean(env.LINE_CHANNEL_ACCESS_TOKEN?.trim() && env.LINE_CHANNEL_SECRET?.trim());
  },

  isChatId(value: string) {
    return isLineChatId(value);
  },

  async start(ctx: ChannelStartContext): Promise<ChannelRuntime | null> {
    const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
    const channelSecret = process.env.LINE_CHANNEL_SECRET?.trim();
    if (!accessToken || !channelSecret) return null;
    if (!ctx.fastify) {
      logger.warn('LINE channel requires the Fastify server — skipping');
      return null;
    }
    try {
      const adapter = await createLineAdapter({
        fastify: ctx.fastify,
        accessToken,
        channelSecret,
        handler: ctx.handler,
      });
      return {
        async stop() {
          await adapter.stop();
        },
        async sendDirect(chatId, text) {
          if (!isLineChatId(chatId)) return false;
          await sendDirectMessage(adapter.client, chatId, text);
          return true;
        },
      };
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to start LINE adapter');
      return null;
    }
  },

  async runWizard({ prompts }: ChannelWizardContext): Promise<ChannelWizardResult | null> {
    prompts.log.info('LINE setup (Messaging API):');
    prompts.log.info('1. https://developers.line.biz/console → Create a Provider, then a Messaging API channel.');
    prompts.log.info('2. Channel access token (long-lived): Messaging API tab → Issue.');
    prompts.log.info('3. Channel secret: Basic settings tab.');
    prompts.log.info('4. Webhook URL: Messaging API tab → set to https://<your-public-domain>/webhooks/line');
    prompts.log.info('   (Use ngrok/cloudflared if MOZI is on a laptop.) Enable "Use webhook".');
    prompts.log.info('5. Disable Auto-reply messages and greeting messages (same tab).');

    const accessToken = await prompts.text({
      message: 'LINE channel access token (long-lived):',
      placeholder: '...',
      validate: (v) => (!v?.trim() ? 'Access token is required' : undefined),
    });
    if (prompts.isCancel(accessToken)) return null;

    const channelSecret = await prompts.text({
      message: 'LINE channel secret:',
      placeholder: '...',
      validate: (v) => (!v?.trim() ? 'Channel secret is required' : undefined),
    });
    if (prompts.isCancel(channelSecret)) return null;

    const spinner = prompts.spinner();
    spinner.start('Validating LINE access token (/v2/bot/info)...');
    const result = await validateAccessToken(String(accessToken));
    if (!result.valid) {
      spinner.stop(`Invalid token: ${result.error ?? 'token rejected'}. Not saved.`);
      return null;
    }
    spinner.stop(`LINE bot: ${result.botName ?? '(no display name)'}`);
    return {
      env: {
        LINE_CHANNEL_ACCESS_TOKEN: String(accessToken).trim(),
        LINE_CHANNEL_SECRET: String(channelSecret).trim(),
      },
    };
  },
};
