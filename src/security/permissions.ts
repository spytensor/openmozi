/**
 * Permission Level Enforcement — controls what actions agents can perform.
 *
 * Permission levels form a hierarchy:
 *   L0_READ_ONLY   → filesystem read
 *   L1_READ_WRITE  → filesystem read + write
 *   L2_SHELL_EXEC  → above + shell execution
 *   L3_FULL_ACCESS → above + network, docker, external comms
 *
 * The TEL layer checks permissions before executing any tool action.
 */

import pino from 'pino';
import { log as logEvent } from '../store/events.js';

const logger = pino({ name: 'mozi:security:permissions' });

// ---------------------------------------------------------------------------
// Permission levels (ordered by privilege)
// ---------------------------------------------------------------------------

export const PERMISSION_LEVELS = [
  'L0_READ_ONLY',
  'L1_READ_WRITE',
  'L2_SHELL_EXEC',
  'L3_FULL_ACCESS',
] as const;

export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

const LEVEL_ORDER: Record<PermissionLevel, number> = {
  L0_READ_ONLY: 0,
  L1_READ_WRITE: 1,
  L2_SHELL_EXEC: 2,
  L3_FULL_ACCESS: 3,
};

// ---------------------------------------------------------------------------
// Action → required permission mapping
// ---------------------------------------------------------------------------

/**
 * Maps category.action to minimum required permission level.
 */
const ACTION_REQUIREMENTS: Record<string, PermissionLevel> = {
  'filesystem.read': 'L0_READ_ONLY',
  'filesystem.list': 'L0_READ_ONLY',
  'filesystem.search': 'L0_READ_ONLY',
  'filesystem.write': 'L1_READ_WRITE',
  'filesystem.delete': 'L1_READ_WRITE',
  'blackboard.read': 'L0_READ_ONLY',
  'blackboard.write': 'L1_READ_WRITE',
  'shell.execute': 'L2_SHELL_EXEC',
  'shell.execute_background': 'L2_SHELL_EXEC',
  'shell.process_status': 'L2_SHELL_EXEC',
  'shell.process_output': 'L2_SHELL_EXEC',
  'shell.process_input': 'L2_SHELL_EXEC',
  'shell.process_kill': 'L2_SHELL_EXEC',
  'network.read': 'L2_SHELL_EXEC',
  'network.request': 'L3_FULL_ACCESS',
  'network.fetch': 'L3_FULL_ACCESS',
  'desktop.control': 'L3_FULL_ACCESS',
  'docker.run': 'L3_FULL_ACCESS',
  'docker.exec': 'L3_FULL_ACCESS',
  'external.send': 'L3_FULL_ACCESS',
  'runtime.restart': 'L3_FULL_ACCESS',
};

// ---------------------------------------------------------------------------
// PermissionDeniedError
// ---------------------------------------------------------------------------

export class PermissionDeniedError extends Error {
  public readonly agentId: string;
  public readonly agentLevel: PermissionLevel;
  public readonly requiredLevel: PermissionLevel;
  public readonly action: string;

  constructor(agentId: string, agentLevel: PermissionLevel, requiredLevel: PermissionLevel, action: string) {
    super(
      `Permission denied: agent '${agentId}' has ${agentLevel} but action '${action}' requires ${requiredLevel}`,
    );
    this.name = 'PermissionDeniedError';
    this.agentId = agentId;
    this.agentLevel = agentLevel;
    this.requiredLevel = requiredLevel;
    this.action = action;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a permission level is valid.
 */
export function isValidLevel(level: string): level is PermissionLevel {
  return PERMISSION_LEVELS.includes(level as PermissionLevel);
}

/**
 * Get the numeric order of a permission level (higher = more access).
 */
export function getLevelOrder(level: PermissionLevel): number {
  return LEVEL_ORDER[level];
}

/**
 * Check if `agentLevel` meets or exceeds `requiredLevel`.
 */
export function hasPermission(agentLevel: PermissionLevel, requiredLevel: PermissionLevel): boolean {
  return LEVEL_ORDER[agentLevel] >= LEVEL_ORDER[requiredLevel];
}

/**
 * Get the minimum required permission level for a given action.
 * Returns L3_FULL_ACCESS for unknown actions (fail-close for unregistered tools).
 */
export function getRequiredLevel(action: string): PermissionLevel {
  return ACTION_REQUIREMENTS[action] ?? 'L3_FULL_ACCESS';
}

/**
 * Register a custom action → permission requirement.
 */
export function registerActionRequirement(action: string, level: PermissionLevel): void {
  ACTION_REQUIREMENTS[action] = level;
}

/**
 * Check permission for an agent performing an action.
 * Throws PermissionDeniedError if insufficient.
 *
 * @param agentId    - The agent attempting the action
 * @param agentLevel - The agent's permission level
 * @param category   - Tool category (e.g. 'shell')
 * @param action     - Tool action (e.g. 'execute')
 * @param tenantId   - Tenant for event logging
 * @throws PermissionDeniedError if insufficient permissions
 */
export function checkPermission(
  agentId: string,
  agentLevel: string,
  category: string,
  action: string,
  tenantId = 'default',
): void {
  const level = isValidLevel(agentLevel) ? agentLevel : 'L0_READ_ONLY';
  const actionKey = `${category}.${action}`;
  const required = getRequiredLevel(actionKey);

  if (!hasPermission(level, required)) {
    logger.warn(
      { agent_id: agentId, agent_level: level, required_level: required, action: actionKey },
      'Permission denied',
    );
    logEvent(
      'permission_denied',
      'agent',
      agentId,
      { action: actionKey, agent_level: level, required_level: required },
      tenantId,
    );
    throw new PermissionDeniedError(agentId, level, required, actionKey);
  }
}
