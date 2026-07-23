import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';
import { z } from 'zod';
import { gitListBranches, gitSwitchBranch, isValidBranchName } from '../tools/git.js';
import { getRuntimeProjectRoot } from '../runtime/project-root.js';
import { logAudit } from '../security/audit.js';

/**
 * Branch listing / switching for the composer branch picker.
 *
 * Semantics are deliberately plain `git switch`: uncommitted changes carry
 * over per git defaults, conflicts abort with git's own stderr surfaced
 * verbatim, nothing is ever stashed or forced. Out of scope for v1 (documented
 * future work): fetch/pull/push, remote-tracking checkout, auto-stash, branch
 * delete/rename, and locking against an in-flight brain turn — switching here
 * carries the same risk as the operator running git in a terminal mid-turn.
 */

type TenantContext = { tenant_id: string; user_id: string; roles: string[] };

export interface GitBranchRouteDependencies {
  /** Resolve a user-supplied absolute dir to a granted root path (null = not allowed). */
  resolveAllowedDir(path: string, userId: string): string | null;
  /** Override for tests; defaults to comparing against the runtime source root. */
  isRuntimeSourceRoot?(path: string): boolean;
}

const GitBranchesQuerySchema = z.object({ root: z.string().min(1) }).strict();

const GitSwitchBodySchema = z.object({
  root: z.string().min(1),
  branch: z.string().min(1).max(244),
  create: z.boolean().optional(),
}).strict();

function tenantContext(request: unknown): TenantContext | undefined {
  return (request as { tenantContext?: TenantContext }).tenantContext;
}

function defaultIsRuntimeSourceRoot(path: string): boolean {
  try {
    return resolve(path) === resolve(getRuntimeProjectRoot());
  } catch {
    return false;
  }
}

export function registerGitBranchRoutes(app: FastifyInstance, deps: GitBranchRouteDependencies): void {
  const isRuntimeSourceRoot = deps.isRuntimeSourceRoot ?? defaultIsRuntimeSourceRoot;

  app.get('/api/git/branches', async (request, reply) => {
    const ctx = tenantContext(request);
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });

    const parsed = GitBranchesQuerySchema.safeParse(request.query || {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: parsed.error.message });
    }

    // 404 (not 403) for non-granted paths — same no-disclosure stance as fs routes.
    const root = deps.resolveAllowedDir(parsed.data.root, ctx.user_id);
    if (!root) return reply.code(404).send({ success: false, error: 'Not found' });

    try {
      const result = await gitListBranches(root);
      return reply.send({
        success: true,
        current: result.current,
        dirty_count: result.dirty_count,
        is_runtime_source: isRuntimeSourceRoot(root),
        branches: result.branches,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ success: false, error: message });
    }
  });

  app.post('/api/git/switch', async (request, reply) => {
    const ctx = tenantContext(request);
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });

    const parsed = GitSwitchBodySchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: parsed.error.message });
    }

    const root = deps.resolveAllowedDir(parsed.data.root, ctx.user_id);
    if (!root) return reply.code(404).send({ success: false, error: 'Not found' });

    if (!isValidBranchName(parsed.data.branch)) {
      return reply.code(400).send({ success: false, error: `Invalid branch name: ${parsed.data.branch}` });
    }

    try {
      const result = await gitSwitchBranch(root, parsed.data.branch, { create: parsed.data.create });
      logAudit({
        tenant_id: ctx.tenant_id,
        user_id: ctx.user_id,
        action: 'git.branch_switch',
        resource_type: 'fs_root',
        resource_id: root,
        details: { branch: result.branch, previous: result.previous, create: parsed.data.create === true },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
      });
      return reply.send({ success: true, branch: result.branch, previous: result.previous });
    } catch (err) {
      // git aborted (conflict, already checked out in a worktree, unknown
      // branch, …) — the tree is untouched; surface git's stderr verbatim.
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ success: false, error: message });
    }
  });
}
