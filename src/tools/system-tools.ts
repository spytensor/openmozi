/**
 * System Tools — Aggregation entry point.
 *
 * All tool definitions and executors live in domain-specific modules:
 * - task-tools.ts: create/list/get/update/run/repair/decompose tasks
 * - delegation-tools.ts: delegate coding work to managed external workers
 * - skill-tools.ts: list/install/set_state/validate/reload skills
 * - runtime-tools.ts: create_tool, restart_self, proactive_control, send_progress_report
 * - integration-tools.ts: connector_execute, read/write_context, set_reminder, run_tests, improve_code
 */

import type { ToolDefinition } from '../core/llm.js';
import type { ToolResult, ToolContext } from './types.js';

// Re-export all individual tool definitions for consumers that import them directly
export {
  createTaskTool, listTasksTool, getTaskTool, updateTaskTool,
  runTaskTool, repairTaskTool, decomposeTaskTool,
} from './task-tools.js';
export {
  delegateCodingTaskTool,
} from './delegation-tools.js';
export {
  useSkillTool, unloadSkillTool, listRuntimeSkillsTool, installSkillTool, setSkillStateTool,
  validateSkillTool, reloadSkillsTool,
} from './skill-tools.js';
export {
  createToolTool, restartSelfTool, proactiveControlTool, sendProgressReportTool,
} from './runtime-tools.js';
export {
  connectorExecuteTool, readContextTool, writeContextTool,
  setReminderTool, listRemindersTool, cancelReminderTool, runTestsTool, improveCodeTool,
} from './integration-tools.js';
export { findDeliverableTool } from './deliverable-tools.js';

// Import domain arrays for aggregation
import { TASK_TOOL_DEFINITIONS, executeTaskTool } from './task-tools.js';
import { DELEGATION_TOOL_DEFINITIONS, executeDelegationTool } from './delegation-tools.js';
import { SKILL_TOOL_DEFINITIONS, executeSkillTool } from './skill-tools.js';
import { RUNTIME_TOOL_DEFINITIONS, executeRuntimeTool } from './runtime-tools.js';
import { INTEGRATION_TOOL_DEFINITIONS, executeIntegrationTool } from './integration-tools.js';
import { DELIVERABLE_TOOL_DEFINITIONS, executeDeliverableTool } from './deliverable-tools.js';

/** All system tool definitions. */
export const SYSTEM_TOOLS: ToolDefinition[] = [
  ...DELIVERABLE_TOOL_DEFINITIONS,
  ...INTEGRATION_TOOL_DEFINITIONS,
  ...TASK_TOOL_DEFINITIONS,
  ...DELEGATION_TOOL_DEFINITIONS,
  ...SKILL_TOOL_DEFINITIONS,
  ...RUNTIME_TOOL_DEFINITIONS,
];

/** Execute a system tool by name. Returns null if not a system tool. */
export async function executeSystemTool(
  name: string,
  args: Record<string, unknown>,
  id: string,
  context?: ToolContext,
): Promise<ToolResult | null> {
  // Try each domain executor in turn; first non-null wins
  const result =
    await executeDeliverableTool(name, args, id, context) ??
    await executeIntegrationTool(name, args, id, context) ??
    await executeTaskTool(name, args, id, context) ??
    await executeDelegationTool(name, args, id, context) ??
    await executeSkillTool(name, args, id, context) ??
    await executeRuntimeTool(name, args, id, context);

  if (result) return result;

  // Dynamic tool fallback
  const { isDynamicToolAvailable, executeDynamicTool } = await import('./dynamic-registry.js');
  if (isDynamicToolAvailable(name, context?.tenantId)) {
    const output = await executeDynamicTool(name, args, context?.tenantId);
    return { tool_call_id: id, content: output, is_error: false };
  }

  return null;
}
