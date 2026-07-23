/**
 * Skill Management Tools — list, install, enable/disable, validate, reload skills.
 */

import type { ToolDefinition } from '../core/llm.js';
import type { ToolResult, ToolContext } from './types.js';
import { getWorkspaceDir } from './tool-utils.js';
import { join } from 'node:path';
import { activateSkill, activeSkillScope, unloadActiveSkill } from '../skills/active-skills.js';

type SkillLoadMetadata = Pick<
  ToolResult,
  'skillName' | 'skillDescription' | 'skillLoadOutcome' | 'skillMissingBins' | 'skillMissingEnv' | 'skillLoadError'
>;

// ── Definitions ──

export const listRuntimeSkillsTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'list_runtime_skills',
    description: 'List bundled and workspace runtime skills with enabled/disabled state and requirement status.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
};

export const useSkillTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'use_skill',
    description: 'Activate one eligible skill listed in the Available Skills catalog. The runtime places full instructions in the session-scoped Active Skills context slot; call before applying a skill whose full procedure is needed.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact skill name from the Available Skills catalog.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
};

export const unloadSkillTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'unload_skill',
    description: 'Retire one active skill from the current session when its full instructions are no longer needed.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact active skill name to unload.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
};

export const installSkillTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'install_skill',
    description: 'Install a skill into the workspace skill directory from a bundled runtime skill, a local path containing SKILL.md, or an https git repository. Use this when a task needs a reusable skill asset, not just an ad-hoc prompt.',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: ['bundled', 'path', 'git'],
          description: 'Install from a bundled bootstrap skill, a local filesystem path, or an https git repository',
        },
        skill_id: {
          type: 'string',
          description: 'Bundled skill directory name (required when source=bundled)',
        },
        source_path: {
          type: 'string',
          description: 'Local directory or SKILL.md path (required when source=path)',
        },
        repo_url: {
          type: 'string',
          description: 'https git repository URL (required when source=git)',
        },
        skill_subpath: {
          type: 'string',
          description: 'Optional path inside the cloned repository that contains SKILL.md',
        },
        target_name: {
          type: 'string',
          description: 'Optional workspace directory name to install into',
        },
        overwrite: {
          type: 'boolean',
          description: 'Overwrite an existing workspace skill directory',
        },
        enabled: {
          type: 'boolean',
          description: 'Whether the installed skill should be enabled immediately (default true)',
        },
      },
      required: ['source'],
      additionalProperties: false,
    },
  },
};

export const setSkillStateTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'set_skill_state',
    description: 'Enable or disable a workspace skill by toggling its runtime state. This only affects workspace-installed skills, not bundled built-ins.',
    parameters: {
      type: 'object',
      properties: {
        skill_id: {
          type: 'string',
          description: 'Workspace skill directory name or skill name',
        },
        enabled: {
          type: 'boolean',
          description: 'true = enable, false = disable',
        },
      },
      required: ['skill_id', 'enabled'],
      additionalProperties: false,
    },
  },
};

export const validateSkillTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'validate_skill',
    description: 'Validate one runtime skill and report whether its requirements are currently satisfied.',
    parameters: {
      type: 'object',
      properties: {
        skill_id: {
          type: 'string',
          description: 'Skill directory name or skill name',
        },
        source: {
          type: 'string',
          enum: ['workspace', 'bundled'],
          description: 'Skill source to validate (default workspace)',
        },
      },
      required: ['skill_id'],
      additionalProperties: false,
    },
  },
};

export const reloadSkillsTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'reload_skills',
    description: 'Reload workspace skills from ~/.mozi/workspace/skills/ without restarting. Call after creating or modifying SKILL.md files.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
};

