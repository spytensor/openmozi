import type { ChatMessage, ToolDefinition } from '../core/llm.js';
import { ALL_TOOLS } from './definitions.js';
import { explicitlyRequestsRenderableArtifact } from '../artifacts/content-contract.js';
import { schedulerAdmissionToolNames } from '../core/durable-plan-admission.js';
import {
  AVAILABLE_TOOLS_SECTION_HEADING,
  AVAILABLE_TOOLS_SHAPED_INSTRUCTION,
  RUNTIME_CAPABILITY_SECTION_HEADING,
  formatAvailableToolsSection,
  removePromptSection,
  replacePromptSection,
} from '../prompt-sections.js';

export type TaskToolProfile = 'simple' | 'coding' | 'research' | 'office' | 'report' | 'data' | 'creative' | 'finance' | 'desktop' | 'general';

/**
 * Tool shaping is keyed on the *task*, never on which model is running.
 *
 * A `ModelExecutionProfile` used to exist here and decided that some models were
 * too weak to be trusted. It has been removed, because it violated this repo's
 * first design rule — "the LLM Brain makes ALL decisions; never add hardcoded
 * logic that overrides, second-guesses, or teaches the LLM how to think" — and
 * because every mechanism it used was unsound:
 *
 * - `deepseek`/`minimax` were named as weak by *provider id*, so the judgement
 *   did not even look at which model was running.
 * - Everything else fell back to a catalog `reasoning` flag that defaults to
 *   false and is set on only 11 of 64 models, so ~53 models were silently
 *   downgraded because nobody had annotated them, not because anyone judged
 *   them. Any newly added model was degraded by default.
 * - That flag is declared in providers.ts as "reasoning model — temperature not
 *   supported": an API-compatibility fact, read here as an intelligence tier.
 *   Fixing a temperature bug silently changed prompt content.
 * - The verdict contradicted the runtime's own evidence: ai-sdk-adapter.ts
 *   documents DeepSeek reasoning models as probe-verified competent at tool
 *   continuation, while this file called DeepSeek weak at tools.
 *
 * Runtime still owns capability readiness and durable-plan admission. Within
 * the admitted tool surface, the Brain decides how to execute the request.
 *
 * The consequence was that "Task Decomposition" and "Persistent Tasks" were
 * deleted from the system prompt for those models, so they never planned with
 * DAGs — the Brain cannot choose a capability it was never told exists.
 *
 * Genuine provider/API compatibility (temperature omission for reasoning APIs,
 * per-provider reasoning-effort spelling, MiniMax tool-call markup parsing)
 * stays where it belongs, in the adapter layer.
 */
export interface ToolShapingResult {
  tools: ToolDefinition[];
  taskProfile: TaskToolProfile;
  runtimeAdmission?: 'durable_plan' | 'plan_control' | 'scheduler_control';
  originalCount: number;
  shapedCount: number;
  schemaTokensEstimate: number;
}

const BUILTIN_NAMES = new Set(ALL_TOOLS.map(tool => tool.function.name));
const CORE = new Set([
  'get_capabilities', 'list_directory', 'read_context', 'read_file', 'recall', 'recall_episodes',
  'remember', 'use_skill', 'unload_skill', 'list_runtime_skills',
]);
const FILE_WRITE = ['append_file', 'edit_file', 'write_file'];
const SHELL = ['shell_exec', 'shell_exec_bg', 'process_input', 'process_kill', 'process_output', 'process_status'];
const GIT = ['git_add', 'git_commit', 'git_diff', 'git_log', 'git_push', 'git_revert', 'git_status'];
const TASKS = ['create_task', 'decompose_task', 'get_task', 'list_tasks', 'read_task_result', 'repair_task', 'run_task', 'update_task'];
const ARTIFACTS = ['create_artifact', 'update_artifact'];
const WEB = ['web_fetch', 'web_search'];
const BROWSER = ['browser_assert', 'browser_click', 'browser_extract', 'browser_open', 'browser_type'];
const DESKTOP = [
  'desktop_screenshot', 'desktop_list_windows', 'desktop_focus_window', 'desktop_launch_app',
  'desktop_click', 'desktop_type', 'desktop_hotkey', 'desktop_click_hint', 'desktop_type_hint',
];
const RUNTIME_CONTROL = [
  'connector_execute', 'create_background_task', 'proactive_control', 'send_progress_report',
  'set_reminder', 'list_reminders', 'cancel_reminder', 'set_cron_task', 'list_cron_tasks', 'cancel_cron_task',
  'install_skill', 'set_skill_state', 'validate_skill', 'reload_skills',
];
const DURABLE_PLAN_ADMISSION = new Set(['use_skill', 'decompose_task']);
const PLAN_CONTROL_ADMISSION = new Set([
  'use_skill', 'list_tasks', 'get_task', 'read_task_result',
  'repair_task', 'run_task', 'update_task',
]);
const SCHEDULER_CONTROL_TOOLS = new Set([
  'set_reminder', 'list_reminders', 'cancel_reminder',
  'set_cron_task', 'list_cron_tasks', 'cancel_cron_task',
]);

