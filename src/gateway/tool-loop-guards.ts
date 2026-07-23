/**
 * Tool-loop guardrails — utility functions for the LLM tool-calling loop
 * in handler.ts.
 *
 * Philosophy: trust the LLM but verify. Safety nets include timeout, iteration
 * cap, persistent failure hint, and hash-based loop detection (consecutive
 * repeats + periodic cycles). When a loop is detected, a hint is injected
 * first; only if the LLM continues looping is the turn force-stopped.
 */

import { createHash } from 'crypto';
import type { ChatMessage, ToolCall } from '../core/llm.js';
import { log as logEvent } from '../store/events.js';
import {
  extractMissingEnvKeys,
  type RecoveryLoopStopReason,
} from '../core/recovery-policy.js';
import { estimateTokens } from '../memory/token-counter.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:tool-loop-guards' });

export type LoopStopReason = RecoveryLoopStopReason;

/** Tool names that are expected to be called repeatedly (polling). Exempt from loop detection. */
const POLLING_TOOLS = new Set(['process_status', 'process_output']);

// ── Hash-based tool call loop detection ──

export type LoopPatternType = 'consecutive' | 'periodic' | 'turn_frequency';

export interface LoopPattern {
  type: LoopPatternType;
  /** For consecutive: number of repetitions. For periodic: cycle length. */
  detail: number;
}

/**
 * Compute a short SHA-256 hash signature for a batch of tool calls.
 * Normalizes by sorting JSON keys and sorting the calls themselves,
 * so that argument key order and call order don't affect the hash.
 */
