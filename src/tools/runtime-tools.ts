/**
 * Runtime/System Tools — create_tool, restart_self, proactive_control, send_progress_report.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import pino from 'pino';
import { getRuntimeProjectRoot } from '../runtime/project-root.js';
import type { ToolDefinition } from '../core/llm.js';
import type { ToolResult, ToolContext } from './types.js';
import { ensureArtifactCoordinator } from '../artifacts/coordinator.js';
import type { ArtifactEnvelope } from '../artifacts/types.js';
import { normalizeArtifactContentType } from '../artifacts/content-contract.js';
import {
  findLatestArtifactIdentityByPersistedPath,
  getLatestArtifactVersion,
  getNextArtifactVersionNumber,
  insertArtifactVersion,
  isPersistableArtifactContentType,
  persistArtifactContent,
  persistArtifactContentToPath,
  type PersistableArtifactContentType,
} from '../artifacts/versioning.js';
import {
  getWorkspaceDir,
  asRecord,
  MAX_DYNAMIC_SCRIPT_SIZE_BYTES,
  DYNAMIC_TOOL_NAME_PATTERN,
} from './tool-utils.js';
import { resolveSchedulerControlAction } from '../core/durable-plan-admission.js';

const logger = pino({ name: 'mozi:tools:system' });

/** Timestamp when this module was loaded — used for restart_self cooldown. */
const restartSelfProcessStartTime = Date.now();

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function createArtifactValidationError(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  const previewEntries = entries.slice(0, 8);
  const keys = previewEntries.map(([key]) => key);
  const types = previewEntries.map(([key, value]) => {
    const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    return `${key}=${type}`;
  });
  const omitted = entries.length - previewEntries.length;
  return [
    'Error: create_artifact requires title, content_type, code.',
    `Received keys: [${keys.join(', ')}]${omitted > 0 ? ` (+${omitted} more)` : ''}`,
    `(types: ${types.join(', ')}).`,
    'Coercible aliases: content/markdown/text→code, name→title.',
    'Expected example: {"title":"Report","content_type":"markdown","code":"# Report"}',
  ].join(' ');
}

// ── Definitions ──

export const createToolTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'create_tool',
    description: 'Create a new dynamic tool by writing a script and registering it at runtime. Use only for recurring tasks not covered by existing tools. Test the tool after creation. Do NOT create tools for one-off tasks or to duplicate existing functionality.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Tool name in snake_case',
        },
        description: {
          type: 'string',
          description: 'Short description of what the tool does',
        },
        parameters_schema: {
          type: 'string',
          description: 'JSON string containing the tool parameter schema object',
        },
        script_content: {
          type: 'string',
          description: 'Script source code to execute when this tool is called',
        },
        script_type: {
          type: 'string',
          description: 'Script language type',
          enum: ['bash', 'python'],
        },
      },
      required: ['name', 'description', 'parameters_schema', 'script_content', 'script_type'],
      additionalProperties: false,
    },
  },
};

export const restartSelfTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'restart_self',
    description: 'Gracefully restart MOZI. ONLY use when YOU have written changes to mozi.json or .env that require a restart to take effect. NEVER restart for verification, debugging, diagnostics, or "checking if config loaded". NEVER restart via shell_exec. Use reload_skills for skill changes instead.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Why the restart is needed (logged for diagnostics)',
        },
      },
      required: ['reason'],
      additionalProperties: false,
    },
  },
};

export const proactiveControlTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'proactive_control',
    description: 'Control only the proactive engine quiet/wait override. This does not list or cancel persisted reminders; use list_reminders and cancel_reminder for those.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'The action to perform',
          enum: ['status', 'cancel_wait', 'set_wait'],
        },
        minutes: {
          type: 'number',
          description: 'Number of minutes to wait (only for set_wait action)',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
};

export const sendProgressReportTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'send_progress_report',
    description: 'Send an interim progress report to the user during a long-running task. Use this to communicate milestone completion, phase transitions, or intermediate findings BEFORE the final response. The report is sent immediately as a separate message. Continue working after sending.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Report title (e.g., "Phase 1 Complete", "Research Summary")',
        },
        body: {
          type: 'string',
          description: 'Report body in markdown. Include what was done, key findings, and what comes next.',
        },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
  },
};

const createBackgroundTaskTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'create_background_task',
    description: 'Create a long-running background task. The task runs asynchronously and the user is notified when it completes or fails. Use for: shell commands that take more than 60s, LLM analysis tasks, URL polling/monitoring.',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'What the task should accomplish (shown to user in notifications)' },
        handler_type: {
          type: 'string',
          enum: ['shell_background', 'llm_background', 'poll_url'],
          description: 'Handler type: shell_background (run shell command), llm_background (LLM generation), poll_url (poll URL until condition met)',
        },
        handler_params: {
          type: 'object',
          description: 'Parameters for the handler. shell_background: {command, cwd?}. llm_background: {prompt, system?, max_tokens?}. poll_url: {url, expected_status?, match_body?, poll_interval_ms?}',
        },
        timeout_minutes: { type: 'number', description: 'Max execution time in minutes (default 5)' },
      },
      required: ['objective', 'handler_type', 'handler_params'],
    },
  },
};

const createArtifactTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'create_artifact',
    description: 'Render rich content directly in the UI canvas. Use for visualizations (HTML, SVG, React, chart), interactive widgets, OR long-form documents/reports (markdown). Prefer a markdown artifact over a giant chat message when delivering a structured report, analysis, or write-up the user will want to read, keep, or export. Do not use this tool as a substitute for a real Office file: when the user explicitly asks for a DOCX/PPTX/XLSX report, deck, or spreadsheet, use an available file-generation skill/tool to create the binary file instead; if no such capability is available, say so rather than silently downgrading to markdown. VISUAL CONTRACT for svg/html/javascript (the UI shows them inline in a titled card): do NOT repeat a large title inside the graphic — the card header already displays your title parameter; fill the canvas edge-to-edge with outer margins under 6% of the viewBox; the frame adopts YOUR viewBox aspect ratio, so choose it for the content (wide charts ~2:1); must be fully self-contained — no external CDN scripts, fonts, or images: inline cards enforce a no-network Content-Security-Policy, so any external reference renders blank (inline code and data: URIs work). Author a chart/widget as an HTML FRAGMENT (a container div plus its inline script/style — no <!doctype> or <html> shell); a full standalone page is treated as a DOCUMENT deliverable and renders as a click-to-open card instead of inline.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Display title for the artifact card' },
        name: { type: 'string', description: 'Backward-compatible alias for title' },
        content_type: { type: 'string', enum: ['html', 'svg', 'react', 'javascript', 'markdown'], description: 'Type of content: html (full page or fragment), svg (raw SVG), react (JSX/TSX component), javascript (vanilla JS), markdown (long-form report/document rendered as rich text in the canvas)' },
        code: { type: 'string', description: 'The content. For HTML: full document or fragment. For SVG: raw <svg>...</svg>. For React: a component with export default. For JS: vanilla JavaScript. For markdown: the full document in GitHub-flavored markdown (headings, tables, lists).' },
        content: { type: 'string', description: 'Backward-compatible alias for code; defaults content_type to markdown' },
        markdown: { type: 'string', description: 'Backward-compatible markdown alias for code' },
        text: { type: 'string', description: 'Backward-compatible plain-text alias for code' },
        fallback_text: { type: 'string', description: 'Plain text summary for non-rich clients (Telegram, etc.)' },
      },
      allOf: [
        { anyOf: [{ required: ['title'] }, { required: ['name'] }] },
        { anyOf: [{ required: ['code'] }, { required: ['content'] }, { required: ['markdown'] }, { required: ['text'] }] },
      ],
      additionalProperties: false,
    },
  },
};

const updateArtifactTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'update_artifact',
    description: 'Update an existing persisted markdown or HTML artifact by creating a new version linked to the original artifact_id. Use this for iterative edits to a previous artifact; pass the full updated content, not only the changed fragment.',
    parameters: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string', description: 'Original artifact id, or any version artifact id from the artifact_versions table' },
        new_content: { type: 'string', description: 'Full updated artifact content. Preserve unchanged sections from the previous version.' },
        change_description: { type: 'string', description: 'Optional short description of what changed' },
      },
      required: ['artifact_id', 'new_content'],
      additionalProperties: false,
    },
  },
};

export const getCapabilitiesTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'get_capabilities',
    description: 'Return the full runtime capability contract: per-capability enabled/disabled status, active skill extensions, providers/models, and registered tools. Use when the user asks whether a specific capability, integration, or execution path is available, or before claiming delegation/worker readiness. The per-turn system prompt only carries a compact summary.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
};

