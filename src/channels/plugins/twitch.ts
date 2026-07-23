import pino from 'pino';
import type {
  ChannelPlugin,
  ChannelRuntime,
  ChannelStartContext,
  ChannelWizardContext,
  ChannelWizardResult,
} from '../registry.js';
import {
  createTwitchAdapter,
  isTwitchChatId,
  parseTwitchChannels,
  sendDirectMessage,
  validateOAuthToken,
} from '../twitch.js';

const logger = pino({ name: 'mozi:channel:twitch' });

export const twitchPlugin: ChannelPlugin = {
  id: 'twitch',
  label: 'Twitch Chat',
  description: 'Twitch chat bot (tmi.js over IRC-WSS).',
  docsPath: 'docs/channels/twitch.md',
  envKeys: ['TWITCH_USERNAME', 'TWITCH_OAUTH_TOKEN', 'TWITCH_CHANNELS'],
  status: 'stable',
  capabilities: { direction: 'bidirectional', inboundMedia: false, outboundMedia: false, proactive: true, editing: false, deletion: false },

  isConfigured(env = process.env) {
    return Boolean(env.TWITCH_USERNAME?.trim() && env.TWITCH_OAUTH_TOKEN?.trim());
  },

  isChatId(value: string) {
    return isTwitchChatId(value);
  },

  async start(ctx: ChannelStartContext): Promise<ChannelRuntime | null> {
    const username = process.env.TWITCH_USERNAME?.trim();
    const oauthToken = process.env.TWITCH_OAUTH_TOKEN?.trim();
    if (!username || !oauthToken) return null;
    const channels = parseTwitchChannels(process.env.TWITCH_CHANNELS);
    try {
      const adapter = await createTwitchAdapter({ username, oauthToken, channels, handler: ctx.handler });
      return {
        async stop() {
          await adapter.stop();
        },
        async sendDirect(chatId, text) {
          if (!isTwitchChatId(chatId)) return false;
          await sendDirectMessage(adapter.client, chatId, text);
          return true;
        },
      };
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to start Twitch adapter');
      return null;
    }
  },

  async runWizard({ prompts }: ChannelWizardContext): Promise<ChannelWizardResult | null> {
    prompts.log.info('Twitch Chat setup:');
    prompts.log.info('1. Create a dedicated Twitch account for the bot (optional but recommended).');
    prompts.log.info('2. While logged in as that account, visit https://twitchtokengenerator.com/');
    prompts.log.info('3. Grant scopes: chat:read, chat:edit. Copy the "Access Token".');
    prompts.log.info('4. Mod the bot account in your channel: /mod mozi_bot (lifts rate-limits).');

    const username = await prompts.text({
      message: 'Bot username (your Twitch login, lowercase):',
      placeholder: 'mozi_bot',
      validate: (v) =>
        !v?.trim() ? 'Username is required' : !/^[a-z0-9_]{3,25}$/i.test(v) ? 'Must match Twitch login rules (3–25 chars, a-z/0-9/_)' : undefined,
    });
    if (prompts.isCancel(username)) return null;

    const oauth = await prompts.password({ message: 'OAuth access token (with chat:read, chat:edit):' });
    if (prompts.isCancel(oauth)) return null;

    const channelsRaw = await prompts.text({
      message: 'Channels to join (comma-separated, no #):',
      placeholder: 'your_channel,other_channel',
      defaultValue: '',
    });
    if (prompts.isCancel(channelsRaw)) return null;

    const spinner = prompts.spinner();
    spinner.start('Validating Twitch token (id.twitch.tv/oauth2/validate)...');
    const result = await validateOAuthToken(String(oauth));
    if (!result.valid) {
      spinner.stop(`Invalid: ${result.error ?? 'rejected'}. Not saved.`);
      return null;
    }
    if (result.login && result.login !== String(username).trim().toLowerCase()) {
      spinner.stop(`Token belongs to ${result.login}, but you entered ${username}. Not saved.`);
      return null;
    }
    spinner.stop(`Twitch login: ${result.login ?? '(validated)'}`);

    return {
      env: {
        TWITCH_USERNAME: String(username).trim().toLowerCase(),
        TWITCH_OAUTH_TOKEN: String(oauth),
        TWITCH_CHANNELS: parseTwitchChannels(String(channelsRaw)).join(','),
      },
    };
  },
};