function setOf(...groups: Array<string | string[] | Set<string>>): Set<string> {
  const result = new Set<string>();
  for (const group of groups) {
    if (typeof group === 'string') result.add(group);
    else for (const value of group) result.add(value);
  }
  return result;
}

const TASK_TOOLS: Record<TaskToolProfile, Set<string>> = {
  simple: setOf(CORE, WEB, 'analyze_image'),
  coding: setOf(CORE, FILE_WRITE, SHELL, GIT, TASKS, WEB, ARTIFACTS, 'analyze_image', 'delegate_coding_task', 'run_tests'),
  research: setOf(CORE, WEB, BROWSER, ARTIFACTS, TASKS, 'analyze_image', 'write_file', 'set_reminder'),
  office: setOf(CORE, FILE_WRITE, SHELL, ARTIFACTS, WEB, 'analyze_image', 'run_tests'),
  // Report production: gather sources, run a generator, publish the document.
  // TASKS is deliberately included — a report is the archetypal multi-step job,
  // and withholding decompose_task here would recreate the bug this profile is
  // meant to help: holding a planning tool with no way to reach for it. What is
  // left out is control-plane surface (cron, connectors, skill installation) and
  // test running, none of which produce a document.
  report: setOf(CORE, FILE_WRITE, SHELL, ARTIFACTS, TASKS, WEB, BROWSER, 'analyze_image'),
  data: setOf(CORE, FILE_WRITE, SHELL, ARTIFACTS, WEB, 'analyze_image', 'run_tests'),
  creative: setOf(CORE, FILE_WRITE, SHELL, ARTIFACTS, WEB, 'analyze_image'),
  finance: setOf(CORE, FILE_WRITE, SHELL, ARTIFACTS, WEB, 'analyze_image'),
  desktop: setOf(CORE, DESKTOP, BROWSER, 'analyze_image'),
  general: setOf(CORE, FILE_WRITE, SHELL, TASKS, ARTIFACTS, WEB, RUNTIME_CONTROL, 'analyze_image', 'run_tests'),
};