export const proposeSkillTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'propose_skill',
    description:
      'Persist a reusable skill distilled from the current task. Call this ONLY when YOU judge the sequence of steps is genuinely reusable across future tasks — do not call it as a formality. MOZI writes the SKILL.md to the workspace autogen namespace (origin: "autogen", user-invocable: false, sandbox_profile: read-only). Operator must promote it before users can invoke it by name.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 80, description: 'Human name; will be slugified to `autogen-<slug>`.' },
        description: { type: 'string', minLength: 1, maxLength: 240, description: 'One-line description for frontmatter.' },
        category: { type: 'string', enum: ['utility', 'coding', 'research', 'communication', 'media', 'system'] },
        steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 40, description: 'Ordered step list that ran successfully.' },
        examples: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        edge_cases: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        source_task_id: { type: 'string', maxLength: 120, description: 'Optional originating task id for audit.' },
        when_to_use: { type: 'string', minLength: 1, maxLength: 400 },
      },
      required: ['name', 'description', 'category', 'steps'],
      additionalProperties: false,
    },
  },
};

export const SKILL_TOOL_DEFINITIONS: ToolDefinition[] = [
  useSkillTool,
  unloadSkillTool,
  listRuntimeSkillsTool,
  installSkillTool,
  setSkillStateTool,
  validateSkillTool,
  reloadSkillsTool,
  proposeSkillTool,
];

// ── Executor ──

function runtimeSkillPaths(projectRoot: string, workspaceDir: string): { bundledDir: string; workspaceDir: string } {
  return {
    bundledDir: join(projectRoot, 'skills'),
    workspaceDir: join(workspaceDir, 'skills'),
  };
}

function skillLoadErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function classifySkillLoadFailure(
  requestedName: string,
  errorMessage: string,
  paths: { bundledDir: string; workspaceDir: string },
): Promise<SkillLoadMetadata> {
  try {
    const { listRuntimeSkills } = await import('../skills/workspace-manager.js');
    const skills = await listRuntimeSkills(paths, { includeAutogen: true });
    const skill = skills.find(candidate => candidate.name === requestedName);

    if (!skill) {
      return {
        skillName: requestedName,
        skillLoadOutcome: 'not_found',
        skillLoadError: 'Skill not found',
      };
    }

    return {
      skillName: skill.name,
      skillDescription: skill.description,
      skillLoadOutcome: 'ineligible',
      skillMissingBins: skill.missing_bins,
      skillMissingEnv: skill.missing_env,
      skillLoadError: errorMessage,
    };
  } catch {
    return {
      skillName: requestedName,
      skillLoadOutcome: 'not_found',
      skillLoadError: errorMessage,
    };
  }
}

