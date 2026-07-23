/**
 * Tool name → (category, action) map for Brain tool-call hot path permission gate.
 *
 * Used by `executor.ts:executeToolInner` to preflight `checkPermission` against
 * the requested tool. Maps to keys understood by
 * `src/security/permissions.ts:ACTION_REQUIREMENTS`.
 *
 * Every built-in tool must be listed here. Unknown names fail closed at the
 * dynamic-tool execution level so a newly registered script cannot bypass the
 * session permission level.
 */
import type { ToolDefinition } from '../core/llm.js';
export interface ToolPermission {
  category: string;
  action: string;
}

export const TOOL_PERMISSION_MAP: Record<string, ToolPermission> = {
  // --- fs (defense-in-depth; runTel also gates) ---
  read_file: { category: 'filesystem', action: 'read' },
  write_file: { category: 'filesystem', action: 'write' },
  edit_file: { category: 'filesystem', action: 'write' },
  append_file: { category: 'filesystem', action: 'write' },
  list_directory: { category: 'filesystem', action: 'list' },

  // --- shell (defense-in-depth) ---
  shell_exec: { category: 'shell', action: 'execute' },
  shell_exec_bg: { category: 'shell', action: 'execute' },
  process_status: { category: 'shell', action: 'execute' },
  process_output: { category: 'shell', action: 'execute' },
  process_input: { category: 'shell', action: 'execute' },
  process_kill: { category: 'shell', action: 'execute' },

  // --- web (previously ungated) ---
  web_fetch: { category: 'network', action: 'read' },
  web_search: { category: 'network', action: 'read' },
  analyze_image: { category: 'filesystem', action: 'read' },

  // --- git (previously ungated) ---
  git_status: { category: 'filesystem', action: 'read' },
  git_diff: { category: 'filesystem', action: 'read' },
  git_log: { category: 'filesystem', action: 'read' },
  git_add: { category: 'filesystem', action: 'write' },
  git_commit: { category: 'filesystem', action: 'write' },
  git_revert: { category: 'filesystem', action: 'write' },
  git_push: { category: 'network', action: 'request' },

  // --- browser (previously ungated — network effect via headless browser) ---
  browser_open: { category: 'network', action: 'request' },
  browser_click: { category: 'network', action: 'request' },
  browser_type: { category: 'network', action: 'request' },
  browser_extract: { category: 'network', action: 'read' },
  browser_assert: { category: 'network', action: 'read' },

  // --- desktop (previously ungated — host control) ---
  desktop_screenshot: { category: 'desktop', action: 'control' },
  desktop_list_windows: { category: 'desktop', action: 'control' },
  desktop_focus_window: { category: 'desktop', action: 'control' },
  desktop_launch_app: { category: 'desktop', action: 'control' },
  desktop_click: { category: 'desktop', action: 'control' },
  desktop_type: { category: 'desktop', action: 'control' },
  desktop_hotkey: { category: 'desktop', action: 'control' },
  desktop_click_hint: { category: 'desktop', action: 'control' },
  desktop_type_hint: { category: 'desktop', action: 'control' },

  // --- memory (previously ungated — local DB I/O) ---
  remember: { category: 'filesystem', action: 'write' },
  recall: { category: 'filesystem', action: 'read' },
  recall_episodes: { category: 'filesystem', action: 'read' },
  learn_lesson: { category: 'filesystem', action: 'write' },
  find_deliverable: { category: 'filesystem', action: 'read' },

  // --- managed workers ---
  delegate_coding_task: { category: 'shell', action: 'execute' },

  // --- blackboard / integrations ---
  connector_execute: { category: 'network', action: 'request' },
  read_context: { category: 'blackboard', action: 'read' },
  write_context: { category: 'blackboard', action: 'write' },
  set_reminder: { category: 'filesystem', action: 'write' },
  list_reminders: { category: 'filesystem', action: 'read' },
  cancel_reminder: { category: 'filesystem', action: 'write' },
  run_tests: { category: 'shell', action: 'execute' },
  improve_code: { category: 'filesystem', action: 'write' },

  // --- persistent tasks ---
  create_task: { category: 'filesystem', action: 'write' },
  list_tasks: { category: 'filesystem', action: 'read' },
  get_task: { category: 'filesystem', action: 'read' },
  update_task: { category: 'filesystem', action: 'write' },
  run_task: { category: 'shell', action: 'execute' },
  repair_task: { category: 'shell', action: 'execute' },
  decompose_task: { category: 'shell', action: 'execute' },
  read_task_result: { category: 'filesystem', action: 'read' },

  // --- skill runtime ---
  use_skill: { category: 'filesystem', action: 'read' },
  unload_skill: { category: 'filesystem', action: 'read' },
  list_runtime_skills: { category: 'filesystem', action: 'read' },
  install_skill: { category: 'filesystem', action: 'write' },
  set_skill_state: { category: 'filesystem', action: 'write' },
  validate_skill: { category: 'filesystem', action: 'read' },
  reload_skills: { category: 'filesystem', action: 'read' },
  propose_skill: { category: 'filesystem', action: 'write' },

  // --- runtime control / artifacts / schedules ---
  create_tool: { category: 'shell', action: 'execute' },
  restart_self: { category: 'runtime', action: 'restart' },
  proactive_control: { category: 'filesystem', action: 'write' },
  send_progress_report: { category: 'external', action: 'send' },
  create_background_task: { category: 'shell', action: 'execute' },
  create_artifact: { category: 'filesystem', action: 'write' },
  update_artifact: { category: 'filesystem', action: 'write' },
  get_capabilities: { category: 'filesystem', action: 'read' },
  // A schedule may perform network/model work later, so creation requires the
  // same L2 boundary as deferred execution even though raw shell is disallowed.
  set_cron_task: { category: 'shell', action: 'execute' },
  list_cron_tasks: { category: 'filesystem', action: 'read' },
  cancel_cron_task: { category: 'filesystem', action: 'write' },
};

export const DYNAMIC_TOOL_PERMISSION: ToolPermission = {
  category: 'shell',
  action: 'execute',
};

export function assertToolPermissionCoverage(tools: ToolDefinition[]): void {
  const missing = tools
    .map(tool => tool.function.name)
    .filter(name => TOOL_PERMISSION_MAP[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing permission declarations for tools: ${missing.sort().join(', ')}`);
  }
}

/** Look up permission requirement. Unknown names are treated as executable scripts. */
export function getToolPermission(toolName: string): ToolPermission {
  return TOOL_PERMISSION_MAP[toolName] ?? DYNAMIC_TOOL_PERMISSION;
}
