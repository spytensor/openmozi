import { updateSessionPermissionLevel } from '../memory/sessions.js';
import { logAudit } from './audit.js';
import type { PermissionLevel } from './permissions.js';

export interface ApplySessionPermissionLevelInput {
  sessionId: string;
  tenantId?: string;
  permissionLevel: PermissionLevel;
  userId?: string;
  reason?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Single audited path for changing a session-scoped permission level.
 */
export function applySessionPermissionLevel(input: ApplySessionPermissionLevelInput): boolean {
  const tenantId = input.tenantId ?? 'default';
  const updated = updateSessionPermissionLevel(input.sessionId, input.permissionLevel, tenantId);
  if (!updated) return false;

  logAudit({
    tenant_id: tenantId,
    user_id: input.userId,
    action: 'session.permission',
    resource_type: 'session',
    resource_id: input.sessionId,
    details: {
      permission_level: input.permissionLevel,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.details ?? {}),
    },
    ip_address: input.ipAddress,
    user_agent: input.userAgent,
  });

  return true;
}
