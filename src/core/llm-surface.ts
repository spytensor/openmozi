/**
 * LLM Surface Registry — per-surface ChatOptions defaults.
 *
 * Each surface in the system has a canonical set of default ChatOptions that
 * governs execution_scope, timeout, billing, and think inheritance. Callers
 * may spread these defaults into their actual chat calls, overriding individual
 * fields as needed.
 *
 * This module is the single source of truth for that policy. It does NOT wrap
 * or replace the LLM call itself — callers still call client.chat / client.chatStream
 * directly. The surface registry exists to:
 *  1. Make per-surface policy explicit and testable (snapshot tests).
 *  2. Surface missing billing/tenant context at the call site (type-checked inputs).
 *  3. Document why each surface uses its particular scope/timeout.
 */

import type { ChatOptions } from './llm.js';

// ---------------------------------------------------------------------------
// Surface identifiers
// ---------------------------------------------------------------------------

export type LLMSurface =
  | 'brain_stream'       // Interactive foreground stream (brain-engine.ts)
  | 'brain_nonstream'    // Interactive foreground non-stream (brain-engine.ts)
  | 'dag_step'           // DAG task execution loop (dag-task-loop.ts)
  | 'plan_summary'       // Plan completion summary (plan-runner.ts)
  | 'recovery'           // Self-heal / error recovery call (brain-engine.ts)
  | 'background_job'     // Background queue LLM task (llm-background.ts)
  | 'proactive';         // Proactive engine wake cycle (proactive-engine.ts)

// ---------------------------------------------------------------------------
// Per-surface context inputs (what callers must supply)
// ---------------------------------------------------------------------------

export interface SurfaceContext {
  /** Required for billing. Must be 'default' if not multi-tenant. */
  tenantId?: string;
  /** Owning user for per-user usage attribution. */
  userId?: string;
  taskId?: string;
  agentId?: string;
  /** Caller max_tokens override (surface default is used if omitted). */
  max_tokens?: number;
  /** Caller temperature override. */
  temperature?: number;
  /** Think setting override. */
  think?: ChatOptions['think'];
  /** AbortSignal for the call. */
  abort_signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Per-surface default policy table
// ---------------------------------------------------------------------------

/**
 * Returns the canonical ChatOptions defaults for a surface.
 * Callers spread these into their actual chat call options.
 *
 * @example
 * ```ts
 * const defaults = defaultChatOptionsForSurface('dag_step', { tenantId, taskId });
 * const response = await client.chat(messages, { ...defaults, max_tokens: taskMaxTokens, think: taskThink });
 * ```
 */
export function defaultChatOptionsForSurface(
  surface: LLMSurface,
  ctx: SurfaceContext = {},
): ChatOptions {
  const billing = ctx.tenantId
    ? { tenantId: ctx.tenantId, userId: ctx.userId, taskId: ctx.taskId, agentId: ctx.agentId }
    : undefined;

  switch (surface) {
    case 'brain_stream':
      // Foreground interactive: interactive scope, 5-min hard timeout per call,
      // billing injected from session context.
      return {
        execution_scope: 'interactive',
        timeout_ms: 300_000,
        billing,
        ...(ctx.max_tokens !== undefined && { max_tokens: ctx.max_tokens }),
        ...(ctx.temperature !== undefined && { temperature: ctx.temperature }),
        ...(ctx.think !== undefined && { think: ctx.think }),
        ...(ctx.abort_signal && { abort_signal: ctx.abort_signal }),
      };

    case 'brain_nonstream':
      // Same as stream: interactive, same timeout policy, same billing.
      return {
        execution_scope: 'interactive',
        timeout_ms: 300_000,
        billing,
        ...(ctx.max_tokens !== undefined && { max_tokens: ctx.max_tokens }),
        ...(ctx.temperature !== undefined && { temperature: ctx.temperature }),
        ...(ctx.think !== undefined && { think: ctx.think }),
        ...(ctx.abort_signal && { abort_signal: ctx.abort_signal }),
      };

    case 'dag_step':
      // Background DAG step: worker scope (not interactive — no real-time
      // streaming consumer), 5-min per-call cap (same as brain), billing
      // required for cost attribution to the plan's tenant and task.
      // Blueprint gap fix: was missing execution_scope and billing.
      return {
        execution_scope: 'worker',
        timeout_ms: 300_000,
        billing,
        ...(ctx.max_tokens !== undefined && { max_tokens: ctx.max_tokens }),
        ...(ctx.temperature !== undefined && { temperature: ctx.temperature }),
        ...(ctx.think !== undefined && { think: ctx.think }),
        ...(ctx.abort_signal && { abort_signal: ctx.abort_signal }),
      };

    case 'plan_summary':
      // Plan completion summary: background scope, short response, low temp.
      // Uses fallbackClient (brain), not a step worker client.
      // 1200, not 700: reasoning-capable providers (DeepSeek) spend part of
      // the cap on thinking tokens, and 700 total cut a ~200-token visible
      // summary mid-sentence. The caller discards truncated responses.
      return {
        execution_scope: 'background',
        timeout_ms: 45_000,
        billing,
        max_tokens: ctx.max_tokens ?? 1200,
        temperature: ctx.temperature ?? 0.3,
        ...(ctx.think !== undefined && { think: ctx.think }),
        ...(ctx.abort_signal && { abort_signal: ctx.abort_signal }),
      };

    case 'recovery':
      // Self-heal / error recovery: no abort signal (recovery may outlast
      // the original turn), background scope, short timeout.
      return {
        execution_scope: 'background',
        timeout_ms: 30_000,
        billing,
        ...(ctx.max_tokens !== undefined && { max_tokens: ctx.max_tokens }),
        ...(ctx.temperature !== undefined && { temperature: ctx.temperature }),
        ...(ctx.think !== undefined && { think: ctx.think }),
      };

    case 'background_job':
      // Background queue task: worker scope, no interactive consumer,
      // billing injected from the task's tenant context.
      // Blueprint gap fix: was missing execution_scope and billing.
      return {
        execution_scope: 'worker',
        timeout_ms: 120_000,
        billing,
        max_tokens: ctx.max_tokens ?? 4096,
        temperature: ctx.temperature ?? 0.7,
        ...(ctx.think !== undefined && { think: ctx.think }),
        ...(ctx.abort_signal && { abort_signal: ctx.abort_signal }),
      };

    case 'proactive':
      // Proactive engine wake cycle: background scope, moderate timeout.
      return {
        execution_scope: 'background',
        timeout_ms: 30_000,
        billing,
        ...(ctx.max_tokens !== undefined && { max_tokens: ctx.max_tokens }),
        temperature: ctx.temperature ?? 0.3,
        ...(ctx.think !== undefined && { think: ctx.think }),
        ...(ctx.abort_signal && { abort_signal: ctx.abort_signal }),
      };

  }
}
