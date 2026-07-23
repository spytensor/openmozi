/**
 * SubAgent Worker — runs as a child process.
 *
 * Communication protocol:
 * - Receives JSON-RPC requests via stdin (line-delimited JSON)
 * - Sends JSON-RPC responses/notifications via stdout
 * - Sends heartbeat every 3 seconds
 *
 * Main methods:
 * - "execute_task": Receive a TaskBrief, execute it via LLM tool-call loop, return ResultEnvelope
 * - "ping": Health check, returns "pong"
 * - "shutdown": Graceful shutdown
 */

import { createRpcResponse, createRpcNotification, TaskBriefSchema, type TaskBrief, type ResultEnvelope, type JsonRpcRequest, type JsonRpcNotification } from './protocol.js';
import { createInterface } from 'node:readline';
import { create } from '../core/llm.js';
import type { ChatMessage, LLMClient, ToolDefinition } from '../core/llm.js';
import { getTextContent } from '../core/llm.js';
import {
  UnifiedExecutionKernel,
  createKernelSystemMessage,
  sanitizeExecutionMessages,
} from '../core/unified-execution-kernel.js';
import { ALL_TOOLS } from '../tools/definitions.js';
import { executeTool } from '../tools/executor.js';
import {
  resolveEffectiveAllowedTools,
  resolveEffectivePermissionLevel,
  buildSubagentPolicyPrompt,
  buildSubagentToolContext,
} from './subagent-policy.js';

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const AGENT_ID = process.env.MOZI_AGENT_ID || 'unknown';
const PROCESS_ID = process.env.MOZI_PROCESS_ID || 'unknown';
const SYSTEM_PROMPT = process.env.MOZI_SYSTEM_PROMPT || 'You are a helpful sub-agent. Complete the given task.';
const TOOLS_ALLOWED: string[] = JSON.parse(process.env.MOZI_TOOLS_ALLOWED || '[]');
const ENV_PERMISSION_LEVEL = process.env.MOZI_PERMISSION_LEVEL || 'L0_READ_ONLY';
const LLM_PROVIDER = process.env.MOZI_LLM_PROVIDER || process.env.MOZI_BRAIN_PROVIDER || 'openai';
const LLM_MODEL = process.env.MOZI_LLM_MODEL || process.env.MOZI_BRAIN_MODEL || 'MiniMax-M2.5';
const ENV_SUBAGENT_MAX_TOOL_ITERATIONS = Number(process.env.MOZI_SUBAGENT_MAX_TOOL_ITERATIONS);
const PEER_COLLABORATION = process.env.MOZI_PEER_COLLABORATION === 'true';
const CAPABILITIES: string[] = JSON.parse(process.env.MOZI_CAPABILITIES || '[]');
const TENANT_ID = process.env.MOZI_TENANT_ID || 'default';

/** Max iterations for the tool-call loop to prevent runaway agents */
const MAX_TOOL_ITERATIONS = Number.isFinite(ENV_SUBAGENT_MAX_TOOL_ITERATIONS) && ENV_SUBAGENT_MAX_TOOL_ITERATIONS >= 0
  ? Math.floor(ENV_SUBAGENT_MAX_TOOL_ITERATIONS)
  : 0;

// Peer collaboration state
const pendingPeerResponses = new Map<string, (result: unknown) => void>();
let activeTaskController: AbortController | null = null;
let activeTaskId: string | null = null;

function cancelActiveTask(reason: string): void {
  if (!activeTaskController || activeTaskController.signal.aborted) return;
  activeTaskController.abort(new Error(reason));
}

function throwIfCancelled(brief: TaskBrief, signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error && reason.message.trim().length > 0) {
    throw new Error(`Task cancelled: ${reason.message}`);
  }
  if (typeof reason === 'string' && reason.trim().length > 0) {
    throw new Error(`Task cancelled: ${reason.trim()}`);
  }
  throw new Error(`Task cancelled: ${brief.task_id}`);
}

