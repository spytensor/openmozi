import { describe, it, expect, beforeEach } from 'vitest';
import { channelRegistry, type ChannelPlugin } from './registry.js';

function makePlugin(id: string, prefix: string): ChannelPlugin {
  return {
    id,
    label: id,
    description: `${id} channel`,
    docsPath: `docs/channels/${id}.md`,
    envKeys: [`${id.toUpperCase()}_TOKEN`],
    status: 'stable',
    capabilities: { direction: 'bidirectional', inboundMedia: false, outboundMedia: false, proactive: true, editing: false, deletion: false },
    isConfigured: (env = process.env) => Boolean(env[`${id.toUpperCase()}_TOKEN`]),
    isChatId: (v: string) => v.startsWith(`${prefix}:`),
    start: async () => ({ stop: () => {} }),
  };
}

describe('channelRegistry', () => {
  beforeEach(() => {
    channelRegistry.clear();
  });

  it('registers and retrieves plugins by id', () => {
    const tg = makePlugin('telegram', 'tg');
    channelRegistry.register(tg);
    expect(channelRegistry.get('telegram')).toBe(tg);
    expect(channelRegistry.list()).toEqual([tg]);
  });

  it('rejects duplicate ids', () => {
    channelRegistry.register(makePlugin('discord', 'dc'));
    expect(() => channelRegistry.register(makePlugin('discord', 'dc'))).toThrow(/already registered/);
  });

  it('routes chatIds to the owning plugin', () => {
    const tg = makePlugin('telegram', 'tg');
    const dc = makePlugin('discord', 'dc');
    channelRegistry.register(tg);
    channelRegistry.register(dc);
    expect(channelRegistry.findByChatId('tg:123')).toBe(tg);
    expect(channelRegistry.findByChatId('dc:456')).toBe(dc);
    expect(channelRegistry.findByChatId('slack:789')).toBeUndefined();
  });

  it('returns undefined for unknown ids', () => {
    expect(channelRegistry.get('nope')).toBeUndefined();
  });

  it('unregister removes a plugin', () => {
    const p = makePlugin('line', 'line');
    channelRegistry.register(p);
    channelRegistry.unregister('line');
    expect(channelRegistry.get('line')).toBeUndefined();
  });

  it('isConfigured reads from a provided env object', () => {
    const p = makePlugin('slack', 'slack');
    channelRegistry.register(p);
    expect(p.isConfigured({})).toBe(false);
    expect(p.isConfigured({ SLACK_TOKEN: 'x' })).toBe(true);
  });
});
