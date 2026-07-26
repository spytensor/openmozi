import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, LLMClient, ToolCall, ToolDefinition } from '../core/llm.js';
import { create } from '../core/llm.js';
import { getBrainClient } from '../core/model-router.js';
import { getAllProviders } from '../core/providers.js';
import { defaultChatOptionsForSurface } from '../core/llm-surface.js';
import { discoverAgentDefinitions, type LoadedAgentDefinition } from './definition-loader.js';
import {
  createAgentFailureEnvelope,
  normalizeAgentExecutionEnvelope,
  type AgentExecutionEnvelope,
} from './execution-envelope.js';
import { discoverSkills, loadSkillForModelInvocation, type LoadedSkill } from '../skills/loader.js';
import { getRuntimeProjectRoot } from '../runtime/project-root.js';
import type { ToolContext, ToolResult } from '../tools/types.js';
import { getOutputDir, getWorkspaceAllowedRoots, getWorkspaceDir, isPathInsideRoot } from '../tools/workspace-policy.js';
import { emit as emitProgress } from '../progress/event-bus.js';
import { getLevelOrder, isValidLevel, type PermissionLevel } from '../security/permissions.js';

/**
 * Delegated runs execute at the weakest of the AGENT.md declaration, the
 * delegating turn's level, and a hard L2 ceiling: the dangerous lane requires
 * an approval flow that does not exist for delegation yet (constitution §12),
 * and full access would also dissolve the run-directory write pin.
 */
