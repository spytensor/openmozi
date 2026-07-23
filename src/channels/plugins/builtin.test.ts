import { describe, it, expect, beforeEach } from 'vitest';
import { channelRegistry } from '../registry.js';
import { installBuiltinChannelPlugins, BUILT_IN_PLUGINS } from './index.js';

describe('built-in channel plugins', () => {
  beforeEach(() => {
    channelRegistry.clear();
  });

  it('registers telegram, wechat, and websocket', () => {
    installBuiltinChannelPlugins();
    expect(channelRegistry.get('telegram')).toBeDefined();
    expect(channelRegistry.get('wechat')).toBeDefined();
    expect(channelRegistry.get('websocket')).toBeDefined();
  });

  it('install is idempotent', () => {
    installBuiltinChannelPlugins();
    installBuiltinChannelPlugins();
    expect(channelRegistry.list()).toHaveLength(BUILT_IN_PLUGINS.length);
  });

  it('every built-in plugin has a docs file path under docs/channels', () => {
    for (const plugin of BUILT_IN_PLUGINS) {
      expect(plugin.docsPath).toMatch(/^docs\/channels\/[a-z]+\.md$/);
    }
  });

  it('declares truthful partial-channel capabilities', () => {
    const byId = Object.fromEntries(BUILT_IN_PLUGINS.map(plugin => [plugin.id, plugin.capabilities]));
    expect(byId.googlechat.direction).toBe('outgoing_only');
    expect(byId.msteams.direction).toBe('outgoing_only');
    expect(byId.wechat.proactive).toBe(false);
    expect(byId.line.inboundMedia).toBe(false);
    expect(byId.line.outboundMedia).toBe(false);
    for (const plugin of BUILT_IN_PLUGINS) {
      expect(plugin.capabilities.editing).toBe(false);
      expect(plugin.capabilities.deletion).toBe(false);
    }
  });

  it('telegram isConfigured reads TELEGRAM_BOT_TOKEN', () => {
    installBuiltinChannelPlugins();
    const p = channelRegistry.get('telegram')!;
    expect(p.isConfigured({})).toBe(false);
    expect(p.isConfigured({ TELEGRAM_BOT_TOKEN: 'abc' })).toBe(true);
  });

  it('wechat isConfigured reads WECHAT_BOT_TOKEN', () => {
    installBuiltinChannelPlugins();
    const p = channelRegistry.get('wechat')!;
    expect(p.isConfigured({})).toBe(false);
    expect(p.isConfigured({ WECHAT_BOT_TOKEN: 'abc' })).toBe(true);
  });

  it('websocket is always configured and has no env keys', () => {
    installBuiltinChannelPlugins();
    const p = channelRegistry.get('websocket')!;
    expect(p.isConfigured()).toBe(true);
    expect(p.envKeys).toEqual([]);
  });

  it('isChatId is disjoint between plugins for sample ids', () => {
    installBuiltinChannelPlugins();
    const tg = channelRegistry.get('telegram')!;
    const wc = channelRegistry.get('wechat')!;
    const ws = channelRegistry.get('websocket')!;
    expect(tg.isChatId('123456789')).toBe(true);
    expect(ws.isChatId('ws:client-1')).toBe(true);
    // A typical wechat userId-looking string should not match telegram
    expect(tg.isChatId('abcdefghij1234567890abcd')).toBe(false);
    expect(wc.isChatId('abcdefghij1234567890abcd')).toBe(true);
  });
});