// ---------------------------------------------------------------------------
// Output helpers (write to stdout as JSON lines)
// ---------------------------------------------------------------------------

function sendMessage(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/** Debug logging goes to stderr so it doesn't interfere with JSON-RPC on stdout */
function debugLog(message: string): void {
  process.stderr.write(`[subagent:${AGENT_ID}] ${message}\n`);
}

// ---------------------------------------------------------------------------
// Tool filtering
// ---------------------------------------------------------------------------

/** delegate_to_peer tool definition — only injected when MOZI_PEER_COLLABORATION=true */
const delegateToPeerTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'delegate_to_peer',
    description: 'Delegate a sub-objective to a peer agent with a specific capability. The peer agent will execute the task and return the result.',
    parameters: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          description: 'Required capability of the peer agent (e.g., "code", "research", "review")',
        },
        objective: {
          type: 'string',
          description: 'The objective for the peer agent to accomplish',
        },
        timeout_ms: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
      },
      required: ['capability', 'objective'],
      additionalProperties: false,
    },
  },
};

/** Get tool definitions filtered by TOOLS_ALLOWED. Empty list = all tools. */
function getAllowedTools(allowedTools: string[]): ToolDefinition[] {
  const base = allowedTools.length === 0 ? ALL_TOOLS : ALL_TOOLS.filter((t) => allowedTools.includes(t.function.name));
  const allowDelegateToPeer = PEER_COLLABORATION && (allowedTools.length === 0 || allowedTools.includes('delegate_to_peer'));
  if (allowDelegateToPeer) {
    return [...base, delegateToPeerTool];
  }
  return base;
}

// ---------------------------------------------------------------------------
// Heartbeat — every 3 seconds
// ---------------------------------------------------------------------------

const heartbeatTimer = setInterval(() => {
  sendMessage(createRpcNotification('heartbeat'));
}, 3000);

// Send initial heartbeat immediately
sendMessage(createRpcNotification('heartbeat'));

// ---------------------------------------------------------------------------
// Task execution — LLM tool-call loop
// ---------------------------------------------------------------------------