export function clampDelegatedPermission(
  declared: PermissionLevel | undefined,
  parent: string | undefined,
): PermissionLevel {
  const parentLevel: PermissionLevel = parent && isValidLevel(parent) ? parent : 'L2_SHELL_EXEC';
  const candidates: PermissionLevel[] = [declared ?? 'L0_READ_ONLY', parentLevel, 'L2_SHELL_EXEC'];
  return candidates.reduce((lowest, level) => (getLevelOrder(level) < getLevelOrder(lowest) ? level : lowest));
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ROUNDS = 8;
const MAX_CONTEXT_REF_BYTES = 256 * 1024;
const MAX_CONTEXT_TOTAL_BYTES = 1024 * 1024;

const TOOL_GROUPS: Record<string, string[]> = {
  filesystem: ['read_file', 'write_file', 'edit_file', 'append_file', 'list_directory', 'find_deliverable'],
  shell: ['shell_exec', 'shell_exec_bg', 'process_status', 'process_output', 'process_input', 'process_kill'],
  git: ['git_status', 'git_diff', 'git_log', 'git_add', 'git_commit', 'git_revert'],
  network: ['web_search', 'web_fetch'],
};

const DEFAULT_AGENT_TOOL_GROUPS = ['filesystem', 'shell'];

export interface DelegateAgentRunInput {
  agent: string;
  brief: string;
  contextRefs?: string[];
  context?: ToolContext;
  timeoutMs?: number;
  maxRounds?: number;
  maxTokens?: number;
  outputDir?: string;
  client?: LLMClient;
  definitions?: LoadedAgentDefinition[];
  registeredTools?: ToolDefinition[];
  bundledSkillsDir?: string;
  workspaceSkillsDir?: string;
}

interface TranscriptFrame {
  heading: string;
  body: string;
}

function markdownFence(value: string): string {
  return `\`\`\`text\n${value}\n\`\`\``;
}

function jsonFence(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function renderTranscript(
  brief: string,
  contextRefs: Array<{ path: string; content: string }>,
  frames: TranscriptFrame[],
  envelope: AgentExecutionEnvelope,
): string {
  const refs = contextRefs.flatMap(ref => [
    `### ${ref.path}`,
    '',
    markdownFence(ref.content),
    '',
  ]);
  return [
    '# Agent Delegation Transcript',
    '',
    '## Brief',
    '',
    brief,
    '',
    '## Context References',
    '',
    ...(refs.length > 0 ? refs : ['None.', '']),
    ...frames.flatMap(frame => [`## ${frame.heading}`, '', frame.body, '']),
    '## Final Envelope',
    '',
    jsonFence(envelope),
    '',
  ].join('\n');
}

async function allocateRunDirectory(outputDir: string, agentName: string): Promise<string> {
  const agentDir = join(outputDir, 'agents', agentName);
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  for (let number = 1; number <= 100_000; number += 1) {
    const runDir = join(agentDir, `run-${number}`);
    try {
      await mkdir(runDir, { mode: 0o700 });
      return runDir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Unable to allocate run directory for agent "${agentName}"`);
}

async function canonicalRoot(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function loadContextReferences(
  refs: string[],
  context: ToolContext | undefined,
  runDir: string,
): Promise<Array<{ path: string; content: string }>> {
  if (refs.length === 0) return [];
  const workspaceDir = getWorkspaceDir(context?.userId);
  const roots = [
    ...(context?.allowedPaths ?? []),
    ...(context?.workspaceRootPath ? [context.workspaceRootPath] : []),
    ...getWorkspaceAllowedRoots(context?.userId),
  ];
  const canonicalRoots = await Promise.all(roots.map(canonicalRoot));
  const loaded: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;

  for (const ref of refs) {
    const requested = isAbsolute(ref) ? resolve(ref) : resolve(workspaceDir, ref);
    let canonical: string;
    try {
      canonical = await realpath(requested);
    } catch {
      throw new Error(`context_ref_not_found: ${ref}`);
    }
    if (!canonicalRoots.some(root => isPathInsideRoot(canonical, root))) {
      throw new Error(`context_ref_out_of_scope: ${ref}`);
    }
    const content = await readFile(canonical, 'utf-8');
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_CONTEXT_REF_BYTES || totalBytes + bytes > MAX_CONTEXT_TOTAL_BYTES) {
      throw new Error(`context_ref_too_large: ${ref}`);
    }
    totalBytes += bytes;
    loaded.push({ path: canonical, content });
  }

  return loaded;
}

function expandToolWhitelist(names: string[] | undefined, registered: ToolDefinition[]): ToolDefinition[] {
  const requested = names && names.length > 0 ? names : DEFAULT_AGENT_TOOL_GROUPS;
  const allowed = new Set(requested.flatMap(name => TOOL_GROUPS[name] ?? [name]));
  allowed.delete('delegate_to_agent');
  allowed.delete('delegate_coding_task');
  allowed.delete('decompose_task');
  return registered.filter(tool => allowed.has(tool.function.name));
}

function resolveAgentClient(
  definition: LoadedAgentDefinition,
  context: ToolContext | undefined,
): { client: LLMClient; model: string; provider: string } {
  if (!definition.model) {
    const routed = getBrainClient({ tenantId: context?.tenantId, userId: context?.userId });
    return {
      client: routed.client,
      model: routed.selection.model,
      provider: routed.selection.provider,
    };
  }
  const slash = definition.model.indexOf('/');
  const provider = slash > 0
    ? definition.model.slice(0, slash)
    : getAllProviders().find(item => item.models.some(model => model.id === definition.model))?.id;
  const model = slash > 0 ? definition.model.slice(slash + 1) : definition.model;
  if (!provider) throw new Error(`agent_model_unavailable: ${definition.model}`);
  return { client: create(provider, { model, tenantId: context?.tenantId }), model, provider };
}

async function loadAgentSkills(
  definition: LoadedAgentDefinition,
  bundledDir: string,
  workspaceDir: string,
): Promise<string> {
  const options = { bundledDir, workspaceDir, useCache: false };
  const discovered = await discoverSkills(options);
  const names = new Set([
    ...definition.skills,
    ...discovered
      .filter((skill: LoadedSkill) => skill.frontmatter.always === true)
      .map((skill: LoadedSkill) => skill.name),
  ]);
  const loaded = await Promise.all([...names].map(name => loadSkillForModelInvocation(name, options)));
  if (loaded.length === 0) return '';
  return [
    '## Bound Skills',
    ...loaded.map(({ skill, instructions, directoryPath }) => [
      `### ${skill.name}`,
      `Directory: ${directoryPath}`,
      instructions,
    ].join('\n')),
  ].join('\n\n');
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed;
  return JSON.parse(unfenced);
}

function classifyRunError(error: unknown): { summary: string; blocker: string; status: 'failed' | 'blocked' } {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'agent_execution_timeout') {
    return { summary: 'Agent execution timed out.', blocker: 'timeout', status: 'failed' };
  }
  if (message.startsWith('context_ref_')) {
    return { summary: 'Agent context could not be admitted.', blocker: message, status: 'blocked' };
  }
  if (message.startsWith('agent_model_') || message.includes('No brain model')) {
    return { summary: 'Agent model is not available.', blocker: message, status: 'blocked' };
  }
  if (message.startsWith('agent_disabled:') || message.startsWith('agent_not_ready:')) {
    return { summary: 'Agent is not ready for execution.', blocker: message, status: 'blocked' };
  }
  return { summary: 'Agent execution failed.', blocker: message, status: 'failed' };
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('agent_execution_timeout'));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function validateArtifactPaths(paths: string[], runDir: string): Promise<string[]> {
  const artifacts: string[] = [];
  const canonicalRunDir = await realpath(runDir);
  for (const path of paths) {
    const requested = isAbsolute(path) ? resolve(path) : resolve(runDir, path);
    let canonical: string;
    try {
      canonical = await realpath(requested);
    } catch {
      throw new Error(`agent_artifact_not_found: ${path}`);
    }
    if (!isPathInsideRoot(canonical, canonicalRunDir)) {
      throw new Error(`agent_artifact_out_of_scope: ${path}`);
    }
    artifacts.push(requested);
  }
  return artifacts;
}

