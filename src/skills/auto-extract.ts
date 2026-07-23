/**
 * Brain-driven skill auto-extraction (#258).
 *
 * The Brain decides *whether* a successful task is worth persisting as a
 * reusable skill. Infrastructure executes that decision: validates the
 * proposed frontmatter, writes a `SKILL.md` under the workspace autogen
 * namespace, and logs an audit event.
 *
 * Scope (phase 1):
 *  - Tool-layer only: `propose_skill` accepts a structured proposal and
 *    produces a valid workspace skill file.
 *  - Auto-trigger logic (when the Brain should *choose* to call this tool)
 *    is intentionally out of scope; that belongs to Agent Loop v2
 *    Evaluate phase (`IMPLEMENTATION.md` 10.3.1).
 *
 * Constitutional alignment:
 *  - §3 SKILL.md compatibility — strict SKILL-SPEC frontmatter.
 *  - §6 Execution over Narration — no keyword heuristic infra-side.
 *  - §7 Managed Worker — default `sandbox_profile: read-only` so autogen
 *    skills require an explicit operator promotion to gain wider access.
 *  - §8 Capability truthfulness — `user-invocable: false` by default, so
 *    newly written skills do NOT become self-advertised user commands.
 */

import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import yaml from 'js-yaml';
import pino from 'pino';
import { getWorkspaceDir } from '../tools/tool-utils.js';
import { log as logEvent } from '../store/events.js';

const logger = pino({ name: 'mozi:skills:auto-extract' });

// ---------------------------------------------------------------------------
// Proposal schema (Zod)
// ---------------------------------------------------------------------------

const SKILL_CATEGORIES = ['utility', 'coding', 'research', 'communication', 'media', 'system'] as const;

/** Upper bound on every user-visible string so a malicious Brain cannot
 *  DoS the workspace with a 100KB SKILL.md. */
const MAX_BODY_STRING = 2000;

export const ProposeSkillArgsSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(240),
  category: z.enum(SKILL_CATEGORIES),
  steps: z.array(z.string().min(1).max(MAX_BODY_STRING)).min(1).max(40),
  examples: z.array(z.string().min(1).max(MAX_BODY_STRING)).max(10).optional(),
  edge_cases: z.array(z.string().min(1).max(MAX_BODY_STRING)).max(10).optional(),
  source_task_id: z.string().max(120).optional(),
  when_to_use: z.string().min(1).max(MAX_BODY_STRING).optional(),
});

export type ProposeSkillArgs = z.infer<typeof ProposeSkillArgsSchema>;

// ---------------------------------------------------------------------------
// Slug safety
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Convert a human skill name into a safe allowlisted slug.
 * Returns `null` if the slug would be empty after normalization.
 */
export function slugify(raw: string): string | null {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (!normalized) return null;
  const truncated = normalized.slice(0, 56);
  const slug = `autogen-${truncated}`;
  return SLUG_RE.test(slug) ? slug : null;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ProposeSkillOk {
  ok: true;
  slug: string;
  filePath: string;
}

export interface ProposeSkillErr {
  ok: false;
  reason:
    | 'invalid_args'
    | 'invalid_slug'
    | 'already_exists'
    | 'write_failed'
    | 'path_escape'
    | 'symlink_target';
  detail: string;
}

export type ProposeSkillResult = ProposeSkillOk | ProposeSkillErr;

// ---------------------------------------------------------------------------
// Core — proposeSkill
// ---------------------------------------------------------------------------

export async function proposeSkill(
  input: unknown,
  opts: { workspaceDir?: string; tenantId?: string } = {},
): Promise<ProposeSkillResult> {
  const parseResult = ProposeSkillArgsSchema.safeParse(input);
  if (!parseResult.success) {
    return {
      ok: false,
      reason: 'invalid_args',
      detail: parseResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  const args = parseResult.data;

  const slug = slugify(args.name);
  if (!slug) {
    return { ok: false, reason: 'invalid_slug', detail: `cannot derive safe slug from "${args.name}"` };
  }

  const workspaceSkillsDir = resolve(opts.workspaceDir ?? join(getWorkspaceDir(), 'skills'));
  const skillDir = resolve(workspaceSkillsDir, slug);

  // Defense-in-depth: ensure resolve() did not escape workspaceSkillsDir.
  if (!skillDir.startsWith(workspaceSkillsDir + '/') && skillDir !== workspaceSkillsDir) {
    return { ok: false, reason: 'path_escape', detail: slug };
  }

  // Defense-in-depth against symlink-planting attacks: refuse the write if the
  // target is itself a symlink (otherwise `existsSync` → `already_exists`
  // would hide a symlink pointing outside the workspace). Pairs with the
  // O_EXCL write flag below for TOCTOU safety.
  try {
    const stats = lstatSync(skillDir);
    if (stats.isSymbolicLink()) {
      return { ok: false, reason: 'symlink_target', detail: slug };
    }
    // Path exists and is NOT a symlink → regular duplicate.
    return { ok: false, reason: 'already_exists', detail: slug };
  } catch {
    // ENOENT is the happy path (directory does not exist yet) — continue.
  }

  const frontmatter = {
    name: slug,
    description: args.description,
    version: '0.1.0',
    category: args.category,
    'user-invocable': false,
    origin: 'autogen',
    ...(args.source_task_id ? { source_task_id: args.source_task_id } : {}),
    metadata: {
      sandbox_profile: 'read-only' as const,
      generated_at: new Date().toISOString(),
    },
  };

  const body = renderSkillBody(args);
  const content = `---\n${yaml.dump(frontmatter, { lineWidth: 120 }).trim()}\n---\n\n${body}`;

  try {
    mkdirSync(skillDir, { recursive: true });
    // `wx` = O_CREAT | O_EXCL — atomic refuse-if-exists. Closes the narrow
    // TOCTOU window between the existence check above and this write (two
    // concurrent proposeSkill calls for the same slug now cannot both
    // succeed — the second gets EEXIST).
    writeFileSync(join(skillDir, 'SKILL.md'), content, { encoding: 'utf-8', flag: 'wx' });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn({ slug, detail }, 'proposeSkill write failed');
    return { ok: false, reason: 'write_failed', detail };
  }

  const tenantId = opts.tenantId ?? 'default';
  try {
    logEvent(
      'skill.autogen_created',
      'skill',
      slug,
      {
        name: args.name,
        description: args.description,
        category: args.category,
        source_task_id: args.source_task_id ?? null,
        file_path: join(skillDir, 'SKILL.md'),
      },
      tenantId,
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message, slug }, 'audit log failed');
  }

  return { ok: true, slug, filePath: join(skillDir, 'SKILL.md') };
}

function renderSkillBody(args: ProposeSkillArgs): string {
  const lines: string[] = [`# ${args.name}`, ''];
  if (args.when_to_use) {
    lines.push('## When to Use', args.when_to_use, '');
  }
  lines.push('## How to Execute', ...args.steps.map((s, i) => `${i + 1}. ${s}`), '');
  if (args.examples && args.examples.length > 0) {
    lines.push('## Examples', ...args.examples.map(e => `- ${e}`), '');
  }
  if (args.edge_cases && args.edge_cases.length > 0) {
    lines.push('## Edge Cases', ...args.edge_cases.map(e => `- ${e}`), '');
  }
  return lines.join('\n');
}