async function executeTask(brief: TaskBrief): Promise<ResultEnvelope> {
  const startTime = Date.now();
  let totalTokens = 0;
  let totalToolCalls = 0;
  const taskController = new AbortController();
  activeTaskController = taskController;
  activeTaskId = brief.task_id;

  try {
    // Create LLM client from Brain-selected provider/model (wizard + model-router source of truth)
    const client: LLMClient = create(LLM_PROVIDER, { model: LLM_MODEL });

    const effectivePermissionLevel = resolveEffectivePermissionLevel(
      ENV_PERMISSION_LEVEL,
      brief.constraints.permission_level,
    );
    const effectiveAllowedTools = resolveEffectiveAllowedTools(
      TOOLS_ALLOWED,
      brief.constraints.allowed_tools,
    );
    const policyPrompt = buildSubagentPolicyPrompt(
      AGENT_ID,
      TENANT_ID,
      effectivePermissionLevel,
      effectiveAllowedTools,
    );
    const toolContext = buildSubagentToolContext(
      brief.task_id,
      TENANT_ID,
      AGENT_ID,
      effectivePermissionLevel,
    );

    // Build initial messages
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: policyPrompt },
      { role: 'user', content: brief.objective },
    ];

    const tools = getAllowedTools(effectiveAllowedTools);
    const executionKernel = new UnifiedExecutionKernel({
      scope: 'subagent',
      tenantId: TENANT_ID,
      chatId: brief.task_id,
      taskId: brief.task_id,
      maxIterations: MAX_TOOL_ITERATIONS,
      llmCallTimeoutMs: 0,
      maxLoopElapsedMs: 0,
      maxFailedToolBatches: 3,
      repeatedFailureStrategy: 'stop',
    });

    while (executionKernel.canContinue()) {
      throwIfCancelled(brief, taskController.signal);
      const iterationBudget = executionKernel.beginIteration();
      if ('stopReason' in iterationBudget) {
        break;
      }

      const sanitizedMessages = sanitizeExecutionMessages(messages);
      if (sanitizedMessages !== messages) {
        messages.length = 0;
        messages.push(...sanitizedMessages);
      }

      let response;
      try {
        response = await client.chat(messages, {
          tools: tools.length > 0 ? tools : undefined,
          max_tokens: 2048,
          timeout_ms: iterationBudget.effectiveCallTimeoutMs,
          abort_signal: taskController.signal,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        throwIfCancelled(brief, taskController.signal);
        const isTimeout = errMsg.includes('abort') || errMsg.includes('timeout')
          || (err instanceof Error && err.name === 'AbortError');
        if (isTimeout) {
          const timeoutDecision = executionKernel.handleLlmTimeoutError(errMsg, iterationBudget.effectiveCallTimeoutMs);
          if (timeoutDecision.autotuneDirective) {
            messages.push(createKernelSystemMessage(timeoutDecision.autotuneDirective));
          }
          if (timeoutDecision.stopReason) {
            return {
              task_id: brief.task_id,
              status: 'failed',
              output: timeoutDecision.recentFailureDetails,
              summary: 'Task blocked by repeated timeouts',
              cost: {
                tokens: totalTokens,
                tool_calls: totalToolCalls,
                elapsed_time: Date.now() - startTime,
              },
              issues: timeoutDecision.recentFailureDetails,
            };
          }
          continue;
        }
        throw err;
      }

      totalTokens += response.usage.input_tokens + response.usage.output_tokens;

      if (!response.tool_calls || response.tool_calls.length === 0) {
        return {
          task_id: brief.task_id,
          status: 'success',
          output: [response.content],
          summary: response.content.slice(0, 200),
          cost: {
            tokens: totalTokens,
            tool_calls: totalToolCalls,
            elapsed_time: Date.now() - startTime,
          },
          issues: [],
        };
      }

      messages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.tool_calls,
      });

      const toolOutcomes: Array<{
        toolCallId: string;
        toolName: string;
        status: 'success' | 'error';
        errorSummary?: string;
      }> = [];
      const recentErrors: string[] = [];

      for (const toolCall of response.tool_calls) {
        throwIfCancelled(brief, taskController.signal);
        totalToolCalls++;

        if (toolCall.function.name === 'delegate_to_peer' && PEER_COLLABORATION) {
          const peerResult = await handlePeerDelegation(toolCall);
          messages.push({
            role: 'tool',
            content: peerResult.content,
            tool_call_id: toolCall.id,
            tool_name: 'delegate_to_peer',
          });
          toolOutcomes.push({
            toolCallId: toolCall.id,
            toolName: 'delegate_to_peer',
            status: peerResult.is_error ? 'error' : 'success',
            errorSummary: peerResult.is_error ? peerResult.content.slice(0, 200) : undefined,
          });
          if (peerResult.is_error && recentErrors.length < 2) {
            recentErrors.push(peerResult.content.slice(0, 240));
          }
          continue;
        }

        const result = await executeTool(toolCall, toolContext);
        throwIfCancelled(brief, taskController.signal);
        const toolName = result.tool_name || toolCall.function.name;
        messages.push({
          role: 'tool',
          content: result.content,
          tool_call_id: toolCall.id,
          tool_name: toolName,
        });
        toolOutcomes.push({
          toolCallId: toolCall.id,
          toolName,
          status: result.is_error ? 'error' : 'success',
          errorSummary: result.is_error ? result.content.slice(0, 200) : undefined,
        });
        if (result.is_error && recentErrors.length < 2) {
          recentErrors.push(result.content.slice(0, 240));
        }
      }

      const toolBatchDecision = executionKernel.recordToolBatch(
        response.tool_calls,
        toolOutcomes,
        recentErrors,
      );
      if (toolBatchDecision.toolTruthDirective) {
        messages.push(createKernelSystemMessage(toolBatchDecision.toolTruthDirective));
      }
      if (toolBatchDecision.constraintRecoveryHint) {
        messages.push(createKernelSystemMessage(toolBatchDecision.constraintRecoveryHint));
      }
      if (toolBatchDecision.failureHint) {
        messages.push(createKernelSystemMessage(toolBatchDecision.failureHint));
      }
      if (toolBatchDecision.loopHint) {
        messages.push(createKernelSystemMessage(toolBatchDecision.loopHint));
      }
      if (toolBatchDecision.stopReason) {
        return {
          task_id: brief.task_id,
          status: 'failed',
          output: toolBatchDecision.recentFailureDetails.length > 0
            ? toolBatchDecision.recentFailureDetails
            : [`Execution stopped: ${toolBatchDecision.stopReason}`],
          summary: `Task blocked — ${toolBatchDecision.stopReason}`,
          cost: {
            tokens: totalTokens,
            tool_calls: totalToolCalls,
            elapsed_time: Date.now() - startTime,
          },
          issues: toolBatchDecision.recentFailureDetails.length > 0
            ? toolBatchDecision.recentFailureDetails
            : [toolBatchDecision.stopReason],
        };
      }
    }

    // If we hit max iterations (only applicable for positive limits), return partial result
    const lastAssistant = messages.filter((m) => m.role === 'assistant').pop();
    return {
      task_id: brief.task_id,
      status: 'partial',
      output: [lastAssistant ? getTextContent(lastAssistant) : `Max tool iterations reached (${MAX_TOOL_ITERATIONS})`],
      summary: `Task incomplete — max tool iterations reached (${MAX_TOOL_ITERATIONS})`,
      cost: {
        tokens: totalTokens,
        tool_calls: totalToolCalls,
        elapsed_time: Date.now() - startTime,
      },
      issues: [`Max tool iterations reached (${MAX_TOOL_ITERATIONS})`],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (taskController.signal.aborted || message.toLowerCase().includes('task cancelled')) {
      debugLog(`executeTask cancelled: ${message}`);
      return {
        task_id: brief.task_id,
        status: 'cancelled',
        output: [message || `Task cancelled: ${brief.task_id}`],
        summary: `Task cancelled: ${brief.task_id}`,
        cost: {
          tokens: totalTokens,
          tool_calls: totalToolCalls,
          elapsed_time: Date.now() - startTime,
        },
        issues: [message || 'Cancelled'],
      };
    }

    debugLog(`executeTask error: ${message}`);
    return {
      task_id: brief.task_id,
      status: 'failed',
      output: [message],
      summary: `Error: ${message.slice(0, 200)}`,
      cost: {
        tokens: totalTokens,
        tool_calls: totalToolCalls,
        elapsed_time: Date.now() - startTime,
      },
      issues: [message],
    };
  } finally {
    if (activeTaskController === taskController) {
      activeTaskController = null;
      activeTaskId = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Peer collaboration
// ---------------------------------------------------------------------------

/**
 * Request help from another agent via the parent process-manager.
 * Sends a peer_request notification to stdout; parent routes it.
 */
function sendPeerRequest(capability: string, objective: string, timeoutMs = 30000): Promise<unknown> {
  const requestId = `peer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const notification: JsonRpcNotification = {
    jsonrpc: '2.0',
    method: 'peer_request',
    params: { request_id: requestId, capability, objective, tenant_id: TENANT_ID, timeout_ms: timeoutMs },
  };
  process.stdout.write(JSON.stringify(notification) + '\n');

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingPeerResponses.delete(requestId);
      reject(new Error(`Peer request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingPeerResponses.set(requestId, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });
  });
}