export const RUNTIME_TOOL_DEFINITIONS: ToolDefinition[] = [
  getCapabilitiesTool,
  createToolTool,
  restartSelfTool,
  proactiveControlTool,
  sendProgressReportTool,
  createBackgroundTaskTool,
  createArtifactTool,
  updateArtifactTool,
  {
    type: 'function',
    function: {
      name: 'set_cron_task',
      description: 'Create a MOZI-managed scheduled task. Supports "cron" recurring, "every" fixed interval (milliseconds, min 60000), and "at" one-shot ISO time. For market-close work, use the exchange timezone and weekday cron, and require the future managed_brain prompt to verify that the current date is an actual completed trading session before producing results; never substitute stale or mock data. Task fires automatically and the result is persistently delivered.',
      parameters: {
        type: 'object',
        properties: {
          schedule_kind: { type: 'string', enum: ['cron', 'every', 'at'], description: 'Schedule mode. "cron" = recurring expression, "every" = fixed interval in ms, "at" = one-shot ISO datetime' },
          schedule_value: { type: 'string', description: 'Cron expression ("0 9 * * *"), interval ms ("3600000"), or ISO datetime ("2026-03-19T09:00:00Z")' },
          handler_type: { type: 'string', enum: ['notify', 'daily_summary', 'managed_brain', 'llm_background', 'poll_url'], description: 'Safe registered handler to run. Use managed_brain for research, files, dashboards, or other MOZI work. Raw shell execution is not permitted for schedules.' },
          handler_params: { type: 'object', description: 'Handler parameters. managed_brain requires prompt: the future workload only, excluding instructions to create the schedule. The runtime also preserves the full source request.' },
          description: { type: 'string', description: 'Human-readable description shown in notifications' },
          timezone: { type: 'string', description: 'Timezone for cron expressions (e.g. "Asia/Shanghai"). Defaults to system timezone' },
          delete_after_run: { type: 'boolean', description: 'Delete task after first run (for one-shot "at" tasks). Default false' },
        },
        required: ['schedule_kind', 'schedule_value', 'handler_type', 'description'],
      },
    },
  } as ToolDefinition,
  {
    type: 'function',
    function: {
      name: 'list_cron_tasks',
      description: 'List all recurring scheduled tasks.',
      parameters: { type: 'object', properties: {} },
    },
  } as ToolDefinition,
  {
    type: 'function',
    function: {
      name: 'cancel_cron_task',
      description: 'Cancel a recurring scheduled task by ID.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Cron task ID to cancel' } },
        required: ['id'],
      },
    },
  } as ToolDefinition,
];

function pluginIdForArtifactContent(contentType: string): string {
  return contentType === 'markdown' || contentType === 'document' ? 'document_v1' : 'sandpack_v1';
}

function artifactDataForContent(
  contentType: string,
  content: string,
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  if (contentType === 'markdown') {
    return { markdown: content, content_type: 'markdown', ...metadata };
  }
  return { code: content, content_type: contentType, ...metadata };
}

function inferPersistedContentType(path: string): PersistableArtifactContentType {
  return /\.html?$/i.test(path) ? 'html' : 'markdown';
}

function versionWarningMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function saveArtifactEnvelopeToConversation(
  artifact: ArtifactEnvelope,
  context: ToolContext | undefined,
  logLabel: string,
): Promise<string | null> {
  if (!context?.chatId) {
    logger.warn(
      { artifactId: artifact.id, sessionId: context?.sessionId },
      `${logLabel}: artifact not persisted — missing chatId`,
    );
    return 'missing chatId';
  }

  try {
    const { saveMessage } = await import('../memory/conversations.js');
    const artifactJson = JSON.stringify({ _artifact: true, ...artifact });
    saveMessage(context.chatId, 'tool', artifactJson, undefined, undefined, context.sessionId, context.tenantId);
    return null;
  } catch (err) {
    const message = versionWarningMessage(err);
    logger.error(
      { err: message, artifactId: artifact.id, chatId: context.chatId, sessionId: context.sessionId },
      `${logLabel}: failed to persist artifact`,
    );
    return message;
  }
}

// ── Executor ──

