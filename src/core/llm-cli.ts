/**
 * CLI-pipe LLM adapter — wraps CLI AI tools (claude, codex, gemini) as MOZI LLM providers.
 *
 * Each CLI tool handles its own authentication (OAuth, browser login, subscription).
 * The adapter spawns the CLI as a child process, passes the prompt, collects output,
 * and returns a standard ChatResponse.
 *
 * Inspired by OpenClaw's declarative CliBackendConfig pattern.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import pino from 'pino';
import type { CliBackendConfig } from './providers.js';
import {
  getTextContent,
  type LLMClient,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type StreamChunk,
} from './llm-contracts.js';
import {
  resolveCliPromptDelivery,
  writeCliPromptToStdin,
  type CliPromptDeliveryError,
} from './cli-prompt-delivery.js';
import { assertCliSpawnBudget } from './cli-spawn-budget.js';

const logger = pino({ name: 'mozi:llm-cli' });

// CLI tools (claude, codex, gemini) run as full agent turns — they think, use tools,
// and generate responses. 5 minutes is a reasonable default; the autonomous-timeout
// system will self-tune upward if needed.
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const KILL_ESCALATION_MS = 2_000;

/** Maximum stdout/stderr buffer size before killing the child process (100 MB). */
const MAX_BUFFER_SIZE = 100 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Session tracking
// ---------------------------------------------------------------------------

/** Per-backend session ID storage, keyed by caller-provided session key. */
const sessionStore = new Map<string, Map<string, string>>();

function getSessionMap(providerName: string): Map<string, string> {
  let map = sessionStore.get(providerName);
  if (!map) {
    map = new Map();
    sessionStore.set(providerName, map);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Output parsing helpers
// ---------------------------------------------------------------------------

/**
 * Recursively extract text from a value — handles strings, arrays, and
 * objects with common text fields (result, content, text, message, output).
 */
function collectText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(collectText).filter(Boolean).join('');
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Try common text fields in priority order
    for (const key of ['result', 'content', 'text', 'message', 'output', 'response']) {
      if (key in obj && obj[key] !== undefined && obj[key] !== null) {
        const extracted = collectText(obj[key]);
        if (extracted) return extracted;
      }
    }
  }
  return '';
}

/** Extract token usage from various key formats. */
function toUsage(obj: Record<string, unknown>): { input_tokens: number; output_tokens: number } {
  const input = Number(
    obj.input_tokens ?? obj.inputTokens ?? obj.prompt_tokens ?? obj.promptTokens ?? 0,
  );
  const output = Number(
    obj.output_tokens ?? obj.outputTokens ?? obj.completion_tokens ?? obj.completionTokens ?? 0,
  );
  return {
    input_tokens: Number.isFinite(input) ? input : 0,
    output_tokens: Number.isFinite(output) ? output : 0,
  };
}

/** Extract a nested field value by dot-separated path or flat key names. */
function extractField(obj: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = obj[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Parse a single JSON blob from CLI output. */
function parseCliJson(raw: string): { text: string; usage: ReturnType<typeof toUsage>; sessionId?: string; parsed: Record<string, unknown> } {
  const trimmed = raw.trim();
  if (!trimmed) return { text: '', usage: { input_tokens: 0, output_tokens: 0 }, parsed: {} };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Not valid JSON — treat entire output as text
    return { text: trimmed, usage: { input_tokens: 0, output_tokens: 0 }, parsed: {} };
  }

  const text = collectText(parsed);
  const usageObj = (parsed.usage ?? parsed) as Record<string, unknown>;
  const usage = toUsage(typeof usageObj === 'object' && usageObj ? usageObj : {});

  return { text, usage, parsed };
}

/** Extract human-facing text from one JSONL event line. */
function extractJsonlLineText(obj: Record<string, unknown>): string {
  const eventType = typeof obj.type === 'string' ? obj.type : '';

  // Codex JSONL transport/reconnect noise; do not surface to end users.
  if (eventType === 'error') return '';

  // Codex packs assistant output under item.completed.item.text.
  if (eventType === 'item.completed' && obj.item && typeof obj.item === 'object') {
    const item = obj.item as Record<string, unknown>;
    const itemType = typeof item.type === 'string' ? item.type : '';
    if (itemType === 'error' || itemType === 'reasoning') return '';

    const directText = collectText(item.text ?? item.content ?? item.message ?? item.output ?? item.response);
    if (directText) return directText;
    return collectText(item);
  }

  if (eventType === 'response.output_text.delta' && typeof obj.delta === 'string') {
    return obj.delta;
  }
  if (eventType === 'response.output_text.done' && typeof obj.text === 'string') {
    return obj.text;
  }

  return collectText(obj);
}

/** Parse newline-delimited JSON (JSONL) from CLI output. */
function parseCliJsonl(raw: string): { text: string; usage: ReturnType<typeof toUsage>; sessionId?: string; parsed: Record<string, unknown> } {
  const lines = raw.split('\n').filter(l => l.trim());
  let aggregatedText = '';
  let lastParsed: Record<string, unknown> = {};
  const totalUsage = { input_tokens: 0, output_tokens: 0 };

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const lineText = extractJsonlLineText(obj);
      if (lineText) aggregatedText += lineText;
      const lineUsage = toUsage((obj.usage ?? obj) as Record<string, unknown>);
      totalUsage.input_tokens += lineUsage.input_tokens;
      totalUsage.output_tokens += lineUsage.output_tokens;
      lastParsed = obj;
    } catch {
      // Non-JSON line — append as text
      aggregatedText += line;
    }
  }

  return { text: aggregatedText, usage: totalUsage, parsed: lastParsed };
}

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function resolveTimeoutMs(
  requestedTimeoutMs: number | undefined,
  backendTimeoutMs: number | undefined,
  executionScope: ChatOptions['execution_scope'] | undefined,
): number | undefined {
  let resolved: number | undefined;

  if (typeof requestedTimeoutMs === 'number' && Number.isFinite(requestedTimeoutMs)) {
    const normalizedRequested = Math.max(0, Math.trunc(requestedTimeoutMs));
    resolved = normalizedRequested > 0 ? normalizedRequested : undefined;
  } else if (typeof backendTimeoutMs === 'number' && Number.isFinite(backendTimeoutMs)) {
    const normalizedBackend = Math.max(0, Math.trunc(backendTimeoutMs));
    resolved = normalizedBackend > 0 ? normalizedBackend : undefined;
  } else {
    resolved = DEFAULT_TIMEOUT_MS;
  }

  return resolved;
}

