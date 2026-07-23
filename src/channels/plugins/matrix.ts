import pino from 'pino';
import type {
  ChannelPlugin,
  ChannelRuntime,
  ChannelStartContext,
  ChannelWizardContext,
  ChannelWizardResult,
} from '../registry.js';
import {
  createMatrixAdapter,
  isMatrixChatId,
  sendDirectMessage,
  validateCredentials,
} from '../matrix.js';

const logger = pino({ name: 'mozi:channel:matrix' });

export const matrixPlugin: ChannelPlugin = {
  id: 'matrix',
  label: 'Matrix',
  description: 'Matrix homeserver (matrix.org or self-hosted, via matrix-js-sdk).',
  docsPath: 'docs/channels/matrix.md',
  envKeys: ['MATRIX_HOMESERVER', 'MATRIX_USER_ID', 'MATRIX_ACCESS_TOKEN'],
  status: 'stable',
  capabilities: { direction: 'bidirectional', inboundMedia: false, outboundMedia: false, proactive: true, editing: false, deletion: false },

  isConfigured(env = process.env) {
    return Boolean(
      env.MATRIX_HOMESERVER?.trim() &&
      env.MATRIX_USER_ID?.trim() &&
      env.MATRIX_ACCESS_TOKEN?.trim(),
    );
  },

  isChatId(value: string) {
    return isMatrixChatId(value);
  },

  async start(ctx: ChannelStartContext): Promise<ChannelRuntime | null> {
    const homeserver = process.env.MATRIX_HOMESERVER?.trim();
    const userId = process.env.MATRIX_USER_ID?.trim();
    const accessToken = process.env.MATRIX_ACCESS_TOKEN?.trim();
    if (!homeserver || !userId || !accessToken) return null;
    try {
      const adapter = await createMatrixAdapter({ homeserver, userId, accessToken, handler: ctx.handler });
      return {
        async stop() {
          await adapter.stop();
        },
        async sendDirect(chatId, text) {
          if (!isMatrixChatId(chatId)) return false;
          await sendDirectMessage(adapter.client, chatId, text);
          return true;
        },
      };
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to start Matrix adapter');
      return null;
    }
  },

  async runWizard({ prompts }: ChannelWizardContext): Promise<ChannelWizardResult | null> {
    prompts.log.info('Matrix setup:');
    prompts.log.info('1. Pick (or choose) a homeserver — matrix.org is the public default; self-hosted works identically.');
    prompts.log.info('2. Create a dedicated user for MOZI on that homeserver.');
    prompts.log.info('3. Sign in as that user in Element Web → Settings → Help & About → Access Token.');
    prompts.log.info('   (Or log in via `curl -X POST .../_matrix/client/v3/login` to get a token.)');
    prompts.log.info('4. Invite @mozi-bot:homeserver.tld to any room you want it to respond in.');

    const homeserver = await prompts.text({
      message: 'Homeserver URL:',
      placeholder: 'https://matrix.org',
      validate: (v) =>
        !v?.trim() ? 'Homeserver URL is required' : !/^https?:\/\//.test(v) ? 'Must include https://' : undefined,
    });
    if (prompts.isCancel(homeserver)) return null;

    const userId = await prompts.text({
      message: 'User ID (full form @user:homeserver.tld):',
      placeholder: '@mozi-bot:matrix.org',
      validate: (v) => (!/^@.+:.+/.test(v ?? '') ? 'Expected @user:homeserver.tld' : undefined),
    });
    if (prompts.isCancel(userId)) return null;

    const accessToken = await prompts.password({
      message: 'Access token (syt_...):',
    });
    if (prompts.isCancel(accessToken)) return null;

    const spinner = prompts.spinner();
    spinner.start('Validating Matrix token (/_matrix/client/v3/account/whoami)...');
    const result = await validateCredentials({
      homeserver: String(homeserver).trim(),
      accessToken: String(accessToken),
    });
    if (!result.valid) {
      spinner.stop(`Invalid: ${result.error ?? 'rejected'}. Not saved.`);
      return null;
    }
    if (result.userId && result.userId !== String(userId).trim()) {
      spinner.stop(`Token belongs to ${result.userId}, but you entered ${userId}. Not saved.`);
      return null;
    }
    spinner.stop(`Matrix user: ${result.userId ?? '(whoami ok)'}`);

    return {
      env: {
        MATRIX_HOMESERVER: String(homeserver).trim().replace(/\/+$/, ''),
        MATRIX_USER_ID: String(userId).trim(),
        MATRIX_ACCESS_TOKEN: String(accessToken),
      },
    };
  },
};
