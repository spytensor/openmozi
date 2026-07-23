/**
 * Integration Tools — connector_execute, read/write_context, set_reminder, run_tests, improve_code.
 */

import pino from 'pino';
import { addReminder, cancelReminder, listReminders } from '../scheduler/reminders.js';
import type { ToolDefinition } from '../core/llm.js';
import type { ToolResult, ToolContext } from './types.js';
import { asRecord } from './tool-utils.js';
import { resolveSchedulerControlAction } from '../core/durable-plan-admission.js';

const logger = pino({ name: 'mozi:tools:system' });

// ── Definitions ──

export const connectorExecuteTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'connector_execute',
    description: 'Execute external connector action for gmail/calendar/slack/github using standardized auth + execute + retry + idempotency. Sending actions require approval and should be retried with approval_request_id after /approve.',
    parameters: {
      type: 'object',
      properties: {
        connector: {
          type: 'string',
          enum: ['gmail', 'calendar', 'slack', 'github'],
          description: 'Connector provider name',
        },
        action: {
          type: 'string',
          description: 'Connector action name (e.g. send_email, create_event, post_message, create_issue)',
        },
        payload: {
          type: 'object',
          description: 'Action payload body',
          additionalProperties: true,
        },
        idempotency_key: {
          type: 'string',
          description: 'Required stable key for dedupe and safe retries',
        },
        max_retries: {
          type: 'number',
          description: 'Retry attempts on transient failures (0-5, default 2)',
        },
        retry_backoff_ms: {
          type: 'number',
          description: 'Base backoff in milliseconds between retries (default 1000)',
        },
        approval_request_id: {
          type: 'string',
          description: 'Required when retrying send action after /approve',
        },
        auth: {
          type: 'object',
          description: 'Optional connector auth override (token/base_url); defaults to env vars',
          properties: {
            token: { type: 'string' },
            base_url: { type: 'string' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      required: ['connector', 'action', 'payload', 'idempotency_key'],
      additionalProperties: false,
    },
  },
};

export const readContextTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_context',
    description: 'Read shared context from the Blackboard for multi-agent collaboration. Specify a key to read a specific entry, or omit to list all keys in the scope. Check Blackboard when starting a task — other agents may have written relevant context.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Specific key to read. Omit to list all keys in the scope.',
        },
        scope: {
          type: 'string',
          description: 'Context scope: "global" (default), "task:{task_id}", or "agent:{agent_id}".',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

export const writeContextTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'write_context',
    description: 'Write shared context to the Blackboard for other agents to read. Use to share findings, partial results, or important state. Write concise summaries, not large data blobs. Blackboard is for inter-agent context; use memory tools for cross-session persistence.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Context key (e.g., "analysis_result", "code_review_notes").',
        },
        value: {
          type: 'string',
          description: 'Context value — text summary, JSON, or any string content.',
        },
        scope: {
          type: 'string',
          description: 'Context scope: "global" (default), "task:{task_id}", or "agent:{agent_id}".',
        },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
  },
};

export const setReminderTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'set_reminder',
    description: 'Set a reminder message to be sent after a delay in minutes. Only set reminders when the user asks. Do NOT set unrequested reminders or use extremely long delays without confirming.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Reminder message to send later',
        },
        delay_minutes: {
          type: 'number',
          description: 'Delay in minutes before sending the reminder',
        },
      },
      required: ['message', 'delay_minutes'],
      additionalProperties: false,
    },
  },
};

export const listRemindersTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'list_reminders',
    description: 'List reminders for the current conversation, including pending, delivered, retrying, and failed delivery state.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

export const cancelReminderTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'cancel_reminder',
    description: 'Cancel and delete a reminder by its numeric ID. Use list_reminders first when the user did not provide an ID.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Reminder ID' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
};

export const runTestsTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'run_tests',
    description: 'Run project tests and return structured results with pass/fail counts and failure details. Always run after code changes. Can target a specific file or grep pattern. Do NOT skip testing after modifications.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Specific test file to run (optional)' },
        grep: { type: 'string', description: 'Pattern to match test names (optional)' },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

export const improveCodeTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'improve_code',
    description: 'Analyze and improve MOZI\'s own source code (refactor, fix bugs, add features). Changes are logged for review. Always read the target file first. Do NOT use for files outside MOZI\'s src/ directory.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Target file path in src/ (e.g., "gateway/handler.ts")',
        },
        issue: {
          type: 'string',
          description: 'What\'s wrong or what to add',
        },
        approach: {
          type: 'string',
          description: 'How to fix it',
        },
        auto_apply: {
          type: 'boolean',
          description: 'If true, attempt to write changes directly (requires review)',
        },
      },
      required: ['target', 'issue'],
      additionalProperties: false,
    },
  },
};