/**
 * Run one file-defined agent in an isolated in-process model/tool loop.
 * Only the terminal envelope is returned to the caller.
 */
export async function delegateToAgent(input: DelegateAgentRunInput): Promise<AgentExecutionEnvelope> {
  const outputDir = resolve(input.outputDir ?? getOutputDir());
  const definitions = input.definitions ?? await discoverAgentDefinitions({ useCache: false });
  const definition = definitions.find(agent => agent.name === input.agent);
  const fallbackName = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.agent) ? input.agent : 'invalid-agent';
  let runDir: string;
  try {
    runDir = await allocateRunDirectory(outputDir, definition?.name ?? fallbackName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createAgentFailureEnvelope(
      '(run directory was not created)',
      `run directory allocation failed: ${message}`,
      'run_dir_allocation_failed',
      'failed',
    );
  }
  const transcriptPath = join(runDir, 'transcript.md');
  const frames: TranscriptFrame[] = [];
  let refs: Array<{ path: string; content: string }> = [];
  let envelope: AgentExecutionEnvelope;

  const emitStatus = (workerStatus: string, summary?: string, heartbeat = false): void => {
    emitProgress({
      type: 'worker_status',
      agentId: definition?.name ?? input.agent,
      agentColor: definition?.color,
      agentIcon: definition?.icon,
      runtimeLabel: definition?.name ?? input.agent,
      workerStatus,
      heartbeat,
      summary,
      runDir,
      chatId: input.context?.chatId,
      tenantId: input.context?.tenantId,
      sessionId: input.context?.sessionId,
      turnId: input.context?.turnId,
    });
  };

  // The summary is the user-facing card subtitle; the run directory travels in
  // its own field and must not be shown as a status line.
  emitStatus('launching', 'Preparing run');
  try {
    if (!definition) throw new Error(`agent_not_found: ${input.agent}`);
    if (!definition.enabled || definition.status === 'disabled') {
      throw new Error(`agent_disabled: ${input.agent}`);
    }
    if (definition.status !== 'ready') {
      throw new Error(`agent_not_ready: ${input.agent}`);
    }

    refs = await loadContextReferences(input.contextRefs ?? [], input.context, runDir);
    const bundledSkillsDir = input.bundledSkillsDir ?? join(getRuntimeProjectRoot(), 'skills');
    const workspaceSkillsDir = input.workspaceSkillsDir ?? join(getWorkspaceDir(input.context?.userId), 'skills');
    const skillsPrompt = await loadAgentSkills(definition, bundledSkillsDir, workspaceSkillsDir);
    const registeredTools = input.registeredTools
      ?? (await import('../tools/dynamic-registry.js')).getAllRegisteredTools(input.context?.tenantId);
    const tools = expandToolWhitelist(definition.tools, registeredTools);
    const allowedToolNames = new Set(tools.map(tool => tool.function.name));
    const selected = input.client
      ? { client: input.client, model: definition.model ?? input.context?.executionModel?.model ?? 'injected', provider: input.client.provider }
      : resolveAgentClient(definition, input.context);
    const controller = new AbortController();
    // Bridge the delegating turn's cancellation into this run — a user stop on
    // the parent turn must also stop the delegated agent (#826 bug class).
    const abortSignal = input.context?.abortSignal
      ? AbortSignal.any([input.context.abortSignal, controller.signal])
      : controller.signal;
    const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const maxRounds = Math.max(1, input.maxRounds ?? DEFAULT_MAX_ROUNDS);
    const failoverSessionKey = `agent:${definition.name}:${randomUUID()}`;
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          definition.persona,
          skillsPrompt,
          '## Execution Contract',
          `Work only inside this run directory for generated files: ${runDir}`,
          'Return only one JSON object with keys: status (succeeded|failed|blocked), summary, key_findings, artifacts, and optional blocker.',
          'Artifacts must be paths inside the run directory. Do not include commentary outside the JSON object.',
        ].filter(Boolean).join('\n\n'),
      },
      {
        role: 'user',
        content: [
          input.brief,
          ...refs.map(ref => `\n[Context: ${ref.path}]\n${ref.content}`),
        ].join('\n'),
      },
    ];
    const toolContext: ToolContext = {
      ...input.context,
      agentId: definition.name,
      permissionLevel: clampDelegatedPermission(definition.permission_level, input.context?.permissionLevel),
      workspaceRootPath: runDir,
      workingDirectory: runDir,
      allowedPaths: [runDir],
      enforcedWriteRoots: [runDir],
      abortSignal,
      taskId: `agent_${definition.name}_${randomUUID()}`,
    };

    emitStatus('running', 'Working');
    const runLoop = async (): Promise<AgentExecutionEnvelope> => {
      for (let round = 1; round <= maxRounds; round += 1) {
        emitStatus('running', `round ${round}`, round > 1);
        const response = await selected.client.chat(messages, {
          ...defaultChatOptionsForSurface('dag_step', {
            tenantId: input.context?.tenantId ?? 'default',
            userId: input.context?.userId,
            taskId: toolContext.taskId,
            agentId: definition.name,
            abort_signal: abortSignal,
          }),
          model: selected.model,
          max_tokens: Math.max(1, input.maxTokens ?? 2_000),
          temperature: 0.2,
          tools: tools.length > 0 ? tools : undefined,
          timeout_ms: timeoutMs,
          failoverSessionKey,
        });
        frames.push({
          heading: `Round ${round} — Model`,
          body: [
            response.reasoning_content ? `Reasoning:\n\n${markdownFence(response.reasoning_content)}` : '',
            `Response:\n\n${markdownFence(response.content ?? '')}`,
            response.tool_calls ? `Tool calls:\n\n${jsonFence(response.tool_calls)}` : '',
          ].filter(Boolean).join('\n\n'),
        });
        messages.push({
          role: 'assistant',
          content: response.content ?? '',
          reasoning_content: response.reasoning_content,
          tool_calls: response.tool_calls,
        });

        if (!response.tool_calls || response.tool_calls.length === 0) {
          try {
            const candidate = normalizeAgentExecutionEnvelope(extractJsonObject(response.content), transcriptPath);
            const artifacts = await validateArtifactPaths(candidate.artifacts, runDir);
            return normalizeAgentExecutionEnvelope({ ...candidate, artifacts }, transcriptPath);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`agent_invalid_result: ${message}`);
          }
        }

        const disallowed = response.tool_calls.filter(call => !allowedToolNames.has(call.function.name));
        const allowed = response.tool_calls.filter(call => allowedToolNames.has(call.function.name));
        const deniedResults: ToolResult[] = disallowed.map((call: ToolCall) => ({
          tool_call_id: call.id,
          tool_name: call.function.name,
          content: `Error: tool "${call.function.name}" is outside this agent's whitelist`,
          is_error: true,
        }));
        const allowedResults = allowed.length > 0
          ? await (await import('../tools/executor.js')).executeToolCalls(allowed, toolContext)
          : [];
        const results = [...allowedResults, ...deniedResults];
        frames.push({ heading: `Round ${round} — Tool Results`, body: jsonFence(results) });
        for (const result of results) {
          messages.push({
            role: 'tool',
            content: result.content,
            tool_call_id: result.tool_call_id,
            tool_name: result.tool_name,
          });
        }
      }
      throw new Error('agent_max_rounds_exceeded');
    };

    envelope = await raceWithTimeout(runLoop(), timeoutMs, controller);
  } catch (error) {
    const classified = classifyRunError(error);
    envelope = createAgentFailureEnvelope(
      transcriptPath,
      classified.summary,
      classified.blocker,
      classified.status,
    );
  }

  await writeFile(transcriptPath, renderTranscript(input.brief, refs, frames, envelope), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  emitStatus(envelope.status === 'succeeded' ? 'completed' : envelope.status, envelope.summary);
  return envelope;
}
