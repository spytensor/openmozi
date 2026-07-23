import { describe, expect, it } from 'vitest';
import { buildTenantScopedChatKey } from './runtime-session-key.js';

describe('gateway/runtime-session-key', () => {
  it('builds a stable tenant-scoped key for a chat', () => {
    expect(buildTenantScopedChatKey('shared-chat', 'tenant-a')).toBe('tenant-a:shared-chat');
  });

  it('separates same chat ids across tenants', () => {
    expect(buildTenantScopedChatKey('shared-chat', 'tenant-a'))
      .not.toBe(buildTenantScopedChatKey('shared-chat', 'tenant-b'));
  });
});
