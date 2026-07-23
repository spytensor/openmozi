/**
 * Tool plugin hook registry (#259).
 *
 * Mirrors the channel plugin registry pattern (`src/channels/registry.ts`).
 * Holds two ordered lists (one per phase) and enforces fail-closed semantics
 * when hooks throw or time out.
 *
 * Key invariants:
 *   - Hooks NEVER run before the #261 permission preflight. `executeToolInner`
 *     guarantees the call order: preflight → pre_tool_call hooks → tool body
 *     → transform_tool_result hooks.
 *   - `transform_tool_result` may rewrite `content` and `file_path`, but
 *     **cannot** toggle `is_error`. A hook that tries is rejected and an
 *     audit event `security.hook_violation` is emitted.
 *   - Same-priority hooks fire in registration order (insertion order in the
 *     underlying array).
 */
import pino from 'pino';
import { log as logEvent } from '../store/events.js';
import type { ToolResult } from './types.js';
import {
  HOOK_DEFAULT_PRIORITY,
  HOOK_DEFAULT_TIMEOUT_MS,
  type HookResult,
  type ToolHook,
  type ToolHookContext,
  type ToolHookPhase,
} from './plugin.js';

const logger = pino({ name: 'mozi:tools:plugin-registry' });

const hooksByPhase: Record<ToolHookPhase, ToolHook[]> = {
  pre_tool_call: [],
  transform_tool_result: [],
};

// ---------------------------------------------------------------------------
// Registry — register / unregister / list
// ---------------------------------------------------------------------------

export function registerToolHook(hook: ToolHook): void {
  if (!hook.id || typeof hook.id !== 'string') {
    throw new Error('Tool hook id must be a non-empty string');
  }
  if (hook.phase !== 'pre_tool_call' && hook.phase !== 'transform_tool_result') {
    throw new Error(`Unknown hook phase: ${hook.phase}`);
  }
  const phaseHooks = hooksByPhase[hook.phase];
  if (phaseHooks.some(h => h.id === hook.id)) {
    throw new Error(`Tool hook id "${hook.id}" already registered for phase ${hook.phase}`);
  }
  phaseHooks.push(hook);
  // Stable sort: lower priority first, but same priority preserves insertion
  // order (Array.sort is stable in V8).
  phaseHooks.sort((a, b) => (a.priority ?? HOOK_DEFAULT_PRIORITY) - (b.priority ?? HOOK_DEFAULT_PRIORITY));
}

export function unregisterToolHook(id: string, phase?: ToolHookPhase): boolean {
  let removed = false;
  const phases: ToolHookPhase[] = phase ? [phase] : ['pre_tool_call', 'transform_tool_result'];
  for (const p of phases) {
    const arr = hooksByPhase[p];
    const idx = arr.findIndex(h => h.id === id);
    if (idx >= 0) {
      arr.splice(idx, 1);
      removed = true;
    }
  }
  return removed;
}

export function listToolHooks(phase?: ToolHookPhase): ToolHook[] {
  if (phase) return [...hooksByPhase[phase]];
  return [...hooksByPhase.pre_tool_call, ...hooksByPhase.transform_tool_result];
}

/** Test helper — clear all hooks. */
export function __resetToolHookRegistryForTests(): void {
  hooksByPhase.pre_tool_call.length = 0;
  hooksByPhase.transform_tool_result.length = 0;
}

// ---------------------------------------------------------------------------
// Invocation — fail-closed wrappers
// ---------------------------------------------------------------------------

async function runHandlerWithTimeout(
  hook: ToolHook,
  ctx: ToolHookContext,
): Promise<HookResult> {
  const timeoutMs = hook.timeoutMs ?? HOOK_DEFAULT_TIMEOUT_MS;
  // #265 review fix — keep the timer handle so we can cancel it on the
  // fast (happy) path. Without this, every tool call leaves a 5s timer
  // alive in the event loop for the full timeout duration, which
  // accumulates under sustained load and delays clean shutdown.
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race<HookResult>([
      Promise.resolve().then(() => hook.handler(ctx)),
      new Promise<HookResult>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('hook_timeout')), timeoutMs);
      }),
    ]);
    return result ?? { kind: 'continue' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ hook: hook.id, phase: hook.phase, err: msg }, 'Hook threw — fail-closed veto');
    try {
      logEvent('security.hook_error', 'tool_hook', hook.id, { phase: hook.phase, error: msg }, ctx.tenantId);
    } catch { /* non-critical */ }
    return { kind: 'veto', reason: msg === 'hook_timeout' ? 'hook_timeout' : `hook_error: ${msg}` };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export interface PreHookOutcome {
  kind: 'continue' | 'veto' | 'rewrite';
  args?: Record<string, unknown>;
  reason?: string;
}

/**
 * Run all pre_tool_call hooks in order. First veto short-circuits. Rewrites
 * are applied to a running copy of args so later hooks see the updated values.
 */
export async function runPreToolCallHooks(
  ctx: ToolHookContext,
): Promise<PreHookOutcome> {
  const hooks = hooksByPhase.pre_tool_call;
  if (hooks.length === 0) return { kind: 'continue', args: ctx.args };

  let currentArgs = ctx.args;
  let rewritten = false;

  for (const hook of hooks) {
    const res = await runHandlerWithTimeout(hook, { ...ctx, args: currentArgs });
    if (res.kind === 'veto') {
      return { kind: 'veto', reason: res.reason };
    }
    if (res.kind === 'rewrite' && res.args !== undefined) {
      currentArgs = res.args;
      rewritten = true;
    }
  }
  return rewritten
    ? { kind: 'rewrite', args: currentArgs }
    : { kind: 'continue', args: currentArgs };
}

export interface TransformHookOutcome {
  kind: 'continue' | 'rewrite';
  result: ToolResult;
}

/**
 * Run all transform_tool_result hooks in order. Hooks returning `veto` at
 * this phase are coerced to `continue` (there is no meaningful veto of an
 * already-executed tool). Rewrites that mutate `is_error` are rejected and
 * audited; the original result is preserved.
 */
export async function runTransformResultHooks(
  ctx: ToolHookContext,
  initialResult: ToolResult,
): Promise<TransformHookOutcome> {
  const hooks = hooksByPhase.transform_tool_result;
  if (hooks.length === 0) return { kind: 'continue', result: initialResult };

  let currentResult = initialResult;
  let rewritten = false;

  for (const hook of hooks) {
    const res = await runHandlerWithTimeout(hook, { ...ctx, result: currentResult });
    if (res.kind === 'rewrite' && res.result !== undefined) {
      // Reject any attempt to flip is_error; it would let the hook hide
      // real failures from the completion gate.
      if (res.result.is_error !== currentResult.is_error) {
        logger.warn({
          hook: hook.id,
          from: currentResult.is_error,
          to: res.result.is_error,
        }, 'Hook tried to toggle is_error — rejected');
        try {
          logEvent(
            'security.hook_violation',
            'tool_hook',
            hook.id,
            { reason: 'is_error_toggle', from: currentResult.is_error, to: res.result.is_error },
            ctx.tenantId,
          );
        } catch { /* non-critical */ }
        continue; // skip this rewrite, keep previous result
      }
      currentResult = res.result;
      rewritten = true;
    }
    // `veto` at transform phase is meaningless; ignore.
  }
  return rewritten ? { kind: 'rewrite', result: currentResult } : { kind: 'continue', result: currentResult };
}