function timeoutError(command: string, timeoutMs: number, executionScope: ChatOptions['execution_scope'] | undefined): Error {
  if (executionScope === 'interactive') {
    return new Error(`The CLI model did not respond in time (${timeoutMs}ms).`);
  }
  return new Error(`CLI command "${command}" timed out after ${timeoutMs}ms`);
}

function abortErrorFromSignal(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string' && reason.trim()) return new Error(reason);
  return new Error('CLI command aborted');
}

function signalChildProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
    } catch (err) {
      logger.debug(
        { pid: child.pid, signal, err: err instanceof Error ? err.message : String(err) },
        'Unable to signal CLI process group; falling back to direct child signal',
      );
    }
  }

  try {
    child.kill(signal);
  } catch (err) {
    logger.debug(
      { pid: child.pid, signal, err: err instanceof Error ? err.message : String(err) },
      'Unable to signal CLI child process',
    );
  }
}

async function execCli(
  command: string,
  args: string[],
  stdinData: string | undefined,
  timeoutMs: number | undefined,
  abortSignal: AbortSignal | undefined,
  executionScope: ChatOptions['execution_scope'] | undefined,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortErrorFromSignal(abortSignal));
      return;
    }

    const ac = new AbortController();
    let settled = false;
    let abortCause: Error | null = null;
    let killEscalationTimer: NodeJS.Timeout | null = null;
    let abortSettleTimer: NodeJS.Timeout | null = null;
    let onExternalAbort: () => void = () => undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killEscalationTimer) clearTimeout(killEscalationTimer);
      if (abortSettleTimer) clearTimeout(abortSettleTimer);
      abortSignal?.removeEventListener('abort', onExternalAbort);
      fn();
    };

    let child: ChildProcessWithoutNullStreams | null = null;

    const terminateChild = (reason: Error): void => {
      abortCause ??= reason;
      if (child) {
        signalChildProcessTree(child, 'SIGTERM');
        killEscalationTimer ??= setTimeout(() => {
          if (settled || !child) return;
          signalChildProcessTree(child, 'SIGKILL');
        }, KILL_ESCALATION_MS);
        abortSettleTimer ??= setTimeout(() => {
          finish(() => reject(abortCause ?? reason));
        }, KILL_ESCALATION_MS + 250);
      }
      if (!ac.signal.aborted) {
        ac.abort(reason);
      }
    };

    onExternalAbort = (): void => {
      terminateChild(abortErrorFromSignal(abortSignal));
    };

    // Validate the exact child inputs before arming timers or external abort
    // listeners. A synchronous budget rejection must not leave resources alive.
    const childEnv = { ...process.env };
    for (const key of [
      'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT',
      'CODEX_CLI_SESSION', 'CODEX_SANDBOX_ACTIVE',
      'GEMINI_CLI_SESSION',
    ]) {
      delete childEnv[key];
    }
    assertCliSpawnBudget(command, args, childEnv);

    const timer = timeoutMs ? setTimeout(() => {
      terminateChild(timeoutError(command, timeoutMs, executionScope));
    }, timeoutMs) : null;

    if (abortSignal) {
      abortSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const spawned = spawn(command, args, {
      signal: ac.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
      detached: process.platform !== 'win32',
    });
    child = spawned;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let bufferTruncated = false;
    let promptDeliveryError: CliPromptDeliveryError | null = null;

    spawned.stdout.on('data', (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize <= MAX_BUFFER_SIZE) {
        stdoutChunks.push(chunk);
      } else if (!bufferTruncated) {
        bufferTruncated = true;
        logger.warn({ pid: spawned.pid, stdoutSize }, 'CLI stdout exceeded buffer limit, killing process');
        signalChildProcessTree(spawned, 'SIGTERM');
      }
    });
    spawned.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize <= MAX_BUFFER_SIZE) {
        stderrChunks.push(chunk);
      }
      // Don't kill for stderr overflow — just stop collecting
    });

    spawned.on('error', (err) => {
      if (abortCause) {
        logger.debug({ command, err: err instanceof Error ? err.message : String(err) }, 'CLI process emitted error after abort');
        return;
      }
      finish(() => reject(err));
    });

    spawned.on('close', (code) => {
      if (abortCause) {
        finish(() => reject(abortCause));
        return;
      }
      if (promptDeliveryError) {
        finish(() => reject(promptDeliveryError));
        return;
      }
      const stderrStr = Buffer.concat(stderrChunks).toString('utf-8');
      finish(() => resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: bufferTruncated
          ? stderrStr + `\n[MOZI] stdout truncated at ${stdoutSize} bytes (limit: ${MAX_BUFFER_SIZE})`
          : stderrStr,
        exitCode: code ?? 1,
      }));
    });

    if (stdinData !== undefined) {
      writeCliPromptToStdin(spawned.stdin, stdinData, error => {
        promptDeliveryError ??= error;
        terminateChild(promptDeliveryError);
      });
    } else {
      spawned.stdin.end();
    }
  });
}