export async function executeSkillTool(
  name: string,
  args: Record<string, unknown>,
  id: string,
  context?: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'use_skill': {
      const skillName = args.name;
      if (!skillName || typeof skillName !== 'string') {
        return {
          tool_call_id: id,
          tool_name: 'use_skill',
          content: 'Error: "name" is required and must be a string',
          is_error: true,
        };
      }

      const { loadSkillForModelInvocation } = await import('../skills/loader.js');
      const { getRuntimeProjectRoot } = await import('../runtime/project-root.js');
      const projectRoot = getRuntimeProjectRoot();
      const paths = runtimeSkillPaths(projectRoot, getWorkspaceDir());
      const scope = activeSkillScope({
        tenantId: context?.tenantId,
        sessionId: context?.sessionId,
        chatId: context?.chatId,
      });
      if (!scope) {
        return {
          tool_call_id: id,
          tool_name: 'use_skill',
          content: 'Error: use_skill requires an active session context',
          is_error: true,
          skillName,
          skillLoadOutcome: 'not_found',
          skillLoadError: 'Session context required',
        };
      }
      try {
        const result = await loadSkillForModelInvocation(skillName, {
          bundledDir: paths.bundledDir,
          workspaceDir: paths.workspaceDir,
        });
        activateSkill(scope, result.skill);

        // Provision the skill's declared runtime dependencies (npm/pip) into the
        // shared skill-runtime dir so scripts the Brain writes can import them
        // directly — NODE_PATH / PYTHONPATH are preconfigured for shell commands.
        let depNote = '';
        try {
          const { provisionSkillDependencies } = await import('../skills/provision-deps.js');
          const prov = await provisionSkillDependencies(result.skill.frontmatter.install);
          const ready = [...prov.installed, ...prov.ready];
          if (ready.length > 0) {
            depNote = ` Runtime dependencies verified ready in MOZI's managed environment: ${ready.join(', ')}.`;
          }
          if (prov.needsAction.length > 0) {
            const actions = prov.needsAction.map((need) => {
              if (need.kind === 'brew') return `brew install ${need.dependency}`;
              return need.command || need.label || `install ${need.dependency}`;
            });
            depNote += ` Runtime dependencies requiring explicit operator action (not installed or reported ready): ${actions.join('; ')}.`;
          }
          if (prov.failed.length > 0) {
            depNote += ` Managed dependency provisioning failed: ${prov.failed.map((f) => `${f.package}: ${f.error}`).join('; ')}.`;
          }
        } catch (provErr) {
          depNote = ` (Dependency provisioning was skipped: ${provErr instanceof Error ? provErr.message : String(provErr)})`;
        }

        return {
          tool_call_id: id,
          tool_name: 'use_skill',
          content: `Skill ${result.skill.name} loaded — full instructions are available in the Active Skills section of your context.${depNote}`,
          is_error: false,
          skillName: result.skill.name,
          skillDescription: result.skill.description,
          skillLoadOutcome: 'success',
        };
      } catch (err) {
        const message = skillLoadErrorMessage(err);
        const metadata = await classifySkillLoadFailure(skillName, message, paths);
        return {
          tool_call_id: id,
          tool_name: 'use_skill',
          content: `Error: ${message}`,
          is_error: true,
          ...metadata,
        };
      }
    }

    case 'unload_skill': {
      const skillName = args.name;
      if (!skillName || typeof skillName !== 'string') {
        return {
          tool_call_id: id,
          tool_name: 'unload_skill',
          content: 'Error: "name" is required and must be a string',
          is_error: true,
        };
      }
      const scope = activeSkillScope({
        tenantId: context?.tenantId,
        sessionId: context?.sessionId,
        chatId: context?.chatId,
      });
      if (!scope) {
        return {
          tool_call_id: id,
          tool_name: 'unload_skill',
          content: 'Error: unload_skill requires an active session context',
          is_error: true,
        };
      }
      const removed = unloadActiveSkill(scope, skillName);
      return {
        tool_call_id: id,
        tool_name: 'unload_skill',
        content: removed ? `Skill ${skillName} unloaded.` : `Skill ${skillName} was not active.`,
        is_error: false,
      };
    }

    case 'list_runtime_skills': {
      const { formatRuntimeSkillsCommandOutput, listRuntimeSkills } = await import('../skills/workspace-manager.js');
      const skills = await listRuntimeSkills();
      return {
        tool_call_id: id,
        tool_name: 'list_runtime_skills',
        content: formatRuntimeSkillsCommandOutput(skills),
        is_error: false,
      };
    }

    case 'install_skill': {
      const source = args.source as string;
      if (source !== 'bundled' && source !== 'path' && source !== 'git') {
        return {
          tool_call_id: id,
          tool_name: 'install_skill',
          content: 'Error: "source" must be "bundled", "path", or "git"',
          is_error: true,
        };
      }
      const overwrite = args.overwrite;
      const enabled = args.enabled;
      if (overwrite !== undefined && typeof overwrite !== 'boolean') {
        return {
          tool_call_id: id,
          tool_name: 'install_skill',
          content: 'Error: "overwrite" must be a boolean',
          is_error: true,
        };
      }
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        return {
          tool_call_id: id,
          tool_name: 'install_skill',
          content: 'Error: "enabled" must be a boolean',
          is_error: true,
        };
      }

      const { installWorkspaceSkill } = await import('../skills/workspace-manager.js');
      const { clearSkillDiscoveryCache } = await import('../skills/loader.js');
      const result = await installWorkspaceSkill({
        source,
        skill_id: args.skill_id as string | undefined,
        source_path: args.source_path as string | undefined,
        repo_url: args.repo_url as string | undefined,
        skill_subpath: args.skill_subpath as string | undefined,
        target_name: args.target_name as string | undefined,
        overwrite: overwrite as boolean | undefined,
        enabled: enabled as boolean | undefined,
      });
      clearSkillDiscoveryCache();
      return {
        tool_call_id: id,
        tool_name: 'install_skill',
        content: JSON.stringify(result, null, 2),
        is_error: false,
      };
    }

    case 'set_skill_state': {
      const skillId = args.skill_id as string;
      const enabled = args.enabled;
      if (!skillId || typeof skillId !== 'string') {
        return {
          tool_call_id: id,
          tool_name: 'set_skill_state',
          content: 'Error: "skill_id" is required and must be a string',
          is_error: true,
        };
      }
      if (typeof enabled !== 'boolean') {
        return {
          tool_call_id: id,
          tool_name: 'set_skill_state',
          content: 'Error: "enabled" is required and must be a boolean',
          is_error: true,
        };
      }

      const { setWorkspaceSkillState } = await import('../skills/workspace-manager.js');
      const { clearSkillDiscoveryCache } = await import('../skills/loader.js');
      const result = await setWorkspaceSkillState(skillId, enabled);
      clearSkillDiscoveryCache();
      return {
        tool_call_id: id,
        tool_name: 'set_skill_state',
        content: JSON.stringify(result, null, 2),
        is_error: false,
      };
    }

    case 'validate_skill': {
      const skillId = args.skill_id as string;
      const source = (args.source as string | undefined) ?? 'workspace';
      if (!skillId || typeof skillId !== 'string') {
        return {
          tool_call_id: id,
          tool_name: 'validate_skill',
          content: 'Error: "skill_id" is required and must be a string',
          is_error: true,
        };
      }
      if (source !== 'workspace' && source !== 'bundled') {
        return {
          tool_call_id: id,
          tool_name: 'validate_skill',
          content: 'Error: "source" must be "workspace" or "bundled"',
          is_error: true,
        };
      }

      const { validateRuntimeSkill } = await import('../skills/workspace-manager.js');
      const result = await validateRuntimeSkill(skillId, { source });
      return {
        tool_call_id: id,
        tool_name: 'validate_skill',
        content: JSON.stringify(result, null, 2),
        is_error: false,
      };
    }

    case 'reload_skills': {
      const { clearSkillDiscoveryCache, discoverSkills } = await import('../skills/loader.js');
      const { getRuntimeProjectRoot } = await import('../runtime/project-root.js');
      const { join } = await import('node:path');
      clearSkillDiscoveryCache();
      const skills = await discoverSkills({
        bundledDir: join(getRuntimeProjectRoot(), 'skills'),
        workspaceDir: join(getWorkspaceDir(), 'skills'),
      });
      const eligible = skills.filter(s => s.eligible);
      return {
        tool_call_id: id,
        content: `Reloaded skills: ${eligible.length} eligible skill(s) found (${skills.length} total).`,
        is_error: false,
      };
    }

    case 'propose_skill': {
      const { proposeSkill } = await import('../skills/auto-extract.js');
      const { clearSkillDiscoveryCache } = await import('../skills/loader.js');
      const result = await proposeSkill(args, { tenantId: context?.tenantId });
      if (result.ok) {
        clearSkillDiscoveryCache();
        return {
          tool_call_id: id,
          tool_name: 'propose_skill',
          content: `Skill persisted at ${result.filePath}. Slug: ${result.slug}. It is NOT user-invocable and NOT eligible until an operator reviews and promotes it. Call reload_skills to pick it up in-process.`,
          is_error: false,
        };
      }
      return {
        tool_call_id: id,
        tool_name: 'propose_skill',
        content: `Skill proposal rejected (${result.reason}): ${result.detail}`,
        is_error: true,
      };
    }

    default:
      return null;
  }
}