export function computeToolCallHash(toolCalls: ToolCall[]): string {
  const normalized = toolCalls
    .map(tc => {
      let argsNormalized: string;
      try {
        const parsed = JSON.parse(tc.function.arguments);
        argsNormalized = JSON.stringify(parsed, Object.keys(parsed).sort());
      } catch {
        argsNormalized = tc.function.arguments;
      }
      return `${tc.function.name}:${argsNormalized}`;
    })
    .sort()
    .join('|');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

const LOOP_HINT = [
  '[SYSTEM] Loop detected: you have been repeating the same tool calls.',
  'This pattern will not produce different results.',
  'Try a DIFFERENT approach, use DIFFERENT parameters, or explain to the user why you are stuck.',
].join('\n');

/**
 * Stateful detector that tracks tool call batch hashes across iterations
 * and detects repetitive patterns (consecutive repeats or periodic cycles).
 */
export class LoopDetector {
  private history: string[] = [];
  private readonly counts = new Map<string, number>();
  private readonly maxHistory: number;
  private readonly consecutiveThreshold: number;
  private readonly exemptToolNames: ReadonlySet<string>;
  private readonly countingMode: 'pattern' | 'turn_frequency';
  private hintInjected = false;

  constructor(opts?: {
    maxHistory?: number;
    consecutiveThreshold?: number;
    exemptToolNames?: ReadonlySet<string>;
    countingMode?: 'pattern' | 'turn_frequency';
  }) {
    this.maxHistory = opts?.maxHistory ?? 20;
    this.consecutiveThreshold = opts?.consecutiveThreshold ?? 3;
    this.exemptToolNames = opts?.exemptToolNames ?? POLLING_TOOLS;
    this.countingMode = opts?.countingMode ?? 'pattern';
  }

  /**
   * Record a batch of tool calls and check for loop patterns.
   * Polling tools (process_status, process_output) are exempt — repeated
   * polling is normal behavior for background process monitoring.
   * @returns A LoopPattern if a loop is detected, or null.
   */
  record(toolCalls: ToolCall[]): LoopPattern | null {
    if (toolCalls.length === 0) return null;

    // Filter out pure-polling batches (all calls are polling tools)
    const nonPolling = toolCalls.filter(tc => !this.exemptToolNames.has(tc.function.name));
    if (nonPolling.length === 0) return null; // Pure exempt/polling batch — skip detection

    // For mixed batches, hash only the non-polling calls
    const hash = computeToolCallHash(nonPolling);
    if (this.countingMode === 'turn_frequency') {
      const count = (this.counts.get(hash) ?? 0) + 1;
      this.counts.set(hash, count);
      return count >= this.consecutiveThreshold
        ? { type: 'turn_frequency', detail: count }
        : null;
    }
    this.history.push(hash);
    if (this.history.length > this.maxHistory) this.history.shift();

    // Check 1: consecutive repeats (A, A, A)
    const consecutive = this.detectConsecutive();
    if (consecutive) return consecutive;

    // Check 2: periodic cycles (A,B,A,B or A,B,C,A,B,C)
    const periodic = this.detectPeriodic();
    if (periodic) return periodic;

    return null;
  }

  /**
   * Get the hint message to inject when a loop is first detected.
   * Returns the hint only once per detection — subsequent calls return null
   * until reset() is called.
   */
  getHintOnce(): string | null {
    if (this.hintInjected) return null;
    this.hintInjected = true;
    return LOOP_HINT;
  }

  /** Whether a hint has already been injected for the current loop. */
  get hintWasInjected(): boolean {
    return this.hintInjected;
  }

  /** Reset the detector state. */
  reset(): void {
    this.history = [];
    this.counts.clear();
    this.hintInjected = false;
  }

  private detectConsecutive(): LoopPattern | null {
    const len = this.history.length;
    if (len < this.consecutiveThreshold) return null;
    const last = this.history[len - 1];
    const slice = this.history.slice(-this.consecutiveThreshold);
    if (slice.every(h => h === last)) {
      return { type: 'consecutive', detail: this.consecutiveThreshold };
    }
    return null;
  }

  private detectPeriodic(): LoopPattern | null {
    const hashes = this.history;
    // Try periods 2, 3, 4
    for (const period of [2, 3, 4]) {
      if (hashes.length < period * 2) continue;
      const recent = hashes.slice(-period * 2);
      const firstHalf = recent.slice(0, period).join(',');
      const secondHalf = recent.slice(period).join(',');
      if (firstHalf === secondHalf) {
        return { type: 'periodic', detail: period };
      }
    }
    return null;
  }
}

interface LoopConstraintHints {
  shellPermissionDenied: boolean;
  workspacePolicyDenied: boolean;
  missingPath: boolean;
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function normalizeNonNegativeInt(value: unknown, fallback: number, min = 0): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.max(min, Math.floor(numeric));
}

/** Coerce tool result content to a string (some tools may return non-string). */
export function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function hasCjkText(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

const REASON_MAP: Record<LoopStopReason, string> = {
  max_iterations: 'tool iteration budget was exhausted',
  loop_timeout: 'tool loop runtime budget was exhausted',
  loop_detected: 'repetitive tool call loop detected',
  narration_without_execution: 'model narrated a plan instead of executing tools',
  empty_response: 'model returned empty visible output',
};

/**
 * Build a failure hint message injected INTO the active tool loop.
 * The LLM still has tools — this just tells it what's going wrong
 * and suggests trying a different approach.
 */
export function buildFailureHintMessage(
  consecutiveFailures: number,
  failureDetails: string[],
): string {
  const detailStr = failureDetails.length > 0
    ? `Recent errors: ${failureDetails.join(' | ').slice(0, 400)}`
    : 'No error details captured.';

  return [
    `[TOOL FAILURE HINT — ${consecutiveFailures} consecutive tool calls failed]`,
    detailStr,
    'Try a different approach: use a different tool, change the arguments, or answer directly with what you know.',
    'Do not repeat the same failing calls.',
  ].join('\n');
}

function detectLoopConstraintHints(failureDetails: string[]): LoopConstraintHints {
  const joined = failureDetails.join('\n');
  return {
    shellPermissionDenied:
      /permission denied/i.test(joined)
      && (/shell\.execute/i.test(joined) || /l2_shell_exec/i.test(joined)),
    workspacePolicyDenied:
      /workspace_only policy/i.test(joined)
      || /path not allowed/i.test(joined),
    missingPath:
      /enoent/i.test(joined)
      || /no such file or directory/i.test(joined)
      || /could not ground .* to a real file/i.test(joined),
  };
}

/**
 * Build an immediate in-loop recovery hint when failures are caused by
 * hard runtime constraints (permission/path sandbox), so the model can
 * adapt in the very next iteration instead of repeating blocked calls.
 */
export function buildConstraintRecoveryHintMessage(failureDetails: string[]): string | null {
  const hints = detectLoopConstraintHints(failureDetails);
  const lines: string[] = [];

  if (hints.shellPermissionDenied) {
    lines.push(
      'shell_exec is blocked by RBAC (requires L2_SHELL_EXEC). Do not call shell_exec again in this turn.',
    );
    lines.push('Use non-shell tools only (read_file/list_directory/edit_file/write_file if allowed).');
  }

  if (hints.workspacePolicyDenied) {
    lines.push('File access is blocked by tools.fs.workspace_only policy.');
    lines.push('Do not use ../ traversal or out-of-workspace absolute paths.');
    lines.push('Discover valid paths via list_directory before reading/writing.');
  }

  if (hints.missingPath) {
    lines.push('The requested path does not exist (ENOENT).');
    lines.push('First locate the correct directory/file path, then retry with the exact path.');
  }

  if (lines.length === 0) return null;
  return [
    '[INTERNAL DIRECTIVE — not a user message]',
    ...lines,
    'If constraints prevent completion, explain the exact blocker and request the minimal user action.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Behavioral failure detection — catch models that narrate instead of executing
// ---------------------------------------------------------------------------

/**
 * Detect behavioral failure. Minimal checks — no pattern matching:
 * - empty_response: model returned nothing
 * - narration_without_execution: model returned text but called zero tools
 *   AND text is very short (single sentence, no substance)
 *
 * When tools DID run, the brain loop handles synthesis recovery via length
 * ratio comparison — detectBehavioralFailure does not second-guess.
 */
export function detectBehavioralFailure(
  responseText: string,
  hadToolCalls: boolean,
): 'narration_without_execution' | 'empty_response' | null {
  if (!responseText.trim()) return 'empty_response';
  if (hadToolCalls) return null;
  return null;
}

/**
 * Build a system message that feeds a behavioral failure back to the Brain,
 * giving it a chance to self-correct instead of silently failing.
 */
export function buildBrainSelfCorrectionPrompt(
  failureType: 'narration_without_execution' | 'empty_response',
  originalUserMessage: string,
): string {
  if (failureType === 'narration_without_execution') {
    return [
      '[RUNTIME FEEDBACK — your previous response was rejected]',
      '',
      'You described a PLAN but did not call any tools. Your response was discarded.',
      'MOZI is an execution engine — do not narrate what you would do. Actually DO it.',
      '',
      'Requirements:',
      '- Call tools immediately (read_file, shell_exec, web_search, etc.)',
      '- Do not describe steps — execute them',
      '- If you need delegation, use a registered agent / managed worker path (for example decompose_task or an external_worker agent), not shell_exec_bg',
      '',
      `Original user request: ${originalUserMessage.slice(0, 500)}`,
    ].join('\n');
  }

  return [
    '[RUNTIME FEEDBACK — your previous response was empty]',
    '',
    'You returned no visible output and called no tools. Your response was discarded.',
    'The user is waiting for a real answer. Try again — use tools if needed.',
    '',
    `Original user request: ${originalUserMessage.slice(0, 500)}`,
  ].join('\n');
}

/**
 * Build a user-facing fallback message when the loop is stopped by a safety net.
 * Honest and concise — no "reset executor and preserved context" theatre.
 */
export function buildGuardFallbackMessage(
  stopReason: LoopStopReason,
  userMessage: string,
  recentToolFailureDetails: string[],
): string {
  const isZh = hasCjkText(userMessage);
  const missingEnvKeys = extractMissingEnvKeys(recentToolFailureDetails);
  const constraintHints = detectLoopConstraintHints(recentToolFailureDetails);

  if (isZh) {
    if (missingEnvKeys.length > 0) {
      return `当前请求依赖的环境变量缺失：${missingEnvKeys.join(', ')}。请完成配置后重新发送请求。`;
    }
    if (constraintHints.shellPermissionDenied) {
      return '当前会话权限为只读，已禁止 shell_exec（需要 L2_SHELL_EXEC）。请提升权限，或让我改用只读工具继续。';
    }
    if (constraintHints.workspacePolicyDenied) {
      return '当前路径被 workspace_only 策略拦截。请提供工作区内的正确路径，或调整 tools.fs 允许目录后重试。';
    }
    if (constraintHints.missingPath) {
      return '目标文件/目录不存在（ENOENT）。请提供正确路径后我继续执行。';
    }
    if (stopReason === 'loop_timeout') {
      return '当前请求执行超时。请尝试简化请求或重新发送。';
    }
    if (stopReason === 'loop_detected') {
      return '检测到重复执行相同操作的循环。请尝试换种方式描述需求。';
    }
    if (stopReason === 'narration_without_execution') {
      return '这次回复只有计划性叙述，没有实际执行工具。该结果已被拒绝。请重试，或让我改走已注册的 agent/worker 路径继续执行。';
    }
    if (stopReason === 'empty_response') {
      return '模型返回了空响应。请重试或换一种问法。';
    }
    return '当前请求执行未能完成。请重新发送请求。';
  }

  if (missingEnvKeys.length > 0) {
    return `This request requires missing environment variables: ${missingEnvKeys.join(', ')}. Please configure them and resend the request.`;
  }
  if (constraintHints.shellPermissionDenied) {
    return 'shell_exec is blocked by RBAC (requires L2_SHELL_EXEC). Grant higher permission or let me continue with read-only tools.';
  }
  if (constraintHints.workspacePolicyDenied) {
    return 'The requested path is blocked by tools.fs.workspace_only policy. Provide an in-workspace path or adjust allowed roots.';
  }
  if (constraintHints.missingPath) {
    return 'The target path does not exist (ENOENT). Provide the correct path and I will continue.';
  }
  if (stopReason === 'loop_timeout') {
    return 'This request timed out. Try simplifying the request or resend it.';
  }
  if (stopReason === 'loop_detected') {
    return 'A repetitive tool call loop was detected. Try rephrasing your request.';
  }
  if (stopReason === 'narration_without_execution') {
    return 'The model described a plan instead of executing tools. That response was rejected. Retry the request or let me continue through a registered agent/worker path.';
  }
  if (stopReason === 'empty_response') {
    return 'The model returned empty visible output. Please retry or rephrase your request.';
  }
  return 'This request could not be completed. Please resend the request.';
}

/**
 * Classify a raw API/LLM error message into a user-friendly response.
 * Returns null if the error is not recognized as a surfaceable API error.
 */
export function buildUserFriendlyErrorMessage(
  errorMessage: string,
  userMessage: string,
): string | null {
  const lower = errorMessage.toLowerCase();
  const isZh = hasCjkText(userMessage);

  // Quota / usage limit errors
  if (/quota|usage.?limit|rate.?limit.*exceeded|billing|insufficient.?funds|credit/i.test(lower)
      || /hit your.*limit/i.test(lower)) {
    return isZh
      ? `⚠️ 额度已耗尽 (Quota Exceeded): ${errorMessage.slice(0, 300)}`
      : `⚠️ Quota exceeded: ${errorMessage.slice(0, 300)}`;
  }

  // Rate limiting (429-style)
  if (/rate.?limit|too many requests|429|throttl/i.test(lower)) {
    return isZh
      ? `⚠️ API 限流 (Rate Limited)，请稍后重试。详情: ${errorMessage.slice(0, 200)}`
      : `⚠️ Rate limited — please retry in a moment. Details: ${errorMessage.slice(0, 200)}`;
  }

  // Context length / token overflow
  if (/context.?length|token.*exceed|maximum.*tokens|too long|content.?size/i.test(lower)) {
    return isZh
      ? `⚠️ 上下文超出模型限制 (Context Too Long): ${errorMessage.slice(0, 200)}`
      : `⚠️ Context length exceeded: ${errorMessage.slice(0, 200)}`;
  }

  // Authentication / key errors
  if (/invalid.*api.?key|unauthorized|401|authentication|forbidden|403/i.test(lower)) {
    return isZh
      ? `⚠️ API 认证失败: ${errorMessage.slice(0, 200)}`
      : `⚠️ API authentication failed: ${errorMessage.slice(0, 200)}`;
  }

  // Server errors (500, 502, 503)
  if (/5\d{2}|server.?error|service.?unavailable|bad.?gateway|internal.*error/i.test(lower)) {
    return isZh
      ? `⚠️ 模型服务暂时不可用，请稍后重试。详情: ${errorMessage.slice(0, 200)}`
      : `⚠️ Model service temporarily unavailable — please retry. Details: ${errorMessage.slice(0, 200)}`;
  }

  // Timeout
  if (/timeout|timed?.?out|abort/i.test(lower)) {
    return isZh
      ? `⚠️ 请求超时，请重试或简化请求。`
      : `⚠️ Request timed out — please retry or simplify your request.`;
  }

  // Fallback chain exhausted
  if (/all providers failed/i.test(lower)) {
    return isZh
      ? `⚠️ 所有可用模型均调用失败 (可能由于欠费或网络原因)，请检查后台日志。`
      : `⚠️ All providers failed. Please check backend logs for exact causes (e.g. quota or network).`;
  }

  return null;
}

function hasAdjacentToolResults(
  messages: ChatMessage[],
  assistantIndex: number,
  calls: Array<{ id: string }>,
): boolean {
  const expected = new Set(
    calls
      .map(tc => tc.id)
      .filter(id => typeof id === 'string' && id.trim().length > 0),
  );
  if (expected.size === 0) return true;

  const seen = new Set<string>();
  for (let i = assistantIndex + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool') break;
    if (msg.tool_call_id && expected.has(msg.tool_call_id)) {
      seen.add(msg.tool_call_id);
      if (seen.size === expected.size) return true;
    }
  }
  return false;
}

/**
 * Sanitize tool_call/result pairs in a message array.
 *
 * LLM APIs require every assistant message with `tool_calls` to be followed
 * immediately by matching `tool` result messages. Compression, truncation, or
 * history loading can break both completeness and adjacency. This function
 * repairs them by:
 *
 * 1. Stripping `tool_calls` from assistant messages whose results are missing.
 * 2. Stripping `tool_calls` when results exist but are not adjacent.
 * 3. Removing orphaned `tool` messages that have no matching assistant `tool_calls`.
 *
 * Runs iteratively since stripping tool_calls can orphan existing tool results.
 * Should be called before every LLM API call as a safety net.
 */
export function sanitizeToolPairs(messages: ChatMessage[]): ChatMessage[] {
  let current = messages;
  let repaired = false;

  // Iterate until stable (stripping tool_calls can orphan results, which need removal)
  for (let pass = 0; pass < 5; pass++) {
    // Collect all tool_call_ids that have results
    const resultIds = new Set<string>();
    for (const m of current) {
      if (m.role === 'tool' && m.tool_call_id) {
        resultIds.add(m.tool_call_id);
      }
    }

    // Collect all tool_call_ids that are requested by assistant messages
    const requestedIds = new Set<string>();
    for (const m of current) {
      if (m.role === 'assistant') {
        const calls = (m as unknown as Record<string, unknown>).tool_calls as Array<{ id: string }> | undefined;
        if (Array.isArray(calls)) {
          for (const tc of calls) {
            if (tc.id) requestedIds.add(tc.id);
          }
        }
      }
    }

    const next: ChatMessage[] = [];
    let changed = false;

    for (let index = 0; index < current.length; index++) {
      const m = current[index];
      // Remove orphaned tool results (no matching assistant tool_call)
      if (m.role === 'tool' && m.tool_call_id && !requestedIds.has(m.tool_call_id)) {
        changed = true;
        continue;
      }

      // For assistant messages with tool_calls, check if ALL results exist
      if (m.role === 'assistant') {
        const calls = (m as unknown as Record<string, unknown>).tool_calls as Array<{ id: string }> | undefined;
        if (Array.isArray(calls) && calls.length > 0) {
          const allResultsPresent = calls.every(tc => resultIds.has(tc.id));
          const adjacentResultsPresent = hasAdjacentToolResults(current, index, calls);
          if (!allResultsPresent || !adjacentResultsPresent) {
            // Strip tool_calls — keep the message as plain assistant text
            changed = true;
            next.push({ role: 'assistant', content: m.content || '' });
            continue;
          }
        }
      }

      next.push(m);
    }

    if (!changed) break; // Stable — no more repairs needed
    current = next;
    repaired = true;
  }

  if (repaired) {
    logger.warn(
      { before: messages.length, after: current.length },
      'sanitizeToolPairs repaired broken tool_call/result pairs',
    );
  }

  return current;
}

/** Minimum token budget per tool result — never truncate below this. */
const MIN_TOOL_RESULT_BUDGET = 200;

/**
 * Truncate a tool result string to fit within the remaining token budget.
 *
 * Each tool result gets at most `floor(remainingBudgetTokens * 0.3 / toolCallCount)`
 * tokens. If the content fits, it is returned unchanged. Otherwise a smart
 * head/tail truncation is applied (60% head, 30% tail, middle ellipsis).
 *
 * @param content            - The raw tool result content string.
 * @param remainingBudgetTokens - Tokens remaining in the context window budget.
 * @param toolCallCount      - Number of tool calls in this batch.
 * @returns The (possibly truncated) content string.
 */
export function truncateToolResult(
  content: string,
  remainingBudgetTokens: number,
  toolCallCount: number,
): string {
  if (!content || toolCallCount <= 0) return content;

  const perToolBudget = Math.max(
    MIN_TOOL_RESULT_BUDGET,
    Math.floor((remainingBudgetTokens * 0.3) / toolCallCount),
  );

  const estimated = estimateTokens(content);
  if (estimated <= perToolBudget) return content;

  // Convert token budget to approximate character budget.
  // Use conservative ~3.5 chars/token to avoid over-truncating.
  // CJK text averages ~0.67 chars/token but we use a blended heuristic.
  const hasCjk = /[\u3400-\u9fff]/.test(content);
  const charsPerToken = hasCjk ? 1.5 : 3.5;
  const charBudget = Math.floor(perToolBudget * charsPerToken);

  const headChars = Math.floor(charBudget * 0.6);
  const tailChars = Math.floor(charBudget * 0.3);

  const head = content.slice(0, headChars);
  const tail = content.slice(-tailChars);
  const omittedTokens = estimated - perToolBudget;

  return `${head}\n\n[truncated ~${omittedTokens} tokens]\n\n${tail}`;
}

export function recordLoopGuardEvent(
  chatId: string,
  stopReason: LoopStopReason,
  stage: 'user_fallback',
  payload?: Record<string, unknown>,
): void {
  try {
    logEvent(
      'tool_loop_guard',
      'chat',
      chatId,
      {
        reason: stopReason,
        stage,
        ...payload,
      },
    );
  } catch (err) {
    logger.warn({
      chatId,
      reason: stopReason,
      stage,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to persist tool-loop guard event');
  }
}