function buildConversationPrompt(messages: ChatMessage[]): string {
  const nonSystem = messages.filter(m => m.role !== 'system');
  if (nonSystem.length === 0) return '';
  if (
    nonSystem.length === 1 &&
    nonSystem[0].role === 'user' &&
    (!nonSystem[0].tool_calls || nonSystem[0].tool_calls.length === 0)
  ) {
    return getTextContent(nonSystem[0]);
  }

  const lines: string[] = [];
  for (const msg of nonSystem) {
    const text = getTextContent(msg);
    if (msg.role === 'user') {
      lines.push(`[USER]\n${text}`);
      continue;
    }
    if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        lines.push(`[ASSISTANT_TOOL_CALLS]\n${JSON.stringify(msg.tool_calls)}`);
      }
      if (text.trim()) {
        lines.push(`[ASSISTANT]\n${text}`);
      }
      continue;
    }
    if (msg.role === 'tool') {
      const toolName = msg.tool_name || 'tool';
      const toolId = msg.tool_call_id || '';
      lines.push(`[TOOL_RESULT name=${toolName}${toolId ? ` id=${toolId}` : ''}]\n${text}`);
    }
  }
  return lines.join('\n\n').trim();
}

function formatSystemPromptArgValue(systemPrompt: string, backend: CliBackendConfig): string {
  if (backend.systemPromptFormat === 'codex-config-instructions') {
    // Codex CLI exec uses the developer_instructions config key for injected system policy.
    return `developer_instructions=${JSON.stringify(systemPrompt)}`;
  }
  return systemPrompt;
}

function isSessionConflictError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return lower.includes('session id') && lower.includes('already in use');
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 * Create an LLMClient that delegates to a CLI tool via child_process.spawn.
 *
 * No API key required — the CLI handles its own authentication.
 */
