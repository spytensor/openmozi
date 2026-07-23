/**
 * Entry point for the built-in channel plugin bundle. Importing this module
 * populates the channel registry with every first-party plugin.
 *
 * Ordering matters: plugins listed first appear first in wizard selection
 * and capability listings.
 */

import { channelRegistry, type ChannelPlugin } from '../registry.js';
import { telegramPlugin } from './telegram.js';
import { wechatPlugin } from './wechat.js';
import { websocketPlugin } from './websocket.js';
import { discordPlugin } from './discord.js';
import { slackPlugin } from './slack.js';
import { linePlugin } from './line.js';
import { feishuPlugin } from './feishu.js';
import { googleChatPlugin } from './googlechat.js';
import { msTeamsPlugin } from './msteams.js';
import { ircPlugin } from './irc.js';
import { matrixPlugin } from './matrix.js';
import { mattermostPlugin } from './mattermost.js';
import { twitchPlugin } from './twitch.js';

const BUILT_IN_PLUGINS: readonly ChannelPlugin[] = [
  telegramPlugin,
  wechatPlugin,
  websocketPlugin,
  discordPlugin,
  slackPlugin,
  linePlugin,
  feishuPlugin,
  googleChatPlugin,
  msTeamsPlugin,
  ircPlugin,
  matrixPlugin,
  mattermostPlugin,
  twitchPlugin,
];

/**
 * Install every built-in plugin into the global registry. Idempotent —
 * existing registrations are left alone so tests can call this repeatedly
 * after `channelRegistry.clear()`.
 */
export function installBuiltinChannelPlugins(): void {
  for (const plugin of BUILT_IN_PLUGINS) {
    if (!channelRegistry.get(plugin.id)) {
      channelRegistry.register(plugin);
    }
  }
}

export { BUILT_IN_PLUGINS };
