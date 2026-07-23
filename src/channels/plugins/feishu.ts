/**
 * Feishu / Lark channel plugin (WSClient mode — no public URL required).
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
  createFeishuAdapter,
  isFeishuChatId,
  sendDirectMessage,
  validateAppCredentials,
} from '../feishu.js';

const logger = pino({ name: 'mozi:channel:feishu' });

export const feishuPlugin: ChannelPlugin = {
  id: 'feishu',
  label: 'Feishu / Lark',
  description: 'Feishu (国内) and Lark (international) via WebSocket long-connection.',
  docsPath: 'docs/channels/feishu.md',
  envKeys: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_DOMAIN'],
  status: 'stable',
  capabilities: { direction: 'bidirectional', inboundMedia: false, outboundMedia: false, proactive: true, editing: false, deletion: false },

  isConfigured(env = process.env) {
    return Boolean(env.FEISHU_APP_ID?.trim() && env.FEISHU_APP_SECRET?.trim());
  },

  isChatId(value: string) {
    return isFeishuChatId(value);
  },

  async start(ctx: ChannelStartContext): Promise<ChannelRuntime | null> {
    const appId = process.env.FEISHU_APP_ID?.trim();
    const appSecret = process.env.FEISHU_APP_SECRET?.trim();
    if (!appId || !appSecret) return null;
    const domainEnv = process.env.FEISHU_DOMAIN?.trim().toLowerCase();
    const domain: 'feishu' | 'lark' = domainEnv === 'lark' ? 'lark' : 'feishu';
    try {
      const adapter = await createFeishuAdapter({ appId, appSecret, domain, handler: ctx.handler });
      return {
        async stop() {
          await adapter.stop();
        },
        async sendDirect(chatId, text) {
          if (!isFeishuChatId(chatId)) return false;
          await sendDirectMessage(adapter.client, chatId, text);
          return true;
        },
      };
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to start Feishu adapter');
      return null;
    }
  },

  async runWizard({ prompts }: ChannelWizardContext): Promise<ChannelWizardResult | null> {
    prompts.log.info('Feishu / Lark setup:');
    prompts.log.info('1. https://open.feishu.cn/app (or https://open.larksuite.com/app) → Create Custom App.');
    prompts.log.info('2. Credentials & Basic Info → copy App ID + App Secret.');
    prompts.log.info('3. Bot page → enable the bot, set name/avatar.');
    prompts.log.info('4. Permissions → add: im:message, im:message.receive_v1, im:chat, im:message:send_as_bot.');
    prompts.log.info('5. Event Subscriptions → set delivery to "Long Connection (WebSocket)".');
    prompts.log.info('6. Subscribe: im.message.receive_v1');
    prompts.log.info('7. Publish app version → wait for admin approval.');

    const domain = await prompts.select({
      message: 'Which environment?',
      options: [
        { value: 'feishu', label: 'Feishu (feishu.cn, 国内)' },
        { value: 'lark', label: 'Lark (larksuite.com, international)' },
      ],
      initialValue: 'feishu',
    });
    if (prompts.isCancel(domain)) return null;

    const appId = await prompts.text({
      message: 'App ID:',
      placeholder: 'cli_a...',
      validate: (v) => (!v?.trim() ? 'App ID is required' : undefined),
    });
    if (prompts.isCancel(appId)) return null;

    const appSecret = await prompts.text({
      message: 'App Secret:',
      placeholder: '...',
      validate: (v) => (!v?.trim() ? 'App secret is required' : undefined),
    });
    if (prompts.isCancel(appSecret)) return null;

    const spinner = prompts.spinner();
    spinner.start('Validating Feishu credentials (app_access_token/internal)...');
    const result = await validateAppCredentials(
      String(appId),
      String(appSecret),
      domain as 'feishu' | 'lark',
    );
    if (!result.valid) {
      spinner.stop(`Invalid credentials: ${result.error ?? 'rejected'}. Not saved.`);
      return null;
    }
    spinner.stop('Feishu credentials OK.');
    return {
      env: {
        FEISHU_APP_ID: String(appId).trim(),
        FEISHU_APP_SECRET: String(appSecret).trim(),
        FEISHU_DOMAIN: String(domain),
      },
    };
  },
};