/**
 * Handle a delegate_to_peer tool call by sending a peer request to the parent process-manager.
 */
async function handlePeerDelegation(toolCall: { id: string; function: { name: string; arguments: string } }): Promise<{ content: string; is_error: boolean }> {
  try {
    const args = JSON.parse(toolCall.function.arguments) as { capability?: string; objective?: string; timeout_ms?: number };
    if (!args.capability || !args.objective) {
      return { content: 'Error: "capability" and "objective" are required', is_error: true };
    }
    const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : 30000;
    const result = await sendPeerRequest(args.capability, args.objective, timeoutMs);
    const payload = result as { status?: string; result?: unknown; reason?: string };
    if (payload.status === 'completed') {
      const output = typeof payload.result === 'string' ? payload.result : JSON.stringify(payload.result);
      return { content: output, is_error: false };
    }
    return { content: `Peer delegation failed: ${payload.reason || 'Unknown error'}`, is_error: true };
  } catch (err) {
    return { content: `Peer delegation error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
  }
}

// Advertise capabilities on startup if peer collaboration is enabled
if (PEER_COLLABORATION && CAPABILITIES.length > 0) {
  sendMessage(createRpcNotification('capability_ad', { capabilities: CAPABILITIES }));
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  try {
    switch (request.method) {
      case 'ping': {
        sendMessage(createRpcResponse(request.id, 'pong'));
        break;
      }

      case 'execute_task': {
        const brief = TaskBriefSchema.parse(request.params);
        const result = await executeTask(brief);
        sendMessage(createRpcResponse(request.id, result));
        break;
      }

      case 'shutdown': {
        clearInterval(heartbeatTimer);
        sendMessage(createRpcResponse(request.id, 'ok'));
        rl.close();
        process.exit(0);
        break;
      }

      default: {
        sendMessage(createRpcResponse(request.id, undefined, {
          code: -32601,
          message: `Method not found: ${request.method}`,
        }));
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendMessage(createRpcResponse(request.id, undefined, {
      code: -32603,
      message,
    }));
  }
}

// ---------------------------------------------------------------------------
// stdin reader — line-delimited JSON-RPC
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const parsed = JSON.parse(trimmed);
    if ('id' in parsed && parsed.id !== undefined && parsed.method) {
      // JSON-RPC request — handle it
      handleRequest(parsed as JsonRpcRequest);
    } else if (parsed.method && !('id' in parsed && parsed.id !== undefined)) {
      // JSON-RPC notification — handle by method
      switch (parsed.method) {
        case 'agent_message': {
          // Peer message forwarded by process-manager
          const msg = parsed.params as { type: string; payload: unknown; from: string; id: string };
          if (msg.type === 'peer_response' && msg.payload) {
            const payload = msg.payload as { request_id?: string };
            const resolver = pendingPeerResponses.get(payload.request_id ?? '');
            if (resolver) {
              pendingPeerResponses.delete(payload.request_id ?? '');
              resolver(msg.payload);
            }
          }
          // Log broadcast and other message types
          if (msg.type === 'broadcast') {
            debugLog(`[broadcast] from=${msg.from}: ${typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload)}`);
          } else {
            debugLog(`[agent_message] type=${msg.type} from=${msg.from}`);
          }
          break;
        }
        case 'cancel_task': {
          const params = parsed.params as { task_id?: string; reason?: string } | undefined;
          const reason = params?.reason?.trim() || 'Cancellation requested by parent process';
          const targetTaskId = params?.task_id?.trim();
          if (!targetTaskId || !activeTaskId || activeTaskId === targetTaskId) {
            debugLog(`[cancel_task] task=${activeTaskId ?? 'none'} reason=${reason}`);
            cancelActiveTask(reason);
          } else {
            debugLog(`[cancel_task] ignored target=${targetTaskId} active=${activeTaskId}`);
          }
          break;
        }
        default:
          debugLog(`[notification] method=${parsed.method}`);
      }
    }
  } catch {
    // Ignore non-JSON input
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

process.on('SIGTERM', () => {
  clearInterval(heartbeatTimer);
  rl.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  clearInterval(heartbeatTimer);
  rl.close();
  process.exit(0);
});
