/**
 * Discord channel plugin. Registers a Discord bot client with the channel
 * registry; the lifecycle runs through `startRegisteredChannels`.
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
  createDiscordAdapter,
  isDiscordChatId,
  sendDirectMessage,
  validateBotToken,
} from '../discord.js';

const logger = pino({ name: 'mozi:channel:discord' });

export const discordPlugin: ChannelPlugin = {
  id: 'discord',
  label: 'Discord',
  description: 'Bot connected via the Discord Gateway (discord.js).',
  docsPath: 'docs/channels/discord.md',
  envKeys: ['DISCORD_BOT_TOKEN'],
  status: 'stable',
  capabilities: { direction: 'bidirectional', inboundMedia: false, outboundMedia: false, proactive: true, editing: false, deletion: false },

  isConfigured(env = process.env) {
    return Boolean(env.DISCORD_BOT_TOKEN?.trim());
  },

  isChatId(value: string) {
    return isDiscordChatId(value);
  },

  async start(ctx: ChannelStartContext): Promise<ChannelRuntime | null> {
    const token = process.env.DISCORD_BOT_TOKEN?.trim();
    if (!token) return null;
    try {
      const adapter = await createDiscordAdapter(token, ctx.handler);
      return {
        async stop() {
          await adapter.stop();
        },
        async sendDirect(chatId, text) {
          if (!isDiscordChatId(chatId)) return false;
          await sendDirectMessage(adapter.client, chatId, text);
          return true;
        },
      };
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to start Discord adapter',
      );
      return null;
    }
  },

  async runWizard({ prompts }: ChannelWizardContext): Promise<ChannelWizardResult | null> {
    prompts.log.info('Discord setup:');
    prompts.log.info('1. Go to https://discord.com/developers/applications and create an application.');
    prompts.log.info('2. "Bot" tab → Reset Token → copy the token.');
    prompts.log.info('3. Enable Privileged Gateway Intents → MESSAGE CONTENT INTENT.');
    prompts.log.info('4. "OAuth2 → URL Generator" → scopes: bot / applications.commands.');
    prompts.log.info('   Bot permissions: Send Messages, Read Message History.');
    prompts.log.info('5. Open the generated URL in your browser to add the bot to a server.');

    const token = await prompts.text({
      message: 'Discord bot token:',
      placeholder: 'MTI1...ABCdef',
      validate: (v) => (!v?.trim() ? 'Bot token is required' : undefined),
    });
    if (prompts.isCancel(token)) return null;

    const trimmed = String(token).trim();
    const spinner = prompts.spinner();
    spinner.start('Validating Discord bot (login + destroy)...');
    const result = await validateBotToken(trimmed);
    if (!result.valid) {
      spinner.stop(`Invalid token: ${result.error ?? 'login refused'}. Not saved.`);
      return null;
    }
    spinner.stop(`Discord bot: ${result.tag}`);
    return { env: { DISCORD_BOT_TOKEN: trimmed } };
  },
};
