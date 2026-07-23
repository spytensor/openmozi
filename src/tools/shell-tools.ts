import { getConfig } from '../config/index.js';
import pino from 'pino';
import type { ToolDefinition } from '../core/llm.js';
import type { ToolResult, ToolContext } from './types.js';
import {
  resolveWritePath,
  ensureToolWorkspaceDir,
  runTel,
  telErrorMessage,
  asRecord,
  requireShellApprovalIfNeeded,
  createFileCheckpointHandle,
  finalizeFileCheckpoint,
  rollbackFileCheckpoint,
  SHELL_TIMEOUT_MS,
} from './tool-utils.js';

const logger = pino({ name: 'mozi:tools:shell' });

// ── Definitions ──

const EXTERNAL_AI_CLI_HINTS = new Map<string, string>([
  ['claude', 'Claude Code'],
  ['codex', 'Codex CLI'],
  ['gemini', 'Gemini CLI'],
]);

function detectNestedShellAgentCli(command: string): string | null {
  const nestedShellMatch = command.match(/\b(?:bash|sh|zsh)\b[^\n]*?\s-(?:[A-Za-z]*c[A-Za-z]*)\s+["']([\s\S]+?)["']\s*$/i);
  if (!nestedShellMatch) return null;
  return detectExternalAiCliInvocation(nestedShellMatch[1]);
}

function detectExternalAiCliInvocation(command: string): string | null {
  const nested = detectNestedShellAgentCli(command);
  if (nested) return nested;

  const segments = command.split(/&&|\|\||;|\|/);
  for (const rawSegment of segments) {
    let segment = rawSegment.trim();
    if (!segment) continue;

    if (segment.startsWith('env ')) {
      segment = segment.slice(4).trimStart();
    }

    while (/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s*/.test(segment)) {
      segment = segment.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s*/, '').trimStart();
    }

    const executableMatch = segment.match(/^(['"]?)([^'"`\s]+)\1/);
    const executable = executableMatch?.[2]?.split('/').pop()?.toLowerCase();
    if (!executable) continue;

    const hint = EXTERNAL_AI_CLI_HINTS.get(executable);
    if (hint) return hint;
  }

  return null;
}

function buildManagedWorkerOnlyShellError(toolName: string, cliHint: string): string {
  return `Error: ${cliHint} must be launched through skill instructions or a registered agent, not directly via ${toolName}. Follow the skill instructions in your context or use a registered agent with config.external_worker.`;
}

export const shellExecTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'shell_exec',
    description: 'Execute a shell command natively with a 60s timeout. You can run commands like git, curl, npm, python, docker, etc. Do NOT use for reading files (use read_file), listing dirs (use list_directory), interactive commands, or launching external AI CLIs like Claude Code/Codex/Gemini. One command per call.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
        checkpoint_paths: {
          type: 'array',
          description: 'Optional file paths to snapshot before command execution for rollback on failure',
          items: {
            type: 'string',
          },
        },
        approval_request_id: {
          type: 'string',
          description: 'Approval request ID for high-risk shell commands. Required only when the command is blocked pending approval.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
};

export const shellExecBgTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'shell_exec_bg',
    description: 'Start a long-running shell command in the background. Returns a process_id immediately. Use process_status/process_output to monitor. Use for builds, servers, or other host commands that take >60s. Do NOT use this to launch external AI CLIs like Claude Code/Codex/Gemini.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute in background' },
        checkpoint_paths: {
          type: 'array',
          description: 'Optional file paths to snapshot before execution for rollback',
          items: { type: 'string' },
        },
        approval_request_id: {
          type: 'string',
          description: 'Approval request ID for high-risk commands',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
};

export const processStatusTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'process_status',
    description: 'Check the status of a background process. Returns running/completed/failed/killed, exit code, and elapsed time.',
    parameters: {
      type: 'object',
      properties: {
        process_id: { type: 'string', description: 'The process ID returned by shell_exec_bg' },
      },
      required: ['process_id'],
      additionalProperties: false,
    },
  },
};

export const processOutputTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'process_output',
    description: 'Read stdout/stderr output from a background process. Use tail_lines to get only the latest output.',
    parameters: {
      type: 'object',
      properties: {
        process_id: { type: 'string', description: 'The process ID returned by shell_exec_bg' },
        tail_lines: { type: 'number', description: 'Only return the last N lines (default: all)' },
      },
      required: ['process_id'],
      additionalProperties: false,
    },
  },
};

