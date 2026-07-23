/**
 * Task Management Tools — create, list, get, update, run, repair, decompose tasks.
 */

import type { ToolDefinition } from '../core/llm.js';
import type { ToolResult, ToolContext } from './types.js';

// ── Definitions ──

export const createTaskTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'create_task',
    description: 'Create a persistent runtime task or subtask with optional dependencies. Use for multi-step work that needs explicit tracking, handoff, or resumable progress. Do NOT create tasks for trivial one-shot actions you will finish immediately.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short task title',
        },
        objective: {
          type: 'string',
          description: 'What the task must accomplish',
        },
        done_criteria: {
          type: 'string',
          description: 'How to verify completion',
        },
        parent_task_id: {
          type: 'string',
          description: 'Optional parent task ID when creating a subtask',
        },
        depends_on: {
          type: 'array',
          description: 'Task IDs that must complete before this task can run',
          items: { type: 'string' },
        },
        priority: {
          type: 'number',
          description: 'Lower number = earlier scheduling priority',
        },
        tags: {
          type: 'array',
          description: 'Optional task labels',
          items: { type: 'string' },
        },
        agent_type_hint: {
          type: 'string',
          description: 'Hint for agent/worker selection (for example: code, research, review, any)',
        },
        constraints: {
          type: 'object',
          description: 'Optional runtime constraints such as timeout, retries, and permission level',
          properties: {
            token_budget: { type: 'number' },
            timeout_seconds: { type: 'number' },
            max_retries: { type: 'number' },
            permission_level: { type: 'string' },
            allowed_paths: { type: 'array', items: { type: 'string' } },
            forbidden_paths: { type: 'array', items: { type: 'string' } },
            max_tokens: { type: 'number' },
            temperature: { type: 'number' },
            tool_max_iterations: { type: 'number' },
          },
          additionalProperties: false,
        },
      },
      required: ['title', 'objective'],
      additionalProperties: false,
    },
  },
};

export const listTasksTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'list_tasks',
    description: 'List persistent runtime tasks with optional filters. Use before creating duplicate tasks, when checking current plan state, or when you need the next ready/blocked items.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'ready', 'assigned', 'running', 'blocked', 'completed', 'failed', 'cancelled'],
          description: 'Optional status filter',
        },
        parent_task_id: {
          type: 'string',
          description: 'Optional parent task ID filter',
        },
        tag: {
          type: 'string',
          description: 'Optional tag filter',
        },
        assigned_agent: {
          type: 'string',
          description: 'Optional assigned agent filter',
        },
        search: {
          type: 'string',
          description: 'Optional case-insensitive search across title/objective/done criteria',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of tasks to return (default 20, max 100)',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

export const getTaskTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'get_task',
    description: 'Inspect one persistent task in detail, including dependencies, dependents, children, and recent task events.',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID to inspect',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
};