export function detectTaskToolProfile(text: string): TaskToolProfile {
  const value = text.toLowerCase();
  if (/\b(docx?|word|xlsx?|excel|pptx?|powerpoint|spreadsheet|slide deck)\b|文档|表格|演示文稿|幻灯片/.test(value)) return 'office';
  if (/\b(code|coding|bug|fix|refactor|repository|repo|typescript|javascript|python|test|pull request|\bpr\b|commit|git|docker|api)\b|代码|修复|仓库|测试|提交/.test(value)) return 'coding';
  // After `office` and `coding`, before everything else.
  //
  // Ahead of research/data/finance because a request to *produce a document* is a
  // report task even when it also gathers or analyses, and `report` carries the
  // union those need (WEB+BROWSER to gather, SHELL to generate, TASKS to plan).
  // Measured on the real prompt — "Collect the latest U.S. macroeconomic data ...
  // Generate a detailed PDF report" — `latest` otherwise matched `research`,
  // whose allowlist has no SHELL, so the model could not run the generator that
  // produces the PDF; "bond market" would have hit `finance`, which has no TASKS
  // and so cannot decompose.
  //
  // Behind `coding` because `pdf`/`report` are ordinary nouns in code work —
  // "fix the pdf.js CJK cmaps bug", "the test report is failing". Those need git
  // and run_tests, which `report` does not carry. The asymmetry decides the
  // order: a report request misread as `coding` still has everything it needs
  // (coding is a superset here), while a coding request misread as `report`
  // silently loses version control.
  if (/\b(pdf|report|whitepaper|write-?up)\b|报告|周报|月报|日报|年报|白皮书|编排|可视化/.test(value)) return 'report';
  if (/\b(research|compare|investigate|latest|sources?|citation|find out|look up|search)\b|研究|对比|调查|最新|搜索|查找/.test(value)) return 'research';
  if (/\b(csv|dataset|data analysis|sql|statistics|chart|plot|pivot)\b|数据分析|统计|图表/.test(value)) return 'data';
  if (/\b(design|illustration|image|svg|poster|creative|story|logo|website)\b|设计|图片|海报|创作|网页/.test(value)) return 'creative';
  if (/\b(finance|stock|market|crypto|portfolio|valuation|investment)\b|股票|市场|加密货币|投资|估值/.test(value)) return 'finance';
  if (/\b(desktop|screen|screenshot|window|launch app|open app|click|type into|hotkey)\b|桌面|屏幕|截图|窗口|打开应用|启动应用|点击|输入到/.test(value)) return 'desktop';
  if (/^(what|why|how|who|when|where|is|are|can|does|explain|define)\b|[?？]$|是什么|为什么|怎么/.test(value.trim())) return 'simple';
  return 'general';
}

export function shapeToolsForExecution(input: {
  tools: ToolDefinition[];
  userText: string;
  /** Runtime-owned admission gate. It is based on task structure, never model identity. */
  runtimeAdmission?: 'durable_plan' | 'plan_control' | 'scheduler_control';
  /** Accepted for call-site compatibility; deliberately unused — see ToolShapingResult. */
  provider?: string;
  model?: string;
}): ToolShapingResult {
  const taskProfile = detectTaskToolProfile(input.userText);
  // `general` means "no narrower task was recognised", so there is nothing to
  // narrow to and every tool stays visible — for every model alike.
  const shouldShape = taskProfile !== 'general';
  const allowed = new Set(TASK_TOOLS[taskProfile]);
  if (explicitlyRequestsRenderableArtifact(input.userText)) {
    for (const toolName of ARTIFACTS) allowed.add(toolName);
  }
  const tools = input.runtimeAdmission === 'durable_plan'
    // Admission is fail-closed for built-in and tenant tools alike. Skill
    // activation may shape the plan; decompose_task is the only execution
    // transition. Search, writes, shell, connectors and dynamic tools cannot
    // bypass the durable plan by appearing in the same foreground turn.
    ? input.tools.filter(tool => DURABLE_PLAN_ADMISSION.has(tool.function.name))
    : input.runtimeAdmission === 'plan_control'
      ? input.tools.filter(tool => PLAN_CONTROL_ADMISSION.has(tool.function.name))
    : input.runtimeAdmission === 'scheduler_control'
      ? input.tools.filter(tool => {
          const admitted = schedulerAdmissionToolNames(input.userText);
          return SCHEDULER_CONTROL_TOOLS.has(tool.function.name) && admitted.has(tool.function.name);
        })
    : shouldShape
      ? input.tools.filter(tool => !BUILTIN_NAMES.has(tool.function.name) || allowed.has(tool.function.name))
      : input.tools;
  const schemaChars = JSON.stringify(tools).length;
  return {
    tools,
    taskProfile,
    runtimeAdmission: input.runtimeAdmission,
    originalCount: input.tools.length,
    shapedCount: tools.length,
    schemaTokensEstimate: Math.ceil(schemaChars / 4),
  };
}

