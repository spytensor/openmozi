/**
 * Telegram channel plugin — metadata, wizard, chatId routing.
 *
 * Note: Telegram's runtime (bot creation, long-polling, progress bridge) is
 * currently managed directly from `src/index.ts` because of deep coupling to
 * the shared `Telegraf` instance. This plugin therefore omits `start()` and
 * only provides configuration metadata plus wizard UX. When we later unify
 * the boot path, `start()` can be added here without touching callers.
 */

import type { ChannelPlugin, ChannelWizardContext, ChannelWizardResult } from '../registry.js';
import { validateBotToken, isTelegramChatId } from '../telegram.js';

export const telegramPlugin: ChannelPlugin = {
  id: 'telegram',
  label: 'Telegram',
  description: 'Standard Telegram bot via @BotFather.',
  docsPath: 'docs/channels/telegram.md',
  envKeys: ['TELEGRAM_BOT_TOKEN'],
  status: 'stable',
  capabilities: { direction: 'bidirectional', inboundMedia: true, outboundMedia: true, proactive: true, editing: false, deletion: false },

  isConfigured(env = process.env) {
    return Boolean(env.TELEGRAM_BOT_TOKEN?.trim());
  },

  isChatId(value: string) {
    return isTelegramChatId(value);
  },

  async runWizard({ prompts }: ChannelWizardContext): Promise<ChannelWizardResult | null> {
    const token = await prompts.text({
      message: 'Telegram bot token from @BotFather:',
      placeholder: '123456:ABC-DEF...',
      validate: v => (!v?.trim() ? 'Bot token is required' : undefined),
    });
    if (prompts.isCancel(token)) return null;

    const spinner = prompts.spinner();
    spinner.start('Validating Telegram bot...');
    const result = await validateBotToken(String(token).trim());
    if (!result.valid) {
      spinner.stop('Invalid token — Telegram skipped.');
      return null;
    }
    spinner.stop(`Telegram bot: @${result.username}`);
    return { env: { TELEGRAM_BOT_TOKEN: String(token).trim() } };
  },
};
