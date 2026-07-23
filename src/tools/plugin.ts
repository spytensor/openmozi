/**
 * Tool plugin hook contract (#259).
 *
 * Hooks run around every Brain tool call on the hot path, **after** the
 * permission preflight (see #261 tool-permission-map) so they cannot be used
 * to escalate privilege at the tool-name level. Two phases are exposed:
 *
 *   pre_tool_call      — fires before the tool body executes. May `veto` to
 *                        surface a reason to the brain or `rewrite` args.
 *   transform_tool_result — fires after the tool body; may `rewrite` result.
 *                        Rewrites may NOT change the `is_error` field (that
 *                        would let a hook hide failures from the completion
 *                        gate).
 *
 * Fail-closed rules (enforced by the registry, not by individual hooks):
 *   - handler throws         → translate to `{ kind: 'veto', reason: 'hook_error:<msg>' }`
 *   - handler times out 5s   → translate to `{ kind: 'veto', reason: 'hook_timeout' }`
 *   - rewrite tries is_error → rejected + event_log `security.hook_violation`
 *
 * Design notes:
 *   - Plugins are registered once at startup, like channel plugins. No
 *     runtime registration from user code yet.
 *   - Multiple hooks at the same `priority` run in registration order (stable).
 *   - Lower priority numbers run earlier; default 100.
 *
 * ## Security boundary (read before writing a hook)
 *
 * Hooks run AFTER the #261 permission gate, so a `pre_tool_call` rewrite
 * CANNOT grant a caller privilege it lacks at the tool-name level — the
 * gate already classified `shell_exec` as L2 / `web_fetch` as L3 before
 * the hook saw the call.
 *
 * However, **rewriting `args` for tools that do not re-validate their
 * inputs against a deny-list is a privilege-preserving bypass vector**:
 *
 *   - `fs_*` / `shell_*` tools re-validate paths via `runTel` → `validatePath`
 *     inside the tool body, so a hook rewriting `args.path` to
 *     `/etc/passwd` is caught there (verified by negative integration test).
 *   - `web_fetch` / `web_search` / `browser_*` tools do NOT re-validate URLs.
 *     A hook rewriting `args.url` to `http://169.254.169.254/…` succeeds
 *     against the cloud metadata service if the caller already has
 *     `network.request` (L3). The permission gate validated
 *     "web_fetch requires L3", not "this URL is safe".
 *   - `desktop_launch_app` with a rewritten `args.command` — same class.
 *
 * Hooks are therefore **privileged plugin code** on par with the tool
 * dispatchers themselves. They MUST be authored or vetted by the operator
 * to the same degree. MOZI does not sandbox hook handlers and does not
 * replay permission checks against rewritten args.
 *
 * Trust model:
 *   - Built-in hooks (this codebase) are reviewed at commit time.
 *   - Workspace / third-party hooks (future) must be reviewed by the
 *     operator before install, same as workspace skills. Do not install
 *     hook code from untrusted sources.
 */
import type { ToolResult } from './types.js';

export type ToolHookPhase = 'pre_tool_call' | 'transform_tool_result';

export interface ToolHookContext {
  toolName: string;
  args: Record<string, unknown>;
  tenantId: string;
  agentId?: string;
  chatId?: string;
  /** Populated only for `transform_tool_result`. */
  result?: ToolResult;
}

export type HookResult =
  | { kind: 'continue' }
  | { kind: 'veto'; reason: string }
  | { kind: 'rewrite'; args?: Record<string, unknown>; result?: ToolResult };

export interface ToolHook {
  /** Stable identifier — unique per (phase). */
  id: string;
  phase: ToolHookPhase;
  /** Lower runs earlier (default 100). */
  priority?: number;
  /** Per-handler timeout in ms. Default 5000. */
  timeoutMs?: number;
  handler(ctx: ToolHookContext): Promise<HookResult> | HookResult;
}

export const HOOK_DEFAULT_PRIORITY = 100;
export const HOOK_DEFAULT_TIMEOUT_MS = 5_000;