export function createCliAdapter(
  providerName: string,
  defaultModelId: string,
  backend: CliBackendConfig,
): LLMClient {
  const sessions = getSessionMap(providerName);

  return {
    provider: providerName,

    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
      if (!messages || messages.length === 0) {
        throw new Error('chat() called with empty messages array');
      }

      const modelId = options?.model || defaultModelId;
      const sessionKey = (options as Record<string, unknown> | undefined)?.cliSessionKey as string | undefined ?? 'default';
      const timeoutMs = resolveTimeoutMs(options?.timeout_ms, backend.timeoutMs, options?.execution_scope);
      const sessionEnabled = backend.sessionMode !== 'none';

      // Build a conversation transcript so CLI providers keep similar context behavior
      // to native message-based providers.
      let prompt = buildConversationPrompt(messages);
      if (!prompt) prompt = getTextContent(messages[messages.length - 1]);

      // Extract system message
      let systemPrompt: string | undefined;
      const systemParts: string[] = [];
      for (const msg of messages) {
        if (msg.role === 'system') {
          const text = getTextContent(msg);
          if (text.trim()) systemParts.push(text);
        }
      }
      if (systemParts.length > 0) {
        systemPrompt = systemParts.join('\n\n');
      }
      if (!sessionEnabled) {
        // Keep runtime behavior deterministic for non-session backends.
        sessions.delete(sessionKey);
      }

      const runOnce = async (attemptSessionId?: string): Promise<ChatResponse> => {
        let effectivePrompt = prompt;

        // Build args
        const isResume = attemptSessionId && backend.resumeArgs;
        const baseArgs = isResume ? [...backend.resumeArgs!] : [...backend.args];

        // Model arg — only pass --model when the user configured a real model ID.
        // Empty/placeholder IDs (e.g. '_cli-default', '') mean "let the CLI decide".
        const resolvedModel = backend.modelAliases?.[modelId] || modelId;
        if (backend.modelArg && resolvedModel && !resolvedModel.startsWith('_cli-')) {
          baseArgs.push(backend.modelArg, resolvedModel);
        }

        // System prompt arg
        if (
          systemPrompt &&
          backend.systemPromptArg &&
          (backend.systemPromptWhen === 'always' || (backend.systemPromptWhen === 'first' && !attemptSessionId))
        ) {
          baseArgs.push(backend.systemPromptArg, formatSystemPromptArgValue(systemPrompt, backend));
        }
        if (systemPrompt && backend.inlineSystemPrompt && !backend.systemPromptArg) {
          const shouldInlineSystem =
            backend.systemPromptWhen === 'always' || (backend.systemPromptWhen === 'first' && !attemptSessionId);
          if (shouldInlineSystem) {
            effectivePrompt =
              `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${effectivePrompt}`;
          }
        }

        // Session arg
        if (backend.sessionArg && attemptSessionId) {
          baseArgs.push(backend.sessionArg, attemptSessionId);
        }

        const promptDelivery = resolveCliPromptDelivery(effectivePrompt, backend);
        baseArgs.push(...promptDelivery.promptArgs);

        logger.info(
          {
            provider: providerName,
            command: backend.command,
            argCount: baseArgs.length,
            hasSession: !!attemptSessionId,
            timeoutMs: timeoutMs ?? 0,
          },
          'Executing CLI command',
        );

        const result = await execCli(
          backend.command,
          baseArgs,
          promptDelivery.stdinPayload,
          timeoutMs,
          options?.abort_signal,
          options?.execution_scope,
        );

        if (result.exitCode !== 0) {
          const errMsg = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
          throw new Error(`CLI "${backend.command}" failed: ${errMsg}`);
        }

        logger.info(
          { provider: providerName, exitCode: result.exitCode, stdoutLen: result.stdout.length },
          'CLI command completed',
        );

        // Parse output
        let text: string;
        let usage: { input_tokens: number; output_tokens: number };
        let parsed: Record<string, unknown>;

        switch (backend.output) {
          case 'json': {
            const r = parseCliJson(result.stdout);
            text = r.text;
            usage = r.usage;
            parsed = r.parsed;
            break;
          }
          case 'jsonl': {
            const r = parseCliJsonl(result.stdout);
            text = r.text;
            usage = r.usage;
            parsed = r.parsed;
            break;
          }
          case 'text':
          default:
            text = result.stdout.trim();
            usage = { input_tokens: 0, output_tokens: 0 };
            parsed = {};
            break;
        }

        // Extract and store session ID
        if (backend.sessionIdFields && sessionEnabled) {
          const newSessionId = extractField(parsed, backend.sessionIdFields);
          if (newSessionId) {
            sessions.set(sessionKey, newSessionId);
            logger.debug({ provider: providerName, sessionKey, sessionId: newSessionId }, 'Stored CLI session ID');
          }
        }

        return {
          content: text,
          usage,
          model: modelId,
          stop_reason: 'end_turn',
        };
      };

      const existingSessionId = sessionEnabled ? sessions.get(sessionKey) : undefined;
      try {
        return await runOnce(existingSessionId);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (existingSessionId && sessionEnabled && isSessionConflictError(errMsg)) {
          logger.warn(
            { provider: providerName, sessionKey, sessionId: existingSessionId },
            'CLI session conflict detected; clearing cached session and retrying once',
          );
          sessions.delete(sessionKey);
          return runOnce(undefined);
        }
        throw err;
      }
    },

    async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
      // CLI providers don't support true streaming — call chat() and yield a single chunk.
      const response = await this.chat(messages, options);

      if (response.content) {
        yield { type: 'text', text: response.content };
      }

      yield { type: 'done', response };
    },
  };
}
