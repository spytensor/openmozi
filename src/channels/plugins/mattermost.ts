import pino from 'pino';
import type {
  ChannelPlugin,
  ChannelRuntime,
  ChannelStartContext,
  ChannelWizardContext,
  ChannelWizardResult,
} from '../registry.js';
import {
  createMattermostAdapter,
  isMattermostChatId,
  sendDirectMessage,
  validateCredentials,
} from '../mattermost.js';

const logger = pino({ name: 'mozi:channel:mattermost' });

export const mattermostPlugin: ChannelPlugin = {
  id: 'mattermost',
  label: 'Mattermost',
  description: 'Self-hosted or cloud Mattermost server via @mattermost/client.',
  docsPath: 'docs/channels/mattermost.md',
  envKeys: ['MATTERMOST_URL', 'MATTERMOST_ACCESS_TOKEN'],
  status: 'stable',
  capabilities: { direction: 'bidirectional', inboundMedia: false, outboundMedia: false, proactive: true, editing: false, deletion: false },

  isConfigured(env = process.env) {
    return Boolean(env.MATTERMOST_URL?.trim() && env.MATTERMOST_ACCESS_TOKEN?.trim());
  },

  isChatId(value: string) {
    return isMattermostChatId(value);
  },

  async start(ctx: ChannelStartContext): Promise<ChannelRuntime | null> {
    const serverUrl = process.env.MATTERMOST_URL?.trim();
    const accessToken = process.env.MATTERMOST_ACCESS_TOKEN?.trim();
    if (!serverUrl || !accessToken) return null;
    try {
      const adapter = await createMattermostAdapter({ serverUrl, accessToken, handler: ctx.handler });
      return {
        async stop() {
          await adapter.stop();
        },
        async sendDirect(chatId, text) {
          if (!isMattermostChatId(chatId)) return false;
          await sendDirectMessage(adapter.rest, chatId, text);
          return true;
        },
      };
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to start Mattermost adapter');
      return null;
    }
  },

  async runWizard({ prompts }: ChannelWizardContext): Promise<ChannelWizardResult | null> {
    prompts.log.info('Mattermost setup:');
    prompts.log.info('1. Admin Console → Integrations → enable "Personal Access Tokens" (if not already).');
    prompts.log.info('2. As the bot user: Profile → Security → Personal Access Tokens → Create.');
    prompts.log.info('3. Give it a name + description, copy the token.');
    prompts.log.info('4. Invite the bot to any channel you want it to respond in.');

    const serverUrl = await prompts.text({
      message: 'Mattermost server URL:',
      placeholder: 'https://chat.example.com',
      validate: (v) =>
        !v?.trim() ? 'URL required' : !/^https?:\/\//.test(v) ? 'Must start with http(s)://' : undefined,
    });
    if (prompts.isCancel(serverUrl)) return null;

    const accessToken = await prompts.password({ message: 'Personal Access Token:' });
    if (prompts.isCancel(accessToken)) return null;

    const spinner = prompts.spinner();
    spinner.start('Validating Mattermost token (/api/v4/users/me)...');
    const result = await validateCredentials({
      serverUrl: String(serverUrl).trim(),
      accessToken: String(accessToken),
    });
    if (!result.valid) {
      spinner.stop(`Invalid: ${result.error ?? 'rejected'}. Not saved.`);
      return null;
    }
    spinner.stop(`Mattermost user: @${result.username ?? result.userId}`);

    return {
      env: {
        MATTERMOST_URL: String(serverUrl).trim().replace(/\/+$/, ''),
        MATTERMOST_ACCESS_TOKEN: String(accessToken),
      },
    };
  },
};