export const updateTaskTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'update_task',
    description: 'Patch task metadata and/or transition task state. Use this to assign, block, unblock, start, complete, fail, or cancel tracked work. Provide a reason when blocking or failing a task.',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID to update',
        },
        patch: {
          type: 'object',
          description: 'Optional metadata patch',
          properties: {
            parent_task_id: { type: 'string' },
            title: { type: 'string' },
            objective: { type: 'string' },
            done_criteria: { type: 'string' },
            priority: { type: 'number' },
            tags: { type: 'array', items: { type: 'string' } },
            agent_type_hint: { type: 'string' },
            constraints: {
              type: 'object',
              properties: {
                token_budget: { type: 'number' },
                timeout_seconds: { type: 'number' },
                max_retries: { type: 'number' },
                permission_level: { type: 'string' },
                allowed_paths: { type: 'array', items: { type: 'string' } },
                forbidden_paths: { type: 'array', items: { type: 'string' } },
                max_tokens: { type: 'number' },
                temperature: { type: 'number' },
                tool_max_iterations: { type: 'number' },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        status: {
          type: 'string',
          enum: ['pending', 'ready', 'assigned', 'running', 'blocked', 'completed', 'failed', 'cancelled'],
          description: 'Optional next status',
        },
        assigned_agent: {
          type: 'string',
          description: 'Agent ID to assign when status is assigned',
        },
        reason: {
          type: 'string',
          description: 'Required when blocking or failing a task; optional for cancellation or manual status changes',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
};

export const runTaskTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'run_task',
    description: 'Execute a persistent task through the runtime task executor. By default this runs the selected task plus its subtree and any unresolved upstream dependencies. Use after planning/tracking work with create_task or when resuming durable work.',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Root task ID to execute',
        },
        include_subtasks: {
          type: 'boolean',
          description: 'When true (default), include child tasks in the execution scope',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
};

export const repairTaskTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'repair_task',
    description: 'Diagnose a failed/blocked persistent task and optionally reset it for another run. Use mode="diagnose" to inspect failure cause first. Use mode="repair" or "repair_and_run" only when the task looks recoverable.',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID to diagnose or repair',
        },
        mode: {
          type: 'string',
          enum: ['diagnose', 'repair', 'repair_and_run'],
          description: 'diagnose = inspect only, repair = reset statuses only, repair_and_run = reset then execute',
        },
        include_subtasks: {
          type: 'boolean',
          description: 'When repairing and rerunning, include child tasks in the rerun scope (default true)',
        },
        reason: {
          type: 'string',
          description: 'Optional repair reason to record in task events',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
};

export const decomposeTaskTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'decompose_task',
    description: 'Decompose a complex task into a persistent dependency graph that the runtime executes IN THE BACKGROUND, detached from this conversation turn. The plan survives timeouts, page refreshes, and restarts; the runtime delivers real results as a message when execution finishes, and live progress is shown to the user. Preserve every explicit requirement from the user request: the goal may summarize it, but each subtask MUST include concrete done_criteria and the plan must not narrow requested scope. Every subtask MUST declare depends_on, even when the array is empty. For a completely independent zero-edge plan, explicitly attest all_steps_independent=true. The tool returns immediately with the plan id — acknowledge the plan to the user and NEVER invent progress or results. Do NOT over-decompose simple tasks, and do NOT decompose again while a plan for the same goal is already running (check the active plan state block).',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'High-level goal being decomposed (1-2 sentences)',
        },
        all_steps_independent: {
          type: 'boolean',
          description: 'Set true only when every subtask is genuinely independent and the plan intentionally has zero dependency edges. Required as an explicit attestation for every zero-edge plan.',
        },
        subtasks: {
          type: 'array',
          description: 'Ordered list of subtasks. depends_on uses 0-based indices into this array (only earlier indices allowed).',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Short title for the subtask',
              },
              objective: {
                type: 'string',
                description: 'Detailed objective explaining what this subtask should accomplish',
              },
              done_criteria: {
                type: 'string',
                description: 'Required, concrete acceptance criteria for verifying this subtask against its persisted result and artifacts',
              },
              depends_on: {
                type: 'array',
                items: { type: 'number' },
                description: 'Required. Indices of subtasks this one depends on (0-based, unique, and earlier than this subtask). Use [] only when this subtask has no prerequisites.',
              },
              agent_type_hint: {
                type: 'string',
                description: 'Hint for agent selection: "code", "research", "review", "summary", or "any"',
              },
              constraints: {
                type: 'object',
                properties: {
                  timeout_seconds: { type: 'number', description: 'Max execution time in seconds (10-600)' },
                  max_retries: { type: 'number', description: 'Max retry attempts on timeout (0-5)' },
                  max_tokens: { type: 'number', description: 'Max output tokens (100-16000)' },
                },
              },
            },
            required: ['title', 'objective', 'done_criteria', 'depends_on'],
            additionalProperties: false,
          },
          minItems: 2,
          maxItems: 20,
        },
      },
      required: ['goal', 'subtasks'],
      additionalProperties: false,
    },
  },
};

export const readTaskResultTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_task_result',
    description: 'Recover a persisted task result or execution transcript from disk. Use after context compaction when you see a [TaskResult:...] reference and need the full details. Also useful for inspecting historical task outputs.',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID whose result to load',
        },
        section: {
          type: 'string',
          enum: ['result', 'transcript', 'metadata'],
          description: 'What to load: "result" (default) = final result, "transcript" = execution log, "metadata" = task metadata snapshot',
        },
        tail: {
          type: 'number',
          description: 'For transcript section: only return the last N entries (default: all)',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
};

export const TASK_TOOL_DEFINITIONS: ToolDefinition[] = [
  createTaskTool,
  listTasksTool,
  getTaskTool,
  updateTaskTool,
  runTaskTool,
  repairTaskTool,
  decomposeTaskTool,
  readTaskResultTool,
];

// ── Executor ──