export const processInputTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'process_input',
    description: 'Send input to a running background process stdin. Use for interactive prompts (y/n confirmations, input data).',
    parameters: {
      type: 'object',
      properties: {
        process_id: { type: 'string', description: 'The process ID returned by shell_exec_bg' },
        input: { type: 'string', description: 'Text to write to stdin (newline appended automatically)' },
      },
      required: ['process_id', 'input'],
      additionalProperties: false,
    },
  },
};

export const processKillTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'process_kill',
    description: 'Terminate a running background process.',
    parameters: {
      type: 'object',
      properties: {
        process_id: { type: 'string', description: 'The process ID returned by shell_exec_bg' },
        signal: { type: 'string', description: 'Signal to send (default: SIGTERM). Use SIGKILL for force kill.' },
      },
      required: ['process_id'],
      additionalProperties: false,
    },
  },
};

export const SHELL_TOOLS: ToolDefinition[] = [
  shellExecTool,
  shellExecBgTool,
  processStatusTool,
  processOutputTool,
  processInputTool,
  processKillTool,
];

// ── Executor ──

export async function executeShellTool(
  name: string,
  args: Record<string, unknown>,
  id: string,
  context?: ToolContext,
): Promise<ToolResult | null> {
  if (name === 'shell_exec') {
    const shellCfg = getConfig().tools?.shell;
    const shellRestricted = shellCfg?.restricted ?? false;
    const command = args.command as string;
    if (!command || typeof command !== 'string') {
      return { tool_call_id: id, content: 'Error: "command" parameter is required and must be a string', is_error: true };
    }
    const externalAiCli = detectExternalAiCliInvocation(command);
    if (externalAiCli) {
      return { tool_call_id: id, content: buildManagedWorkerOnlyShellError(name, externalAiCli), is_error: true };
    }
    const approvalRequestId = args.approval_request_id as string | undefined;
    if (approvalRequestId !== undefined && typeof approvalRequestId !== 'string') {
      return { tool_call_id: id, content: 'Error: "approval_request_id" must be a string', is_error: true };
    }
    const approvalMessage = requireShellApprovalIfNeeded(command, approvalRequestId, context, id);
    if (approvalMessage) {
      return { tool_call_id: id, content: approvalMessage, is_error: true };
    }
    const checkpointPathsRaw = args.checkpoint_paths;
    if (
      checkpointPathsRaw !== undefined
      && (!Array.isArray(checkpointPathsRaw) || checkpointPathsRaw.some(item => typeof item !== 'string'))
    ) {
      return { tool_call_id: id, content: 'Error: "checkpoint_paths" must be an array of strings', is_error: true };
    }
    const userId = context?.userId;
    const cwd = await ensureToolWorkspaceDir(userId);
    const checkpointPaths = (checkpointPathsRaw as string[] | undefined)?.map(path => resolveWritePath(path, userId)) ?? [];
    const checkpoint = createFileCheckpointHandle(checkpointPaths, name, id, context);

    const telResult = await runTel('shell', 'execute', {
      command,
      timeout: SHELL_TIMEOUT_MS,
      restricted: shellRestricted,
      cwd,
      userId,
      enforceWorkspaceBoundary: true,
    }, context);
    if (!telResult.success) {
      const errorMessage = telErrorMessage(telResult);
      rollbackFileCheckpoint(checkpoint, name, id, errorMessage, context);
      return { tool_call_id: id, content: `Error: ${errorMessage}`, is_error: true };
    }
    const shellResult = asRecord(telResult.data);
    const blocked = shellResult?.blocked === true;
    const timedOut = shellResult?.timed_out === true;
    const exitCode = typeof shellResult?.exit_code === 'number' ? shellResult.exit_code : -1;
    const stdout = typeof shellResult?.stdout === 'string' ? shellResult.stdout : '';
    const stderr = typeof shellResult?.stderr === 'string' ? shellResult.stderr : '';
    if (blocked) {
      const errorMessage = stderr || `Command blocked by security policy: ${command}`;
      rollbackFileCheckpoint(checkpoint, name, id, errorMessage, context);
      return { tool_call_id: id, content: `Error: ${errorMessage}`, is_error: true };
    }
    if (timedOut) {
      rollbackFileCheckpoint(checkpoint, name, id, `Command timed out after ${SHELL_TIMEOUT_MS / 1000}s`, context);
      return { tool_call_id: id, content: `Command timed out after ${SHELL_TIMEOUT_MS / 1000}s`, is_error: true };
    }
    let output = '';
    if (stdout) output += stdout;
    if (stderr) output += (output ? '\n' : '') + `stderr: ${stderr}`;
    if (!output) output = `(exit code ${exitCode})`;
    if (exitCode !== 0) {
      rollbackFileCheckpoint(checkpoint, name, id, `Non-zero exit code: ${exitCode}`, context);
      // Dependency failures are runtime facts, not an invitation for the Brain
      // to improvise a host-level pip/npm/brew command. Resolve only exact
      // dependencies declared by enabled skills; successful provisioning still
      // leaves this command failed so the next loop must truthfully retry it.
      try {
        const { recoverDeclaredSkillDependency } = await import('../skills/dependency-ledger.js');
        const recovery = await recoverDeclaredSkillDependency(output, context);
        if (recovery) {
          return {
            tool_call_id: id,
            content: `${output}\n\n[RUNTIME DEPENDENCY RECOVERY]\n${recovery.message}`,
            is_error: true,
            ...(recovery.status === 'provisioned' && recovery.skill ? {
              skillName: recovery.skill.name,
              skillDescription: recovery.skill.description,
              skillLoadOutcome: 'success' as const,
            } : {}),
          };
        }
      } catch (err) {
        // Preserve the original command truth if recovery inspection itself
        // fails; the command must never be rewritten as successful.
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'dependency recovery inspection failed');
      }
      return { tool_call_id: id, content: output, is_error: true };
    }

    finalizeFileCheckpoint(checkpoint, name, id);
    return { tool_call_id: id, content: output, is_error: false };
  }

  if (name === 'shell_exec_bg') {
    const shellCfg = getConfig().tools?.shell;
    const shellRestricted = shellCfg?.restricted ?? false;
    const command = args.command as string;
    if (!command || typeof command !== 'string') {
      return { tool_call_id: id, content: 'Error: "command" parameter is required and must be a string', is_error: true };
    }
    const externalAiCli = detectExternalAiCliInvocation(command);
    if (externalAiCli) {
      return { tool_call_id: id, content: buildManagedWorkerOnlyShellError(name, externalAiCli), is_error: true };
    }
    const approvalRequestId = args.approval_request_id as string | undefined;
    if (approvalRequestId !== undefined && typeof approvalRequestId !== 'string') {
      return { tool_call_id: id, content: 'Error: "approval_request_id" must be a string', is_error: true };
    }
    const approvalMessage = requireShellApprovalIfNeeded(command, approvalRequestId, context, id);
    if (approvalMessage) {
      return { tool_call_id: id, content: approvalMessage, is_error: true };
    }
    const checkpointPathsRaw = args.checkpoint_paths;
    if (
      checkpointPathsRaw !== undefined
      && (!Array.isArray(checkpointPathsRaw) || checkpointPathsRaw.some(item => typeof item !== 'string'))
    ) {
      return { tool_call_id: id, content: 'Error: "checkpoint_paths" must be an array of strings', is_error: true };
    }
    const userId = context?.userId;
    const cwd = await ensureToolWorkspaceDir(userId);
    const checkpointPaths = (checkpointPathsRaw as string[] | undefined)?.map(path => resolveWritePath(path, userId)) ?? [];
    const checkpoint = createFileCheckpointHandle(checkpointPaths, name, id, context);

    const telResult = await runTel('shell', 'execute_background', {
      command,
      cwd,
      userId,
      restricted: shellRestricted,
      enforceWorkspaceBoundary: true,
      chat_id: context?.chatId ?? '',
      tenant_id: context?.tenantId ?? 'default',
    }, context);
    if (!telResult.success) {
      const errorMessage = telErrorMessage(telResult);
      rollbackFileCheckpoint(checkpoint, name, id, errorMessage, context);
      return { tool_call_id: id, content: `Error: ${errorMessage}`, is_error: true };
    }
    const data = telResult.data as Record<string, unknown>;
    if (data?.blocked === true) {
      const errorMessage = typeof data.stderr === 'string' && data.stderr.trim().length > 0
        ? data.stderr
        : `Command blocked by security policy: ${command}`;
      rollbackFileCheckpoint(checkpoint, name, id, errorMessage, context);
      return { tool_call_id: id, content: `Error: ${errorMessage}`, is_error: true };
    }
    finalizeFileCheckpoint(checkpoint, name, id);
    return {
      tool_call_id: id,
      content: [
        `Background process started.`,
        `process_id: ${data.process_id}`,
        `pid: ${data.pid}`,
        `Status: running`,
        ``,
        `IMPORTANT: This process is running in the background. You MUST now call process_status with this process_id to check when it completes, then call process_output to retrieve the results. Do not end your turn without collecting the results.`,
      ].join('\n'),
      is_error: false,
    };
  }

  if (name === 'process_status') {
    const processId = args.process_id as string;
    if (!processId || typeof processId !== 'string') {
      return { tool_call_id: id, content: 'Error: "process_id" is required', is_error: true };
    }
    const telResult = await runTel('shell', 'process_status', { process_id: processId }, context);
    if (!telResult.success) {
      return { tool_call_id: id, content: `Error: ${telErrorMessage(telResult)}`, is_error: true };
    }
    return { tool_call_id: id, content: JSON.stringify(telResult.data), is_error: false };
  }

  if (name === 'process_output') {
    const processId = args.process_id as string;
    if (!processId || typeof processId !== 'string') {
      return { tool_call_id: id, content: 'Error: "process_id" is required', is_error: true };
    }
    const tailLines = typeof args.tail_lines === 'number' ? args.tail_lines : undefined;
    const telResult = await runTel('shell', 'process_output', { process_id: processId, tail_lines: tailLines }, context);
    if (!telResult.success) {
      return { tool_call_id: id, content: `Error: ${telErrorMessage(telResult)}`, is_error: true };
    }
    const output = telResult.data as { stdout?: string; stderr?: string };
    let content = '';
    if (output?.stdout) content += output.stdout;
    if (output?.stderr) content += (content ? '\n' : '') + `stderr: ${output.stderr}`;
    if (!content) content = '(no output yet)';
    return { tool_call_id: id, content, is_error: false };
  }

  if (name === 'process_input') {
    const processId = args.process_id as string;
    const input = args.input as string;
    if (!processId || typeof processId !== 'string') {
      return { tool_call_id: id, content: 'Error: "process_id" is required', is_error: true };
    }
    if (input === undefined || typeof input !== 'string') {
      return { tool_call_id: id, content: 'Error: "input" is required', is_error: true };
    }
    const telResult = await runTel('shell', 'process_input', {
      process_id: processId,
      input: input.endsWith('\n') ? input : input + '\n',
    }, context);
    if (!telResult.success) {
      return { tool_call_id: id, content: `Error: ${telErrorMessage(telResult)}`, is_error: true };
    }
    const result = telResult.data as { ok?: boolean; error?: string };
    if (!result?.ok) {
      return { tool_call_id: id, content: `Error: ${result?.error ?? 'stdin write failed'}`, is_error: true };
    }
    return { tool_call_id: id, content: 'Input sent.', is_error: false };
  }

  if (name === 'process_kill') {
    const processId = args.process_id as string;
    if (!processId || typeof processId !== 'string') {
      return { tool_call_id: id, content: 'Error: "process_id" is required', is_error: true };
    }
    const signal = typeof args.signal === 'string' ? args.signal : undefined;
    const telResult = await runTel('shell', 'process_kill', {
      process_id: processId,
      ...(signal ? { signal } : {}),
    }, context);
    if (!telResult.success) {
      return { tool_call_id: id, content: `Error: ${telErrorMessage(telResult)}`, is_error: true };
    }
    const result = telResult.data as { killed?: boolean; error?: string };
    if (!result?.killed) {
      return { tool_call_id: id, content: `Error: ${result?.error ?? 'kill failed'}`, is_error: true };
    }
    return { tool_call_id: id, content: 'Process terminated.', is_error: false };
  }

  return null;
}
