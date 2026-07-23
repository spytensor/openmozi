import { getLevelOrder, isValidLevel, type PermissionLevel } from '../security/permissions.js';
import type { ToolContext } from '../tools/executor.js';

function normalizePermissionLevel(level: string | undefined): PermissionLevel {
  const normalized = level ?? '';
  return isValidLevel(normalized) ? normalized : 'L0_READ_ONLY';
}

/**
 * Resolve effective permission using least-privilege rule:
 * task brief cannot elevate beyond process-level env permission.
 */
export function resolveEffectivePermissionLevel(
  envPermissionLevel: string | undefined,
  briefPermissionLevel: string | undefined,
): PermissionLevel {
  const envLevel = normalizePermissionLevel(envPermissionLevel);
  if (!briefPermissionLevel) return envLevel;
  const briefLevel = normalizePermissionLevel(briefPermissionLevel);
  return getLevelOrder(briefLevel) <= getLevelOrder(envLevel) ? briefLevel : envLevel;
}

function toRestrictionSet(values: string[] | undefined): Set<string> | null {
  if (!values || values.length === 0) return null;
  return new Set(values);
}

/**
 * Resolve effective allowed tools:
 * - [] means unrestricted
 * - if both are restricted, take intersection
 * - if one is unrestricted, use the other restriction
 */
export function resolveEffectiveAllowedTools(
  envAllowedTools: string[] | undefined,
  briefAllowedTools: string[] | undefined,
): string[] {
  const envSet = toRestrictionSet(envAllowedTools);
  const briefSet = toRestrictionSet(briefAllowedTools);

  if (!envSet && !briefSet) return [];
  if (!envSet && briefSet) return [...briefSet];
  if (envSet && !briefSet) return [...envSet];

  return [...envSet!].filter((tool) => briefSet!.has(tool));
}

export function buildSubagentPolicyPrompt(
  agentId: string,
  tenantId: string,
  permissionLevel: PermissionLevel,
  allowedTools: string[],
): string {
  const toolsSummary = allowedTools.length > 0 ? allowedTools.join(', ') : 'ALL_REGISTERED_TOOLS';
  return [
    'Execution policy (strict):',
    `- agent_id: ${agentId}`,
    `- tenant_id: ${tenantId}`,
    `- permission_level: ${permissionLevel}`,
    `- allowed_tools: ${toolsSummary}`,
    '- Never retry the same blocked tool action repeatedly.',
    '- If permission is denied, explain the constraint and choose a compliant approach.',
  ].join('\n');
}

export function buildSubagentToolContext(
  taskId: string,
  tenantId: string,
  agentId: string,
  permissionLevel: PermissionLevel,
): ToolContext {
  return {
    chatId: taskId,
    taskId,
    tenantId,
    agentId,
    permissionLevel,
  };
}
