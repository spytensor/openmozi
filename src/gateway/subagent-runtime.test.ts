import { describe, it, expect } from 'vitest';
import { MoziConfigSchema } from '../config/index.js';
import { buildSubagentSessionKey, resolveSubagentRuntime } from './subagent-runtime.js';

function makeConfig(overrides?: {
  enabled?: boolean;
  enabledTenants?: string[];
  enabledSessions?: string[];
  sessionCapability?: string;
}) {
  const base = MoziConfigSchema.parse({});
  return {
    ...base,
    tools: {
      ...base.tools,
      subagents: {
        ...base.tools.subagents,
        ...(overrides?.enabled !== undefined ? { enabled: overrides.enabled } : {}),
        ...(overrides?.enabledTenants ? { enabled_tenants: overrides.enabledTenants } : {}),
        ...(overrides?.enabledSessions ? { enabled_sessions: overrides.enabledSessions } : {}),
        ...(overrides?.sessionCapability ? { session_capability: overrides.sessionCapability } : {}),
      },
    },
  };
}

describe('gateway/subagent-runtime', () => {
  it('builds session key from tenant + chat by default', () => {
    expect(buildSubagentSessionKey('tenant-a', 'chat-1')).toBe('tenant-a:chat-1');
    expect(buildSubagentSessionKey('tenant-a', 'chat-1', 'session-x')).toBe('tenant-a:session-x');
  });

  it('enables runtime globally by default', () => {
    const decision = resolveSubagentRuntime(
      { tenantId: 'tenant-a', chatId: 'chat-1' },
      makeConfig(),
    );
    expect(decision.enabled).toBe(true);
    expect(decision.source).toBe('global');
    expect(decision.sessionKey).toBe('tenant-a:chat-1');
  });

  it('stays disabled when explicitly set to false', () => {
    const decision = resolveSubagentRuntime(
      { tenantId: 'tenant-a', chatId: 'chat-1' },
      makeConfig({ enabled: false }),
    );
    expect(decision.enabled).toBe(false);
    expect(decision.source).toBe('disabled');
  });

  it('enables runtime for allowlisted tenants when global is off', () => {
    const decision = resolveSubagentRuntime(
      { tenantId: 'tenant-rollout', chatId: 'chat-1' },
      makeConfig({ enabled: false, enabledTenants: ['tenant-rollout'] }),
    );
    expect(decision.enabled).toBe(true);
    expect(decision.source).toBe('tenant');
  });

  it('enables runtime for allowlisted session keys when global is off', () => {
    const decision = resolveSubagentRuntime(
      { tenantId: 'tenant-a', chatId: 'chat-1', sessionId: 'sess-42' },
      makeConfig({ enabled: false, enabledSessions: ['tenant-a:sess-42'] }),
    );
    expect(decision.enabled).toBe(true);
    expect(decision.source).toBe('session');
    expect(decision.sessionKey).toBe('tenant-a:sess-42');
  });

  it('enables runtime when client capability is present (case-insensitive)', () => {
    const decision = resolveSubagentRuntime(
      {
        tenantId: 'tenant-a',
        chatId: 'chat-1',
        clientCapabilities: ['SubAgent_Execution', 'streaming'],
      },
      makeConfig({ enabled: false, sessionCapability: 'subagent_execution' }),
    );
    expect(decision.enabled).toBe(true);
    expect(decision.source).toBe('client_capability');
  });
});
