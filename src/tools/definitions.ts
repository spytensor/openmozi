import type { ToolDefinition } from '../core/llm.js';
import { FS_TOOLS } from './fs-tools.js';
import { SHELL_TOOLS } from './shell-tools.js';
import { WEB_TOOLS } from './web-tools.js';
import { BROWSER_TOOLS } from './browser-tools.js';
import { DESKTOP_TOOLS } from './desktop-tools.js';
import { GIT_TOOLS } from './git-tools.js';
import { MEMORY_TOOLS } from './memory-tools.js';
import { SYSTEM_TOOLS } from './system-tools.js';
import { assertToolPermissionCoverage } from './tool-permission-map.js';

// Re-export individual definitions for backward compatibility
export { shellExecTool } from './shell-tools.js';
export { readFileTool, writeFileTool, editFileTool, appendFileTool, listDirectoryTool } from './fs-tools.js';
export { webSearchTool, webFetchTool, analyzeImageTool } from './web-tools.js';
export {
  browserOpenTool, browserClickTool, browserTypeTool,
  browserExtractTool, browserAssertTool,
} from './browser-tools.js';
export {
  desktopScreenshotTool, desktopListWindowsTool, desktopFocusWindowTool,
  desktopLaunchAppTool, desktopClickTool, desktopTypeTool, desktopHotkeyTool,
  desktopClickHintTool, desktopTypeHintTool,
} from './desktop-tools.js';
export { gitStatusTool, gitDiffTool, gitAddTool, gitCommitTool, gitPushTool, gitLogTool, gitRevertTool } from './git-tools.js';
export { rememberTool, recallTool, learnLessonTool, recallEpisodesTool } from './memory-tools.js';
export {
  connectorExecuteTool, createToolTool, setReminderTool, listRemindersTool, cancelReminderTool, runTestsTool,
  improveCodeTool, readContextTool, writeContextTool,
  createTaskTool, listTasksTool, getTaskTool, updateTaskTool, runTaskTool, repairTaskTool,
  useSkillTool, listRuntimeSkillsTool, installSkillTool, setSkillStateTool, validateSkillTool,
  decomposeTaskTool, delegateCodingTaskTool, reloadSkillsTool, restartSelfTool, proactiveControlTool,
  findDeliverableTool,
} from './system-tools.js';

/** All available tool definitions */
export const ALL_TOOLS: ToolDefinition[] = [
  ...SHELL_TOOLS,
  ...FS_TOOLS,
  ...WEB_TOOLS,
  ...BROWSER_TOOLS,
  ...DESKTOP_TOOLS,
  ...MEMORY_TOOLS,
  ...SYSTEM_TOOLS,
  ...GIT_TOOLS,
];

assertToolPermissionCoverage(ALL_TOOLS);

/** Get a tool definition by name */
export function getToolDefinition(name: string): ToolDefinition | undefined {
  return ALL_TOOLS.find((t) => t.function.name === name);
}
