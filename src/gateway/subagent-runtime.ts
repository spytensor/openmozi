import type { IncomingMessage } from '../channels/telegram.js';
import type { MoziConfig } from '../config/index.js';

export type SubagentRuntimeSource =
  | 'disabled'
  | 'global'
  | 'tenant'
  | 'session'
  | 'client_capability';

export interface SubagentRuntimeDecision {
  enabled: boolean;
  source: SubagentRuntimeSource;
  tenantId: string;
  sessionKey: string;
}

function normalizeCapabilities(capabilities: string[] | undefined): Set<string> {
  if (!capabilities || capabilities.length === 0) return new Set();
  return new Set(
    capabilities
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim().toLowerCase())
      .filter(value => value.length > 0),
  );
}

function isSessionEnabled(
  enabledSessions: Set<string>,
  tenantId: string,
  chatId: string,
  sessionId?: string,
): boolean {
  const fullSessionKey = buildSubagentSessionKey(tenantId, chatId, sessionId);
  if (enabledSessions.has(fullSessionKey)) return true;
  if (sessionId && enabledSessions.has(sessionId)) return true;
  return enabledSessions.has(chatId);
}

export function buildSubagentSessionKey(tenantId: string, chatId: string, sessionId?: string): string {
  const token = sessionId?.trim() ? sessionId.trim() : chatId;
  return `${tenantId}:${token}`;
}

export function resolveSubagentRuntime(
  msg: Pick<IncomingMessage, 'tenantId' | 'chatId' | 'sessionId' | 'clientCapabilities'>,
  config: MoziConfig,
): SubagentRuntimeDecision {
  const tenantId = msg.tenantId ?? 'default';
  const subagentConfig = config.tools.subagents;
  const sessionKey = buildSubagentSessionKey(tenantId, msg.chatId, msg.sessionId);

  if (subagentConfig.enabled) {
    return { enabled: true, source: 'global', tenantId, sessionKey };
  }

  if (subagentConfig.enabled_tenants.includes(tenantId)) {
    return { enabled: true, source: 'tenant', tenantId, sessionKey };
  }

  const enabledSessions = new Set(subagentConfig.enabled_sessions);
  if (isSessionEnabled(enabledSessions, tenantId, msg.chatId, msg.sessionId)) {
    return { enabled: true, source: 'session', tenantId, sessionKey };
  }

  const requiredCapability = subagentConfig.session_capability.trim().toLowerCase();
  if (requiredCapability) {
    const capabilitySet = normalizeCapabilities(msg.clientCapabilities);
    if (capabilitySet.has(requiredCapability)) {
      return { enabled: true, source: 'client_capability', tenantId, sessionKey };
    }
  }

  return { enabled: false, source: 'disabled', tenantId, sessionKey };
}
