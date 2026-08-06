import { z } from 'zod';
import type { ToolDefinition } from '../core/llm.js';
import { createAgentDefinition } from '../agents/definition-loader.js';
import { delegateToAgent } from '../agents/delegate-runner.js';
import type { ToolContext, ToolResult } from './types.js';

const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AGENT_TOOL_GROUPS = ['filesystem', 'shell', 'git', 'network'] as const;
const AGENT_PERMISSION_LEVELS = ['L0_READ_ONLY', 'L1_READ_WRITE', 'L2_SHELL_EXEC'] as const;

const CreateAgentInputSchema = z.object({
  name: z.string().trim().regex(AGENT_NAME_PATTERN),
  description: z.string().trim().min(1),
  persona: z.string().trim().min(1),
  permission_level: z.enum(AGENT_PERMISSION_LEVELS),
  model: z.string().trim().min(1).optional(),
  skills: z.array(z.string().trim().min(1)).default([]),
  tool_groups: z.array(z.enum(AGENT_TOOL_GROUPS)).max(AGENT_TOOL_GROUPS.length).optional(),
}).strict();

const DelegateToAgentInputSchema = z.object({
  agent: z.string().min(1),
  brief: z.string().min(1),
  context_refs: z.array(z.string().min(1)).max(20).optional(),
});

export const createAgentTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'create_agent',
    description: 'Create a reusable custom Agent through MOZI\'s registry. Use whenever the user asks to create an Agent. Never create or edit AGENT.md with file or shell tools; MOZI owns storage.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          pattern: '^[a-z0-9][a-z0-9_-]{0,63}$',
          description: 'Stable Agent name using lowercase letters, numbers, hyphens, or underscores.',
        },
        description: {
          type: 'string',
          description: 'One concise sentence describing when MOZI should use this Agent.',
        },
        persona: {
          type: 'string',
          description: 'The Agent\'s role, expertise, method, and quality bar. Do not include file paths or runtime response-envelope instructions.',
        },
        permission_level: {
          type: 'string',
          enum: AGENT_PERMISSION_LEVELS,
          description: 'Least privilege needed: L0 reads, L1 may write files, L2 may also execute shell commands.',
        },
        model: {
          type: 'string',
          description: 'Optional configured provider/model id. Omit to inherit the active model.',
        },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional exact names of installed skills this Agent requires.',
        },
        tool_groups: {
          type: 'array',
          items: { type: 'string', enum: AGENT_TOOL_GROUPS },
          maxItems: AGENT_TOOL_GROUPS.length,
          description: 'Optional runtime tool groups. Omit for MOZI\'s default filesystem and shell groups.',
        },
      },
      required: ['name', 'description', 'persona', 'permission_level'],
      additionalProperties: false,
    },
  },
};

export const delegateToAgentTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'delegate_to_agent',
    description: 'Delegate a self-contained brief to a ready file-defined agent. The isolated agent loop returns only a validated result envelope; intermediate agent messages remain in its archived transcript.',
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Exact agent name from the runtime capability contract.',
        },
        brief: {
          type: 'string',
          description: 'Self-contained task brief written by MOZI, including outcome, constraints, and completion criteria.',
        },
        context_refs: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 20,
          description: 'Optional workspace/output file paths to read into the isolated agent context.',
        },
      },
      required: ['agent', 'brief'],
      additionalProperties: false,
    },
  },
};

export const AGENT_TOOL_DEFINITIONS: ToolDefinition[] = [createAgentTool, delegateToAgentTool];

export async function executeAgentTool(
  name: string,
  args: Record<string, unknown>,
  id: string,
  context?: ToolContext,
): Promise<ToolResult | null> {
  if (name === 'create_agent') {
    const parsed = CreateAgentInputSchema.parse(args);
    const agent = await createAgentDefinition({
      name: parsed.name,
      description: parsed.description,
      persona: parsed.persona,
      permission_level: parsed.permission_level,
      ...(parsed.model ? { model: parsed.model } : {}),
      skills: parsed.skills,
      ...(parsed.tool_groups ? { tools: parsed.tool_groups } : {}),
    });
    return {
      tool_call_id: id,
      tool_name: name,
      content: JSON.stringify({
        agent: {
          name: agent.name,
          description: agent.description,
          status: agent.status,
          enabled: agent.enabled,
          model: agent.model ?? null,
          skills: agent.skills,
          tool_groups: agent.tools ?? null,
          permission_level: agent.permission_level ?? null,
        },
      }),
      is_error: false,
    };
  }

  if (name === 'delegate_to_agent') {
    const parsed = DelegateToAgentInputSchema.parse(args);
    const envelope = await delegateToAgent({
      agent: parsed.agent,
      brief: parsed.brief,
      contextRefs: parsed.context_refs,
      context,
    });
    // The transcript is runtime diagnostic state, not task evidence for the
    // parent model. On failure especially, exposing its path enabled the parent
    // to salvage an empty/partial run and claim success.
    const { transcript_path: _transcriptPath, ...modelResult } = envelope;
    return {
      tool_call_id: id,
      tool_name: name,
      content: JSON.stringify(modelResult),
      is_error: envelope.status !== 'succeeded',
    };
  }

  return null;
}