export async function executeTaskTool(
  name: string,
  args: Record<string, unknown>,
  id: string,
  context?: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'create_task': {
      const { CreateTaskInput } = await import('../store/task-dag.js');
      const { createManagedTask } = await import('../core/task-management.js');
      const parsed = CreateTaskInput.parse({
        tenant_id: context?.tenantId || 'default',
        ...args,
      });
      const result = createManagedTask(parsed);
      return {
        tool_call_id: id,
        tool_name: 'create_task',
        content: JSON.stringify(result, null, 2),
        is_error: false,
      };
    }

    case 'list_tasks': {
      const { TaskListFiltersSchema, listManagedTasks } = await import('../core/task-management.js');
      const parsed = TaskListFiltersSchema.parse({
        tenant_id: context?.tenantId || 'default',
        ...args,
      });
      const result = listManagedTasks(parsed);
      return {
        tool_call_id: id,
        tool_name: 'list_tasks',
        content: JSON.stringify(result, null, 2),
        is_error: false,
      };
    }

    case 'get_task': {
      const taskId = args.task_id as string;
      if (!taskId || typeof taskId !== 'string') {
        return {
          tool_call_id: id,
          tool_name: 'get_task',
          content: 'Error: "task_id" is required and must be a string',
          is_error: true,
        };
      }

      const { getManagedTask } = await import('../core/task-management.js');
      const result = getManagedTask(taskId, context?.tenantId || 'default');
      if (!result) {
        return {
          tool_call_id: id,
          tool_name: 'get_task',
          content: `Error: Task not found: ${taskId}`,
          is_error: true,
        };
      }

      return {
        tool_call_id: id,
        tool_name: 'get_task',
        content: JSON.stringify(result, null, 2),
        is_error: false,
      };
    }

    case 'update_task': {
      const { UpdateManagedTaskInputSchema, updateManagedTask } = await import('../core/task-management.js');
      const parsed = UpdateManagedTaskInputSchema.parse({
        tenant_id: context?.tenantId || 'default',
        ...args,
      });
      const result = updateManagedTask(parsed);
      return {
        tool_call_id: id,
        tool_name: 'update_task',
        content: JSON.stringify(result, null, 2),
        is_error: false,
      };
    }

    case 'run_task': {
      const taskId = args.task_id as string;
      if (!taskId || typeof taskId !== 'string') {
        return {
          tool_call_id: id,
          tool_name: 'run_task',
          content: 'Error: "task_id" is required and must be a string',
          is_error: true,
        };
      }

      const includeSubtasks = args.include_subtasks;
      if (includeSubtasks !== undefined && typeof includeSubtasks !== 'boolean') {
        return {
          tool_call_id: id,
          tool_name: 'run_task',
          content: 'Error: "include_subtasks" must be a boolean',
          is_error: true,
        };
      }

      const { runManagedTask } = await import('../core/task-execution.js');
      const result = await runManagedTask(taskId, {
        tenantId: context?.tenantId || 'default',
        chatId: context?.chatId,
        turnId: context?.turnId,
        systemPrompt: context?.systemPrompt,
        fallbackClient: context?.client,
        useSubAgents: context?.useSubAgents === true,
        subagentRuntimeSource: context?.subagentRuntimeSource,
        subagentSessionKey: context?.subagentSessionKey,
        includeSubtasks: includeSubtasks as boolean | undefined,
      });
      return {
        tool_call_id: id,
        tool_name: 'run_task',
        content: JSON.stringify(result, null, 2),
        is_error: false,
      };
    }

    case 'repair_task': {
      const taskId = args.task_id as string;
      if (!taskId || typeof taskId !== 'string') {
        return {
          tool_call_id: id,
          tool_name: 'repair_task',
          content: 'Error: "task_id" is required and must be a string',
          is_error: true,
        };
      }

      const mode = (args.mode as string | undefined) ?? 'diagnose';
      if (!['diagnose', 'repair', 'repair_and_run'].includes(mode)) {
        return {
          tool_call_id: id,
          tool_name: 'repair_task',
          content: 'Error: "mode" must be one of: diagnose, repair, repair_and_run',
          is_error: true,
        };
      }

      const includeSubtasks = args.include_subtasks;
      if (includeSubtasks !== undefined && typeof includeSubtasks !== 'boolean') {
        return {
          tool_call_id: id,
          tool_name: 'repair_task',
          content: 'Error: "include_subtasks" must be a boolean',
          is_error: true,
        };
      }

      const reason = args.reason;
      if (reason !== undefined && typeof reason !== 'string') {
        return {
          tool_call_id: id,
          tool_name: 'repair_task',
          content: 'Error: "reason" must be a string',
          is_error: true,
        };
      }

      const { diagnoseManagedTaskRepair, repairManagedTask } = await import('../core/task-repair.js');
      if (mode === 'diagnose') {
        const diagnosis = diagnoseManagedTaskRepair(taskId, context?.tenantId || 'default');
        return {
          tool_call_id: id,
          tool_name: 'repair_task',
          content: JSON.stringify(diagnosis, null, 2),
          is_error: false,
        };
      }

      const result = await repairManagedTask(taskId, {
        tenantId: context?.tenantId || 'default',
        chatId: context?.chatId,
        turnId: context?.turnId,
        systemPrompt: context?.systemPrompt,
        fallbackClient: context?.client,
        useSubAgents: context?.useSubAgents === true,
        subagentRuntimeSource: context?.subagentRuntimeSource,
        subagentSessionKey: context?.subagentSessionKey,
        includeSubtasks: includeSubtasks as boolean | undefined,
        reason: reason as string | undefined,
        rerun: mode === 'repair_and_run',
      });
      return {
        tool_call_id: id,
        tool_name: 'repair_task',
        content: JSON.stringify(result, null, 2),
        is_error: false,
      };
    }

    case 'read_task_result': {
      const taskId = args.task_id as string;
      if (!taskId || typeof taskId !== 'string') {
        return {
          tool_call_id: id,
          tool_name: 'read_task_result',
          content: 'Error: "task_id" is required and must be a string',
          is_error: true,
        };
      }

      const section = (args.section as string) || 'result';
      const {
        loadTaskResult: loadResult,
        loadTaskTranscript: loadTranscript,
        loadTranscriptTail: loadTail,
        loadTaskMetadata: loadMeta,
        getTranscriptStats,
      } = await import('../tasks/workspace.js');

      if (section === 'result') {
        const result = loadResult(taskId);
        if (!result) {
          return { tool_call_id: id, tool_name: 'read_task_result', content: `No persisted result for task ${taskId}`, is_error: true };
        }
        return { tool_call_id: id, tool_name: 'read_task_result', content: JSON.stringify(result, null, 2), is_error: false };
      }

      if (section === 'transcript') {
        const tail = typeof args.tail === 'number' ? args.tail : 0;
        const entries = tail > 0 ? loadTail(taskId, tail) : loadTranscript(taskId);
        if (entries.length === 0) {
          return { tool_call_id: id, tool_name: 'read_task_result', content: `No transcript for task ${taskId}`, is_error: true };
        }
        const stats = getTranscriptStats(taskId);
        const header = stats ? `Transcript: ${stats.entries} entries, ${stats.bytes} bytes${tail > 0 ? ` (showing last ${tail})` : ''}\n\n` : '';
        return { tool_call_id: id, tool_name: 'read_task_result', content: header + entries.map(e => JSON.stringify(e)).join('\n'), is_error: false };
      }

      if (section === 'metadata') {
        const meta = loadMeta(taskId);
        if (!meta) {
          return { tool_call_id: id, tool_name: 'read_task_result', content: `No metadata for task ${taskId}`, is_error: true };
        }
        return { tool_call_id: id, tool_name: 'read_task_result', content: JSON.stringify(meta, null, 2), is_error: false };
      }

      return { tool_call_id: id, tool_name: 'read_task_result', content: `Unknown section: ${section}`, is_error: true };
    }

    case 'decompose_task': {
      if (!context?.chatId) {
        return { tool_call_id: id, content: 'Error: decompose_task requires chat context', is_error: true };
      }
      const { executeDecomposeTask } = await import('../core/dag-bridge.js');
      const result = await executeDecomposeTask(args, {
        chatId: context.chatId,
        channelType: context.channelType,
        tenantId: context.tenantId || 'default',
        systemPrompt: context.systemPrompt,
        turnId: context.turnId,
        fallbackClient: context.client,
        executionModel: context.executionModel,
        useSubAgents: context.useSubAgents === true,
        subagentRuntimeSource: context.subagentRuntimeSource,
        subagentSessionKey: context.subagentSessionKey,
        sessionId: context.sessionId,
        userId: context.userId,
        permissionLevel: context.permissionLevel,
        originalRequest: context.originalRequest,
        deliveryMode: context.planDeliveryMode,
        turnOrigin: context.turnOrigin,
      });
      if (typeof result === 'string') {
        return { tool_call_id: id, content: result, is_error: false };
      }
      // Detached background plan started: the runtime ends the turn here —
      // the foreground must not keep working in parallel with the plan.
      return {
        tool_call_id: id,
        content: result.content,
        is_error: false,
        ends_turn: true,
        ends_turn_message: result.userMessage,
        detached_plan_root_id: result.rootTaskId,
      };
    }

    default:
      return null;
  }
}