/**
 * State what the runtime actually did, so the model is not left guessing why a
 * tool it knows about is absent. The durable-plan admission text describes an
 * enforced runtime contract; ordinary task shaping remains non-behavioural.
 */
export function buildModelExecutionPolicy(result: ToolShapingResult): string | null {
  if (result.runtimeAdmission === 'durable_plan') {
    return [
      '[Runtime execution admission]',
      `Task profile: ${result.taskProfile}. Durable plan execution is required.`,
      `The runtime exposed ${result.shapedCount} admission tools (from ${result.originalCount}).`,
      'You may activate a relevant skill, then you must call decompose_task to create the persisted dependency graph.',
      'Inline research, file generation, shell execution, and direct final delivery are blocked until the runtime accepts the plan.',
    ].join('\n');
  }
  if (result.runtimeAdmission === 'plan_control') {
    return [
      '[Runtime execution admission]',
      `Task profile: ${result.taskProfile}. An existing persisted plan is being controlled.`,
      `The runtime exposed ${result.shapedCount} plan-control tools (from ${result.originalCount}).`,
      'Inspect, continue, repair, or update the existing plan through those tools. Do not create a duplicate plan or execute its work inline.',
    ].join('\n');
  }
  if (result.runtimeAdmission === 'scheduler_control') {
    return [
      '[Runtime execution admission]',
      `Task profile: ${result.taskProfile}. This turn controls a persisted MOZI schedule.`,
      `The runtime exposed ${result.shapedCount} scheduler-control tools (from ${result.originalCount}).`,
      'Call the exposed scheduler tool. For a scheduled workload, create only the schedule now; put the future workload in handler_params.prompt and use managed_brain. Do not research, write files, run commands, or create a DAG in this turn.',
      'Never use crontab, launchd, at, systemd timers, or another host scheduler. The successful scheduler tool result is the only valid creation receipt.',
    ].join('\n');
  }
  if (result.taskProfile === 'general') return null;
  return [
    '[Runtime tool surface]',
    `Task profile: ${result.taskProfile}.`,
    `The runtime exposed ${result.shapedCount} tools relevant to this task (from ${result.originalCount}).`,
    'Use only tools that are visible.',
  ].join('\n');
}

/**
 * Rewrite the prompt's tool list to match what was actually exposed.
 *
 * This no longer deletes capability sections. It used to remove "Task
 * Decomposition", "Persistent Tasks" and "Visual Output & Aesthetics" from the
 * system prompt whenever the model was not judged `strong_reasoning` — which is
 * why DeepSeek never planned with DAGs: the guidance describing decomposition
 * was cut out of its prompt, while `decompose_task` stayed in its tool list. It
 * held the tool and had been told nothing about when to reach for it.
 */
export function shapePromptMessagesForExecution(
  messages: ChatMessage[],
  result: ToolShapingResult,
  options: { childSurface?: boolean } = {},
): ChatMessage[] {
  const toolNames = result.tools.map(tool => tool.function.name).join(', ');
  const shaped = messages.map(message => ({ ...message }));
  const firstSystem = shaped.find(message => message.role === 'system');
  if (firstSystem && typeof firstSystem.content === 'string') {
    const rewrittenTools = replacePromptSection(
      firstSystem.content,
      AVAILABLE_TOOLS_SECTION_HEADING,
      formatAvailableToolsSection(toolNames, AVAILABLE_TOOLS_SHAPED_INSTRUCTION),
    );
    firstSystem.content = options.childSurface
      ? removePromptSection(rewrittenTools.prompt, RUNTIME_CAPABILITY_SECTION_HEADING)
      : rewrittenTools.prompt;
  }
  const policy = buildModelExecutionPolicy(result);
  if (policy) {
    let lastUserIndex = -1;
    for (let index = shaped.length - 1; index >= 0; index--) {
      if (shaped[index]?.role === 'user') {
        lastUserIndex = index;
        break;
      }
    }
    shaped.splice(lastUserIndex >= 0 ? lastUserIndex : shaped.length, 0, { role: 'system', content: policy });
  }
  return shaped;
}