export const INTEGRATION_TOOL_DEFINITIONS: ToolDefinition[] = [
  connectorExecuteTool,
  readContextTool,
  writeContextTool,
  setReminderTool,
  listRemindersTool,
  cancelReminderTool,
  runTestsTool,
  improveCodeTool,
];

// ── Executor ──

export async function executeIntegrationTool(
  name: string,
  args: Record<string, unknown>,
  id: string,
  context?: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'improve_code': {
      const { target, issue, approach, auto_apply } = args as { target?: string; issue?: string; approach?: string; auto_apply?: boolean };
      if (!target || !issue) {
        return { tool_call_id: id, content: 'Error: target and issue are required', is_error: true };
      }
      const { improveCode } = await import('../tools/self-modify.js');
      const result = await improveCode(
        { target, issue, approach: approach || 'Not specified', auto_apply: auto_apply || false },
        context?.client,
      );
      return { tool_call_id: id, content: result, is_error: false };
    }

    case 'connector_execute': {
      const connector = args.connector as string;
      const action = args.action as string;
      const payloadRaw = args.payload;
      const idempotencyKey = args.idempotency_key as string;
      const maxRetries = args.max_retries as number | undefined;
      const retryBackoffMs = args.retry_backoff_ms as number | undefined;
      const approvalRequestId = args.approval_request_id as string | undefined;
      const authRaw = args.auth;

      if (!connector || typeof connector !== 'string') {
        return { tool_call_id: id, content: 'Error: "connector" is required and must be a string', is_error: true };
      }
      if (!['gmail', 'calendar', 'slack', 'github'].includes(connector)) {
        return { tool_call_id: id, content: 'Error: "connector" must be one of: gmail, calendar, slack, github', is_error: true };
      }
      if (!action || typeof action !== 'string') {
        return { tool_call_id: id, content: 'Error: "action" is required and must be a string', is_error: true };
      }
      if (!idempotencyKey || typeof idempotencyKey !== 'string') {
        return { tool_call_id: id, content: 'Error: "idempotency_key" is required and must be a string', is_error: true };
      }
      if (!payloadRaw || typeof payloadRaw !== 'object' || Array.isArray(payloadRaw)) {
        return { tool_call_id: id, content: 'Error: "payload" must be an object', is_error: true };
      }
      if (maxRetries !== undefined && typeof maxRetries !== 'number') {
        return { tool_call_id: id, content: 'Error: "max_retries" must be a number', is_error: true };
      }
      if (retryBackoffMs !== undefined && typeof retryBackoffMs !== 'number') {
        return { tool_call_id: id, content: 'Error: "retry_backoff_ms" must be a number', is_error: true };
      }
      if (approvalRequestId !== undefined && typeof approvalRequestId !== 'string') {
        return { tool_call_id: id, content: 'Error: "approval_request_id" must be a string', is_error: true };
      }
      if (authRaw !== undefined && (!authRaw || typeof authRaw !== 'object' || Array.isArray(authRaw))) {
        return { tool_call_id: id, content: 'Error: "auth" must be an object', is_error: true };
      }
      const auth = authRaw ? asRecord(authRaw) : undefined;
      if (auth && auth.token !== undefined && typeof auth.token !== 'string') {
        return { tool_call_id: id, content: 'Error: "auth.token" must be a string', is_error: true };
      }
      if (auth && auth.base_url !== undefined && typeof auth.base_url !== 'string') {
        return { tool_call_id: id, content: 'Error: "auth.base_url" must be a string', is_error: true };
      }

      const { executeConnector } = await import('../capabilities/connectors.js');
      const result = await executeConnector({
        connector: connector as 'gmail' | 'calendar' | 'slack' | 'github',
        action,
        payload: asRecord(payloadRaw)!,
        idempotencyKey,
        maxRetries,
        retryBackoffMs,
        approvalRequestId,
        tenantId: context?.tenantId || 'default',
        auth: auth ? {
          token: auth.token as string | undefined,
          base_url: auth.base_url as string | undefined,
        } : undefined,
      });

      const summary = [
        `Connector: ${result.connector}`,
        `Action: ${result.action}`,
        `Idempotency-Key: ${result.idempotencyKey}`,
        `Attempts: ${result.attempts}`,
        `Cached: ${result.cached ? 'yes' : 'no'}`,
        `External-ID: ${result.externalId ?? '(none)'}`,
        `Data: ${JSON.stringify(result.data)}`,
      ].join('\n');

      return { tool_call_id: id, content: summary, is_error: false };
    }

    case 'set_reminder': {
      const message = args.message as string;
      const delayMinutes = args.delay_minutes as number;
      if (!message || typeof message !== 'string') {
        return { tool_call_id: id, content: 'Error: "message" parameter is required and must be a string', is_error: true };
      }
      if (typeof delayMinutes !== 'number' || !Number.isFinite(delayMinutes)) {
        return { tool_call_id: id, content: 'Error: "delay_minutes" parameter is required and must be a number', is_error: true };
      }
      if (delayMinutes < 0) {
        return { tool_call_id: id, content: 'Error: "delay_minutes" must be a non-negative number', is_error: true };
      }
      if (!context?.chatId) {
        return { tool_call_id: id, content: 'Error: "set_reminder" requires chat context', is_error: true };
      }

      const reminder = addReminder({
        chatId: context.chatId,
        message,
        delayMinutes,
        tenantId: context.tenantId ?? 'default',
        userId: context.userId,
        sessionId: context.sessionId,
        channelType: context.channelType,
      });
      return {
        tool_call_id: id,
        content: `Reminder set for ${delayMinutes} minute(s): ${message} (fire_at: ${reminder.fire_at})`,
        is_error: false,
        ends_turn: true,
        ends_turn_message: `Reminder set for ${delayMinutes} minute(s): ${message} (fire_at: ${reminder.fire_at})`,
      };
    }

    case 'list_reminders': {
      if (!context?.chatId) {
        return { tool_call_id: id, content: 'Error: "list_reminders" requires chat context', is_error: true };
      }
      const reminders = listReminders(context.tenantId ?? 'default')
        .filter(reminder => reminder.chat_id === context.chatId);
      const endsTurn = resolveSchedulerControlAction(context.userPrompt ?? '') === 'list';
      if (reminders.length === 0) {
        const content = 'No reminders in this conversation.';
        return { tool_call_id: id, content, is_error: false, ...(endsTurn ? { ends_turn: true, ends_turn_message: content } : {}) };
      }
      const content = reminders.map(reminder =>
        `- ${reminder.id}: [${reminder.status}] ${reminder.fire_at} — ${reminder.message}`
      ).join('\n');
      return {
        tool_call_id: id,
        content,
        is_error: false,
        ...(endsTurn ? { ends_turn: true, ends_turn_message: content } : {}),
      };
    }

    case 'cancel_reminder': {
      const reminderId = Number(args.id);
      if (!Number.isInteger(reminderId) || reminderId <= 0 || !context?.chatId) {
        return { tool_call_id: id, content: 'Error: a positive reminder ID and chat context are required', is_error: true };
      }
      const owned = listReminders(context.tenantId ?? 'default')
        .some(reminder => reminder.id === reminderId && reminder.chat_id === context.chatId);
      const cancelled = owned && cancelReminder(reminderId, context.tenantId ?? 'default');
      return {
        tool_call_id: id,
        content: cancelled ? `Reminder ${reminderId} cancelled.` : `Reminder ${reminderId} not found in this conversation.`,
        is_error: !cancelled,
        ...(cancelled ? { ends_turn: true, ends_turn_message: `Reminder ${reminderId} cancelled.` } : {}),
      };
    }

    case 'run_tests': {
      const { runTests } = await import('../tools/test-runner.js');
      const file = args.file as string | undefined;
      const grep = args.grep as string | undefined;
      const result = await runTests({ file, grep });
      return { tool_call_id: id, content: JSON.stringify(result, null, 2), is_error: !result.success };
    }

    case 'read_context': {
      const { read, list } = await import('../capabilities/blackboard.js');
      const key = args.key as string | undefined;
      const scope = (args.scope as string) || 'global';
      const tenantId = context?.tenantId || 'default';

      if (key) {
        const value = read(key, { scope, tenant_id: tenantId });
        return {
          tool_call_id: id,
          tool_name: 'read_context',
          content: value ?? `Key "${key}" not found in scope "${scope}"`,
          is_error: false,
        };
      }

      const entries = list({ scope, tenant_id: tenantId });
      if (entries.length === 0) {
        return {
          tool_call_id: id,
          tool_name: 'read_context',
          content: `No context entries in scope "${scope}"`,
          is_error: false,
        };
      }

      const formatted = entries
        .map(e => `[${e.key}] (by ${e.written_by ?? 'unknown'}, ${e.updated_at})\n${e.value}`)
        .join('\n\n');
      return {
        tool_call_id: id,
        tool_name: 'read_context',
        content: formatted,
        is_error: false,
      };
    }

    case 'write_context': {
      const { write } = await import('../capabilities/blackboard.js');
      const key = args.key as string;
      const value = args.value as string;
      if (!key || !value) {
        return {
          tool_call_id: id,
          tool_name: 'write_context',
          content: 'Error: "key" and "value" parameters are required',
          is_error: true,
        };
      }
      const scope = (args.scope as string) || 'global';
      const tenantId = context?.tenantId || 'default';

      write(key, value, { scope, tenant_id: tenantId });
      return {
        tool_call_id: id,
        tool_name: 'write_context',
        content: `Context written: "${key}" in scope "${scope}"`,
        is_error: false,
      };
    }

    default:
      return null;
  }
}