export async function executeRuntimeTool(
  name: string,
  args: Record<string, unknown>,
  id: string,
  context?: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'get_capabilities': {
      const { getConfig } = await import('../config/index.js');
      const { buildRuntimeCapabilityManifest, formatCapabilityPromptSection } = await import('../core/capability-manifest.js');
      const { getAllRegisteredTools } = await import('./dynamic-registry.js');
      const tenantId = context?.tenantId ?? 'default';
      const manifest = buildRuntimeCapabilityManifest(
        getConfig(),
        getAllRegisteredTools(tenantId).map(tool => tool.function.name),
        tenantId,
      );
      return {
        tool_call_id: id,
        content: formatCapabilityPromptSection(manifest),
        is_error: false,
      };
    }
    case 'create_tool': {
      const toolName = args.name as string;
      const description = args.description as string;
      const parametersSchema = args.parameters_schema as string;
      const scriptContent = args.script_content as string;
      const scriptType = args.script_type as 'bash' | 'python';

      if (!toolName || typeof toolName !== 'string') {
        return { tool_call_id: id, content: 'Error: "name" parameter is required and must be a string', is_error: true };
      }
      if (!DYNAMIC_TOOL_NAME_PATTERN.test(toolName)) {
        return { tool_call_id: id, content: 'Error: "name" must be snake_case', is_error: true };
      }
      if (!description || typeof description !== 'string') {
        return { tool_call_id: id, content: 'Error: "description" parameter is required and must be a string', is_error: true };
      }
      if (!parametersSchema || typeof parametersSchema !== 'string') {
        return { tool_call_id: id, content: 'Error: "parameters_schema" parameter is required and must be a JSON string', is_error: true };
      }
      if (!scriptContent || typeof scriptContent !== 'string') {
        return { tool_call_id: id, content: 'Error: "script_content" parameter is required and must be a string', is_error: true };
      }
      if (!scriptType || (scriptType !== 'bash' && scriptType !== 'python')) {
        return { tool_call_id: id, content: 'Error: "script_type" must be "bash" or "python"', is_error: true };
      }

      try {
        const parsed = JSON.parse(parametersSchema) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { tool_call_id: id, content: 'Error: "parameters_schema" must be a JSON object', is_error: true };
        }
      } catch {
        return { tool_call_id: id, content: 'Error: "parameters_schema" must be valid JSON', is_error: true };
      }

      if (Buffer.byteLength(scriptContent, 'utf-8') > MAX_DYNAMIC_SCRIPT_SIZE_BYTES) {
        return { tool_call_id: id, content: 'Error: "script_content" exceeds 10KB limit', is_error: true };
      }

      // Lazy import to avoid circular dependency (definitions.ts imports system-tools.ts)
      const { ALL_TOOLS: allTools } = await import('./definitions.js');
      const builtInToolNames = new Set(allTools.map(t => t.function.name));
      if (builtInToolNames.has(toolName)) {
        return { tool_call_id: id, content: `Error: Tool "${toolName}" conflicts with built-in tools`, is_error: true };
      }
      const { isDynamicToolRegistered } = await import('./dynamic-registry.js');
      if (isDynamicToolRegistered(toolName, context?.tenantId)) {
        return { tool_call_id: id, content: `Error: Tool "${toolName}" already exists`, is_error: true };
      }

      const toolsDir = join(getWorkspaceDir(), 'tools');
      mkdirSync(toolsDir, { recursive: true });

      const bashPath = join(toolsDir, `${toolName}.sh`);
      const pythonPath = join(toolsDir, `${toolName}.py`);
      if (existsSync(bashPath) || existsSync(pythonPath)) {
        return { tool_call_id: id, content: `Error: Tool script for "${toolName}" already exists`, is_error: true };
      }

      const extension = scriptType === 'python' ? 'py' : 'sh';
      const scriptPath = join(toolsDir, `${toolName}.${extension}`);

      writeFileSync(scriptPath, scriptContent, 'utf-8');
      chmodSync(scriptPath, 0o700);

      const { registerDynamicTool } = await import('./dynamic-registry.js');
      registerDynamicTool({
        name: toolName,
        description,
        parameters_schema: parametersSchema,
        handler_type: scriptType,
        handler_path: scriptPath,
        created_at: new Date().toISOString(),
      }, context?.tenantId);

      return {
        tool_call_id: id,
        content: `Dynamic tool "${toolName}" created successfully`,
        is_error: false,
      };
    }

    case 'restart_self': {
      const reason = (args.reason as string) ?? 'no reason provided';
      logger.info({ reason }, 'Self-restart requested');

      // Cooldown: reject if process started less than 5 minutes ago to prevent
      // restart loops from overeager models.
      const uptimeMs = Date.now() - restartSelfProcessStartTime;
      const cooldownMs = 5 * 60 * 1000;
      if (uptimeMs < cooldownMs) {
        const remainingSec = Math.ceil((cooldownMs - uptimeMs) / 1000);
        logger.warn({ reason, uptimeMs, remainingSec }, 'restart_self rejected — cooldown active');
        return {
          tool_call_id: id,
          content: `Restart rejected: MOZI restarted ${Math.floor(uptimeMs / 1000)}s ago. Cooldown has ${remainingSec}s remaining. Do NOT retry — if config is already applied, no restart is needed.`,
          is_error: true,
        };
      }

      // Send reply to user BEFORE restarting — the process will die before
      // the normal response path can deliver the message.
      if (context?.chatId) {
        const { notify } = await import('../channels/proactive-notifier.js');
        const restartMsg = `Restarting MOZI (reason: ${reason}). Back in a moment...`;
        await notify(context.chatId, restartMsg, { channelKey: context.channelType }).catch((err) => {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to notify user before restart');
        });
      }

      const projectRoot = getRuntimeProjectRoot();
      const child = spawn(process.execPath, [
        join(projectRoot, 'dist', 'cli.js'), 'restart', '--daemon', '--skip-ui',
      ], {
        cwd: projectRoot,
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.unref();

      return {
        tool_call_id: id,
        content: `Restart initiated (reason: ${reason}). New process spawning in background. You will briefly lose connectivity.`,
        is_error: false,
      };
    }

    case 'proactive_control': {
      const action = args.action as string;
      const { getProactiveStatus, clearWaitOverride, setWaitOverride } = await import('../core/proactive-engine.js');

      if (action === 'status') {
        const status = getProactiveStatus();
        return { tool_call_id: id, content: JSON.stringify(status, null, 2), is_error: false };
      }
      if (action === 'cancel_wait') {
        clearWaitOverride();
        return { tool_call_id: id, content: 'Wait override cancelled. Proactive engine will resume normal wake cycles.', is_error: false };
      }
      if (action === 'set_wait') {
        const minutes = args.minutes as number | undefined;
        if (!minutes || minutes <= 0) {
          return { tool_call_id: id, content: 'Error: "minutes" must be a positive number for set_wait', is_error: true };
        }
        setWaitOverride(minutes);
        return { tool_call_id: id, content: `Proactive engine will stay quiet for ${minutes} minutes.`, is_error: false };
      }
      return { tool_call_id: id, content: `Error: Unknown action "${action}"`, is_error: true };
    }

    case 'send_progress_report': {
      const title = args.title as string;
      const body = args.body as string;
      if (!title || typeof title !== 'string') {
        return { tool_call_id: id, content: 'Error: "title" is required and must be a string', is_error: true };
      }
      if (!body || typeof body !== 'string') {
        return { tool_call_id: id, content: 'Error: "body" is required and must be a string', is_error: true };
      }

      // Send report to user via proactive notifier (works across all channels)
      if (context?.chatId) {
        const reportMd = `**${title}**\n\n${body}`;
        try {
          const { notify } = await import('../channels/proactive-notifier.js');
          await notify(context.chatId, reportMd, { channelKey: context.channelType });
        } catch (notifyErr) {
          logger.warn({ err: notifyErr instanceof Error ? notifyErr.message : String(notifyErr) }, 'Failed to send progress report via notifier');
        }
      }

      return { tool_call_id: id, content: `Progress report sent: "${title}"`, is_error: false };
    }

    case 'create_artifact': {
      const code = nonEmptyString(args.code)
        ?? nonEmptyString(args.content)
        ?? nonEmptyString(args.markdown)
        ?? nonEmptyString(args.text);
      const requestedContentType = nonEmptyString(args.content_type) ?? (code ? 'markdown' : undefined);
      const title = nonEmptyString(args.title) ?? nonEmptyString(args.name);
      const fallbackText = (args.fallback_text as string) ?? title;

      if (!title || !requestedContentType || !code) {
        const argBytes = Buffer.byteLength(JSON.stringify(args), 'utf8');
        const receivedKeys = Object.keys(args);
        logger.warn(
          { receivedKeys: receivedKeys.slice(0, 12), receivedKeyCount: receivedKeys.length, argBytes },
          'create_artifact validation failed',
        );
        return { tool_call_id: id, content: createArtifactValidationError(args), is_error: true };
      }

      const contentType = normalizeArtifactContentType(requestedContentType, code);
      if (contentType !== requestedContentType && !(requestedContentType === 'document' && contentType === 'markdown')) {
        logger.warn(
          { title, requestedContentType, normalizedContentType: contentType },
          'create_artifact corrected content type from strong content signature',
        );
      }
      const pluginId = pluginIdForArtifactContent(contentType);
      let persistedPath: string | undefined;
      let parentId: string | undefined;
      let versionNumber: number | undefined;
      let changeDescription: string | undefined;
      let versionWarning: string | null = null;

      if (isPersistableArtifactContentType(contentType)) {
        try {
          persistedPath = await persistArtifactContent({
            title,
            contentType,
            content: code,
            chatId: context?.chatId,
            sessionId: context?.sessionId,
            userId: context?.userId,
          });
        } catch (err) {
          const message = versionWarningMessage(err);
          logger.error(
            { err: message, title, contentType, chatId: context?.chatId, sessionId: context?.sessionId },
            'create_artifact: failed to persist artifact content to disk',
          );
          return { tool_call_id: id, content: `Error creating artifact: ${message}`, is_error: true };
        }

        try {
          const existingArtifact = findLatestArtifactIdentityByPersistedPath({
            persistedPath,
            tenantId: context?.tenantId,
            chatId: context?.chatId,
            sessionId: context?.sessionId,
          });
          parentId = existingArtifact?.artifactId;
          versionNumber = parentId ? getNextArtifactVersionNumber(parentId, context?.tenantId ?? 'default') : 1;
          if (parentId) {
            changeDescription = 'Created new content for existing persisted artifact path';
          }
        } catch (err) {
          versionWarning = versionWarningMessage(err);
          logger.error(
            { err: versionWarning, title, contentType, chatId: context?.chatId, sessionId: context?.sessionId },
            'create_artifact: failed to inspect previous artifact version',
          );
          versionNumber = 1;
        }
      }

      const metadata = {
        ...(persistedPath ? { persisted_path: persistedPath } : {}),
        ...(parentId ? { parent_id: parentId } : {}),
        ...(versionNumber !== undefined ? { version_number: versionNumber } : {}),
        ...(changeDescription ? { change_description: changeDescription } : {}),
      };
      const data = artifactDataForContent(contentType, code, metadata);
      const artifactCoordinator = ensureArtifactCoordinator(context, context?.turnId ?? id);
      if (persistedPath) {
        artifactCoordinator.registerFileWrite(id, persistedPath);
      }
      const artifactId = artifactCoordinator.openOrGet(id, {
        plugin_id: pluginId,
        title,
        content_type: contentType,
        status: 'running',
        collapsed_by_default: false,
        fallback_text: fallbackText,
        data,
        persisted_path: persistedPath,
        parent_id: parentId,
        version_number: versionNumber,
        change_description: changeDescription,
      });

      if (persistedPath && versionNumber !== undefined) {
        const rootArtifactId = parentId ?? artifactId;
        try {
          insertArtifactVersion({
            id: artifactId,
            artifactId: rootArtifactId,
            tenantId: context?.tenantId ?? 'default',
            versionNumber,
            content: code,
            persistedPath,
            changeDescription,
          });
        } catch (err) {
          versionWarning = versionWarningMessage(err);
          logger.error(
            { err: versionWarning, artifactId, rootArtifactId, persistedPath, versionNumber },
            'create_artifact: failed to insert artifact version',
          );
        }
      }

      const artifact: ArtifactEnvelope = {
        id: artifactId,
        plugin_id: pluginId,
        title,
        status: 'completed' as const,
        collapsed_by_default: false,
        fallback_text: fallbackText,
        data,
        updated_at: new Date().toISOString(),
        ...(persistedPath ? { persisted_path: persistedPath } : {}),
        ...(parentId ? { parent_id: parentId } : {}),
        ...(versionNumber !== undefined ? { version_number: versionNumber } : {}),
        ...(changeDescription ? { change_description: changeDescription } : {}),
      };

      artifactCoordinator.complete(id, {
        plugin_id: artifact.plugin_id,
        title: artifact.title,
        status: 'completed',
        fallback_text: artifact.fallback_text,
        data: artifact.data,
        updated_at: artifact.updated_at,
        persisted_path: artifact.persisted_path,
        parent_id: artifact.parent_id,
        version_number: artifact.version_number,
        change_description: artifact.change_description,
      });

      const conversationWarning = await saveArtifactEnvelopeToConversation(artifact, context, 'create_artifact');
      const versionText = versionNumber ? ` v${versionNumber}` : '';
      const pathText = persistedPath ? ` Persisted at ${persistedPath}.` : '';
      const parentText = parentId ? ` Linked to parent artifact ${parentId}.` : '';
      const versionWarningText = versionWarning ? ` Warning: artifact version history not recorded (${versionWarning}).` : '';
      const warningText = conversationWarning ? ` Warning: artifact conversation record not saved (${conversationWarning}).` : '';

      return {
        tool_call_id: id,
        content: `Artifact "${title}"${versionText} created and rendered in UI.${pathText}${parentText}${versionWarningText}${warningText}`,
        is_error: false,
        file_path: persistedPath,
      };
    }

    case 'update_artifact': {
      const artifactIdInput = args.artifact_id as string;
      const newContent = args.new_content as string;
      const changeDescription = typeof args.change_description === 'string'
        ? args.change_description.trim() || undefined
        : undefined;

      if (!artifactIdInput || typeof artifactIdInput !== 'string') {
        return { tool_call_id: id, content: 'Error: "artifact_id" is required and must be a string', is_error: true };
      }
      if (newContent === undefined || newContent === null || typeof newContent !== 'string') {
        return { tool_call_id: id, content: 'Error: "new_content" is required and must be a string', is_error: true };
      }

      let latestVersion;
      try {
        latestVersion = getLatestArtifactVersion(artifactIdInput, context?.tenantId ?? 'default');
      } catch (err) {
        const message = versionWarningMessage(err);
        logger.error({ err: message, artifactId: artifactIdInput }, 'update_artifact: failed to load artifact version');
        return { tool_call_id: id, content: `Error loading artifact version: ${message}`, is_error: true };
      }
      if (!latestVersion) {
        return { tool_call_id: id, content: `Error: artifact "${artifactIdInput}" has no persisted versions to update`, is_error: true };
      }

      const contentType = inferPersistedContentType(latestVersion.persisted_path);
      let persistedPath: string;
      let versionNumber: number;
      try {
        persistedPath = await persistArtifactContentToPath(latestVersion.persisted_path, newContent, context?.userId);
        versionNumber = getNextArtifactVersionNumber(latestVersion.artifact_id, context?.tenantId ?? 'default');
      } catch (err) {
        const message = versionWarningMessage(err);
        logger.error(
          { err: message, artifactId: artifactIdInput, persistedPath: latestVersion.persisted_path },
          'update_artifact: failed to persist updated artifact content',
        );
        return { tool_call_id: id, content: `Error updating artifact: ${message}`, is_error: true };
      }

      const pluginId = pluginIdForArtifactContent(contentType);
      const title = `Artifact ${latestVersion.artifact_id} v${versionNumber}`;
      const fallbackText = changeDescription
        ? `Updated ${title}: ${changeDescription}`
        : `Updated ${title}`;
      const metadata = {
        persisted_path: persistedPath,
        parent_id: latestVersion.artifact_id,
        version_number: versionNumber,
        ...(changeDescription ? { change_description: changeDescription } : {}),
      };
      const data = artifactDataForContent(contentType, newContent, metadata);
      const artifactCoordinator = ensureArtifactCoordinator(context, context?.turnId ?? id);
      artifactCoordinator.registerFileWrite(id, persistedPath);
      const updatedArtifactId = artifactCoordinator.openOrGet(id, {
        plugin_id: pluginId,
        title,
        content_type: contentType,
        status: 'running',
        collapsed_by_default: false,
        fallback_text: fallbackText,
        data,
        persisted_path: persistedPath,
        parent_id: latestVersion.artifact_id,
        version_number: versionNumber,
        change_description: changeDescription,
      });

      try {
        insertArtifactVersion({
          id: updatedArtifactId,
          artifactId: latestVersion.artifact_id,
            tenantId: context?.tenantId ?? 'default',
          versionNumber,
          content: newContent,
          persistedPath,
          changeDescription,
        });
      } catch (err) {
        const message = versionWarningMessage(err);
        logger.error(
          { err: message, artifactId: latestVersion.artifact_id, updatedArtifactId, persistedPath, versionNumber },
          'update_artifact: failed to insert artifact version',
        );
        return { tool_call_id: id, content: `Error updating artifact version: ${message}`, is_error: true };
      }

      const artifact: ArtifactEnvelope = {
        id: updatedArtifactId,
        plugin_id: pluginId,
        title,
        status: 'completed',
        collapsed_by_default: false,
        fallback_text: fallbackText,
        data,
        updated_at: new Date().toISOString(),
        persisted_path: persistedPath,
        parent_id: latestVersion.artifact_id,
        version_number: versionNumber,
        ...(changeDescription ? { change_description: changeDescription } : {}),
      };

      artifactCoordinator.complete(id, {
        plugin_id: artifact.plugin_id,
        title: artifact.title,
        status: 'completed',
        fallback_text: artifact.fallback_text,
        data: artifact.data,
        updated_at: artifact.updated_at,
        persisted_path: artifact.persisted_path,
        parent_id: artifact.parent_id,
        version_number: artifact.version_number,
        change_description: artifact.change_description,
      });

      const conversationWarning = await saveArtifactEnvelopeToConversation(artifact, context, 'update_artifact');
      return {
        tool_call_id: id,
        content: JSON.stringify({
          _artifact: true,
          ...artifact,
          ...(conversationWarning ? { warning: `artifact conversation record not saved: ${conversationWarning}` } : {}),
        }, null, 2),
        is_error: false,
        file_path: persistedPath,
      };
    }

    case 'create_background_task': {
      const objective = args.objective as string;
      const handlerType = args.handler_type as string;
      const handlerParams = args.handler_params as Record<string, unknown> | undefined;
      const timeoutMinutes = typeof args.timeout_minutes === 'number' ? args.timeout_minutes : 5;

      if (!objective || typeof objective !== 'string') {
        return { tool_call_id: id, content: 'Error: "objective" is required', is_error: true };
      }
      if (!handlerType) {
        return { tool_call_id: id, content: 'Error: "handler_type" is required', is_error: true };
      }
      if (!['shell_background', 'llm_background', 'poll_url'].includes(handlerType)) {
        return { tool_call_id: id, content: `Error: unsupported background handler "${handlerType}"`, is_error: true };
      }
      if (!context?.chatId || !context.sessionId || !context.userId || !context.channelType) {
        return { tool_call_id: id, content: 'Error: background tasks require user, chat, session, and channel context', is_error: true };
      }
      try {
        const { addBackgroundTask } = await import('../core/background-tasks.js');
        const task = addBackgroundTask({
          chatId: context.chatId,
          userId: context.userId,
          sessionId: context.sessionId,
          channelType: context.channelType,
          permissionLevel: context.permissionLevel,
          objective,
          tenantId: context?.tenantId ?? 'default',
          handlerType,
          handlerParams: handlerParams ?? {},
          timeoutMs: timeoutMinutes * 60 * 1000,
        });
        return {
          tool_call_id: id,
          content: `Background task created (ID: ${task.id}). Type: ${handlerType}. It will run asynchronously and you'll be notified when it completes.\n\nObjective: ${objective}`,
          is_error: false,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return { tool_call_id: id, content: `Error creating background task: ${errMsg}`, is_error: true };
      }
    }

    case 'set_cron_task': {
      const scheduleKind = (args.schedule_kind as string) ?? 'cron';
      const scheduleValue = (args.schedule_value as string) ?? (args.cron_expression as string); // backward compat
      const handlerType = args.handler_type as string;
      const handlerParams = args.handler_params as Record<string, unknown> | undefined;
      const description = args.description as string;
      const timezone = args.timezone as string | undefined;
      const deleteAfterRun = args.delete_after_run as boolean | undefined;

      if (!scheduleValue || !handlerType || !description) {
        return { tool_call_id: id, content: 'Error: schedule_value, handler_type, and description are required', is_error: true };
      }
      if (!context?.chatId || !context.sessionId || !context.userId || !context.channelType || !context.permissionLevel) {
        return { tool_call_id: id, content: 'Error: scheduled tasks require user, chat, session, channel, and permission context', is_error: true };
      }
      let effectiveHandlerParams = handlerParams ?? {};
      if (handlerType === 'managed_brain') {
        const prompt = nonEmptyString(handlerParams?.prompt);
        if (!prompt) {
          return { tool_call_id: id, content: 'Error: managed_brain requires handler_params.prompt containing only the workload to execute when the schedule fires', is_error: true };
        }
        const requestedTimeout = Number(handlerParams?.timeout_minutes ?? 60);
        const managedTimeoutMinutes = Number.isFinite(requestedTimeout)
          ? Math.min(120, Math.max(10, Math.floor(requestedTimeout)))
          : 60;
        effectiveHandlerParams = {
          ...handlerParams,
          prompt,
          source_request: context.userPrompt ?? prompt,
          timeout_minutes: managedTimeoutMinutes,
        };
      }

      try {
        const { addCronTask, isValidSchedule } = await import('../scheduler/cron-tasks.js');
        if (!isValidSchedule(scheduleKind as any, scheduleValue, timezone)) {
          return { tool_call_id: id, content: `Error: Invalid schedule "${scheduleKind}: ${scheduleValue}"`, is_error: true };
        }
        const task = addCronTask({
          chatId: context.chatId,
          userId: context.userId,
          sessionId: context.sessionId,
          channelType: context.channelType,
          permissionLevel: context.permissionLevel,
          scheduleKind: scheduleKind as any,
          scheduleValue,
          timezone,
          handlerType,
          handlerParams: effectiveHandlerParams,
          description,
          deleteAfterRun: deleteAfterRun ?? (scheduleKind === 'at'),
          tenantId: context?.tenantId ?? 'default',
        });
        const isZh = /[㐀-鿿]/.test(context.userPrompt ?? '');
        const content = isZh
          ? `MOZI 定时任务已创建（ID：${task.id}）。\n计划：${scheduleKind} ${scheduleValue}${timezone ? `（${timezone}）` : ''}\n下次运行：${task.next_run_at}\n执行器：${handlerType}\n说明：${description}`
          : `${{ cron: 'Recurring', every: 'Interval', at: 'One-shot' }[scheduleKind] ?? scheduleKind} task created (ID: ${task.id}).\nSchedule: ${scheduleKind} ${scheduleValue}${timezone ? ` (${timezone})` : ''}\nNext run: ${task.next_run_at}\nHandler: ${handlerType}\nDescription: ${description}`;
        return { tool_call_id: id, content, is_error: false, ends_turn: true, ends_turn_message: content };
      } catch (err) {
        return { tool_call_id: id, content: `Error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }
    }

    case 'list_cron_tasks': {
      try {
        const { listCronTasks } = await import('../scheduler/cron-tasks.js');
        const tasks = listCronTasks(context?.tenantId ?? 'default').filter(task =>
          context?.userId ? task.user_id === context.userId : task.chat_id === context?.chatId
        );
        const endsTurn = resolveSchedulerControlAction(context?.userPrompt ?? '') === 'list';
        if (tasks.length === 0) {
          const content = /[㐀-鿿]/.test(context?.userPrompt ?? '') ? '当前没有 MOZI 定时任务。' : 'No MOZI scheduled tasks configured.';
          return { tool_call_id: id, content, is_error: false, ...(endsTurn ? { ends_turn: true, ends_turn_message: content } : {}) };
        }
        const lines = tasks.map(t =>
          `- [${t.enabled ? 'ON' : 'OFF'}] ${t.id}: "${t.description}" (${t.schedule_value}) handler=${t.handler_type}${t.last_run_at ? ` last_run=${t.last_run_at}` : ''}`
        );
        const content = `Cron tasks (${tasks.length}):\n${lines.join('\n')}`;
        return { tool_call_id: id, content, is_error: false, ...(endsTurn ? { ends_turn: true, ends_turn_message: content } : {}) };
      } catch (err) {
        return { tool_call_id: id, content: `Error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }
    }

    case 'cancel_cron_task': {
      const cronId = args.id as string;
      if (!cronId) return { tool_call_id: id, content: 'Error: "id" is required', is_error: true };
      try {
        const { cancelCronTask, listCronTasks } = await import('../scheduler/cron-tasks.js');
        const owned = listCronTasks(context?.tenantId ?? 'default').some(task =>
          task.id === cronId && (context?.userId ? task.user_id === context.userId : task.chat_id === context?.chatId)
        );
        if (owned) {
          const { cascadeCancelCronTask } = await import('../background-executor/runner.js');
          await cascadeCancelCronTask(cronId, context?.tenantId ?? 'default');
        }
        const cancelled = owned && cancelCronTask(cronId, context?.tenantId ?? 'default');
        const content = cancelled ? `Cron task ${cronId} cancelled.` : `Cron task ${cronId} not found.`;
        return { tool_call_id: id, content, is_error: !cancelled, ...(cancelled ? { ends_turn: true, ends_turn_message: content } : {}) };
      } catch (err) {
        return { tool_call_id: id, content: `Error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }
    }

    default:
      return null;
  }
}
