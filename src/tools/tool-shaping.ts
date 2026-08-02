import type { ChatMessage, ToolDefinition } from '../core/llm.js';
import {
  AVAILABLE_TOOLS_SECTION_HEADING,
  AVAILABLE_TOOLS_SHAPED_INSTRUCTION,
  PROMPT_SECTION_SEPARATOR,
  RUNTIME_CAPABILITY_SECTION_HEADING,
  TOOL_CATALOG_SECTION_HEADING,
  formatAvailableToolsSection,
  removePromptSection,
  replacePromptSection,
} from '../prompt-sections.js';

/**
 * Tool choice belongs to the selected model. The runtime exposes a small,
 * invariant bootstrap surface and defers every other full JSON schema until
 * the model explicitly activates it.
 */
export type TaskToolProfile = 'model_driven';

export interface ToolShapingResult {
  /** Mutable for the lifetime of one model loop. Activated definitions append here. */
  tools: ToolDefinition[];
  taskProfile: TaskToolProfile;
  originalCount: number;
  shapedCount: number;
  deferredCount: number;
  schemaTokensEstimate: number;
  toolCatalog: string;
}

const BOOTSTRAP_TOOL_NAMES = new Set([
  'get_capabilities',
  'activate_tools',
  'use_skill',
  'decompose_task',
]);

function compactDescription(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= 180) return singleLine;
  return `${singleLine.slice(0, 177).trimEnd()}...`;
}

export function formatDeferredToolCatalog(tools: ToolDefinition[]): string {
  const deferred = tools.filter(tool => !BOOTSTRAP_TOOL_NAMES.has(tool.function.name));
  if (deferred.length === 0) return '- No deferred tools are ready in this runtime.';
  return deferred
    .map(tool => `- ${tool.function.name}: ${compactDescription(tool.function.description)}`)
    .join('\n');
}

export function shapeToolsForExecution(input: { tools: ToolDefinition[] }): ToolShapingResult {
  const tools = input.tools.filter(tool => BOOTSTRAP_TOOL_NAMES.has(tool.function.name));
  return {
    tools,
    taskProfile: 'model_driven',
    originalCount: input.tools.length,
    shapedCount: tools.length,
    deferredCount: input.tools.length - tools.length,
    schemaTokensEstimate: Math.ceil(JSON.stringify(tools).length / 4),
    toolCatalog: formatDeferredToolCatalog(input.tools),
  };
}

/**
 * Add model-selected schemas to the current loop. Readiness is resolved from
 * the turn-bound registry snapshot; activation never widens permissions and
 * never makes an unavailable tool appear ready.
 */
export function activateToolsForExecution(
  result: ToolShapingResult,
  availableTools: ToolDefinition[],
  requestedNames: string[],
): string[] {
  const availableByName = new Map(availableTools.map(tool => [tool.function.name, tool]));
  const activeNames = new Set(result.tools.map(tool => tool.function.name));
  const activated: string[] = [];

  for (const name of requestedNames) {
    const definition = availableByName.get(name);
    if (!definition) {
      throw new Error(`Tool "${name}" is not ready in this turn`);
    }
    if (activeNames.has(name)) continue;
    result.tools.push(definition);
    activeNames.add(name);
    activated.push(name);
  }

  result.shapedCount = result.tools.length;
  result.deferredCount = result.originalCount - result.shapedCount;
  result.schemaTokensEstimate = Math.ceil(JSON.stringify(result.tools).length / 4);
  return activated;
}

function formatToolCatalogSection(result: ToolShapingResult): string {
  return [
    TOOL_CATALOG_SECTION_HEADING,
    '',
    'The entries below are ready but their full schemas are deferred. Call `activate_tools` with exact names, then use those tools on the next model call. The model decides what to activate; the runtime only validates readiness and permissions.',
    '',
    result.toolCatalog,
  ].join('\n');
}

/** Keep prompt claims synchronized with the schemas actually sent this call. */
export function shapePromptMessagesForExecution(
  messages: ChatMessage[],
  result: ToolShapingResult,
  options: { childSurface?: boolean } = {},
): ChatMessage[] {
  const toolNames = result.tools.map(tool => tool.function.name).join(', ');
  const availableSection = formatAvailableToolsSection(
    toolNames,
    `${AVAILABLE_TOOLS_SHAPED_INSTRUCTION} Activate deferred tools before calling them.`,
  );
  const replacement = `${availableSection}${PROMPT_SECTION_SEPARATOR}${formatToolCatalogSection(result)}`;
  const shaped = messages.map(message => ({ ...message }));
  const firstSystem = shaped.find(message => message.role === 'system');

  if (firstSystem && typeof firstSystem.content === 'string') {
    const withoutOldCatalog = removePromptSection(firstSystem.content, TOOL_CATALOG_SECTION_HEADING);
    const rewritten = replacePromptSection(
      withoutOldCatalog,
      AVAILABLE_TOOLS_SECTION_HEADING,
      replacement,
    );
    const withToolSurface = rewritten.replaced
      ? rewritten.prompt
      : `${withoutOldCatalog.trimEnd()}${PROMPT_SECTION_SEPARATOR}${replacement}`;
    firstSystem.content = options.childSurface
      ? removePromptSection(withToolSurface, RUNTIME_CAPABILITY_SECTION_HEADING)
      : withToolSurface;
  }

  return shaped;
}
