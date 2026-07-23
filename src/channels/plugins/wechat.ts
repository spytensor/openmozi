/**
 * WeChat iLink Bot channel plugin.
 *
 * WeChat's runtime is currently started from `src/index.ts` via
 * `startWeChatPolling`. This plugin only owns metadata and wizard UX; the
 * boot path will be unified later.
 */

import type { ChannelPlugin, ChannelWizardContext, ChannelWizardResult } from '../registry.js';
import { isWeChatUserId } from '../wechat.js';

export const wechatPlugin: ChannelPlugin = {
  id: 'wechat',
  label: 'WeChat (iLink Bot)',
  description: 'Personal WeChat via the ClawBot / iLink Bot bridge (QR-code pairing).',
  docsPath: 'docs/channels/wechat.md',
  envKeys: ['WECHAT_BOT_TOKEN'],
  status: 'beta',
  capabilities: { direction: 'bidirectional', inboundMedia: false, outboundMedia: false, proactive: false, editing: false, deletion: false },

  isConfigured(env = process.env) {
    return Boolean(env.WECHAT_BOT_TOKEN?.trim());
  },

  isChatId(value: string) {
    return isWeChatUserId(value);
  },

  async runWizard({ prompts }: ChannelWizardContext): Promise<ChannelWizardResult | null> {
    prompts.log.info('WeChat iLink Bot setup:');
    prompts.log.info('1. Enable ClawBot in WeChat: Me → Settings → Plugins');
    prompts.log.info('2. Run: npx -y @tencent-weixin/openclaw-weixin-cli@latest install');
    prompts.log.info('3. Scan the QR code — the CLI will print your bot_token.');

    const token = await prompts.text({
      message: 'WeChat Bot Token (bot_token from the pairing CLI):',
      placeholder: 'eyJ...',
      validate: v => (!v?.trim() ? 'Bot token is required' : undefined),
    });
    if (prompts.isCancel(token)) return null;

    return { env: { WECHAT_BOT_TOKEN: String(token).trim() } };
  },
};
