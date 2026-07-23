import { describe, it, expect, beforeEach } from 'vitest';
import { channelRegistry } from '../channels/registry.js';
import { installBuiltinChannelPlugins } from '../channels/plugins/index.js';
import { getConfigurableChannels, buildChannelUpdateMenuItems } from './channels.js';

describe('onboarding/channels registry-driven setup', () => {
  beforeEach(() => {
    channelRegistry.clear();
  });

  it('lists only plugins with an interactive wizard', () => {
    installBuiltinChannelPlugins();
    const configurable = getConfigurableChannels();
    const ids = configurable.map((p) => p.id);
    expect(ids).toContain('telegram');
    expect(ids).toContain('wechat');
    // websocket is always-on and exposes no wizard
    expect(ids).not.toContain('websocket');
  });

  it('builds update-menu entries with channel:<id> action values', () => {
    installBuiltinChannelPlugins();
    const items = buildChannelUpdateMenuItems();
    const values = items.map((item) => item.value);
    expect(values).toContain('channel:telegram');
    expect(values).toContain('channel:wechat');
    // Every value starts with channel:
    for (const v of values) {
      expect(v).toMatch(/^channel:/);
    }
  });

  it('distinguishes configured vs unconfigured plugins in the hint', () => {
    installBuiltinChannelPlugins();
    const originalTelegram = process.env.TELEGRAM_BOT_TOKEN;
    try {
      delete process.env.TELEGRAM_BOT_TOKEN;
      const unconfigured = buildChannelUpdateMenuItems().find((i) => i.value === 'channel:telegram');
      expect(unconfigured?.hint).toBe('Add credentials');

      process.env.TELEGRAM_BOT_TOKEN = 'xxx';
      const configured = buildChannelUpdateMenuItems().find((i) => i.value === 'channel:telegram');
      expect(configured?.hint).toBe('Update credentials');
    } finally {
      if (originalTelegram === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = originalTelegram;
    }
  });
});
